"""
A page has to arrive full.

Civitai has no per-tier content filter, so the content bands were applied in
the browser after the fetch: ask for 24, throw away the 20 that were not
ticked, show 4. The bands are applied server-side now, and the search keeps
asking until the page is full.

Run with:  python3 tests/test_page_fill.py
"""

import os
import re
import sys
import asyncio
import logging

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

# utils.py imports folder_paths, which only exists inside ComfyUI. Nothing in
# the band helpers touches it, so a bare stub is enough to get the real
# helpers in here rather than a copy that could drift from js/rating.js.
sys.modules.setdefault("folder_paths", type(sys)("folder_paths"))

import utils  # noqa: E402  (the real band helpers, so nothing is re-guessed)

SRC = open(os.path.join(ROOT, "server.py"), encoding="utf-8").read()
JS = open(os.path.join(ROOT, "js", "civitai.js"), encoding="utf-8").read()

passed = 0
failed = 0


def ok(cond, label):
    global passed, failed
    if cond:
        passed += 1
    else:
        failed += 1
        print(f"  x {label}")


def eq(actual, expected, label):
    ok(actual == expected, f"{label} — expected {expected!r}, got {actual!r}")


def check(needle, text, label):
    ok(needle in text, f"{label} — not found: {needle!r}")


def reject(needle, text, label):
    ok(needle not in text, f"{label} — should be gone: {needle!r}")


# ── run the real route ─────────────────────────────────────────────────
START = "# ── Civitai Search / Browse"
END = '@routes.get("/civitai/lookup")'
BODY = SRC[SRC.index(START):SRC.index(END)]


class _Routes:
    def get(self, path):
        def deco(fn):
            return fn
        return deco


class _Web:
    @staticmethod
    def json_response(payload):
        return payload


def _namespace(calls, source):
    """Everything the search slice needs, with Civitai stubbed out.

    One dict serves as both globals and locals: with separate ones, `def`
    binds into locals while the functions still look names up in globals.
    """
    class _FakeResp:
        def __init__(self, payload):
            self._payload = payload

        def json(self):
            return self._payload

    class _API:
        @staticmethod
        def _request_with_retry(url, params=None):
            asked = dict(params or {})
            calls.append(asked)
            # `source` is either a list of canned pages or a callable that
            # answers a request — the callable is what makes the batch sizing
            # testable, since Civitai really does return `limit` models.
            payload = source(asked, len(calls)) if callable(source) else (
                source[min(len(calls) - 1, len(source) - 1)] if source else {})
            return _FakeResp(payload)

    fake_utils = type(sys)("utils")
    fake_utils.BAND_IDS = utils.BAND_IDS
    fake_utils.band_id_from_value = utils.band_id_from_value
    fake_utils._get_active_domain = staticmethod(lambda: "civitai.com")
    fake_utils.CivitaiAPIUtils = _API

    ns = {
        "routes": _Routes(), "web": _Web(), "utils": fake_utils,
        "asyncio": asyncio, "time": __import__("time"),
        "logger": logging.getLogger("CivitaiHF"),
        "_api_cache": {}, "_api_cache_put": lambda k, v: None,
    }
    exec(compile(BODY, "server.py", "exec"), ns)
    return ns


def run_search(source, **query):
    """Call the real search route against canned Civitai responses."""
    calls = []
    ns = _namespace(calls, source)
    req = type("R", (), {"query": dict(query)})
    loop = asyncio.new_event_loop()
    try:
        out = loop.run_until_complete(ns["search_civitai"](req))
    finally:
        loop.close()
    return out, calls


def model(mid, band, name=None, tags=None, description=None):
    """A one-version model whose only preview sits in `band`."""
    m = {"id": mid, "name": name if name is not None else f"m{mid}",
         "modelVersions": [
             {"id": mid * 10, "images": [{"url": "u", "nsfwLevel": band}]}]}
    if tags is not None:
        m["tags"] = tags
    if description is not None:
        m["description"] = description
    return m


def sparse(n, start=0):
    """`n` models of which only one in six is PG."""
    return [model(start + i, 1 if i % 6 == 0 else 16) for i in range(n)]


def page(items, cursor=None, total=None):
    meta = {}
    if cursor:
        meta["nextCursor"] = cursor
    if total:
        meta["totalItems"] = total
    return {"items": items, "metadata": meta}


HELPERS = _namespace([], [])


print("the Python band rules match the JS ones")
band_of_model = HELPERS["_band_of_model"]
band_of_item = HELPERS["_band_of_item"]

eq(band_of_model(model(1, 1)), "PG", "a PG preview makes a PG model")
eq(band_of_model(model(2, 16)), "XXX", "an XXX preview makes an XXX model")
eq(band_of_model(model(3, 8)), "X", "the bitmask is read as a bitmask")
eq(band_of_model(model(4, "PG13")), "PG-13", "and the string enum is read too")
eq(band_of_model({"id": 5}), "PG", "a model with no signals at all is PG")
eq(band_of_item({"nsfw": True}), "R", "a bare nsfw: true counts as R")
eq(band_of_item({"nsfw": False}), "PG", "and nsfw: false stays PG")
ok(band_of_model({
    "id": 6, "modelVersions": [
        {"images": [{"nsfwLevel": 1}, {"nsfwLevel": 16}]}]}) == "XXX",
   "the highest tier across a version's previews wins")
ok(band_of_model({
    "id": 7, "modelVersions": [{"images": [{"nsfwLevel": 1}]}],
    "images": [{"nsfwLevel": 4}]}) == "R",
   "model-level previews count as well")
ok(band_of_model({"id": 8, "nsfwLevel": 32, "modelVersions": []}) == "XXX",
   "Blocked (32) is treated as the top tier, as in the JS")

print("filtering keeps only the ticked bands")
keep = HELPERS["_filter_models"]
mix = [model(1, 1), model(2, 16), model(3, 4)]
eq([m["id"] for m in keep(mix, ["PG"])], [1], "one band keeps one model")
eq([m["id"] for m in keep(mix, ["PG", "R"])], [1, 3], "and two keep two")
eq(len(keep(mix, [])), 3, "an empty selection keeps everything")
eq(len(keep(mix, ["PG", "PG-13", "R", "X", "XXX"])), 3, "so does ticking all five")
eq(len(keep([], ["PG"])), 0, "an empty page stays empty")

print("the next batch is sized from the pass rate so far")
nxt = HELPERS["_next_chunk"]
ok(nxt(13, 48, 7) > 48, "a poor pass rate asks for a much bigger batch")
ok(nxt(13, 48, 7) <= 100, "but never more than Civitai's limit of 100")
ok(nxt(2, 48, 46) >= 12, "and there is a floor, so it always asks for something")
ok(nxt(5, 0, 0) >= 12, "even before anything is known")

print("a page with no band filter is a single request")
out, calls = run_search(
    lambda p, n: page([model(i, 1) for i in range(p.get("limit", 24))], "c1", 500),
    **{"limit": "24", "sort": "Highest Rated"})
eq(len(out["items"]), 24, "24 models come back")
eq(len(calls), 1, "from one request")
eq(calls[0].get("limit"), 24, "asking for 24")
eq(out["metadata"]["nextCursor"], "c1", "with the cursor the grid pages on")

print("a page that is mostly filtered out keeps asking until it is full")
# only one model in six is PG — the 4-in-24 page that prompted all this
out, calls = run_search(
    lambda p, n: page(sparse(p.get("limit", 24), start=n * 100), f"c{n + 1}", 500),
    **{"limit": "24", "bands": "PG", "want": "24"})
ok(len(out["items"]) >= 24, f"the page arrives full ({len(out['items'])} models)")
ok(len(calls) > 1, f"because it went back for more ({len(calls)} requests)")
ok(all(m["modelVersions"][0]["images"][0]["nsfwLevel"] == 1 for m in out["items"]),
   "and every model on it is PG")
sizes = [c.get("limit", 0) for c in calls]
ok(max(sizes) > sizes[0], f"batches are sized up from the pass rate {sizes}")
ok(sizes[-1] < max(sizes) or len(sizes) == 1,
   "and the last one is trimmed to just what was still missing")

print("a very narrow band gives up instead of paging forever")
# one PG model in a hundred — worse than anything the live API produced
out, calls = run_search(
    lambda p, n: page([model(n * 1000 + i, 1 if i == 0 else 16)
                       for i in range(p.get("limit", 24))], f"c{n + 1}", 900),
    **{"limit": "24", "bands": "PG", "want": "24"})
eq(len(calls), 6, "it stops at the round cap rather than hammering the API")
ok(len(out["items"]) > 1, f"and still returns more than the old one model ({len(out['items'])})")
ok(all(c.get("limit", 0) <= 100 for c in calls), "never asking for more than Civitai allows")

print("searching a creator's models by text")
# Civitai's own query+username combination cannot be trusted: for creator
# Marlosart it matched "Korra" but not "Hinata" or "Naruto", although both
# appear in the name of one of that creator's models.
match = HELPERS["_matches_query"]
naruto = model(1, 16, name="Hinata Hyuga/ Naruto (NSFW/SFW) SDXL LORA (PONY)")
other = model(2, 16, name="Princess Zelda (NSFW/SFW) SDXL LORA (PONY)")
ok(match(naruto, "Naruto"), "a word in the name matches")
ok(match(naruto, "naruto"), "case does not matter")
ok(not match(other, "Naruto"), "and a model without it does not")
ok(match(naruto, "Hinata Naruto"), "every word has to be there")
ok(not match(naruto, "Naruto Sasuke"), "but one missing word rules it out")
ok(match(other, ""), "an empty query matches everything")
ok(match(model(3, 1, name="X", tags=["naruto"]), "naruto"), "a tag matches")
ok(match(model(4, 1, name="X", description="a Naruto LoRA"), "naruto"),
   "and so does the description")

pool = [naruto, other, model(5, 1, name="Korra / The Legend of Korra")]
out, calls = run_search(
    lambda p, n: page(pool if n == 1 else [], None, 900),
    **{"limit": "24", "username": "Marlosart", "query": "Naruto", "want": "24"})
ok(all("query" not in c for c in calls),
   "the text is no longer handed to Civitai alongside the creator")
ok(all(c.get("username") == "Marlosart" for c in calls),
   "the creator still is")
eq([m["id"] for m in out["items"]], [1],
   "and the model the old combination could not find is returned")

print("  without a creator, Civitai still does the text search")
out, calls = run_search(
    lambda p, n: page([naruto, other] if n == 1 else [], None, 900),
    **{"limit": "24", "query": "Naruto", "want": "24"})
ok(all(c.get("query") == "Naruto" for c in calls),
   "the query goes upstream, where its ranking is better than a substring match")
eq(len(out["items"]), 2, "and nothing is filtered out here")

print("it stops when the results run out, and says so")
out, calls = run_search(
    lambda p, n: page(sparse(p.get("limit", 24), start=n * 100), None, 4),
    **{"limit": "24", "bands": "PG", "want": "24"})
ok(len(out["items"]) < 24, "a short page is all that is left")
ok(not out["metadata"]["nextCursor"], "and the pager is told there is no next page")

print("paging resumes from where the fill left off")
out, calls = run_search(
    lambda p, n: page(sparse(p.get("limit", 24), start=n * 100), f"c{n + 1}", 500),
    **{"limit": "24", "bands": "PG", "want": "24"})
last = calls[-1].get("cursor")
ok(out["metadata"]["nextCursor"] != last,
   "the cursor handed back points past the last batch consumed")
ok(all("cursor" in c for c in calls[1:]), "every follow-up round follows a cursor")
eq(calls[0].get("page"), 1, "the first round still honours the page number")

print("the client no longer filters, it sends the bands instead")
check('params.set("bands", bandSel.join(","))', JS, "bands are sent to the server")
check('params.set("want", String(S.civitai.limit));', JS, "with the page size it wants")
check("bandSel.length < BAND_ORDER.length", JS,
      "ticking every band sends nothing, since that filters nothing out")
reject("items = filterByBands(items, bandSel, false);", JS,
       "the client-side filter that shrank the page is gone")

print("pages are no longer assumed to be the same size")
check("pageStarts: [0]", JS, "each page's offset is remembered")
check("starts[S.civitai.page] =", JS, "and recorded when you move forward")
check("var first = (starts[page - 1] || 0) + 1;", JS,
      "so 'Showing 25-48' stays true when a page is bigger than the last")

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
