# Code review — ComfyUI-CivitAiHF-Downloader

Reviewed at commit `8417c80` (server.py 1644 lines, js/civitai.js 2770, utils.py 1178,
js/rating.js 467, bookmarks_store.py 143). Findings are ordered by severity.
Line numbers are from that commit.

## Status

**Findings 1–3 (high) are fixed** — see `tests/test_server_safety.py` (34 checks):
a shared `_safe_model_path()` now guards every route that reads or removes a
file, and every blocking call runs through `run_in_executor` / `_civitai_call`.
Findings 4–12 (medium and low) are **still open**.

## Verified clean

Automated passes found nothing in these areas, so no need to re-check:

- Python syntax (`ast.parse`) and JS syntax (`node --check`) all clean
- 41 routes, no duplicate method+path, no reused handler names
- Every endpoint the JS calls exists on the server
- No `eval` / `exec` / `os.system` / `subprocess` anywhere
- No undefined identifiers or cross-scope references in `civitai.js`
  (the scan that would have caught the old `_hfCard` → `grid` bug)
- The two `registerSidebarTab` calls are an if-failed-retry-once fallback, not a
  double registration; `installSidebarLogo` polls for up to 10s, so it also
  catches the tab in the retry path
- 282 assertions pass across 9 test files

---

## High

### 1. Any file on disk can be read through `/civitai/local-preview`  — FIXED

`server.py:207` — the route rejects `..` but then accepts **absolute** paths:

```python
if not os.path.isabs(path):
    path = os.path.join(folder_paths.models_dir, path)   # only relative paths are contained
if not os.path.isfile(path): ...
return web.FileResponse(path, ...)
```

`?path=/etc/passwd` (or `~/.ssh/id_rsa`, or ComfyUI's own config) is served to
anyone who can reach the server. `/civitai/local-metadata` has the same shape but
is lower impact — `_load_sidecar` appends `.civitai.json`, so it only reads files
that already have that suffix.

**Fix:** resolve both with `os.path.realpath` and require the result to be inside
`folder_paths.models_dir` (or one of `folder_paths.folder_names_and_paths`), the
same helper the delete routes need (see below).

### 2. Any file on disk can be deleted through `/civitai/delete-model` and `/civitai/cleanup-delete`  — FIXED

`server.py:775` and `server.py:918`:

```python
model_path = data.get("path")
if not model_path or not os.path.exists(model_path): ...
os.remove(model_path)                     # no containment check at all
```

`POST {"path": "/anything"}` deletes it. `cleanup-delete` takes a list of paths and
removes each with the same lack of checking. `delete-model` then also sweeps the
containing directory (see finding 4), so the blast radius is larger than one file.

**Fix:** one shared `_safe_model_path(path)` helper — `realpath` the input, reject
it unless it is under `folder_paths.models_dir`, and use it in every route that
takes a path (`delete-model`, `cleanup-delete`, `local-preview`, `local-metadata`,
`model-info`, `local-previews`).

### 3. Blocking I/O on the asyncio event loop freezes all of ComfyUI  — FIXED

Ten `async def` handlers do synchronous work with no `run_in_executor`. Because
aiohttp is single-threaded, nothing else — UI, queue, other requests — is served
while they run.

| Where | Blocking call | Worst case |
|---|---|---|
| `server.py:1282` `model_info` | `calculate_sha256(filepath)` then a network lookup | **reads a whole multi-GB checkpoint with no yields — seconds to minutes of a frozen UI** |
| `server.py:828` `auto_tag` | network + `open()` per local model, in a loop | freezes for the entire scan |
| `server.py:939` `auto_organize` | network + `shutil` moves, in a loop | freezes for the whole reorganise |
| `server.py:876` `cleanup_scan` | walks and opens files | freezes for the scan |
| `server.py:111, 152, 165, 289` `lookup`, `model_detail`, `model_by_id`, `model_version_detail` | `_request_with_retry` — sync HTTP that `time.sleep(2)` then `4` on a 429 | up to ~6s+ per request |
| `server.py:580` `_save_metadata_and_preview` | same sync HTTP | runs after every download, on the loop |

`utils.py:683` has a `time.sleep(0.1)` per page inside `fetch_civitai_data_by_hash`
— also blocking if that ever reaches the loop.

**Fix:** wrap each in `await loop.run_in_executor(None, ...)` (the search route
already does this correctly at `server.py:91`) and chunk `calculate_sha256` so it
awaits between reads.

---

## Medium

### 4. Deleting a model damages other models' previews, and orphans its own

`server.py:781-786`:

```python
base = os.path.splitext(model_path)[0]
for fname in os.listdir(model_dir):
    if os.path.isfile(fpath) and fname.startswith(os.path.basename(base)):
        if ext in (".png", ".jpg", ".jpeg", ".webp"):
            os.remove(fpath)
```

Two bugs in five lines:

- **Over-deletes.** `startswith("foo")` also matches `foo-v2.png`, `foo_bar.jpg` —
  so deleting `flux-dev.safetensors` takes `flux-dev-v2.png` with it. Any models
  whose filenames share a prefix lose their previews.
- **Under-deletes.** Previews are also stored in a `preview/` subfolder
  (`utils.py:954` and `utils.py:1137`), and this loop only looks in `model_dir`,
  so `preview/foo.png` is left behind forever.

**Fix:** match exactly `basename(base) + "." + ext` plus the numbered variants, and
also clear `<dir>/preview/<basename>.*`.

### 5. Deleting your last model in a folder deletes the folder itself

`server.py:793-797` — `if not os.listdir(model_dir): os.rmdir(model_dir)`. Delete
the last LoRA and `models/loras` disappears, which ComfyUI does not expect until
it is restarted.

**Fix:** only `rmdir` when `model_dir` is a *sub*directory of a models folder, never
the models folder itself.

### 6. Path traversal through `subfolder` and `filename` on both download routes

`server.py:439` and the HF equivalent build the destination with plain joins:

```python
save_dir = os.path.join(models_dir, type_dir, subfolder)
save_path = os.path.join(save_dir, filename)
```

Both values come from user-typed fields in the detail modal. `subfolder = "../../x"`
or `filename = "../../x.safetensors"` writes outside the models directory.

**Fix:** reject `..` and separators in `filename`, and run `subfolder` through the
same containment check as finding 1.

### 7. `/civitai/model-info` never finds metadata for non-`.safetensors` models

`server.py:1290`:

```python
json_path = filepath.replace(".safetensors", ".civitai.json")
```

For a `.ckpt`, `.gguf`, or `.bin` model the replace is a no-op, so `json_path` *is*
the model file. `os.path.exists` is true, so the code `json.load()`s a multi-GB
binary, throws, swallows it, and reports `metadata: null`. Wasted I/O plus a
silently wrong answer. (`str.replace` also replaces every occurrence, not just the
extension.)

**Fix:** `os.path.splitext(filepath)[0] + ".civitai.json"`.

---

## Low

8. **`preserve_subfolders` does nothing.** `js/civitai.js:1937` sends it from the HF
   detail view; neither `server.py` nor `utils.py` ever reads it. Either implement it
   or remove the checkbox.
9. **Dead code.** `_cached_api_get` (`server.py:24`) is defined and never called.
   The download payload still carries `format`, `fp`, `size`
   (`js/civitai.js:1172-1174`) which the server ignores — harmless now that the
   chosen file's URL is sent, but misleading.
10. **`.preview_cache` grows without bound** (`server.py:219`, created at import).
    Nothing evicts it and no route clears it.
11. **`datetime.utcfromtimestamp`** (`server.py:211`) is deprecated on Python 3.12+;
    use `datetime.fromtimestamp(mtime, timezone.utc)`.
12. **30 `except …: pass` blocks** across `server.py` (19) and `utils.py` (11) hide
    failures — most notably around metadata and preview saving, which is why a
    missing preview looks identical to a network error.

---

## Suggested order of work

1. Add `_safe_model_path()` and use it in every path-taking route (fixes 1, 2, 6)
2. Move the blocking calls off the event loop (fixes 3 — start with `model_info`)
3. Fix the preview sweep and the empty-folder `rmdir` in `delete-model` (fixes 4, 5)
4. One-line sidecar fix (7), then the low-severity items
