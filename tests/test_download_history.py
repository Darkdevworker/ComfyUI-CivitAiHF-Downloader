"""
Download history, resuming an interrupted download, and checking a finished
file against the hash Civitai advertised.

Run with:  python3 tests/test_download_history.py
"""

import asyncio
import json
import logging
import os
import sys
import tempfile
import types

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

SRC = open(os.path.join(ROOT, "server.py"), encoding="utf-8").read()

passed = 0
failed = 0


def ok(cond, label):
    global passed, failed
    if cond:
        passed += 1
    else:
        failed += 1
        print(f"  x {label}")


def eq(actual, expected, label):
    ok(actual == expected, f"{label} — expected {expected!r}, got {actual!r}")


def check(text, needle, label):
    ok(needle in text, f"{label} — not found: {needle!r}")


def reject(text, needle, label):
    ok(needle not in text, f"{label} — should be gone: {needle!r}")


def slice_fn(name, end):
    """Pull one function out of server.py. `async def` must be matched whole,
    or the slice starts at `def` and the awaits stop parsing."""
    start = -1
    for prefix in ("async def %s(" % name, "def %s(" % name):
        start = SRC.find(prefix)
        if start >= 0:
            break
    if start < 0:
        raise AssertionError("no function named " + name)
    stop = SRC.index(end, start)
    return SRC[start:stop]


# ── the store ──────────────────────────────────────────────────────────
import history_store  # noqa: E402

_TMP = tempfile.mkdtemp(prefix="civitai-hist-")
_FILE = os.path.join(_TMP, "download_history.json")
history_store.history_path = lambda: _FILE


def entry(n, **kw):
    out = {"id": "dl_%d" % n, "name": "model %d.safetensors" % n, "status": "completed"}
    out.update(kw)
    return out


print("the history file")
eq(history_store.load(), [], "starts empty")
history_store.add(entry(1))
eq(len(history_store.load()), 1, "takes an entry")
history_store.add(entry(2))
eq(history_store.load()[0]["id"], "dl_2", "newest first")
history_store.add(entry(1, name="renamed"))
eq(len(history_store.load()), 2, "re-using an id replaces, it does not append")
eq(history_store.load()[0]["id"], "dl_1", "the re-recorded entry comes back to the top")
eq(history_store.load()[0]["name"], "renamed", "and the new version is the one kept")

print("it stays bounded, so a year of downloads cannot grow without limit")
for i in range(history_store.MAX_ENTRIES + 40):
    history_store.add(entry(1000 + i))
eq(len(history_store.load()), history_store.MAX_ENTRIES, "capped at MAX_ENTRIES")
eq(history_store.load()[0]["id"], "dl_%d" % (1000 + history_store.MAX_ENTRIES + 39),
   "still newest first")

history_store.remove("dl_1000")
eq(all(e["id"] != "dl_1000" for e in history_store.load()), True, "one entry can be removed")
history_store.clear()
eq(history_store.load(), [], "and the whole thing can be forgotten")

history_store.add(entry(7))
ok(json.load(open(_FILE, encoding="utf-8")), "the file is valid JSON")
history_store.add("not a dict")
eq(len(history_store.load()), 1, "junk is refused, not written")

# ── recording a finished job ───────────────────────────────────────────
ns = {
    "os": os, "json": json, "time": __import__("time"),
    "logger": logging.getLogger("CivitaiHF"),
    "history_store": history_store,
    "DOWNLOAD_TASKS": {},
}
exec(compile(slice_fn("_record_history", "\ndef _write_json("), "server.py", "exec"), ns)
record = ns["_record_history"]
DOWNLOAD_TASKS = ns["DOWNLOAD_TASKS"]

history_store.clear()
print("a finished job is recorded with enough to re-download it")
DOWNLOAD_TASKS["dl_9"] = {
    "id": "dl_9", "url": "https://civitai.com/api/download/models/991",
    "filename": "naruto.safetensors", "path": __file__, "type": "loras",
    "subfolder": "Marlosart", "model_version_id": 991,
    "status": "completed", "hash": "abc123", "verified": "ok",
    "started_at": 1700000000,
}
record("dl_9", "completed")
items = history_store.load()
eq(len(items), 1, "one entry")
e = items[0]
eq(e["source"], "civitai", "tagged civitai")
eq(e["url"], "https://civitai.com/api/download/models/991", "with the url")
eq(e["subfolder"], "Marlosart", "the subfolder")
eq(e["model_version_id"], 991, "and the version id, so it can be fetched again")
eq(e["verified"], "ok", "carrying the hash verdict")
ok(e["size"] > 0, "and the size on disk")

print("a Hugging Face job is tagged as one")
DOWNLOAD_TASKS["hf_1"] = {"id": "hf_1", "path": __file__, "filename": "model.bin",
                          "hf_repo_id": "user/repo", "hf_path": "model.bin"}
record("hf_1", "completed")
eq(history_store.load()[0]["source"], "hf", "from the id prefix")
eq(history_store.load()[0]["repo_id"], "user/repo", "with the repo")

print("a failed job is recorded too")
DOWNLOAD_TASKS["dl_x"] = {"id": "dl_x", "url": "u", "filename": "f.safetensors"}
record("dl_x", "error")
eq(history_store.load()[0]["status"], "error", "so failures are not silently lost")
record("never-seen", "completed")
eq(len(history_store.load()), 3, "and an unknown task is ignored rather than crashing")

# ── resuming ───────────────────────────────────────────────────────────
ns2 = {"os": os, "json": json, "logger": logging.getLogger("CivitaiHF")}
exec(compile(slice_fn("_read_part", "\ndef _write_json("), "server.py", "exec"), ns2)
read_part = ns2["_read_part"]
write_part = ns2["_write_part"]
resume_point = ns2["_resume_point"]

print("the resume marker")
marker = os.path.join(_TMP, "model.safetensors.part.json")
eq(read_part(os.path.join(_TMP, "nope.json")), None, "a missing marker reads as None")
write_part(marker, {"url": "https://x/file", "total": 1000, "size": 400})
eq(read_part(marker)["total"], 1000, "and round-trips")
with open(marker, "w", encoding="utf-8") as f:
    f.write("{ not json")
eq(read_part(marker), None, "corruption reads as None, not a crash")

print("the decision to resume is the part that must not go wrong")
part_file = os.path.join(_TMP, "model.safetensors")
URL = "https://x/file"


def size(n):
    with open(part_file, "wb") as f:
        f.write(b"x" * n)


size(400)
eq(resume_point(part_file, {"url": URL, "total": 1000}, URL), 400,
   "a partial file for the same url resumes")
size(1000)
eq(resume_point(part_file, {"url": URL, "total": 1000}, URL), 0,
   "a complete file does not — it is finished, not interrupted")
size(1200)
eq(resume_point(part_file, {"url": URL, "total": 1000}, URL), 0,
   "nor does one that is somehow longer than the total")
size(400)
eq(resume_point(part_file, {"url": "https://x/other", "total": 1000}, URL), 0,
   "a marker for a different url is ignored")
eq(resume_point(part_file, None, URL), 0, "no marker, no resume")
eq(resume_point(part_file, {"url": URL, "total": 0}, URL), 0, "an unknown total, no resume")
eq(resume_point(os.path.join(_TMP, "absent.safetensors"),
                {"url": URL, "total": 1000}, URL), 0, "a missing file, no resume")
size(0)
eq(resume_point(part_file, {"url": URL, "total": 1000}, URL), 0, "an empty file, no resume")

# ── the advertised hash ────────────────────────────────────────────────
print("verifying against the hash Civitai publishes")
_VERSIONS = {
    1: {"files": [{"name": "fp16.safetensors", "hashes": {"SHA256": "AAA"}},
                  {"name": "pruned.safetensors", "hashes": {"SHA256": "BBB"}}]},
    2: {"files": [{"name": "only.safetensors", "hashes": {"SHA256": "CCC"}}]},
}


def _fake_version_info(version_id, domain):
    return _VERSIONS.get(version_id)


ns3 = {"asyncio": asyncio,
       "utils": types.SimpleNamespace(
           CivitaiAPIUtils=types.SimpleNamespace(
               get_model_version_info_by_id=_fake_version_info)),
       "logger": logging.getLogger("CivitaiHF")}
exec(compile(slice_fn("_expected_sha256", "\nasync def _save_metadata_and_preview("),
             "server.py", "exec"), ns3)
expected = ns3["_expected_sha256"]

eq(asyncio.new_event_loop().run_until_complete(expected(1, "pruned.safetensors", "civitai.com")),
   "BBB", "the hash of the file that was asked for")
eq(asyncio.new_event_loop().run_until_complete(expected(1, "fp16.safetensors", "civitai.com")),
   "AAA", "not the version's first file when several are published")
eq(asyncio.new_event_loop().run_until_complete(expected(2, "anything", "civitai.com")),
   "CCC", "a version with one file matches regardless of name")
eq(asyncio.new_event_loop().run_until_complete(expected(1, "unknown.safetensors", "civitai.com")),
   "", "an unmatched name among several gives nothing, rather than guessing")
eq(asyncio.new_event_loop().run_until_complete(expected(0, "x", "civitai.com")), "",
   "no version id, no hash")
eq(asyncio.new_event_loop().run_until_complete(expected(None, "x", "civitai.com")), "",
   "and no crash when there is nothing to look up")

# ── wiring ─────────────────────────────────────────────────────────────
print("the download path uses all of it")
check(SRC, "resume_from = _resume_point(save_path, part, download_url)", "resume is wired in")
check(SRC, 'req_headers["Range"] = "bytes=%d-" % resume_from', "a Range request is sent")
check(SRC, 'open(save_path, "ab" if resume_from else "wb")', "and the file is appended to")
check(SRC, "if resume_from and opened.status != 206:", "a server that ignores Range is detected")
check(SRC, 'resp.headers.get("Content-Range", "")', "and the real total is read back")
check(SRC, "os.remove(part_path)", "the marker is cleared once the file is whole")
check(SRC, "await _expected_sha256(", "the advertised hash is fetched")
check(SRC, 'DOWNLOAD_TASKS[task_id]["verified"] = "ok" if same else "mismatch"',
      "and a mismatch is recorded on the job")
check(SRC, "_record_history(task_id,", "history is recorded for civitai jobs")
ok(SRC.count("_record_history(task_id,") >= 3, "and for failures and hf jobs")
check(SRC, '@routes.get("/civitai/history")', "with routes to read it")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
