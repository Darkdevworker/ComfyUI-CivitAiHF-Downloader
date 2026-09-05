"""
Civitai downloads that require a login — run with:  python3 tests/test_download_auth.py

Some models (e.g. "Phr00t/Qwen-Image-Edit-Rapid-AIO (NSFW)", version 3161121)
answer /api/download/models/<id> with 401 and
  {"error":"Unauthorized","message":"The creator of this asset requires you to be
   logged in to download it"}
so the download must carry the API key and any refusal must be explained.

server.py needs ComfyUI to import, so the two pure helpers are exec'd straight
out of the source and the rest is checked statically.
"""

import os
import re
import sys

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


# ── run the two helpers for real ────────────────────────────────────────
ns = {}
start = SRC.index("def _with_civitai_token")
end = SRC.index("@routes.", start)
exec(SRC[start:end], ns)
with_token = ns["_with_civitai_token"]
download_error = ns["_civitai_download_error"]

KEY = "abc123KEY"

print("attaching the API key")
eq(with_token("https://civitai.com/api/download/models/3161121", KEY),
   "https://civitai.com/api/download/models/3161121?token=" + KEY, "token added with ?")
eq(with_token("https://civitai.com/api/download/models/3161121?fileId=3041519", KEY),
   "https://civitai.com/api/download/models/3161121?fileId=3041519&token=" + KEY, "token added with &")
eq(with_token("https://civitai.com/api/download/models/3161121?token=already", KEY),
   "https://civitai.com/api/download/models/3161121?token=already", "an existing token is left alone")
eq(with_token("https://civitai.com/api/download/models/3161121", ""),
   "https://civitai.com/api/download/models/3161121", "no key -> URL unchanged")
eq(with_token("https://civitai.com/api/download/models/3161121", None),
   "https://civitai.com/api/download/models/3161121", "None key -> URL unchanged")
eq(with_token("https://huggingface.co/user/repo/resolve/main/model.safetensors", KEY),
   "https://huggingface.co/user/repo/resolve/main/model.safetensors",
   "the Civitai key is never attached to a Hugging Face URL")

print("explaining refusals")


class Err(Exception):
    def __init__(self, code):
        self.code = code


for code in (401, 403):
    msg = download_error(Err(code))
    ok("HTTP %d" % code in msg, f"{code} names the status code")
    ok("API key" in msg, f"{code} tells the user to add an API key")
    ok("Settings" in msg, f"{code} says where to add it")
ok("404" in download_error(Err(404)), "404 explains the file is missing")
ok("429" in download_error(Err(429)), "429 explains rate limiting")
ok("Download failed" in download_error(Err(500)), "anything else falls back to the plain message")
eq(download_error(Err(401)).count("401"), 1, "the code appears once, not duplicated")

print("wiring")
ok("import urllib.error" in SRC, "urllib.error is imported")
ok("except urllib.error.HTTPError as e:" in SRC, "HTTP errors are caught specifically")
ok('_civitai_download_error(e)' in SRC, "they go through the friendly message")
ok("_with_civitai_token(download_url, api_key)" in SRC, "the request URL carries the key")
ok('"url": download_url,' in SRC, "the stored task keeps the URL without the key")
ok('"retry_payload"' in SRC and "token=" not in SRC.split('"retry_payload"')[1].split("},")[0],
   "the retry payload the UI keeps has no token in it")
ok('Nothing to download' in SRC, "the bare 400 now says what to do")

print("client sends the chosen file")
JS = open(os.path.join(HERE, "..", "js", "civitai.js"), encoding="utf-8").read()
m = re.search(r'url: file\.downloadUrl \|\| curVersion\.downloadUrl \|\| "",', JS)
ok(m is not None, "the detail modal posts the picked file's URL (carries ?fileId=)")
ok("_jobNeedsApiKey" in JS, "the Downloads tab recognises an auth failure")
ok('detail: "settings"' in JS, "there is a route to the Settings tab")
ok("makeApiKeyBtn" in JS, "a failed job offers an API-key shortcut")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
