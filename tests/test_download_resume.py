#!/usr/bin/env python3
"""Resume must not poison the fallback addresses.

Run with:  python3 tests/test_download_resume.py

How this was found: a download of "V5.1 Hyper (VAE).safetensors" (Civitai
model 4201, version 501240) failed with

    the file's own link (HTTP 400): Civitai returned HTTP 400 for this download.

and only that one address was named. `req_headers["Range"]` was set once
before the candidate loop, so when the first address refused, every
fallback inherited the Range — and a Range Civitai rejects is answered 400
with an XML body carrying no JSON message, which is exactly why the row had
no detail. 416 (a stale resume marker) was never handled either, so one bad
marker made a model permanently undownloadable.

The candidate loop is lifted out of server.py and run for real, against a
fake `_open` that answers however the test asks.
"""

import json
import os
import re
import sys
import tempfile
import textwrap
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = open(os.path.join(HERE, "..", "server.py"), encoding="utf-8").read()

PASS = FAIL = 0


def check(cond, label):
    """Assert on a boolean, the way a reader would say it."""
    global PASS, FAIL
    if cond:
        PASS += 1
    else:
        FAIL += 1
        print("  x " + label)


def load_block():
    """Pull the candidate loop out of _download_blocking."""
    start = SRC.index("            candidates = _download_candidates(")
    end = SRC.index("\n", SRC.index("            resume_from = skip"))
    lines = SRC[start:end].split("\n")
    # The loop builds its own candidate list; the test supplies one instead,
    # so drop that call rather than stubbing _download_candidates.
    assert lines[0].strip().startswith("candidates = _download_candidates("), lines[0]
    assert lines[1].strip().startswith("download_url,"), lines[1]
    lines = lines[2:]
    # It sits three levels deep inside start_download. dedent finds the real
    # common margin, then everything is pushed back in to sit under _loop.
    body = textwrap.dedent("\n".join(lines))
    return "\n".join(("    " + line) if line.strip() else line
                     for line in body.split("\n"))


BLOCK = load_block()
check("the candidate loop was found", "candidates = _download_candidates(" in BLOCK)
check("it ends by adopting the skip that worked",
      BLOCK.rstrip().endswith("resume_from = skip"))


class FakeResp:
    def __init__(self, status=200, headers=None):
        self.status = status
        self.headers = headers or {}
        self.closed = False

    def close(self):
        self.closed = True


class FakeOpener:
    """Answers each address however the test wants, and records what it saw."""

    def __init__(self, behaviour):
        self.behaviour = behaviour          # url -> status | Exception
        self.calls = []                     # (url, headers)

    def __call__(self, url, headers):
        self.calls.append((url, headers))
        result = self.behaviour(url, headers)
        if isinstance(result, Exception):
            raise result
        return FakeResp(result, {"Content-Length": "1000"})


def run(behaviour, resume_from=0, part=None, candidates=None):
    """Run the real loop. Returns (resp, used, resume_from, failures)."""
    opener = FakeOpener(behaviour)
    ns = {
        "urllib": urllib,
        "logger": __import__("logging").getLogger("t"),
        "_open": opener,
        "_civitai_refusal": lambda code, body: "refused %d" % code,
        "_remove_part": lambda p: (os.remove(p) if os.path.exists(p) else None),
        "candidates": candidates or [
            ("the file's own link", "https://civitai.com/a?fileId=1"),
            ("the version link", "https://civitai.com/a"),
        ],
        "req_headers": {"User-Agent": "Mozilla/5.0"},
        "resume_from": resume_from,
        "part": part,
        "part_path": os.path.join(tempfile.mkdtemp(), "x.part.json"),
        "save_path": os.path.join(tempfile.mkdtemp(), "f.safetensors"),
        "task_id": "t1",
        "DOWNLOAD_TASKS": {},
    }
    # The loop's nested _abandon_resume() says `nonlocal skip, part`, so
    # those have to be real locals of the function it is compiled into.
    params = ("candidates req_headers resume_from part part_path save_path "
              "task_id DOWNLOAD_TASKS urllib _open _civitai_refusal "
              "_remove_part logger")
    fn = ("def _loop(%s):\n" % params.replace(" ", ", ")
          + BLOCK
          + "\n    return resp, used, resume_from, failures\n")
    exec(compile(fn, "<loop>", "exec"), ns)
    got = ns["_loop"](*[ns[k] for k in params.split()])
    return got, opener


print("a plain download works and takes the first address")
(result, opener), _ = run(lambda u, h: 200), None
resp, used, resume_from, failures = result
check("the first address was used", used == "the file's own link")
check("nothing failed", failures == [])
check("no Range was sent", "Range" not in opener.calls[0][1])

print("resume sends Range, and only to the address that is asked")
def ok206(u, h):
    return 206 if "Range" in h else 200
(result, opener), _ = run(ok206, resume_from=500), None
resp, used, resume_from, failures = result
check("Range was sent", opener.calls[0][1].get("Range") == "bytes=500-")
check("resume_from survives a 206", resume_from == 500)
check("no failures", failures == [])

print("when the remote ignores Range, the same address is re-asked cleanly")
(result, opener), _ = run(lambda u, h: 200, resume_from=500), None
resp, used, resume_from, failures = result
check("it was asked twice", len(opener.calls) == 2)
check("the first try carried Range", "Range" in opener.calls[0][1])
check("the retry did not", "Range" not in opener.calls[1][1])
check("and it fell back to zero", resume_from == 0)

print("a stale resume marker (416) is dropped, not fatal")
def then_416(u, h):
    if "Range" in h:
        return urllib.error.HTTPError(u, 416, "range", {}, None)
    return 200
(result, opener), _ = run(then_416, resume_from=500), None
resp, used, resume_from, failures = result
check("the download succeeded anyway", resp is not None)
check("it restarted from zero", resume_from == 0)
check("416 was not left as the failure", failures == [])

print("a Range that the remote rejects with 400 does not reach the next address")
seen = []
def then_400(u, h):
    seen.append(dict(h))            # copy: the dict is reused by the loop
    if "Range" in h:
        return urllib.error.HTTPError(u, 400, "bad request", {}, None)
    return 200
(result, opener), _ = run(then_400, resume_from=500), None
resp, used, resume_from, failures = result
check("every address got a clean look", resp is not None)
check("only the first ever carried a Range",
      [("Range" in h) for h in seen] == [True, False])
check("the fallback address succeeded", used == "the version link")
check("and it started from zero", resume_from == 0)

print("failures from every address are reported, not just the last")
def all_404(u, h):
    return urllib.error.HTTPError(u, 404, "nope", {}, None)
try:
    run(all_404)
    check("all-failed raises", False)
except RuntimeError as e:
    msg = str(e)
    check("both addresses are named", "file's own link" in msg and "version link" in msg)
    check("the code is shown", "404" in msg)

print("401 and 403 still short-circuit — no other URL will change the answer")
def refused(u, h):
    return urllib.error.HTTPError(u, 401, "no", {}, None)
calls = []
try:
    (result, opener), _ = run(refused), None
    check("401 raises", False)
except RuntimeError as e:
    check("401 raises straight away", "401" in str(e))
    opener = FakeOpener(refused)
    # Re-run just to count how far it got before raising.
    try:
        run(refused)
    except RuntimeError:
        pass
check("it stops at the first address rather than trying them all",
      len(opener.calls) == 1)

print("the version id is recovered from the URL when it was not sent")
# One address for a file is one chance; three is three. A retry or a
# re-download from history can carry only the URL, and the id is right there
# in the path Civitai hands out.
recover = SRC[SRC.index("        # The version id is the difference"):SRC.index(
    "        if model_version_id and str(model_version_id).strip() and not download_url:")]
check("it looks for /api/download/models/<id>",
      "/api/download/models/(\\d+)" in recover)
check("and only when the id was not sent",
      "if not model_version_id and download_url:" in recover)
ns = {"re": re, "download_url": "https://civitai.com/api/download/models/501240?fileId=418901",
      "model_version_id": 0}
exec(compile("import re\n" + textwrap.dedent(recover), "<r>", "exec"), ns)
check("it is recovered", ns["model_version_id"] == 501240)
ns2 = {"re": re, "download_url": "https://civitai.com/api/download/models/501240?fileId=418901",
       "model_version_id": 501240}
exec(compile("import re\n" + textwrap.dedent(recover), "<r>", "exec"), ns2)
check("an id that was sent is left alone", ns2["model_version_id"] == 501240)

print("the marker helpers agree")
check("_remove_part exists", "def _remove_part(" in SRC)
check("_write_part is its pair", "def _write_part(" in SRC)
check("the loop calls _remove_part when abandoning a resume",
      "_remove_part(part_path)" in BLOCK)

print("\n%d passed, %d failed" % (PASS, FAIL))
sys.exit(1 if FAIL else 0)
