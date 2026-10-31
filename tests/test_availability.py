"""
Can this model be downloaded, and what happens when Civitai says no.

Run with:  python3 tests/test_availability.py

_dl_status / _verdict_for_model / _annotate_availability / _civitai_has_key
/_civitai_refusal / _download_candidates are exec'd out of server.py and
driven directly. The shapes come from the live API: a Buzz-locked model
really does answer 403 with {"error": "Early Access", "message": "This asset
is in Early Access. You can use Buzz access it now!"}.
"""

import os
import sys
import types

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


def check(text, needle, label):
    ok(needle in text, f"{label} — not found: {needle!r}")


def slice_fn(name):
    """The smallest slice starting at `def name(`, up to the next top-level def."""
    for prefix in ("def %s(" % name, "async def %s(" % name):
        i = SRC.find(prefix)
        if i >= 0:
            break
    else:
        raise AssertionError("no such function: " + name)
    j = SRC.find("\ndef ", i + 1)
    k = SRC.find("\nasync def ", i + 1)
    ends = [x for x in (j, k) if x > 0]
    return SRC[i:min(ends)] if ends else SRC[i:]


import logging  # noqa: E402

utils_stub = types.SimpleNamespace()
utils_stub.db_manager = types.SimpleNamespace(
    get_setting=lambda k, d=None: "civitai_testkey" if k == "civitai_api_key" else d)
utils_stub._get_active_domain = staticmethod(lambda: "civitai.com")

ns = {
    "utils": utils_stub, "logger": logging.getLogger("CivitaiHF"),
    "urllib": __import__("urllib", fromlist=["parse"]),
    "json": __import__("json"), "os": os, "re": __import__("re"),
}
for name in ("_dl_status", "_verdict_for_model", "_annotate_availability",
             "_civitai_has_key", "_civitai_refusal", "_download_candidates"):
    exec(compile(slice_fn(name), "server.py", "exec"), ns)

dl_status = ns["_dl_status"]
verdict_for_model = ns["_verdict_for_model"]
annotate = ns["_annotate_availability"]
has_key = ns["_civitai_has_key"]
refusal = ns["_civitai_refusal"]
candidates = ns["_download_candidates"]

# ── the verdict ────────────────────────────────────────────────────────
print("an ordinary model is green")
v = {"id": 1, "files": [{"name": "m.safetensors", "downloadUrl": "https://x/1", "primary": True}]}
m = {"id": 10, "name": "Fine", "availability": "Public", "modelVersions": [v]}
eq(dl_status(m, v, v["files"][0])["level"], "green", "a public file is ready to download")
eq(dl_status(m, v, v["files"][0])["reason"], "Ready to download.", "with a reason to show")

print("Buzz-locked models are yellow, not red")
# This is what Civitai actually returns for an Early Access version.
locked = {"id": 2, "availability": "Public",
          "paidAccess": {"permanent": True, "endsAt": None},
          "files": [{"name": "m.safetensors", "downloadUrl": "https://x/2", "primary": True}]}
m2 = {"id": 20, "name": "Locked", "availability": "Public", "modelVersions": [locked]}
eq(dl_status(m2, locked, locked["files"][0])["level"], "yellow",
   "paidAccess on the version means it can be unlocked")
ok("Buzz" in dl_status(m2, locked, locked["files"][0])["reason"],
   "and the reason says what unlocks it")

m3 = {"id": 30, "name": "Paid", "hasActivePaidAccess": True,
      "modelVersions": [{"id": 3, "files": [{"downloadUrl": "https://x/3"}]}]}
eq(dl_status(m3, m3["modelVersions"][0], m3["modelVersions"][0]["files"][0])["level"],
   "yellow", "a paid-access model is yellow even without the version flag")

eq(dl_status({"availability": "EarlyAccess"},
             {"availability": "EarlyAccess", "files": [{"downloadUrl": "https://x"}]},
             {"downloadUrl": "https://x"})["level"],
   "yellow", "an EarlyAccess availability is yellow too")

print("a model with nothing to fetch is red")
eq(dl_status({"id": 40}, {}, {})["level"], "red", "no version and no file at all")
ok("no downloadable version" in dl_status({"id": 40}, {}, {})["reason"],
   "and says so")
eq(dl_status({"id": 41}, {"id": 5, "files": []}, {})["level"], "red",
   "a version with an empty file list")
eq(dl_status({"id": 42, "mode": "TakenDown"},
             {"id": 6, "files": [{"downloadUrl": "https://x"}]},
             {"downloadUrl": "https://x"})["level"], "red",
   "a taken-down model cannot be downloaded at all")
eq(dl_status({"id": 43, "availability": "Unavailable"},
             {"id": 7, "files": [{"downloadUrl": "https://x"}]},
             {"downloadUrl": "https://x"})["level"], "red", "neither can an unavailable one")
eq(dl_status({"id": 44}, {"id": 8, "files": [{"name": "m.bin"}]}, {"name": "m.bin"})["level"],
   "red", "a file Civitai gives no link for")

print("red outranks yellow — a taken-down model is not 'unlockable'")
eq(dl_status({"id": 45, "mode": "TakenDown"},
             {"id": 9, "paidAccess": {"permanent": True},
              "files": [{"downloadUrl": "https://x"}]},
             {"downloadUrl": "https://x"})["level"], "red", "removal wins over Buzz")

print("needing a login is yellow when there is no key, green with one")
poi = {"id": 50, "poi": True, "modelVersions": [
    {"id": 11, "files": [{"downloadUrl": "https://x", "primary": True}]}]}
eq(dl_status(poi, poi["modelVersions"][0], poi["modelVersions"][0]["files"][0],
             has_key=False)["level"], "yellow", "no key means it cannot be proven")
eq(dl_status(poi, poi["modelVersions"][0], poi["modelVersions"][0]["files"][0],
             has_key=True)["level"], "green", "with a key it is fetchable")

print("the verdict works off a whole search result")
eq(verdict_for_model(m)["level"], "green", "the newest version decides")
eq(verdict_for_model(m2)["level"], "yellow", "so a locked model is flagged from the card")
eq(verdict_for_model({"id": 60})["level"], "red", "and one with no versions is red")

print("annotating a page never loses a model")
page = [m, m2, {"id": 70}, "not a dict", None]
out = annotate(page)
eq(len(out), 5, "every entry survives, whatever it is")
eq(out[0]["dl_status"]["level"], "green", "the good one is green")
eq(out[1]["dl_status"]["level"], "yellow", "the locked one is yellow")
eq(out[2]["dl_status"]["level"], "red", "the empty one is red")
ok("dl_status" not in ("not a dict", None), "and junk is left alone")

print("a settings backend that will not answer cannot break a page")
broken = types.SimpleNamespace(
    db_manager=types.SimpleNamespace(
        get_setting=lambda k, d=None: (_ for _ in ()).throw(RuntimeError("no db"))))
ns2 = dict(ns)
ns2["utils"] = broken
exec(compile(slice_fn("_civitai_has_key"), "server.py", "exec"), ns2)
eq(ns2["_civitai_has_key"](), False, "a failing lookup reads as 'no key'")
eq(has_key(), True, "a working one reads the key")

# ── reading Civitai's refusals ─────────────────────────────────────────
print("Civitai's refusals are read, not just counted")
early = b'{"error":"Early Access","message":"This asset is in Early Access. You can use Buzz access it now!"}'
msg = refusal(403, early)
ok("Early Access" in msg, "a 403 names the problem")
ok("Buzz" in msg, "and says Buzz is what unlocks it")
login = b'{"error":"Unauthorized","message":"The creator of this asset requires you to be logged in to download it"}'
msg = refusal(401, login)
ok("logged in" in msg, "a 401 says a login is needed")
ok("HTTP" not in msg, "rather than just a number")
eq(refusal(404, b"nope"), "Civitai has no file at that address.", "a 404 is plain")
ok("rate" in refusal(429, b"").lower(), "and a 429 asks for patience")
eq(refusal(400, b""), "Civitai returned HTTP 400 for this download.",
   "an unexplained code still says which one")
eq(refusal(500, b"not json at all"), "Civitai returned HTTP 500 for this download.",
   "a body that is not JSON falls back cleanly")
eq(refusal(400, None), "Civitai returned HTTP 400 for this download.", "so does no body")

# ── the fallback chain ─────────────────────────────────────────────────
print("one file, several addresses, most specific first")
c = candidates("https://civitai.com/api/download/models/9?fileId=77", 9,
               {"metadata": {"type": "Model", "format": "SafeTensor"}}, "civitai.com")
eq(len(c), 3, "the file link, the version link and the type/format link")
eq(c[0][1], "https://civitai.com/api/download/models/9?fileId=77",
   "the file's own link is tried first, so the chosen variant is what lands")
eq(c[1][1], "https://civitai.com/api/download/models/9", "then the plain version link")
ok("type=Model&format=SafeTensor" in c[2][1], "then the type/format form")

c = candidates("https://x/1", 9, None, "civitai.com")
eq(len(c), 2, "without file metadata there is no third address")

c = candidates("https://civitai.com/api/download/models/9", 9, None, "civitai.com")
eq(len(c), 1, "the same URL is not offered twice")
eq(c[0][1], "https://civitai.com/api/download/models/9", "it is de-duplicated")

c = candidates("", 0, None, "civitai.com")
eq(c, [], "with nothing to go on there are no addresses at all")

eq(candidates("https://x/1", 9, {"metadata": {"type": "VAE", "format": "SafeTensor"}},
             "civitai.red")[1][1],
   "https://civitai.red/api/download/models/9", "and the mirror domain is honoured")

# ── the wiring ─────────────────────────────────────────────────────────
print("all of it is wired in")
dl = SRC[SRC.index('@routes.post("/civitai/download")'):SRC.index("async def _save_metadata_and_preview(")]
check(dl, "_download_candidates(", "the download builds a list of addresses")
check(dl, "for label, url in candidates:", "and tries each one in turn")
check(dl, "if e.code in (401, 403):", "a refusal of the model stops the search")
check(dl, 'raise RuntimeError(refusal)', "with Civitai's own explanation")
check(dl, 'DOWNLOAD_TASKS[task_id]["strategy"] = used', "the one that worked is recorded")
check(dl, "raise RuntimeError(\n                    last_error or", "and failure reports the last attempt")
check(dl, "finally:", "the response is always closed")

search = SRC[SRC.index("# ── Civitai Search / Browse"):SRC.index('@routes.get("/civitai/lookup")')]
check(search, "_annotate_availability(", "a page of results is annotated")
check(search, "_civitai_has_key()", "using whether a key is set")

vers = SRC[SRC.index('@routes.get("/civitai/model-versions")'):SRC.index('@routes.get("/civitai/model-version-detail")')]
check(vers, 'v["dl_status"] = _dl_status(', "each version in the detail list is classified")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
