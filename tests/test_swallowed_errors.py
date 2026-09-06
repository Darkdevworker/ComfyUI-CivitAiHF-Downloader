"""
Finding 12: 30-odd `except …: pass` blocks hid every failure, so a missing
preview looked exactly like a network error.

Every silent handler now records what it swallowed on the "CivitaiHF"
logger — at DEBUG where an exception is a normal alternative path, and at
WARNING where the user's request silently does not happen (metadata or
preview not saved).

Run with:  python3 tests/test_swallowed_errors.py

This is not a static check: it installs a capturing handler, runs the real
functions against real failures, and asserts a record comes out with the
traceback attached.
"""

import ast
import json
import logging
import os
import re
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SSRC = open(os.path.join(HERE, "..", "server.py"), encoding="utf-8").read()
USRC = open(os.path.join(HERE, "..", "utils.py"), encoding="utf-8").read()

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


class Capture(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.DEBUG)
        self.records = []

    def emit(self, record):
        self.records.append(record)


LOG = logging.getLogger("CivitaiHF")


def capture(fn, *args, **kwargs):
    """Run fn with every CivitaiHF record captured."""
    cap = Capture()
    old_level, old_prop = LOG.level, LOG.propagate
    LOG.addHandler(cap)
    LOG.setLevel(logging.DEBUG)
    LOG.propagate = False
    try:
        result = fn(*args, **kwargs)
    finally:
        LOG.removeHandler(cap)
        LOG.setLevel(old_level)
        LOG.propagate = old_prop
    return result, cap.records


print("no handler swallows an exception silently any more")
SILENT = re.compile(
    r'^[ \t]*except[^\n:]*:\n[ \t]+(?:pass|continue|return)[ \t]*(?:#.*)?$', re.M)
for name, src in (("server.py", SSRC), ("utils.py", USRC)):
    leftover = SILENT.findall(src)
    eq(leftover, [], f"{name} has no bare except/pass blocks")
    check(src, 'logger = logging.getLogger("CivitaiHF")', f"{name} has a logger")

print("  every except block that used to be silent now logs")
count = 0
for name, src in (("server.py", SSRC), ("utils.py", USRC)):
    for m in re.finditer(r'^[ \t]*except([^\n:]*):\n([ \t]+)(.*)$', src, re.M):
        body = m.group(3)
        # only a body that is *just* pass/continue/return hides the failure —
        # `return web.json_response(...)` is a handled outcome, not a swallow
        if re.match(r"^(?:pass|continue|return)[ \t]*(?:#.*)?$", body):
            count += 1
eq(count, 0, "nothing is swallowed without a trace")

print("a corrupt sidecar is reported, not hidden")
tmp = tempfile.mkdtemp()
model = os.path.join(tmp, "model.safetensors")
open(model, "w").close()
with open(os.path.join(tmp, "model.civitai.json"), "w") as f:
    f.write("{ this is not json")

ns = {"os": os, "json": json, "logging": logging}
ns["logger"] = LOG
exec(SSRC[SSRC.index("def _load_sidecar(path):"):SSRC.index("# ── Prompt Fetcher")], ns)
load_sidecar = ns["_load_sidecar"]

result, records = capture(load_sidecar, model)
eq(result, {}, "it still returns an empty dict instead of raising")
eq(len(records), 1, "exactly one record is emitted")
rec = records[0]
eq(rec.levelno, logging.WARNING, "at WARNING — the metadata the user asked for is missing")
ok(rec.exc_info is not None, "with the traceback attached")
ok(isinstance(rec.exc_info[1], ValueError), "and the real exception is the one recorded")
ok("model.civitai.json" in rec.getMessage(), f"naming the file: {rec.getMessage()}")

print("a working sidecar stays quiet and correct")
good = os.path.join(tmp, "good.safetensors")
open(good, "w").close()
with open(os.path.join(tmp, "good.civitai.json"), "w") as f:
    json.dump({"baseModel": "SDXL"}, f)
result, records = capture(load_sidecar, good)
eq(result, {"baseModel": "SDXL"}, "it loads normally")
eq(records, [], "and logs nothing")

print("a missing sidecar is not an error at all")
result, records = capture(load_sidecar, os.path.join(tmp, "nope.safetensors"))
eq(result, {}, "returns an empty dict")
eq(records, [], "without complaining")

print("a failure that degrades gracefully still says so")
# _resize_preview writes its thumbnail to a cache dir; point that at a file so
# the write fails, and check the image still comes back and the failure is logged.
src_img = os.path.join(tmp, "src.png")
try:
    from PIL import Image
    Image.new("RGB", (64, 64), (10, 20, 30)).save(src_img)
    have_pil = True
except ImportError:
    have_pil = False

if have_pil:
    broken_cache = os.path.join(tmp, "not-a-dir")
    open(broken_cache, "w").close()
    ns2 = {"os": os, "logging": logging, "_preview_cache_dir": broken_cache,
           "logger": LOG}
    exec(SSRC[SSRC.index("_PREVIEW_CACHE_MAX_FILES = 3000"):
              SSRC.index('\n@routes.get("/civitai/model-versions")')], ns2)
    resize = ns2["_resize_preview"]
    data, records = capture(resize, src_img, 32, 70)
    ok(len(data[0]) > 0, "the resized image is still returned")
    eq(data[1], "image/webp", "as WebP")
    ok(len(records) >= 1, "the failed cache write is logged")
    ok(all(r.exc_info is not None for r in records), "with the traceback attached")
    ok(all(r.levelno == logging.DEBUG for r in records),
       "at DEBUG — a cache miss is not a user-facing failure")
else:
    print("  (Pillow unavailable, skipped)")

print("the consequential sites are warnings, the routine ones are not")
for needle in ('logger.warning("could not save metadata for %s", save_path, exc_info=True)',
               'logger.warning("could not save the SHA256 sidecar for %s", save_path, exc_info=True)',
               'logger.warning("could not read the metadata sidecar %s", json_path, exc_info=True)',
               'logger.warning("could not download a preview during auto-tag", exc_info=True)'):
    check(SSRC, needle, f"warning: {needle[:56]}...")
check(USRC, 'logger.warning("could not read the metadata sidecar %s", json_path, exc_info=True)',
      "utils warning for the same failure")
check(SSRC, 'logger.debug("could not enrich metadata with the model description", exc_info=True)',
      "a missing description is only debug — the metadata is still written")

print("both modules still parse and the logger name is stable")
ast.parse(SSRC)
ast.parse(USRC)
ok(True, "server.py and utils.py parse")
eq(SSRC.count('logging.getLogger("CivitaiHF")'), 1, "server.py defines the logger once")
eq(USRC.count('logging.getLogger("CivitaiHF")'), 1, "utils.py defines the logger once")

shutil.rmtree(tmp, ignore_errors=True)
print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
