"""
Finding 9: dead code.

`_cached_api_get` was defined in server.py and never called — and it held the
only eviction logic that ever bounded `_api_cache`, so removing it naively
would have left the search cache growing without limit for a session. The
wrapper is replaced by `_api_cache_put`, which the search route now uses.

The download payload also carried `format`, `fp` and `size`, which nothing on
the server read.

Run with:  python3 tests/test_dead_code.py
"""

import os
import sys
import time

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


def reject(text, needle, label):
    ok(needle not in text, label)


print("the dead wrapper is gone")
reject(SRC, "_cached_api_get", "_cached_api_get is no longer defined")
reject(SRC, "_API_CACHE_TTL", "neither is its TTL constant")
ok("_cached_api_get" not in JS, "and nothing in the JS called it either")

print("but the cache it guarded is still in use, and now bounded")
check(SRC, "_api_cache", "the cache survives")
check(SRC, 'cached = _api_cache.get(cache_key)', "the search route reads it")
check(SRC, "_api_cache_put(cache_key, data)", "and writes through the bounded helper")

ns = {"time": time}
exec(SRC[SRC.index("_api_cache = {}"):SRC.index('logger = logging.getLogger(')], ns)
cache = ns["_api_cache"]
put = ns["_api_cache_put"]
MAX = ns["_API_CACHE_MAX"]

eq(len(cache), 0, "starts empty")
put("a", {"items": [1]})
eq(cache["a"]["v"], {"items": [1]}, "stores the value")
ok("t" in cache["a"], "and the time it was stored")

for i in range(MAX):
    put("k%d" % i, i)
ok(len(cache) <= MAX, f"stays under {MAX} entries (has {len(cache)})")

for i in range(1000):
    put("spam%d" % i, i)
ok(len(cache) <= MAX, f"still bounded after 1000 writes (has {len(cache)})")
ok("spam999" in cache, "the newest entry survives eviction")
ok("k0" not in cache, "the oldest entries are the ones dropped")
ok(all(isinstance(v, dict) and "v" in v and "t" in v for v in cache.values()),
   "every entry keeps its {v, t} shape")

print("the download payload no longer carries fields nobody reads")
reject(JS, "format: file.metadata", "format is gone")
reject(JS, "fp: file.metadata", "fp is gone")
reject(JS, "size: file.metadata", "size is gone")
check(JS, "url: file.downloadUrl || curVersion.downloadUrl",
      "the chosen file's URL is still sent — that is what selects the variant")
check(JS, "metadata_only: metadataOnly,", "and the rest of the payload is intact")

print("nothing else in the repo referenced those fields")
for name in ("civitai.js", "utils.py", "server.py", "bookmarks_store.py"):
    path = os.path.join(HERE, "..", name)
    if not os.path.exists(path):
        continue
    text = open(path, encoding="utf-8").read()
    ok("data.get(\"format\"" not in text and ".get(\"fp\"" not in text,
       f"{name} does not read format/fp from a download payload")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
