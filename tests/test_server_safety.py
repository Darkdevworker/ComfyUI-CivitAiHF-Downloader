"""
Server safety: path containment and keeping blocking I/O off the event loop.

Run with:  python3 tests/test_server_safety.py

Two of the high-severity findings from CODE_REVIEW.md:
  1. /civitai/local-preview served any file, and /civitai/delete-model and
     /civitai/cleanup-delete removed any path — nothing checked that a
     request stayed inside the models directories.
  2. Ten async handlers did synchronous work (including SHA-256 over multi-GB
     checkpoints) directly on ComfyUI's single-threaded event loop.

server.py needs ComfyUI to import, so _model_roots/_safe_model_path/_read_json
are exec'd out of the source against a stubbed folder_paths.
"""

import json
import os
import re
import shutil
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
    eq(bool(cond), True, label)


# ── run the helpers for real ───────────────────────────────────────────
tmp = tempfile.mkdtemp()
MODELS = os.path.join(tmp, "models")
LORAS = os.path.join(MODELS, "loras")
os.makedirs(LORAS, exist_ok=True)
with open(os.path.join(LORAS, "real.safetensors"), "w") as f:
    f.write("weights")


class StubFolderPaths:
    models_dir = MODELS
    folder_names_and_paths = {
        "checkpoints": ([os.path.join(MODELS, "checkpoints")], {".safetensors"}),
        "loras": ([LORAS], {".safetensors"}),
    }

    @staticmethod
    def get_full_path(kind, name):
        return os.path.join(MODELS, kind, name)


ns = {"os": os, "json": json, "folder_paths": StubFolderPaths}
start = SRC.index("def _model_roots():")
end = SRC.index("async def _civitai_call(")
exec(SRC[start:end], ns)
safe_path = ns["_safe_model_path"]
read_json = ns["_read_json"]
roots = ns["_model_roots"]()

print("roots discovered")
ok(MODELS in roots, "the models dir is a root")
ok(LORAS in roots, "registered subfolders are roots too")

print("paths inside the models dir are allowed")
ok(safe_path("loras/real.safetensors")[0], "a relative path is resolved and allowed")
eq(safe_path("loras/real.safetensors")[1], os.path.join(LORAS, "real.safetensors"),
   "the relative path resolves to the real file")
ok(safe_path(os.path.join(LORAS, "real.safetensors"))[0], "an absolute path inside is allowed")
ok(safe_path(os.path.join(MODELS, "new-model.safetensors"), must_exist=False)[0],
   "a not-yet-created download target is allowed")
eq(safe_path(os.path.join(LORAS, "missing.safetensors"))[0], False,
   "a missing file is refused by default")
eq(safe_path(os.path.join(LORAS, "missing.safetensors"))[1], "File not found",
   "and says why")

print("paths outside are refused")
for bad in ["/etc/passwd", "/tmp/outside.safetensors", "../outside.safetensors",
            "loras/../../outside.safetensors", "C:\\Windows\\win.ini", "", None, "bad\x00path"]:
    ok(safe_path(bad)[0] is False, "refused: %r" % (bad,))

# a sibling directory whose name starts with the root's name must not pass
sibling = MODELS + "_evil"
os.makedirs(sibling, exist_ok=True)
ok(safe_path(os.path.join(sibling, "x.safetensors"))[0] is False,
   "a sibling dir sharing the root's prefix is refused")

print("symlinks are followed before the check")
inside_link = os.path.join(LORAS, "link.safetensors")
outside_target = os.path.join(tmp, "outside.safetensors")
with open(outside_target, "w") as f:
    f.write("x")
if not os.path.lexists(inside_link):
    os.symlink(outside_target, inside_link)
ok(safe_path(inside_link)[0] is False, "a link inside models/ pointing outside is refused")
ok(safe_path(inside_link)[1] == "Path is outside the ComfyUI models directories",
   "with the containment message")

print("_read_json")
jpath = os.path.join(LORAS, "meta.json")
with open(jpath, "w") as f:
    json.dump({"id": 42}, f)
eq(read_json(jpath), {"id": 42}, "reads a valid file")
eq(read_json(os.path.join(LORAS, "nope.json")), None, "returns None when missing")
bad_json = os.path.join(LORAS, "bad.json")
with open(bad_json, "w") as f:
    f.write("{not json")
eq(read_json(bad_json), None, "returns None on corrupt json")

print("every file-touching route uses the helper")
for route in ["/civitai/local-preview", "/civitai/local-metadata", "/civitai/local-previews",
              "/civitai/delete-model", "/civitai/cleanup-delete", "/civitai/model-info"]:
    at = SRC.index('"%s"' % route)
    body = SRC[at:SRC.index("\n@routes.", at)] if "\n@routes." in SRC[at:] else SRC[at:]
    ok("_safe_model_path" in body, "%s checks the path" % route)

del_body = SRC[SRC.index('async def cleanup_delete('):SRC.index('async def auto_organize(')]
ok("denied" in del_body, "cleanup-delete reports what it refused")
ok("os.remove(resolved)" in del_body, "cleanup-delete only removes resolved paths")

print("no blocking work left on the event loop")
BLOCKING = ["_request_with_retry(", "calculate_sha256(", "get_model_version_info_by_id(",
            "get_model_version_info_by_hash(", "get_model_info_by_id(", "parse_civitai_input(",
            "shutil.", "scan_local_models_direct(", "requests.get(", "urlopen(", "time.sleep("]
marks = [(m.start(), m.group(1)) for m in re.finditer(r"(?m)^async def (\w+)\(", SRC)]
marks.append((len(SRC), None))
offenders = []
for i in range(len(marks) - 1):
    at, name = marks[i]
    body = SRC[at:marks[i + 1][0]]
    offloaded = "run_in_executor" in body or "_civitai_call" in body
    for symbol in BLOCKING:
        if symbol in body and not offloaded:
            ln = SRC[:at].count("\n") + 1 + body[:body.index(symbol)].count("\n")
            offenders.append("%s() line %d: %s" % (name, ln, symbol))
ok(not offenders, "no async handler blocks the loop" + ("" if not offenders else " -> " + "; ".join(offenders)))

print("the helpers themselves are sound")
ok("async def _civitai_call(" in SRC, "_civitai_call exists")
ok("def _safe_model_path(" in SRC, "_safe_model_path exists")
ok("_safe_model_path" in SRC[SRC.index('async def model_info('):SRC.index("print(", SRC.index('async def model_info('))],
   "model_info (the worst offender) checks its path")

shutil.rmtree(tmp, ignore_errors=True)
print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
