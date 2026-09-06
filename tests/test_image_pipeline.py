"""
Server-side image pipeline: /civitai/local-preview used to answer with a
full-size PNG whenever the source happened to be a PNG, which made the Local
tab the heaviest thing in the panel. It now always re-encodes to WebP, honours
a caller-supplied quality, is ETag'd, and keeps its disk cache bounded.

Run with:  python3 tests/test_image_pipeline.py

_resize_preview and _prune_preview_cache are exec'd out of server.py (it needs
ComfyUI to import) against a temporary cache directory.
"""

import io
import logging
import os
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
    global PASS, FAIL
    if cond:
        PASS += 1
    else:
        FAIL += 1
        print(f"  x {label}")


def check(text, needle, label):
    ok(needle in text, label)


try:
    from PIL import Image, ImageFilter
except ImportError:  # pragma: no cover
    print("Pillow is not installed - skipping the resize tests")
    Image = None


# ── run the pipeline for real ──────────────────────────────────────────
tmp = tempfile.mkdtemp()
CACHE = os.path.join(tmp, "cache")
os.makedirs(CACHE, exist_ok=True)

start = SRC.index("_PREVIEW_CACHE_MAX_FILES = 3000")
end = SRC.index('\n@routes.get("/civitai/model-versions")')
assert end > start, "the helper block must precede the next route"
ns = {"os": os, "logging": logging, "_preview_cache_dir": CACHE}
exec(SRC[start:end], ns)
resize = ns["_resize_preview"]
prune = ns["_prune_preview_cache"]

if Image is not None:
    import math

    def _art(path, size=(1024, 1536), seed=0):
        """Something shaped like an AI preview: smooth gradients, soft detail."""
        w, h = size
        im = Image.new("RGB", size)
        px = im.load()
        for y in range(h):
            for x in range(0, w, 2):
                v = (
                    int(128 + 110 * math.sin((x + seed * 30) / 260.0) * math.cos(y / 340.0)),
                    int(110 + 90 * math.sin(y / 210.0 + seed)),
                    int(150 - 80 * math.cos((x + y) / 300.0)),
                )
                px[x, y] = v
                if x + 1 < w:
                    px[x + 1, y] = v
        return im.filter(ImageFilter.GaussianBlur(3))

    print("a realistic preview image")
    src_png = os.path.join(tmp, "preview.png")
    src_jpg = os.path.join(tmp, "preview.jpg")
    small = os.path.join(tmp, "small.png")
    noisy = os.path.join(tmp, "noisy.png")

    art = _art(src_png)
    art.save(src_png)
    art.save(src_jpg, quality=92)
    art.resize((200, 300)).save(small)

    # the pathological case for a lossy codec: per-pixel noise
    import random
    random.seed(7)
    nz = Image.new("RGB", (512, 768))
    nz.putdata([(random.randrange(256), random.randrange(256), random.randrange(256))
                for _ in range(512 * 768)])
    nz.save(noisy)

    def _png_bytes(im, width):
        r = im.resize((width, max(1, int(im.height * width / im.width))), Image.LANCZOS)
        b = io.BytesIO()
        r.save(b, format="PNG")
        return len(b.getvalue())

    print("  WebP, not PNG")
    data, ct = resize(src_png, 450, 72)
    eq(ct, "image/webp", "the content type is WebP")
    ok(data[:4] == b"RIFF" and data[8:12] == b"WEBP", "the bytes really are WebP")
    got = Image.open(io.BytesIO(data))
    eq(got.size, (450, 675), "the output is the requested width")
    old_png_bytes = _png_bytes(Image.open(src_png), 450)
    ok(len(data) < old_png_bytes, "smaller than the PNG it replaces")
    ok(len(data) * 4 < old_png_bytes,
       f"at least 4x smaller ({len(data)} vs {old_png_bytes} bytes)")

    print("  quality is honoured")
    lo, _ = resize(src_png, 450, 40)
    hi, _ = resize(src_png, 450, 90)
    ok(len(lo) < len(data) < len(hi), "lower quality means fewer bytes")

    print("  nothing is upscaled")
    d, _ = resize(small, 450, 72)
    eq(Image.open(io.BytesIO(d)).size, (200, 300), "a small source keeps its size")

    print("  a JPEG source behaves the same")
    d2, ct2 = resize(src_jpg, 450, 72)
    eq(ct2, "image/webp", "JPEG sources are WebP too")
    ok(len(d2) < os.path.getsize(src_jpg), "and smaller than the source JPEG")

    print("  even the worst case for a lossy codec gets smaller")
    dn, _ = resize(noisy, 450, 72)
    ok(len(dn) < _png_bytes(Image.open(noisy), 450),
       "per-pixel noise still compresses better than PNG")

    print("  alpha and palette sources survive")
    rgba = os.path.join(tmp, "alpha.png")
    Image.new("RGBA", (64, 64), (10, 20, 30, 128)).save(rgba)
    ok(resize(rgba, 32, 72)[0][:4] == b"RIFF", "an RGBA source re-encodes")
    pal = os.path.join(tmp, "pal.png")
    Image.new("P", (64, 64)).save(pal)
    ok(resize(pal, 32, 72)[0][:4] == b"RIFF", "a palette source re-encodes")

    print("  the result is cached on disk")
    cached, _ = resize(src_png, 450, 72)
    eq(cached, data, "a second call returns the cached bytes")
    files = os.listdir(CACHE)
    ok(len(files) >= 1, "the thumbnail is written to the cache dir")
    ok(all(f.endswith(".webp") for f in files), "cache entries are WebP")

    # a different quality is a different cache entry
    before = set(os.listdir(CACHE))
    resize(src_png, 450, 50)
    ok(set(os.listdir(CACHE)) - before, "quality is part of the cache key")

    print("  a stale entry is regenerated when the source changes")
    os.utime(src_png, (1, 1))            # source older than the cache entry
    stale, _ = resize(src_png, 450, 72)
    eq(stale, data, "an up-to-date entry is reused")
    _art(None, seed=3).save(src_png)     # source rewritten, newer mtime
    fresh, _ = resize(src_png, 450, 72)
    ok(fresh != data, "a changed source is re-encoded, not served stale")

    print("  an unreadable file raises so the route can fall through")
    junk = os.path.join(tmp, "junk.png")
    with open(junk, "wb") as f:
        f.write(b"not an image at all")
    try:
        resize(junk, 450, 72)
        ok(False, "a non-image should raise")
    except Exception:
        ok(True, "a non-image raises and the route serves the original instead")

print("the cache is bounded")
os.makedirs(CACHE, exist_ok=True)
for i in range(60):
    p = os.path.join(CACHE, "old%02d.webp" % i)
    with open(p, "wb") as f:
        f.write(b"x" * 1000)
ns["_PREVIEW_CACHE_MAX_FILES"] = 20
ns["_PREVIEW_CACHE_MAX_BYTES"] = 8 * 1024 * 1024
prune()
left = os.listdir(CACHE)
ok(len(left) <= 20, f"file count is capped (got {len(left)})")

ns["_PREVIEW_CACHE_MAX_BYTES"] = 4096
prune()
total = sum(os.path.getsize(os.path.join(CACHE, f)) for f in os.listdir(CACHE))
ok(total <= 4096, f"total size is capped (got {total} bytes)")

print("the route clamps what a caller can ask for")
route = SRC[SRC.index('@routes.get("/civitai/local-preview")'):SRC.index("_preview_cache_dir = os.path.join(")]
check(route, 'max_w = max(32, min(2048, max_w)) if max_w else 0', "width is clamped")
check(route, "quality = max(20, min(95, quality))", "quality is clamped")
check(route, 'etag = \'"%s"\' % hashlib.md5(', "an ETag is generated")
check(route, "f\"{path}:{mtime}:{max_w}:{quality}\"", "the ETag covers the transform")
check(route, 'request.headers.get("If-None-Match") == etag', "and a matching one returns 304")
check(route, 'if max_w and ext != ".gif":', "animated GIFs are left alone")
check(route, "None, _resize_preview, path, max_w, quality", "the resize runs off the event loop")
check(route, 'await loop.run_in_executor(', "via run_in_executor")

print("local-previews passes the caller's size through")
lp = SRC[SRC.index('@routes.get("/civitai/local-previews")'):SRC.index('@routes.get("/civitai/local-metadata")')]
check(lp, 'pv_w = request.query.get("w", "450")', "width is read from the request")
check(lp, 'pv_q = request.query.get("q", "72")', "quality is read from the request")
check(lp, "if not pv_w.isdigit():", "and validated")
check(lp, "&w={pv_w}&q={pv_q}", "both reach the generated URL")

print("image quality is a saved setting")
gs = SRC[SRC.index('async def get_settings('):SRC.index('async def save_settings(')]
check(gs, '"image_quality": utils.db_manager.get_setting("image_quality", "balanced")', "GET exposes it")
ss = SRC[SRC.index('async def save_settings('):SRC.index('@routes.get("/civitai/test")')]
check(ss, 'if "image_quality" in data:', "POST accepts it")
check(ss, 'iq if iq in ("saver", "balanced", "high") else "balanced"', "and rejects unknown values")

shutil.rmtree(tmp, ignore_errors=True)
print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
