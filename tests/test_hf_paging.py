"""
Paging for /civitai/hf-search — run with:  python3 tests/test_hf_paging.py

The route used to ask for one page of models and stop there, so a search
returned at most `limit` repos no matter how many Hugging Face had. It now
accepts skip/cursor and reports whether more exist.

server.py pulls in ComfyUI modules, so this checks the route source and runs
its Link-header parsing against a real header captured from the HF API.
"""

import os
import re
import sys
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, "..", "server.py")
SRC = open(SERVER, encoding="utf-8").read()

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


route = SRC[SRC.index('@routes.get("/civitai/hf-search")'):SRC.index('@routes.get("/civitai/hf-lookup")')]

print("request parameters")
ok('skip = int(request.query.get("skip", 0))' in route, "skip is read from the query")
ok('cursor = request.query.get("cursor", "")' in route, "cursor is read from the query")
ok('if cursor:\n            params["cursor"] = cursor' in route, "cursor is forwarded to Hugging Face")
ok('elif skip:\n            params["skip"] = skip' in route, "skip is used when there is no cursor")

print("response")
ok('"hasMore": bool(next_cursor) or len(items) >= limit' in route,
   "hasMore is true while the API keeps giving full pages")
ok('"nextCursor": next_cursor' in route, "the next cursor is returned")
ok('"skip": skip + len(items)' in route, "the next offset is returned")

print("Link header parsing (real header from huggingface.co/api/models)")
sample = (
    '<https://huggingface.co/api/models?search=qwen&limit=5&cursor=eyIkb3IiOlt7'
    'InRyZW5kaW5nU2NvcmUiOjIzNSwiX2lkIjp7IiRndCI6IjZhOGVkYzJjMjI1ZDIyYzBlZTBm'
    'ZGFiNiJ9fSx7InRyZW5kaW5nU2NvcmUiOnsiJGx0IjoyMzV9fSx7InRyZW5kaW5nU2NvcmUi'
    'Om51bGx9XSwic2VhcmNoU2VxdWVuY2VUb2tlbiI6IkNLZk9sUUlhQ1NFQUFBQUFBR0J0UUJv'
    'T1dneHFqdHdzSWwwaXdPNFAycllpRGxvTWFvN2NMQ0pkSXNEdUQ5cTIifQ%3D%3D>; rel="next"'
)
# pull the pattern straight out of the route instead of restating it here
_key = "re.search(r'"
_i = route.index(_key) + len(_key)
_j = route.index("', link)", _i)
pattern = route[_i:_j]
ok("cursor=" in pattern, "the cursor regex is found in the route")
if "cursor=" in pattern:
    found = re.search(pattern, sample)
    ok(found is not None, "the regex matches a real next link")
    if found:
        cursor = urllib.parse.unquote(found.group(1))
        ok(cursor.startswith("eyIkb3IiOlt7"), "the cursor is extracted")
        ok("%3D%3D" not in cursor, "the cursor is URL-decoded (trailing == restored)")
        ok(cursor.endswith("ifQ=="), "decoded cursor ends with the base64 padding")

print("no next link -> no cursor")
m2 = re.search(pattern, '<https://huggingface.co/api/models?search=qwen&limit=5>; rel="prev"')
eq(m2 is None, True, "a prev-only link yields no cursor")
eq(re.search(pattern, "") is None, True, "an empty header yields no cursor")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
