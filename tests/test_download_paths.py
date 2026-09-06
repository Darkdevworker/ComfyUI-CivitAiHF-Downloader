"""
Finding 6: both download routes built their destination with a bare
`os.path.join`, so a user-typed `subfolder` or `filename` could write
outside the models directory:

    save_dir  = os.path.join(models_dir, type_dir, subfolder)
    save_path = os.path.join(save_dir, filename)     # "../../x" walks out

The same hole existed twice more — the download route trusted the filename
in the remote server's Content-Disposition header, and auto-organize built
directories straight out of API text (creator, base model).

Run with:  python3 tests/test_download_paths.py

The helpers are exec'd out of server.py (it needs ComfyUI to import) against
a stubbed folder_paths.
"""

import logging
import os
import re
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "..", "server.py"), encoding="utf-8").read()

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
tmp = tempfile.mkdtemp()
MODELS = os.path.join(tmp, "models")
LORAS = os.path.join(MODELS, "loras")
os.makedirs(LORAS, exist_ok=True)
OUTSIDE = os.path.join(tmp, "outside")
os.makedirs(OUTSIDE, exist_ok=True)


class StubFolderPaths:
    models_dir = MODELS
    folder_names_and_paths = {"loras": ([LORAS], {".safetensors"})}


ns = {"os": os, "re": re, "logging": logging, "folder_paths": StubFolderPaths}
exec(SRC[SRC.index("def _model_roots():"):SRC.index("async def _civitai_call(")], ns)
safe_download_path = ns["_safe_download_path"]
safe_name = ns["_safe_name"]


def refused(*parts):
    ok(safe_download_path(*parts)[0] is False, f"refused: {parts}")


def allowed(*parts):
    good, path = safe_download_path(*parts)
    ok(good is True, f"allowed: {parts} ({path if not good else ''})")
    return path


print("a normal destination still works")
p = allowed("loras", "myfolder", "model.safetensors")
eq(p, os.path.join(LORAS, "myfolder", "model.safetensors"), "folder + subfolder + filename")
eq(safe_download_path("loras", "", "model.safetensors")[1],
   os.path.join(LORAS, "model.safetensors"), "an empty subfolder is just skipped")
eq(safe_download_path("loras", None, "m.safetensors")[1],
   os.path.join(LORAS, "m.safetensors"), "a missing subfolder is skipped too")
p = allowed("loras", "a/b/c", "m.safetensors")
eq(p, os.path.join(LORAS, "a", "b", "c", "m.safetensors"), "nested subfolders are fine")

print("traversal through subfolder is refused")
refused("loras", "..", "m.safetensors")
refused("loras", "../../evil", "m.safetensors")
refused("loras", "a/../../evil", "m.safetensors")
refused("loras", "..\\..\\evil", "m.safetensors")
refused("loras", "/abs/path", "m.safetensors")
refused("loras", "C:\\windows", "m.safetensors")

print("traversal through filename is refused")
refused("loras", "", "../../evil.safetensors")
refused("loras", "sub", "../../evil.safetensors")
refused("loras", "", "/etc/passwd")
refused("loras", "", "..\\..\\evil.safetensors")
refused("loras", "", "a/../../evil.safetensors")
refused("loras", "", "C:\\windows\\system32\\evil.dll")

print("traversal through the destination folder is refused too")
refused("../../evil", "", "m.safetensors")
refused("/abs", "", "m.safetensors")

print("hostile inputs are refused, not merely sanitised")
ok(safe_download_path("loras", "sub", "bad\x00name.safetensors")[0] is False, "a NUL byte")
ok(safe_download_path()[0] is False, "no parts at all")
ok(safe_download_path("")[0] is False, "an empty part list")

print("and the refusal is explained")
msg = safe_download_path("loras", "../../evil", "m.safetensors")[1]
ok("models directory" in msg, f"the error says why: {msg!r}")

print("a symlinked subfolder cannot be used to escape")
link = os.path.join(MODELS, "linked")
if not os.path.lexists(link):
    os.symlink(OUTSIDE, link)
refused("linked", "", "m.safetensors")

print("_safe_name reduces hostile text to one component")
eq(safe_name("正常 name"), "正常 name", "ordinary text is untouched")
eq(safe_name("dir/sub/file.bin"), "file.bin", "directory parts are dropped")
eq(safe_name("..\\..\\evil"), "evil", "backslashes are treated as separators")
eq(safe_name(".."), "", "`..` becomes nothing")
eq(safe_name("."), "", "`..` and `.` are rejected outright")
eq(safe_name(""), "", "empty stays empty")
eq(safe_name(None), "", "None is safe")
eq(safe_name("../../evil", "fallback"), "evil", "the last component survives")
eq(safe_name("a\x00b"), "ab", "control characters are removed")
eq(safe_name("  spaced  "), "spaced", "surrounding whitespace is trimmed")
eq(safe_name("model:v2*"), "modelv2", "characters illegal on Windows are removed")

print("the Civitai download route builds its path through the helper")
civ = SRC[SRC.index('@routes.post("/civitai/download")'):SRC.index("async def _save_metadata_and_preview(")]
check(civ, "_safe_download_path(model_type, subfolder, filename)", "one containment check")
check(civ, 'return web.json_response({"error": save_path}, status=400)', "and a 400 when it fails")
reject(civ, "os.path.join(models_dir, type_dir, subfolder)", "the bare join is gone")
reject(civ, "os.path.join(save_dir, filename)", "so is the unchecked filename join")
check(civ, "real_name = _safe_name(real_name)", "Content-Disposition is sanitised")
check(civ, "_safe_download_path(\n                                model_type, subfolder, real_name)",
      "and the remote filename is re-checked")

print("the Hugging Face route does the same")
hf = SRC[SRC.index('@routes.post("/civitai/hf/download")'):SRC.index("def _hf_dl_blocking(")]
check(hf, "_safe_download_path(", "it uses the helper")
check(hf, "filename = _safe_name(path.split(\"/\")[-1])", "the repo path is reduced to a name")
reject(hf, "os.path.join(dest_dir, subfolder)", "no bare subfolder join")
reject(hf, "dest = os.path.join(dest_dir, filename)", "no bare filename join")

print("auto-organize no longer trusts API text for folder names")
ao = SRC[SRC.index('@routes.post("/civitai/auto-organize")'):SRC.index("# ── HF Browse")]
check(ao, "_safe_name(cat)", "the model type is sanitised")
check(ao, "_safe_name(creator)", "so is the creator name")
check(ao, "_safe_name(base_model_info)", "and the base model")

import shutil
shutil.rmtree(tmp, ignore_errors=True)
print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
