"""
Finding 8: `preserve_subfolders` was sent by the Hugging Face detail view
("Keep subfolders") and read by nobody on the server, so the checkbox did
nothing. It now keeps the repo's own directory layout:

    unet/diffusion_pytorch_model.safetensors
      -> <models>/loras/unet/diffusion_pytorch_model.safetensors   (checked)
      -> <models>/loras/diffusion_pytorch_model.safetensors        (unchecked)

Run with:  python3 tests/test_hf_subfolders.py

The rel_dir expression is exec'd out of server.py rather than restated here,
so the test exercises the shipped code.
"""

import logging
import os
import re
import shutil
import sys
import tempfile
import textwrap

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "..", "server.py"), encoding="utf-8").read()
JS = open(os.path.join(HERE, "..", "js", "civitai.js"), encoding="utf-8").read()

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


# ── run the shipped expression ─────────────────────────────────────────
tmp = tempfile.mkdtemp()
MODELS = os.path.join(tmp, "models")
LORAS = os.path.join(MODELS, "loras")
os.makedirs(LORAS, exist_ok=True)


class StubFolderPaths:
    models_dir = MODELS
    folder_names_and_paths = {"loras": ([LORAS], {".safetensors"})}


ns = {"os": os, "re": re, "logging": logging, "folder_paths": StubFolderPaths}
exec(SRC[SRC.index("def _model_roots():"):SRC.index("async def _civitai_call(")], ns)
safe_download_path = ns["_safe_download_path"]
safe_name = ns["_safe_name"]

# the exact lines the route runs
EXPR = textwrap.dedent(
    SRC[SRC.index('        rel_dir = ""'):SRC.index("        ok, dest = _safe_download_path(")])
ok(EXPR.startswith('rel_dir = ""'), "the rel_dir block was found in the route")
check(EXPR, "if preserve_subfolders:", "and is gated on the flag")


def destination(repo_path, preserve, subfolder=""):
    """What /civitai/hf/download computes, using the real code."""
    scope = {"os": os, "re": re, "_safe_name": safe_name,
             "path": repo_path, "preserve_subfolders": preserve}
    exec(EXPR, scope)
    return safe_download_path("loras", subfolder, scope["rel_dir"],
                              safe_name(repo_path.split("/")[-1]) or "model.safetensors")


print("the repo layout is kept only when asked")
good, path = destination("unet/diffusion_pytorch_model.safetensors", True)
ok(good, "a nested repo file is accepted")
eq(path, os.path.join(LORAS, "unet", "diffusion_pytorch_model.safetensors"),
   "checked: unet/ is recreated under the destination")

good, path = destination("unet/diffusion_pytorch_model.safetensors", False)
eq(path, os.path.join(LORAS, "diffusion_pytorch_model.safetensors"),
   "unchecked: the file is flattened, as before")

print("  and it nests as deeply as the repo does")
good, path = destination("text_encoder/encoder/config.json", True)
eq(path, os.path.join(LORAS, "text_encoder", "encoder", "config.json"),
   "a three-level repo path is reproduced")
good, path = destination("model.safetensors", True)
eq(path, os.path.join(LORAS, "model.safetensors"),
   "a file at the repo root is unaffected by the flag")

print("  the user's own subfolder still applies")
good, path = destination("unet/model.safetensors", True, "my-lora")
eq(path, os.path.join(LORAS, "my-lora", "unet", "model.safetensors"),
   "the repo layout nests inside the chosen subfolder")

print("a hostile repo path cannot climb out")
for hostile in ("../../etc/passwd", "..\\..\\evil.bin", "/etc/passwd", "a/../../../x.bin"):
    good, path = destination(hostile, True)
    ok(good, f"{hostile!r} still resolves to somewhere allowed")
    ok(os.path.normcase(os.path.realpath(os.path.dirname(path)))
       .startswith(os.path.normcase(os.path.realpath(MODELS)) + os.sep),
       f"{hostile!r} stays inside the models directory")

print("the route reads the flag and remembers it")
hf = SRC[SRC.index('@routes.post("/civitai/hf/download")'):SRC.index("def _hf_dl_blocking(")]
check(hf, 'preserve_subfolders = bool(body.get("preserve_subfolders", False))',
      "the route reads it")
check(hf, "if preserve_subfolders:", "and only changes behaviour when it is set")
check(hf, '"preserve_subfolders": preserve_subfolders,', "a retry keeps the same layout")
check(hf, "subfolder, rel_dir, filename)", "the repo directory is part of the destination")

print("the checkbox is wired up in the UI")
check(JS, "preserve_subfolders: subfolderLbl.querySelector(\"input\").checked,",
      "the HF detail view sends it")
check(JS, '" Keep subfolders"', "and is labelled so it is discoverable")

shutil.rmtree(tmp, ignore_errors=True)
print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
