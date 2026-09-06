"""
Findings 4 and 5: deleting a model used to damage its neighbours' previews,
orphan its own, and could delete the models folder itself.

  server.py:781  `if fname.startswith(os.path.basename(base))` — deleting
                 flux-dev.safetensors also removed flux-dev-v2.png, and never
                 looked in the preview/ subfolder where some previews live.
  server.py:793  `if not os.listdir(model_dir): os.rmdir(model_dir)` — delete
                 the last LoRA and models/loras disappeared.

Run with:  python3 tests/test_model_files.py

The helpers are exec'd out of utils.py / server.py (both need ComfyUI to
import) and exercised against a real temporary models folder.
"""

import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
USRC = open(os.path.join(HERE, "..", "utils.py"), encoding="utf-8").read()
SSRC = open(os.path.join(HERE, "..", "server.py"), encoding="utf-8").read()

PASS = FAIL = 0


def eq(actual, expected, label):
    global PASS, FAIL
    if actual == expected:
        PASS += 1
    else:
        FAIL += 1
        print(f"  x {label}\n      expected {expected!r}\n      actual   {actual!r}")


def ok(cond, label):
    global PASS, FAIL
    if cond:
        PASS += 1
    else:
        FAIL += 1
        print(f"  x {label}")


def check(text, needle, label):
    ok(needle in text, label)


def reject(text, needle, label):
    ok(needle not in text, label)


# ── run the helpers for real ───────────────────────────────────────────
ns = {"os": os}
ustart = USRC.index("# ── Files that belong to a model")
uend = USRC.index("HASH_CACHE_REFRESH_INTERVAL = 3600")
exec(USRC[ustart:uend], ns)
preview_paths_for = ns["preview_paths_for"]
find_preview = ns["find_preview"]
sidecar_path_for = ns["sidecar_path_for"]

tmp = tempfile.mkdtemp()
LORAS = os.path.join(tmp, "loras")
os.makedirs(LORAS, exist_ok=True)
MODEL = os.path.join(LORAS, "flux-dev.safetensors")

print("preview_paths_for names exactly this model's files")
paths = preview_paths_for(MODEL)
eq(paths[0], os.path.join(LORAS, "flux-dev.png"), "the first preview is <base>.png")
ok(os.path.join(LORAS, "flux-dev_2.png") in paths, "numbered variants are included")
ok(os.path.join(LORAS, "flux-dev_20.png") in paths, "up to 20 of them")
for ext in (".png", ".jpg", ".jpeg", ".webp"):
    ok(os.path.join(LORAS, "flux-dev" + ext) in paths, f"{ext} is covered")
ok(os.path.join(LORAS, "preview", "flux-dev.png") in paths,
   "the legacy preview/ subfolder is covered too")

print("  and nothing that merely shares a prefix")
for wrong in ("flux-dev-v2.png", "flux-dev-v2.safetensors", "flux-dev-extra.jpg",
              "flux-dev_backup.png", "flux-device.png"):
    ok(os.path.join(LORAS, wrong) not in paths, f"does not claim {wrong}")
ok(not any("flux-dev-v2" in p for p in paths), "no variant of a sibling model appears")

print("find_preview")
eq(find_preview(MODEL), None, "nothing when there are no previews")
open(os.path.join(LORAS, "flux-dev.png"), "w").close()
eq(find_preview(MODEL), os.path.join(LORAS, "flux-dev.png"), "finds <base>.png")
os.remove(os.path.join(LORAS, "flux-dev.png"))
open(os.path.join(LORAS, "flux-dev.webp"), "w").close()
eq(find_preview(MODEL), os.path.join(LORAS, "flux-dev.webp"), "finds other extensions")
os.remove(os.path.join(LORAS, "flux-dev.webp"))
os.makedirs(os.path.join(LORAS, "preview"), exist_ok=True)
open(os.path.join(LORAS, "preview", "flux-dev.png"), "w").close()
eq(find_preview(MODEL), os.path.join(LORAS, "preview", "flux-dev.png"),
   "finds the preview/ subfolder copy")
os.remove(os.path.join(LORAS, "preview", "flux-dev.png"))

print("sidecar_path_for works for every extension (finding 7's bug)")
for ext in (".safetensors", ".ckpt", ".gguf", ".bin", ".pt"):
    p = "/models/loras/thing" + ext
    eq(sidecar_path_for(p), "/models/loras/thing.civitai.json",
       f"{ext} maps to the sidecar, not back onto itself")
ok(sidecar_path_for("/models/loras/a.safetensors.bak") ==
   "/models/loras/a.safetensors.civitai.json",
   "only the real extension is stripped")

print("deleting one model leaves its neighbours alone")
def touch(*names):
    for n in names:
        p = os.path.join(LORAS, n)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, "w").close()

touch("flux-dev.safetensors", "flux-dev.png", "flux-dev_2.png",
      "flux-dev.civitai.json", "preview/flux-dev.png",
      "flux-dev-v2.safetensors", "flux-dev-v2.png", "flux-dev-v2.civitai.json",
      "flux-dev-v2_2.png")

def sweep(model_path):
    """What delete-model does, using the shared helpers."""
    gone = []
    for extra in [sidecar_path_for(model_path)] + preview_paths_for(model_path):
        if os.path.isfile(extra):
            os.remove(extra)
            gone.append(os.path.basename(extra))
    return gone

gone = sweep(MODEL)
for name in ("flux-dev.png", "flux-dev_2.png", "flux-dev.civitai.json", "flux-dev.png"):
    ok(name in gone, f"{name} is removed with the model")
ok(not os.path.isfile(os.path.join(LORAS, "preview", "flux-dev.png")),
   "the preview/ subfolder copy is removed too — it used to be orphaned")

for name in ("flux-dev-v2.safetensors", "flux-dev-v2.png", "flux-dev-v2.civitai.json",
             "flux-dev-v2_2.png"):
    ok(os.path.isfile(os.path.join(LORAS, name)),
       f"{name} survives — a prefix match used to delete it")

print("the models folder itself is never removed")
sns = {"os": os, "folder_paths": type("F", (), {
    "models_dir": tmp,
    "folder_names_and_paths": {"loras": ([LORAS], {".safetensors"})},
})()}
sstart = SSRC.index("def _model_roots():")
send = SSRC.index("async def _civitai_call(")
exec(SSRC[sstart:send], sns)
is_subdir = sns["_is_subdir_of_models"]
safe_path = sns["_safe_model_path"]

ok(is_subdir(LORAS) is True, "models/loras is a subdirectory, so it may be tidied")
ok(is_subdir(os.path.join(LORAS, "subdir")) is True, "a nested folder may be tidied")
ok(is_subdir(tmp) is False, "the models root is never removed")
ok(is_subdir(os.path.join(tmp, "..")) is False, "nor anything above it")
ok(is_subdir("/tmp") is False, "nor an unrelated directory")

# a symlinked subdirectory resolves before the decision is made
deep = os.path.join(tmp, "outside")
os.makedirs(deep, exist_ok=True)
link = os.path.join(tmp, "linked")
if not os.path.lexists(link):
    os.symlink(deep, link)
ok(is_subdir(link) is True, "a link inside models/ still counts as inside")

print("the route uses the helpers")
route = SSRC[SSRC.index('@routes.post("/civitai/delete-model")'):SSRC.index("# ── Auto-Tag")]
reject(route, "startswith", "no prefix matching left in delete-model")
check(route, "utils.preview_paths_for(model_path)", "it deletes exactly this model's previews")
check(route, "utils.sidecar_path_for(model_path)", "and its sidecar")
check(route, "_is_subdir_of_models(model_dir)", "the rmdir is guarded")
check(route, 'if not os.listdir(model_dir) and _is_subdir_of_models(model_dir):',
      "and only fires for an empty subdirectory")
check(route, '"removed": removed', "it reports what it removed")

print("no code guesses a sidecar path with .replace any more")
reject(SSRC, 'replace(".safetensors"', "server.py builds sidecar paths properly")
reject(USRC, 'replace(".safetensors"', "utils.py builds sidecar paths properly")

print("local-previews lists the same set delete removes")
lp = SSRC[SSRC.index('@routes.get("/civitai/local-previews")'):SSRC.index('@routes.get("/civitai/local-metadata")')]
check(lp, "utils.preview_paths_for(path)", "one list for both jobs")
reject(lp, "for idx in range(20)", "the duplicated numbering loop is gone")
check(lp, "utils.sidecar_path_for(path)", "metadata comes from the same helper")

shutil.rmtree(tmp, ignore_errors=True)
print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
