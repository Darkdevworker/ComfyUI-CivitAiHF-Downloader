import asyncio
import json
import logging
import os
import time
import re
import shutil
import threading
import urllib.request
import urllib.error
import urllib.parse
import hashlib
from email.utils import formatdate, parsedate_to_datetime
import requests
import folder_paths
from aiohttp import web
from server import PromptServer

from . import utils
from . import history_store

# ── Response cache for API calls ──────────────────────────────────────
# Keyed by query. Every reader applies its own TTL, so entries are stored as
# {"v": value, "t": stored_at} and evicted oldest-first by _api_cache_put.
_api_cache = {}
_API_CACHE_MAX = 200
_API_CACHE_EVICT = 50


def _api_cache_put(key, value):
    """Store a cached response, dropping the oldest entries when it is full.

    _api_cache used to be bounded only by a generic wrapper that nothing ever
    called, so a long session of searches grew it without limit.
    """
    _api_cache[key] = {"v": value, "t": time.time()}
    if len(_api_cache) > _API_CACHE_MAX:
        oldest = sorted(_api_cache.keys(), key=lambda k: _api_cache[k]["t"])[:_API_CACHE_EVICT]
        for k in oldest:
            del _api_cache[k]

logger = logging.getLogger("CivitaiHF")

routes = PromptServer.instance.routes


# ── Path safety & off-loop helpers ─────────────────────────────────────
# Every route that reads or removes a file on the user's behalf goes through
# _safe_model_path(), and every blocking call goes through run_in_executor,
# so a request can neither reach outside the models directories nor stall
# ComfyUI's single-threaded event loop.

def _model_roots():
    """Real paths of every directory this extension may touch."""
    roots = []
    try:
        if getattr(folder_paths, "models_dir", None):
            roots.append(os.path.realpath(folder_paths.models_dir))
    except Exception:
        logger.debug("_model_roots: ignoring Exception", exc_info=True)
    try:
        for entry in getattr(folder_paths, "folder_names_and_paths", {}).values():
            paths = entry[0] if isinstance(entry, (list, tuple)) else entry
            if isinstance(paths, str):
                paths = [paths]
            for candidate in paths or []:
                try:
                    roots.append(os.path.realpath(candidate))
                except Exception:
                    logger.debug("_model_roots: ignoring Exception", exc_info=True)
    except Exception:
        logger.debug("_model_roots: ignoring Exception", exc_info=True)
    seen, out = set(), []
    for r in roots:
        key = os.path.normcase(r)
        if key not in seen:
            seen.add(key)
            out.append(r)
    return out


def _safe_model_path(path, must_exist=True):
    """
    Resolve a user-supplied path and confirm it sits under a models dir.

    Returns (ok, resolved_path_or_error_message). Relative paths are resolved
    against the models directory, and symlinks are followed before the check,
    so a link inside models/ cannot be used to escape it.
    """
    if not path or not isinstance(path, str):
        return False, "Missing path"
    if "\x00" in path:
        return False, "Invalid path"
    try:
        if not os.path.isabs(path):
            path = os.path.join(folder_paths.models_dir, path)
        real = os.path.realpath(path)
    except Exception:
        return False, "Invalid path"
    real_c = os.path.normcase(real)
    for root in _model_roots():
        root_c = os.path.normcase(root)
        if real_c == root_c or real_c.startswith(root_c + os.sep):
            if must_exist and not os.path.exists(real):
                return False, "File not found"
            return True, real
    return False, "Path is outside the ComfyUI models directories"


_UNSAFE_PART = re.compile(r"(^|[/\\])\.\.([/\\]|$)")
_UNSAFE_NAME = re.compile(r'[\x00-\x1f<>:"|?*]')


def _safe_name(text, fallback=""):
    """Reduce remote- or user-supplied text to a single safe path component.

    Used for names taken from API responses (creator, base model) and from
    the Content-Disposition header, none of which should ever introduce a
    directory separator or a `..` of their own.
    """
    v = str(text if text is not None else "")
    v = v.replace("\\", "/")
    if "/" in v:
        v = v.rsplit("/", 1)[-1]
    v = _UNSAFE_NAME.sub("", v).split("\x00")[0].strip()
    if not v or v in (".", ".."):
        return fallback
    return v


def _safe_download_path(*parts):
    """Join user-supplied parts into a destination inside the models dirs.

    The destination folder, `subfolder` and `filename` are all free text or
    free choice in the download modal, so a bare `os.path.join` lets
    `subfolder: "../../x"` or `filename: "/etc/passwd"` write anywhere on
    disk. Returns (ok, resolved_path_or_error_message).
    """
    clean = []
    for part in parts:
        if part is None:
            continue
        part = str(part)
        if not part.strip():
            continue
        if "\x00" in part:
            return False, "Invalid path"
        if os.path.isabs(part) or _UNSAFE_PART.search(part) or re.match(r"^[A-Za-z]:", part):
            return False, "The destination must stay inside the models directory (%r)" % part
        clean.append(part)
    if not clean:
        return False, "Missing destination"
    return _safe_model_path(
        os.path.join(folder_paths.models_dir, *clean), must_exist=False)


def _is_subdir_of_models(path):
    """True only for a strict subdirectory of a models dir, never a root.

    ComfyUI expects `models/loras` and friends to exist, so an empty models
    root must not be removed just because the last file inside it went.
    """
    real_c = os.path.normcase(os.path.realpath(path))
    for root in _model_roots():
        if real_c.startswith(os.path.normcase(root) + os.sep):
            return True
    return False


def _read_json(path):
    """Read a JSON file, or None if it is missing/unreadable."""
    try:
        if not os.path.isfile(path):
            return None
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


async def _civitai_call(fn, *args):
    """Run a blocking Civitai API call off the event loop."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: fn(*args))


# ── Civitai Search / Browse ────────────────────────────────────────────

def _dl_status(model=None, version=None, file=None, has_key=False):
    """Whether this model can be downloaded, as green / yellow / red.

      green  — a file is there for the taking
      yellow — it exists, but something has to happen first: Buzz to unlock
               an Early Access model, or a Civitai API key to prove who you are
      red    — there is nothing to download

    Civitai publishes no single "you may download this" flag. `paidAccess` on
    a version is what marks Early Access (Buzz), `availability` says what the
    owner decided, and the files list is the final arbiter — a version with
    no file cannot be fetched by any means.
    """
    model = model if isinstance(model, dict) else {}
    version = version if isinstance(version, dict) else {}
    file = file if isinstance(file, dict) else {}

    availability = str(version.get("availability")
                       or model.get("availability") or "").strip()
    mode = str(model.get("mode") or "").strip()

    # ---- red: there is nothing here, and no amount of Buzz changes that ----
    if mode in ("TakenDown", "Deleted", "Archived"):
        return {"level": "red",
                "reason": "This model has been taken down, so it cannot be downloaded."}
    if availability == "Unavailable":
        return {"level": "red", "reason": "Civitai lists this model as unavailable."}
    files = version.get("files") or []
    if not file and not files:
        if not version and not file:
            return {"level": "red", "reason": "This model has no downloadable version."}
        return {"level": "red", "reason": "This version has no files."}

    # ---- yellow: it is real, but not yet reachable ----
    paid = version.get("paidAccess")
    if (isinstance(paid, dict) and paid) or availability == "EarlyAccess" \
            or model.get("hasActivePaidAccess"):
        return {"level": "yellow",
                "reason": "Early Access \u2014 unlock it with Buzz on Civitai, then download."}
    if availability == "Private":
        return {"level": "yellow",
                "reason": "This model is private. Add an API key for an account that can see it."}
    if not has_key and (model.get("poi") or model.get("minor")):
        return {"level": "yellow",
                "reason": "Civitai wants a login for this model \u2014 add an API key in Settings."}

    # ---- green ----
    if (file.get("downloadUrl") or version.get("downloadUrl")
            or (files and (files[0] or {}).get("downloadUrl"))):
        return {"level": "green", "reason": "Ready to download."}
    return {"level": "red",
            "reason": "Civitai publishes no download link for this file."}


def _annotate_availability(items, has_key=False):
    """Stamp each search result with the verdict for its newest version.

    Computed here so a card can show it without a second round trip, and so
    the rule lives in exactly one place.
    """
    for m in items or []:
        if not isinstance(m, dict):
            continue
        try:
            m["dl_status"] = _verdict_for_model(m, has_key)
        except Exception:
            logger.debug("could not classify a search result", exc_info=True)
            m["dl_status"] = {"level": "green", "reason": ""}
    return items


def _verdict_for_model(m, has_key=False):
    """The green / yellow / red verdict for one search result."""
    versions = m.get("modelVersions") or []
    version = versions[0] if versions else {}
    files = version.get("files") or []
    primary = None
    for f in files:
        if isinstance(f, dict) and f.get("primary"):
            primary = f
            break
    if primary is None and files:
        primary = files[0]
    return _dl_status(m, version, primary, has_key)


def _civitai_has_key():
    """Whether an API key is set. Never raises — the verdict is a hint on a
    card, and a settings backend that will not answer must not be able to
    turn a page of results into an error page."""
    try:
        return bool(utils.db_manager.get_setting("civitai_api_key"))
    except Exception:
        logger.debug("could not read the API key setting", exc_info=True)
        return False

# How many times a page may go back to Civitai. Civitai has no per-tier
# filter (nsfwLevel is silently ignored), so the bands are applied here and a
# narrow selection needs several batches to fill 24 slots — measured live,
# only PG ticked leaves about 1 model in 24, and Civitai caps a batch at 100.
# Six rounds is enough for most selections and, worst case, costs six
# requests to an endpoint that is cached for 60 seconds.
_SEARCH_FILL_ROUNDS = 6


def _band_of_item(item):
    """Mirror of rating.js bandIdOfItem."""
    if not isinstance(item, dict):
        return "PG"
    for key in ("nsfwLevel", "nsfw_level", "rating", "nsfwRating", "level", "nsfw"):
        value = item.get(key)
        if value is None or value in ("", "null", "undefined"):
            continue
        band_id = utils.band_id_from_value(value)
        if band_id:
            if key == "nsfw" and isinstance(value, bool):
                return "PG" if band_id == "PG" else band_id
            return band_id
    return "PG"


def _band_of_image(image, fallback=None):
    """Mirror of rating.js bandIdOfImage."""
    if not isinstance(image, dict):
        return "PG"
    for key in ("nsfwLevel", "nsfw_level", "rating", "nsfwRating", "level"):
        value = image.get(key)
        if value is None or value in ("", "null", "undefined"):
            continue
        band_id = utils.band_id_from_value(value)
        if band_id:
            return band_id
    if isinstance(image.get("nsfw"), bool):
        return "R" if image["nsfw"] else "PG"
    return _band_of_item(fallback) if fallback else "PG"


def _band_max(a, b):
    ids = utils.BAND_IDS
    return a if ids.index(a) >= ids.index(b) else b


def _band_of_model(model):
    """Mirror of rating.js bandIdOfModel.

    The highest tier across the model, its versions and every preview image,
    so a model with one XXX preview counts as XXX.
    """
    if not isinstance(model, dict):
        return "PG"
    worst = _band_of_item(model)
    for version in (model.get("modelVersions") or []):
        if not isinstance(version, dict):
            continue
        worst = _band_max(worst, _band_of_item(version))
        for image in (version.get("images") or []):
            worst = _band_max(worst, _band_of_image(image, model))
    for image in (model.get("images") or []):
        worst = _band_max(worst, _band_of_image(image, model))
    return worst


def _matches_query(model, needle):
    """Every word of `needle` must appear in the name, a tag or the blurb."""
    if not needle:
        return True
    words = str(needle).lower().split()
    tags = model.get("tags") or []
    hay = " ".join([
        str(model.get("name") or ""),
        " ".join(str(t) for t in tags),
        str(model.get("description") or ""),
    ]).lower()
    return all(w in hay for w in words)


def _filter_models(items, bands, needle=""):
    """Keep the models whose band is ticked and whose text matches."""
    kept = list(items or [])
    if bands:
        kept = [m for m in kept if _band_of_model(m) in bands]
    if needle:
        kept = [m for m in kept if _matches_query(m, needle)]
    return kept


def _next_chunk(need, fetched, passed, floor=12, ceiling=100):
    """How many models to ask Civitai for on the next round.

    Sized from the pass rate seen so far, so a later round fetches roughly
    what is still missing instead of a fixed batch that overshoots and
    strands models past the end of the page.
    """
    rate = (passed / fetched) if fetched else 0.2
    return max(floor, min(ceiling, int(need / max(rate, 0.05)) + 2))


@routes.get("/civitai/search")
async def search_civitai(request):
    try:
        query = request.query.get("query", "")
        model_type = request.query.get("types", "") or request.query.get("type", "")
        sort = request.query.get("sort", "Highest Rated")
        page = int(request.query.get("page", 1))
        nsfw = request.query.get("nsfw", "false")
        limit = int(request.query.get("limit", 20))
        period = request.query.get("period", "")
        base_models = request.query.get("baseModels", "")
        username = request.query.get("username", "")
        tag = request.query.get("tag", "")
        cursor = request.query.get("cursor", "")
        # How many models the grid wants on one page. The bands are applied
        # here rather than in the browser, and a page still has to arrive
        # full — so when most of a batch is filtered out, ask again.
        want = max(1, min(int(request.query.get("want", limit)), 60))
        bands = [b.strip().upper() for b in request.query.get("bands", "").split(",")
                 if b.strip()]
        domain = utils._get_active_domain()

        params = {}

        # Civitai's own query+username combination cannot be trusted: asked
        # for creator Marlosart it matched "Korra" but not "Hinata" or
        # "Naruto", although both are in the name of one of that creator's
        # models. So when a creator is named the text is matched here
        # instead of upstream, where it behaves the way the cards read.
        local_query = query if (query and username) else ""
        if query and not username:
            params["query"] = query
        if model_type and model_type.lower() != "any":
            params["types"] = model_type
        if nsfw:
            params["nsfw"] = nsfw
        if sort and sort.lower() != "relevancy":
            params["sort"] = sort
        if period:
            params["period"] = period
        if base_models:
            params["baseModels"] = [b.strip() for b in base_models.split(",") if b.strip()]
        if username:
            params["username"] = username
        if tag:
            params["tag"] = tag

        loop = asyncio.get_event_loop()
        cache_key = (f"csearch:{query}:{model_type}:{sort}:{period}:{base_models}:"
                     f"{nsfw}:{username}:{tag}:{bands}:{cursor}:{page}:{limit}:{want}")
        cached = _api_cache.get(cache_key)
        if cached and (time.time() - cached["t"]) < 60:
            return web.json_response(cached["v"])

        def _fetch_search(round_params):
            return utils.CivitaiAPIUtils._request_with_retry(
                f"https://{domain}/api/v1/models", params=round_params
            )

        collected = []
        fetched = 0
        passed = 0
        next_cursor = cursor or None
        total_items = None
        chunk = max(1, min(limit, 100))
        for _ in range(_SEARCH_FILL_ROUNDS):
            round_params = dict(params)
            round_params["limit"] = chunk
            if next_cursor:
                round_params["cursor"] = next_cursor
            elif not query and not cursor:
                round_params["page"] = page
            data = (await loop.run_in_executor(None, _fetch_search, round_params)).json() or {}
            raw = data.get("items") or []
            meta = data.get("metadata") or {}
            kept = _filter_models(raw, bands, local_query)
            collected.extend(kept)
            fetched += len(raw)
            passed += len(kept)
            next_cursor = meta.get("nextCursor") or None
            if meta.get("totalItems"):
                total_items = meta["totalItems"]
            # Stop when the page is full, the results ran out, or Civitai has
            # no cursor to continue from.
            if not raw or not next_cursor or len(collected) >= want:
                break
            chunk = _next_chunk(want - len(collected), fetched, passed)

        payload = {
            "items": _annotate_availability(collected[:want], _civitai_has_key()),
            "metadata": {"nextCursor": next_cursor, "totalItems": total_items},
        }
        _api_cache_put(cache_key, payload)
        return web.json_response(payload)
    except Exception as e:
        return web.json_response({"items": [], "total": 0, "error": str(e)})


@routes.get("/civitai/lookup")
async def lookup_civitai(request):
    try:
        hash_val = request.query.get("hash", "")
        version_id = request.query.get("version_id", "")
        model_id = request.query.get("model_id", "")
        model_input = request.query.get("model", "")
        domain = utils._get_active_domain()

        if hash_val:
            info = await _civitai_call(
                utils.CivitaiAPIUtils.get_model_version_info_by_hash, hash_val.strip())
            if not info:
                return web.json_response({"error": "Not found on Civitai"}, status=404)
            return web.json_response({"kind": "version", "data": info})

        if version_id:
            info = await _civitai_call(
                utils.CivitaiAPIUtils.get_model_version_info_by_id, int(version_id), domain)
            if not info:
                return web.json_response({"error": "Not found on Civitai"}, status=404)
            return web.json_response({"kind": "version", "data": info})

        if model_id:
            info = await _civitai_call(
                utils.CivitaiAPIUtils.get_model_info_by_id, int(model_id), domain)
            if not info:
                return web.json_response({"error": "Not found on Civitai"}, status=404)
            return web.json_response({"kind": "model", "data": info})

        if model_input:
            parsed = await _civitai_call(utils.parse_civitai_input, model_input.strip())
            if parsed.get("version_id"):
                info = await _civitai_call(
                    utils.CivitaiAPIUtils.get_model_version_info_by_id,
                    parsed["version_id"], domain)
                if info:
                    return web.json_response({"kind": "version", "data": info})
            if parsed.get("model_id"):
                info = await _civitai_call(
                    utils.CivitaiAPIUtils.get_model_info_by_id, parsed["model_id"], domain)
                if info:
                    return web.json_response({"kind": "model", "data": info})
            return web.json_response({"error": "Could not parse the input or not found"}, status=400)

        return web.json_response({"error": "Provide one of: hash, version_id, model_id, model"}, status=400)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.get("/civitai/model-detail")
async def model_detail(request):
    try:
        model_id = request.query.get("id")
        if not model_id:
            return web.json_response({"error": "Missing id"}, status=400)
        domain = utils._get_active_domain()
        data = await _civitai_call(
            utils.CivitaiAPIUtils.get_model_info_by_id, int(model_id), domain)
        return web.json_response(data or {})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.get("/civitai/model/{model_id}")
async def model_by_id(request):
    try:
        model_id = request.match_info.get("model_id")
        if not model_id:
            return web.json_response({"error": "Missing model_id"}, status=400)
        domain = utils._get_active_domain()
        data = await _civitai_call(
            utils.CivitaiAPIUtils.get_model_info_by_id, int(model_id), domain)
        return web.json_response(data or {})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.get("/civitai/local-preview")
async def local_preview(request):
    try:
        path = request.query.get("path", "")
        ok, path = _safe_model_path(path)
        if not ok:
            return web.Response(status=400, text=path or "Invalid path")
        if not os.path.isfile(path):
            return web.Response(status=404, text="Not found")

        # w / q are clamped so a caller cannot ask us to decode something huge.
        try:
            max_w = int(request.query.get("w", "") or 0)
        except ValueError:
            max_w = 0
        try:
            quality = int(request.query.get("q", "") or 72)
        except ValueError:
            quality = 72
        max_w = max(32, min(2048, max_w)) if max_w else 0
        quality = max(20, min(95, quality))

        ext = os.path.splitext(path)[1].lower()
        ct = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
              ".webp": "image/webp", ".gif": "image/gif"}.get(ext, "image/png")

        # The ETag covers path + mtime + transform, so reopening a model the
        # browser has already seen costs a 304 instead of the whole preview.
        mtime = os.path.getmtime(path)
        etag = '"%s"' % hashlib.md5(
            f"{path}:{mtime}:{max_w}:{quality}".encode()).hexdigest()
        cache_hdr = {"Cache-Control": "public, max-age=86400", "ETag": etag}
        if request.headers.get("If-None-Match") == etag:
            return web.Response(status=304, headers=cache_hdr)

        # Animated GIFs pass through untouched: resizing keeps only one frame.
        if max_w and ext != ".gif":
            try:
                loop = asyncio.get_event_loop()
                img_bytes, out_ct = await loop.run_in_executor(
                    None, _resize_preview, path, max_w, quality)
                return web.Response(body=img_bytes, content_type=out_ct,
                                    headers=cache_hdr)
            except Exception:
                logger.debug("local_preview: ignoring Exception", exc_info=True)
                # fall through to the original file

        # Conditional requests. HTTP dates go through email.utils, which
        # understands the format and the GMT zone: strptime("%Z") produced a
        # naive datetime that .timestamp() then interpreted as local time, so
        # the comparison was wrong by the machine's UTC offset.
        ims = request.headers.get("If-Modified-Since")
        if ims:
            try:
                since = parsedate_to_datetime(ims)
                if since and mtime <= since.timestamp():
                    return web.Response(status=304, headers=cache_hdr)
            except (TypeError, ValueError, OverflowError):
                logger.debug("local_preview: ignoring (TypeError, ValueError, OverflowError)", exc_info=True)
        headers = dict(cache_hdr)
        headers["Last-Modified"] = formatdate(mtime, usegmt=True)
        return web.FileResponse(path, headers=headers)
    except Exception as e:
        return web.Response(status=500, text=str(e))


_preview_cache_dir = os.path.join(os.path.dirname(__file__), ".preview_cache")
os.makedirs(_preview_cache_dir, exist_ok=True)

_PREVIEW_CACHE_MAX_FILES = 3000
_PREVIEW_CACHE_MAX_BYTES = 256 * 1024 * 1024
_preview_cache_writes = 0


def _prune_preview_cache():
    """Keep the on-disk thumbnail cache from growing without bound.

    Oldest-accessed entries go first. Called every few dozen writes so a
    large Local tab does not stat the whole directory once per image.
    """
    try:
        entries = []
        total = 0
        for name in os.listdir(_preview_cache_dir):
            p = os.path.join(_preview_cache_dir, name)
            try:
                st = os.stat(p)
            except OSError:
                logger.debug("_prune_preview_cache: skipping after OSError", exc_info=True)
                continue
            if not os.path.isfile(p):
                continue
            entries.append((st.st_atime, st.st_mtime, st.st_size, p))
            total += st.st_size
        if len(entries) <= _PREVIEW_CACHE_MAX_FILES and total <= _PREVIEW_CACHE_MAX_BYTES:
            return
        entries.sort()
        while entries and (len(entries) > _PREVIEW_CACHE_MAX_FILES
                           or total > _PREVIEW_CACHE_MAX_BYTES):
            _, _, size, p = entries.pop(0)
            try:
                os.remove(p)
                total -= size
            except OSError:
                logger.debug("_prune_preview_cache: ignoring OSError", exc_info=True)
    except Exception:
        logger.debug("_prune_preview_cache: ignoring Exception", exc_info=True)


def _resize_preview(path, max_w, quality):
    """Downscale and re-encode a preview. Returns (bytes, content_type).

    Always WebP: a 450px-wide PNG preview is typically 25-800 KB while the
    same frame as WebP q72 is 3-75 KB, and every browser that runs the
    ComfyUI frontend decodes WebP. Nothing is upscaled - a source smaller
    than max_w is only re-encoded.
    """
    from PIL import Image
    import io
    import hashlib as _hl

    cache_key = _hl.md5(f"{path}:{max_w}:{quality}".encode()).hexdigest()
    cache_path = os.path.join(_preview_cache_dir, cache_key + ".webp")
    try:
        src_mtime = os.path.getmtime(path)
        if os.path.isfile(cache_path) and os.path.getmtime(cache_path) >= src_mtime:
            with open(cache_path, "rb") as f:
                return f.read(), "image/webp"
    except Exception:
        logger.debug("_resize_preview: ignoring Exception", exc_info=True)

    img = Image.open(path)
    img.load()
    if img.mode == "P":
        img = img.convert("RGBA" if "transparency" in img.info else "RGB")
    elif img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGBA" if "A" in img.getbands() else "RGB")
    if img.width > max_w:
        ratio = max_w / img.width
        new_h = max(1, int(img.height * ratio))
        img = img.resize((max_w, new_h), Image.LANCZOS)
    out = io.BytesIO()
    try:
        img.save(out, format="WEBP", quality=quality, method=4)
        content_type = "image/webp"
    except Exception:
        # Pillow built without WebP - degrade to JPEG rather than PNG, which
        # is several times larger for the same frame.
        out = io.BytesIO()
        img.convert("RGB").save(out, format="JPEG", quality=quality, optimize=True)
        content_type = "image/jpeg"
    data = out.getvalue()

    global _preview_cache_writes
    try:
        with open(cache_path, "wb") as f:
            f.write(data)
        _preview_cache_writes += 1
        if _preview_cache_writes % 50 == 0:
            _prune_preview_cache()
    except Exception:
        logger.debug("_resize_preview: ignoring Exception", exc_info=True)
    return data, content_type

@routes.get("/civitai/model-versions")
async def model_versions(request):
    try:
        model_id = request.query.get("id")
        if not model_id:
            return web.json_response({"error": "Missing id"}, status=400)
        domain = utils._get_active_domain()
        loop = asyncio.get_event_loop()
        resp = await loop.run_in_executor(
            None, lambda: utils.CivitaiAPIUtils._request_with_retry(
                f"https://{domain}/api/v1/models/{model_id}"
            )
        )
        data = resp.json()
        versions = data.get("modelVersions", [])
        has_key = _civitai_has_key()
        for v in versions:
            v["modelName"] = data.get("name", "")
            v["modelId"] = data.get("id")
            files = v.get("files") or []
            primary = None
            for f in files:
                if isinstance(f, dict) and f.get("primary"):
                    primary = f
                    break
            if primary is None and files:
                primary = files[0]
            v["dl_status"] = _dl_status(data, v, primary, has_key)
        return web.json_response({"items": versions})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.get("/civitai/model-version-detail")
async def model_version_detail(request):
    try:
        version_id = request.query.get("id")
        if not version_id:
            return web.json_response({"error": "Missing id"}, status=400)
        domain = utils._get_active_domain()
        data = await _civitai_call(
            utils.CivitaiAPIUtils.get_model_version_info_by_id, int(version_id), domain
        )
        return web.json_response(data or {})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.get("/civitai/images")
async def model_images(request):
    try:
        version_id = request.query.get("versionId")
        page = int(request.query.get("page", 1))
        domain = utils._get_active_domain()
        params = {"modelVersionId": version_id, "limit": 100, "page": page}
        loop = asyncio.get_event_loop()
        resp = await loop.run_in_executor(
            None, lambda: utils.CivitaiAPIUtils._request_with_retry(
                f"https://{domain}/api/v1/images", params=params
            )
        )
        return web.json_response(resp.json())
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


# ── Download ───────────────────────────────────────────────────────────

DOWNLOAD_TASKS = {}

def _with_civitai_token(url, api_key):
    """Civitai's download endpoint takes the API key as ?token= — the
    Authorization header alone is not always accepted."""
    if not api_key or not isinstance(api_key, str) or "civitai" not in (url or ""):
        return url
    if "token=" in url:
        return url
    return url + ("&" if "?" in url else "?") + "token=" + api_key


def _civitai_refusal(code, body):
    """Turn one of Civitai's refusals into something worth showing.

    These arrive as a small JSON body \u2014 {"error": "Early Access", "message":
    "This asset is in Early Access. You can use Buzz access it now!"} \u2014
    which is far more use than the status code alone.
    """
    detail = ""
    try:
        raw = body.decode("utf-8", "replace") if isinstance(body, bytes) else str(body or "")
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            detail = str(parsed.get("message") or parsed.get("error") or "").strip()
    except Exception:
        detail = ""
    if code == 401:
        return detail or ("Civitai needs a login for this model \u2014 add your API key in Settings.")
    if code == 403:
        return (detail + " Unlock it on Civitai, then download again.") if detail \
            else "Civitai refused this download \u2014 the model is locked behind Early Access."
    if code == 404:
        return "Civitai has no file at that address."
    if code == 429:
        return "Civitai is rate-limiting this account \u2014 wait a moment and retry."
    return detail or ("Civitai returned HTTP %d for this download." % code)


def _download_candidates(download_url, model_version_id, file_meta, domain):
    """Every address we know for one file, most specific first.

    Civitai exposes several, and they do not all work for every model: a
    version may serve its primary file from /api/download/models/<id> but
    refuse the ?type=&format= form, or the other way round. Rather than
    betting on one, they are tried in order until one answers with a body.
    """
    out = []

    def add(label, url):
        if not url or not isinstance(url, str):
            return
        if any(u == url for _, u in out):
            return
        out.append((label, url))

    add("the file's own link", download_url)
    if model_version_id:
        base = "https://%s/api/download/models/%s" % (domain, model_version_id)
        add("the version link", base)
        meta = (file_meta or {}).get("metadata") or {}
        ftype, fmt = meta.get("type"), meta.get("format")
        if ftype and fmt:
            add("the %s/%s link" % (ftype, fmt),
                "%s?type=%s&format=%s" % (base, urllib.parse.quote(str(ftype)),
                                          urllib.parse.quote(str(fmt))))
    return out


def _civitai_download_error(e):
    """Explain Civitai's refusals instead of showing a bare HTTP code."""
    code = getattr(e, "code", 0)
    if code in (401, 403):
        return ("Civitai refused this download (HTTP %d) — the creator requires you to be "
                "logged in. Add your Civitai API key in Settings (civitai.com → Account → "
                "API keys). Some creators block API downloads entirely, and Blocked/XXX "
                "models also need mature content enabled on your Civitai account." % code)
    if code == 404:
        return ("Civitai has no download for this file (HTTP 404) — it may have been removed, "
                "or the version needs a specific file/variant picked.")
    if code == 429:
        return "Civitai is rate-limiting this download (HTTP 429). Wait a little and retry."
    return "Download failed: %s" % e


@routes.post("/civitai/download")
async def start_download(request):
    try:
        data = await request.json()
        download_url = data.get("url")
        model_version_id = data.get("model_version_id")
        model_type = data.get("save_as") or data.get("type", "")
        # Strip, not just truthiness: a name of "   " would be skipped by
        # _safe_download_path, leaving the subfolder itself as the target —
        # which then collides with the folder the previous download made.
        filename = (data.get("filename") or "").strip() or "model.safetensors"
        subfolder = data.get("subfolder", "")
        overwrite = data.get("overwrite", False)
        save_metadata = data.get("save_metadata", False)
        save_preview = data.get("save_preview", False)
        metadata_only = data.get("metadata_only", False)
        # True when the client built the name itself — either from a naming
        # template or by typing one. The remote server must not then rename
        # the file out from under the user through Content-Disposition.
        name_template = bool(data.get("name_template"))

        domain = utils._get_active_domain()

        if model_version_id and str(model_version_id).strip() and not download_url:
            # Try fetching version info to get actual download URL from Civitai
            try:
                vi = await loop.run_in_executor(
                    None, utils.CivitaiAPIUtils.get_model_version_info_by_id,
                    int(model_version_id), domain
                )
                if vi and vi.get("downloadUrl"):
                    download_url = vi["downloadUrl"]
                elif vi and vi.get("files") and len(vi["files"]) > 0:
                    # Try to construct URL from file info if downloadUrl not present
                    download_url = f"https://{domain}/api/download/models/{model_version_id}"
                else:
                    download_url = f"https://{domain}/api/download/models/{model_version_id}"
            except Exception:
                download_url = f"https://{domain}/api/download/models/{model_version_id}"

        if not download_url:
            return web.json_response(
                {"error": "Nothing to download — open the model and pick a version/file first "
                          "(no url or model_version_id was sent)."}, status=400)

        loop = asyncio.get_event_loop()

        # Resolve "auto" folder — fetch version info to determine type (async).
        # The same response carries the file list, which also gives the
        # download a third address to try, so it is fetched once and shared.
        loop = asyncio.get_event_loop()
        vi = None
        if model_version_id:
            try:
                vi = await loop.run_in_executor(
                    None, utils.CivitaiAPIUtils.get_model_version_info_by_id,
                    int(model_version_id), domain
                )
            except Exception:
                logger.debug("could not fetch version info for %s", model_version_id,
                             exc_info=True)
                vi = None
        if not model_type or model_type == "auto":
            try:
                civitai_type = (vi.get("model") or {}).get("type", "")
                model_type = {
                    "Checkpoint": "checkpoints", "LORA": "loras", "LoCon": "loras",
                    "DoRA": "loras", "VAE": "vae", "Controlnet": "controlnet",
                    "TextualInversion": "embeddings", "Hypernetwork": "hypernetworks",
                    "Upscaler": "upscale_models", "MotionModule": "animatediff_models",
                }.get(civitai_type, "other")
            except Exception:
                model_type = "loras"

        # Which file is being asked for, so the download can fall back to the
        # ?type=&format= form of the URL if the plain one refuses.
        file_meta = None
        for f in (vi or {}).get("files") or []:
            if isinstance(f, dict) and (f.get("name") or "") == filename:
                file_meta = f
                break

        # The destination folder, subfolder and filename are all chosen in
        # the download modal, so they are built into a path through one
        # containment check rather than a bare join.
        ok, save_path = _safe_download_path(model_type, subfolder, filename)
        if not ok:
            # Name every part: with only the resolved path the user cannot
            # tell which of the three boxes in the modal is at fault.
            return web.json_response(
                {"error": "That destination is not allowed \u2014 %s "
                          "(folder %r, subfolder %r, file %r). Remove any "
                          "\"..\", leading / or drive letter and try again."
                          % (save_path, model_type, subfolder, filename)},
                status=400)
        save_dir = os.path.dirname(save_path)
        os.makedirs(save_dir, exist_ok=True)
        if os.path.isdir(save_path):
            # Almost always a name collision: something was already saved
            # here as a folder, so this file cannot take the same name.
            return web.json_response(
                {"error": "A folder already exists called " + os.path.basename(save_path)
                          + " \u2014 give the file a different name, or use a "
                            "different subfolder."},
                status=400)

        # For metadata-only jobs, just fetch & save metadata then return
        if metadata_only:
            asyncio.ensure_future(_save_metadata_and_preview(
                model_version_id, save_path, save_metadata, save_preview, domain, ""
            ))
            return web.json_response({"task_id": "meta_" + str(model_version_id),
                                      "id": "meta_" + str(model_version_id)})

        task_id = f"dl_{int(time.time())}_{hashlib.md5(download_url.encode()).hexdigest()[:8]}"
        DOWNLOAD_TASKS[task_id] = {
            "id": task_id, "url": download_url, "filename": filename,
            "type": model_type, "progress": 0, "speed": 0,
            "status": "downloading", "path": save_path, "cancelled": False,
            "subfolder": subfolder, "model_version_id": model_version_id,
            "name_template": name_template,
            "started_at": time.time(),
            "retry_endpoint": "/civitai/download",
            "retry_payload": {
                "url": download_url, "model_version_id": model_version_id,
                "save_as": model_type, "filename": filename, "subfolder": subfolder,
                "overwrite": True, "save_metadata": save_metadata,
                "save_preview": save_preview, "name_template": name_template,
            },
        }

        def _download_blocking():
            nonlocal filename, save_path
            req_headers = {"User-Agent": "Mozilla/5.0"}
            api_key = utils.db_manager.get_setting("civitai_api_key")
            if api_key and isinstance(api_key, str) and "civitai" in download_url:
                req_headers["Authorization"] = f"Bearer {api_key}"

            # Resume. A download interrupted part-way — network drop, ComfyUI
            # restart — leaves a partial file behind, and the old behaviour
            # was to start a 12 GB checkpoint again from zero. If the marker
            # beside the file names the same URL and the file is genuinely
            # short of the total, ask for the rest instead.
            #
            # The marker is only trusted when it matches the URL, so a
            # different model landing on the same path can never be appended
            # to. If the server ignores Range, we get 200 back rather than
            # 206 and simply start over.
            part_path = save_path + ".part.json"
            part = _read_part(part_path)
            resume_from = _resume_point(save_path, part, download_url)
            if resume_from:
                req_headers["Range"] = "bytes=%d-" % resume_from

            def _open(url, headers):
                # The key is added to this request only — the task, and the
                # retry payload the UI keeps, store the URL without it.
                return urllib.request.urlopen(
                    urllib.request.Request(
                        _with_civitai_token(url, api_key), headers=headers),
                    timeout=300,
                )

            # Try every address we know for this file. Civitai is not
            # consistent about which one works, so one refusing is not the
            # same as the model being undownloadable.
            candidates = _download_candidates(
                download_url, model_version_id, file_meta, domain)
            resp = None
            used = ""
            last_error = None
            for label, url in candidates:
                try:
                    opened = _open(url, req_headers)
                except urllib.error.HTTPError as e:
                    try:
                        body = e.read()
                    except Exception:
                        body = b""
                    refusal = _civitai_refusal(e.code, body)
                    # 401 and 403 are Civitai refusing the *model*, not this
                    # address — no other URL will change the answer.
                    if e.code in (401, 403):
                        raise RuntimeError(refusal)
                    logger.debug("download strategy %r failed: HTTP %s", label, e.code)
                    last_error = "%s (HTTP %s): %s" % (label, e.code, refusal)
                    continue
                except Exception as e:
                    logger.debug("download strategy %r failed", label, exc_info=True)
                    last_error = "%s: %s" % (label, e)
                    continue

                if "text/html" in (opened.headers.get("Content-Type") or "").lower():
                    opened.close()
                    last_error = ("%s: Civitai returned a login page instead of the "
                                  "model — set a Civitai API key in Settings" % label)
                    continue

                if resume_from and opened.status != 206:
                    # The server did not honour Range, so what is on disk is
                    # not a prefix of this response — start over rather than
                    # splice two different files together.
                    opened.close()
                    logger.debug("resume refused for %s (HTTP %s), starting over",
                                 save_path, opened.status)
                    resume_from = 0
                    part = None
                    req_headers.pop("Range", None)
                    try:
                        opened = _open(url, req_headers)
                    except Exception as e:
                        last_error = "%s: %s" % (label, e)
                        continue

                resp = opened
                used = label
                break

            if resp is None:
                raise RuntimeError(
                    last_error or "Civitai did not return a download for this model.")
            if task_id in DOWNLOAD_TASKS:
                DOWNLOAD_TASKS[task_id]["strategy"] = used

            try:
                total = int(resp.headers.get("Content-Length", 0))
                content_range = resp.headers.get("Content-Range", "")
                if content_range and "/" in content_range:
                    # "bytes 100-999/1000": the total is after the slash
                    try:
                        total = int(content_range.rsplit("/", 1)[1])
                    except (IndexError, ValueError):
                        logger.debug("unreadable Content-Range %r", content_range, exc_info=True)
                if resume_from and part and int(part.get("total") or 0) != total:
                    resume_from = 0
                # Try to get real filename from Content-Disposition
                cd = resp.headers.get("Content-Disposition", "")
                if cd:
                    m = re.search(r'filename\*?=(?:UTF-8\'\')?["\']?([^"\';\n]+)', cd)
                    if m:
                        real_name = urllib.parse.unquote(m.group(1))
                        # Content-Disposition is text from the remote server:
                        # keep only the file name and re-check where it lands.
                        real_name = _safe_name(real_name)
                        # A name the client built itself wins: a naming
                        # template is a decision the user made, and letting
                        # the remote server rename the file would quietly
                        # undo it.
                        if real_name and real_name != filename and not name_template:
                            ok_name, new_path = _safe_download_path(
                                model_type, subfolder, real_name)
                            if ok_name and not os.path.isdir(new_path):
                                filename = real_name
                                save_path = new_path
                                if task_id in DOWNLOAD_TASKS:
                                    DOWNLOAD_TASKS[task_id].update(
                                        {"filename": filename, "path": save_path})
                downloaded = resume_from
                last_mark = resume_from
                start_t = time.time()
                if resume_from and task_id in DOWNLOAD_TASKS:
                    DOWNLOAD_TASKS[task_id]["resumed_from"] = resume_from
                # "ab" when resuming: the bytes already on disk are the
                # beginning of this file, so they must be kept.
                with open(save_path, "ab" if resume_from else "wb") as f:
                    while True:
                        if DOWNLOAD_TASKS.get(task_id, {}).get("cancelled"):
                            DOWNLOAD_TASKS[task_id]["status"] = "cancelled"
                            f.close()
                            if os.path.exists(save_path):
                                os.remove(save_path)
                            if os.path.exists(part_path):
                                os.remove(part_path)
                            return True
                        chunk = resp.read(8192)
                        if not chunk:
                            break
                        f.write(chunk)
                        downloaded += len(chunk)
                        elapsed = time.time() - start_t
                        speed = downloaded / elapsed if elapsed > 0 else 0
                        progress = int(downloaded / total * 100) if total > 0 else 0
                        if task_id in DOWNLOAD_TASKS:
                            DOWNLOAD_TASKS[task_id].update({
                                "progress": progress, "speed": speed,
                                "downloaded": downloaded, "total": total,
                            })
                        # Keep the marker roughly in step with the disk, so an
                        # interruption at any point is resumable. Every 4 MB
                        # is often enough to matter and rare enough to be free.
                        if downloaded - last_mark >= (4 << 20):
                            _write_part(part_path,
                                        {"url": download_url, "total": total,
                                         "size": downloaded})
                            last_mark = downloaded
                # Finished: the file is whole, so the marker is no longer
                # needed — and leaving it would let a later, unrelated
                # download resume onto this file.
                if os.path.exists(part_path):
                    try:
                        os.remove(part_path)
                    except Exception:
                        logger.debug("could not clear the resume marker at %s",
                                     part_path, exc_info=True)
            finally:
                try:
                    resp.close()
                except Exception:
                    logger.debug("could not close the download response", exc_info=True)
            return False

        async def _download():
            nonlocal filename, save_path
            try:
                # Run blocking network + disk I/O in a thread so the event loop
                # stays responsive (progress polling, other requests, etc.)
                cancelled = await loop.run_in_executor(None, _download_blocking)
                if cancelled:
                    return
                if task_id in DOWNLOAD_TASKS:
                    DOWNLOAD_TASKS[task_id]["status"] = "completed"
                    DOWNLOAD_TASKS[task_id]["progress"] = 100
                # Always compute SHA256 hash after download
                file_hash = ""
                try:
                    file_hash = await loop.run_in_executor(
                        None, utils.CivitaiAPIUtils.calculate_sha256, save_path
                    )
                    if task_id in DOWNLOAD_TASKS:
                        DOWNLOAD_TASKS[task_id]["hash"] = file_hash
                        # Civitai publishes a hash for most files. Comparing
                        # it is the only way to catch a truncated transfer,
                        # which otherwise looks fine until the model fails
                        # to load.
                        expected = await _expected_sha256(
                            model_version_id, filename, domain)
                        if expected:
                            same = expected.strip().lower() == file_hash.strip().lower()
                            DOWNLOAD_TASKS[task_id]["verified"] = "ok" if same else "mismatch"
                            DOWNLOAD_TASKS[task_id]["hash_expected"] = expected
                            if not same:
                                logger.warning(
                                    "hash mismatch for %s: downloaded %s but Civitai "
                                    "advertises %s — the file is probably truncated",
                                    save_path, file_hash, expected)
                except Exception:
                    logger.warning("could not hash or save metadata after downloading %s", save_path, exc_info=True)
                # Fetch and save metadata / preview after download
                await _save_metadata_and_preview(
                    model_version_id, save_path, save_metadata, save_preview, domain, file_hash
                )
            except urllib.error.HTTPError as e:
                if task_id in DOWNLOAD_TASKS:
                    DOWNLOAD_TASKS[task_id]["status"] = "error"
                    DOWNLOAD_TASKS[task_id]["error"] = _civitai_download_error(e)
                    _record_history(task_id, "error")
            except Exception as e:
                if task_id in DOWNLOAD_TASKS:
                    DOWNLOAD_TASKS[task_id]["status"] = "error"
                    DOWNLOAD_TASKS[task_id]["error"] = str(e)
                    _record_history(task_id, "error")
            else:
                _record_history(task_id, DOWNLOAD_TASKS.get(task_id, {}).get("status", "completed"))

        asyncio.ensure_future(_download())
        # `id` mirrors the Hugging Face route — the UI reads that field
        return web.json_response({"task_id": task_id, "id": task_id, "filename": filename})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


async def _expected_sha256(model_version_id, filename, domain):
    """The SHA256 Civitai advertises for this file, or "" if it gives none.

    Matched on the file name first, because a version can ship several
    files (a fp16 and a pruned variant, say) each with its own hash — the
    version-level hash would only match one of them.
    """
    if not model_version_id:
        return ""
    try:
        vi = await asyncio.get_event_loop().run_in_executor(
            None, utils.CivitaiAPIUtils.get_model_version_info_by_id,
            int(model_version_id), domain
        )
    except Exception:
        logger.debug("could not fetch the advertised hash for version %s",
                     model_version_id, exc_info=True)
        return ""
    files = (vi or {}).get("files") or []
    for f in files:
        if isinstance(f, dict) and (f.get("name") or "") == filename:
            return str(((f.get("hashes") or {}).get("SHA256")) or "")
    if len(files) == 1 and isinstance(files[0], dict):
        return str(((files[0].get("hashes") or {}).get("SHA256")) or "")
    return ""


async def _save_metadata_and_preview(model_version_id, save_path, save_metadata, save_preview, domain, file_hash=""):
    """Fetch Civitai version info and save .civitai.json + all preview images."""
    if not model_version_id:
        # No version ID — just save hash if available
        if file_hash:
            try:
                meta = {"hashes": {"SHA256": file_hash}}
                loop = asyncio.get_event_loop()
                await loop.run_in_executor(None, _write_json, os.path.splitext(save_path)[0] + ".civitai.json", meta)
            except Exception:
                logger.warning("could not save the SHA256 sidecar for %s", save_path, exc_info=True)
        return
    loop = asyncio.get_event_loop()
    try:
        vi = await loop.run_in_executor(
            None, utils.CivitaiAPIUtils.get_model_version_info_by_id,
            int(model_version_id), domain
        )
        if not vi:
            return
    except Exception:
        logger.warning("could not fetch version info for %s, so no metadata was saved", model_version_id, exc_info=True)
        return

    base = os.path.splitext(save_path)[0]

    # Inject computed hash into version info
    if file_hash:
        if "hashes" not in vi:
            vi["hashes"] = {}
        vi["hashes"]["SHA256"] = file_hash
        files = vi.get("files", [])
        if files and isinstance(files[0], dict):
            if "hashes" not in files[0]:
                files[0]["hashes"] = {}
            files[0]["hashes"]["SHA256"] = file_hash

    # Always save .civitai.json with hash
    meta_path = base + ".civitai.json"
    try:
        # Enrich with full model description if save_metadata is on
        model_id = vi.get("modelId") or (vi.get("model") or {}).get("id")
        if model_id and save_metadata:
            try:
                mresp = await loop.run_in_executor(
                    None, lambda: utils.CivitaiAPIUtils._request_with_retry(
                        f"https://{domain}/api/v1/models/{model_id}"
                    )
                )
                model_data = mresp.json()
                if "model" not in vi:
                    vi["model"] = model_data
                else:
                    vi["model"]["description"] = model_data.get("description", "")
                    vi["model"]["name"] = model_data.get("name", "")
            except Exception:
                logger.debug("could not enrich metadata with the model description", exc_info=True)
        await loop.run_in_executor(None, _write_json, meta_path, vi)
    except Exception:
        logger.warning("could not save metadata for %s", save_path, exc_info=True)

    # Download all preview images
    if save_preview:
        images = vi.get("images", [])
        dl_tasks = []
        for idx, img in enumerate(images):
            img_url = img.get("url", "") if isinstance(img, dict) else ""
            if not img_url:
                continue
            # Saved previews are kept at full resolution
            img_url = _full_res_url(img_url)
            # Number images starting from 1; first image keeps base name for compatibility
            if idx == 0:
                img_path = base + ".png"
            else:
                img_path = f"{base}_{idx + 1}.png"
            if os.path.isfile(img_path):
                continue
            dl_tasks.append((img_url, img_path))
        if dl_tasks:
            await asyncio.gather(*[
                loop.run_in_executor(None, _download_file, url, p)
                for url, p in dl_tasks
            ])


def _record_history(task_id, status):
    """Put a finished job in the download history.

    The queue clears itself, so without this there is no trace that a model
    was ever fetched — nothing to re-download from, and no way to tell where
    a file in the library came from.
    """
    task = DOWNLOAD_TASKS.get(task_id)
    if not task:
        return
    path = task.get("path") or ""
    try:
        size = os.path.getsize(path) if path and os.path.isfile(path) else 0
    except Exception:
        size = 0
    history_store.add({
        "id": task.get("id") or task_id,
        "source": task.get("source") or ("hf" if task_id.startswith("hf_") else "civitai"),
        "name": task.get("filename") or "",
        "filename": task.get("filename") or "",
        "url": task.get("url") or "",
        "path": path,
        "type": task.get("type") or "",
        "subfolder": task.get("subfolder") or "",
        "model_version_id": task.get("model_version_id"),
        "repo_id": task.get("hf_repo_id") or "",
        "repo_path": task.get("hf_path") or "",
        "status": status,
        "size": size,
        "hash": task.get("hash") or "",
        "verified": task.get("verified") or "",
        "error": task.get("error") or "",
        "started_at": task.get("started_at") or 0,
    })


def _read_part(path):
    """Resume marker left beside a partial download, or None."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def _resume_point(save_path, part, url):
    """How many bytes of `save_path` are already the start of `url`.

    Returns 0 when there is nothing trustworthy to resume from. The marker is
    only honoured when it names the same URL and the file is genuinely short
    of the recorded total, so a partial download of one model can never be
    appended to by a different one that lands on the same path.
    """
    if not part or not url or part.get("url") != url:
        return 0
    if not os.path.isfile(save_path):
        return 0
    try:
        have = os.path.getsize(save_path)
    except OSError:
        return 0
    want = int(part.get("total") or 0)
    if 0 < have < want:
        return have
    return 0


def _write_part(path, data):
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f)
    except Exception:
        logger.debug("could not write the resume marker at %s", path, exc_info=True)


def _write_json(path, data):
    import json
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def _full_res_url(url):
    """Force a Civitai CDN image URL to full/original resolution.

    Preview images saved alongside a downloaded model are kept at full
    resolution (the in-UI browser uses low-res thumbnails separately).
    """
    if not url or "image.civitai.com" not in url:
        return url
    # Replace an existing width=NNN[,params] transform segment with original=true
    new = re.sub(r"/width=\d+(?:,[^/]*)?(?=/)", "/original=true", url)
    if new != url:
        return new
    # Already original=true (optionally with params) -> leave as-is
    if re.search(r"/original=true(?:,[^/]*)?(?=/)", url):
        return url
    # No transform segment -> insert original=true before the filename
    return re.sub(r"/([^/]+\.(?:jpe?g|png|webp|gif|avif))(\?|$)",
                  r"/original=true/\1\2", url, flags=re.IGNORECASE)


def _download_file(url, path):
    import urllib.request
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        with open(path, "wb") as f:
            f.write(resp.read())


@routes.get("/civitai/downloads")
async def list_downloads(request):
    # Clean up completed/errored tasks older than 30 minutes
    now = time.time()
    stale = [k for k, v in DOWNLOAD_TASKS.items()
             if v.get("status") in ("completed", "error", "cancelled")
             and now - v.get("started_at", now) > 1800]
    for k in stale:
        del DOWNLOAD_TASKS[k]
    items = list(DOWNLOAD_TASKS.values())
    return web.json_response({"items": items})


@routes.post("/civitai/downloads-clear")
async def clear_downloads(request):
    """Remove finished (completed / error / cancelled) jobs from the task list."""
    try:
        try:
            data = await request.json()
        except Exception:
            data = {}
        task_id = data.get("task_id")
        finished = ("completed", "done", "error", "cancelled")
        if task_id:
            job = DOWNLOAD_TASKS.get(task_id)
            if not job:
                return web.json_response({"error": "Task not found"}, status=404)
            if job.get("status") not in finished:
                return web.json_response({"error": "Task still active"}, status=400)
            del DOWNLOAD_TASKS[task_id]
            return web.json_response({"success": True, "cleared": 1})
        stale = [k for k, v in DOWNLOAD_TASKS.items() if v.get("status") in finished]
        for k in stale:
            del DOWNLOAD_TASKS[k]
        return web.json_response({"success": True, "cleared": len(stale)})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.post("/civitai/download-cancel")
async def cancel_download(request):
    try:
        data = await request.json()
        task_id = data.get("task_id")
        if task_id in DOWNLOAD_TASKS:
            DOWNLOAD_TASKS[task_id]["cancelled"] = True
            return web.json_response({"success": True})
        return web.json_response({"error": "Task not found"}, status=404)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


# ── Local Models ──────────────────────────────────────────────────────

_local_models_cache = {"data": None, "time": 0}
_local_cache_lock = threading.Lock()
_LOCAL_CACHE_TTL = 30  # seconds

@routes.get("/civitai/history")
async def get_history(request):
    """Finished downloads, newest first, whether or not the queue kept them."""
    try:
        items = history_store.load()
        limit = int(request.query.get("limit", 0)) or 0
        if limit > 0:
            items = items[:limit]
        return web.json_response({"items": items})
    except Exception as e:
        return web.json_response({"items": [], "error": str(e)})


@routes.post("/civitai/history-clear")
async def clear_history(request):
    try:
        history_store.clear()
        return web.json_response({"success": True})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.post("/civitai/history-delete")
async def delete_history(request):
    try:
        data = await request.json()
        entry_id = data.get("id") or data.get("task_id") or ""
        history_store.remove(entry_id)
        return web.json_response({"success": True})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.get("/civitai/local-models")
async def local_models(request):
    try:
        force = request.query.get("force_refresh", "false").lower() == "true"
        now = time.time()
        if not force:
            with _local_cache_lock:
                if _local_models_cache["data"] is not None and (now - _local_models_cache["time"]) < _LOCAL_CACHE_TTL:
                    models = _local_models_cache["data"]
                    return web.json_response({"models": models, "total": len(models)})
        loop = asyncio.get_event_loop()
        models = await loop.run_in_executor(None, utils.scan_local_models_direct)
        with _local_cache_lock:
            _local_models_cache["data"] = models
            _local_models_cache["time"] = now
        # Fire background DB sync if force_refresh so next load has hashes
        if force:
            asyncio.ensure_future(_bg_local_sync())
        return web.json_response({"models": models, "total": len(models)})
    except Exception as e:
        # Return cached data if available on error
        if _local_models_cache["data"] is not None:
            models = _local_models_cache["data"]
            return web.json_response({"models": models, "total": len(models), "cached": True})
        return web.json_response({"models": [], "total": 0, "error": str(e)})


async def _bg_local_sync():
    """Sync local files with DB in background — doesn't block the response."""
    try:
        loop = asyncio.get_event_loop()
        for mt in utils.SUPPORTED_MODEL_TYPES:
            await loop.run_in_executor(None, utils.sync_local_files_with_db, mt, True)
    except Exception:
        logger.debug("_bg_local_sync: ignoring Exception", exc_info=True)


@routes.post("/civitai/rescan")
async def rescan_models(request):
    try:
        data = await request.json() if request.can_read_body else {}
        model_type = data.get("model_type", "all")
        force = data.get("force", False)
        if model_type == "all":
            utils.scan_all_supported_model_types(force=True)
        else:
            utils.sync_local_files_with_db(model_type, force=True)
        return web.json_response({"success": True, "message": "Rescan complete"})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.post("/civitai/delete-model")
async def delete_model(request):
    try:
        data = await request.json()
        model_path = data.get("path")
        ok, model_path = _safe_model_path(model_path)
        if not ok:
            return web.json_response({"error": model_path or "File not found"}, status=404)
        model_dir = os.path.dirname(model_path)

        # Remove model file
        os.remove(model_path)

        # Remove the sidecar metadata and every preview image belonging to
        # THIS model. utils.preview_paths_for matches the exact stem, so a
        # deletion can no longer take a sibling's preview (flux-dev vs
        # flux-dev-v2), and it also covers the preview/ subfolder that used
        # to be left behind.
        removed = []
        for extra in [utils.sidecar_path_for(model_path)] + utils.preview_paths_for(model_path):
            if os.path.isfile(extra):
                os.remove(extra)
                removed.append(extra)

        # Tidy the containing folder only when it is an empty subdirectory of
        # a models dir - never a models root, which ComfyUI expects to exist.
        try:
            if not os.listdir(model_dir) and _is_subdir_of_models(model_dir):
                os.rmdir(model_dir)
        except Exception:
            logger.debug("could not remove empty folder %s", model_dir, exc_info=True)

        # Invalidate local models cache
        with _local_cache_lock:
            _local_models_cache["data"] = None
            _local_models_cache["time"] = 0

        return web.json_response({"success": True, "removed": removed})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


# ── Auto-Tag ──────────────────────────────────────────────────────────

@routes.post("/civitai/auto-tag")
async def auto_tag(request):
    try:
        data = await request.json() if request.can_read_body else {}
        model_type = data.get("model_type", "all")
        def _work():
            tagged = 0
            types_to_process = (
                ["checkpoints", "loras", "vae"] if model_type == "all" else [model_type]
            )
            for mt in types_to_process:
                name_to_hash, _ = utils.get_local_model_maps(mt)
                for name, fhash in name_to_hash.items():
                    full_path = folder_paths.get_full_path(mt, name)
                    if not full_path or not os.path.exists(full_path):
                        continue
                    json_path = utils.sidecar_path_for(full_path)
                    if os.path.exists(json_path):
                        continue
                    try:
                        info = utils.CivitaiAPIUtils.get_model_version_info_by_hash(fhash)
                        if info:
                            with open(json_path, "w") as f:
                                json.dump(info, f, indent=2)
                            preview_url = None
                            if info.get("images") and len(info["images"]) > 0:
                                preview_url = info["images"][0].get("url")
                            if preview_url:
                                # Same name the downloader uses, so the
                                # library scanner actually finds it.
                                preview_path = os.path.splitext(full_path)[0] + ".png"
                                if not os.path.exists(preview_path):
                                    try:
                                        req = urllib.request.Request(
                                            preview_url,
                                            headers={"User-Agent": "Mozilla/5.0"},
                                        )
                                        with urllib.request.urlopen(req, timeout=15) as resp:
                                            with open(preview_path, "wb") as pf:
                                                pf.write(resp.read())
                                    except Exception:
                                        logger.warning("could not download a preview during auto-tag", exc_info=True)
                            tagged += 1
                    except Exception:
                        logger.debug("auto_tag: skipping after Exception", exc_info=True)
                        continue
            return tagged

        loop = asyncio.get_event_loop()
        tagged = await loop.run_in_executor(None, _work)
        return web.json_response({"success": True, "tagged": tagged})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


# ── Smart Cleanup ─────────────────────────────────────────────────────

@routes.post("/civitai/cleanup-scan")
async def cleanup_scan(request):
    try:
        def _work():
            issues = []
            for mt in ["checkpoints", "loras", "vae"]:
                try:
                    names = folder_paths.get_filename_list(mt)
                except Exception:
                    logger.debug("cleanup_scan: skipping after Exception", exc_info=True)
                    continue
                for name in names:
                    full = folder_paths.get_full_path(mt, name)
                    if not full or not os.path.exists(full):
                        continue
                    base = full.rsplit(".", 1)[0]
                    if full.endswith(".safetensors"):
                        json_path = base + ".civitai.json"
                        if os.path.exists(json_path):
                            try:
                                with open(json_path) as f:
                                    content = json.load(f)
                                if not content or not content.get("id"):
                                    issues.append({
                                        "type": "orphan_sidecar",
                                        "path": json_path,
                                        "message": "Empty or invalid .civitai.json",
                                    })
                            except Exception:
                                issues.append({
                                    "type": "corrupt_json",
                                    "path": json_path,
                                    "message": "Corrupt .civitai.json",
                                })
                    else:
                        orphan_json = base + ".civitai.json"
                        if os.path.exists(orphan_json):
                            issues.append({
                                "type": "orphan_sidecar",
                                "path": orphan_json,
                                "message": "Orphan .civitai.json (no model found)",
                            })
                        orphan_preview = base + ".preview.png"
                        if os.path.exists(orphan_preview):
                            issues.append({
                                "type": "orphan_preview",
                                "path": orphan_preview,
                                "message": "Orphan .preview.png (no model found)",
                            })
            return issues

        loop = asyncio.get_event_loop()
        issues = await loop.run_in_executor(None, _work)
        return web.json_response({"success": True, "issues": issues, "total": len(issues)})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.post("/civitai/cleanup-delete")
async def cleanup_delete(request):
    try:
        data = await request.json()
        paths = data.get("paths", [])
        deleted = 0
        denied = []
        for p in paths:
            ok, resolved = _safe_model_path(p)
            if not ok:
                denied.append(str(p))
                continue
            if os.path.isfile(resolved):
                os.remove(resolved)
                deleted += 1
        return web.json_response({"success": True, "deleted": deleted,
                                  "denied": denied})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


# ── Auto-Organize ─────────────────────────────────────────────────────

@routes.post("/civitai/auto-organize")
async def auto_organize(request):
    try:
        def _work():
            moved = 0
            for mt in ["loras", "checkpoints", "vae"]:
                names = folder_paths.get_filename_list(mt)
                name_to_hash, _ = utils.get_local_model_maps(mt)
                for name in names:
                    fhash = name_to_hash.get(name)
                    if not fhash:
                        continue
                    try:
                        info = utils.CivitaiAPIUtils.get_model_version_info_by_hash(fhash)
                    except Exception:
                        logger.debug("auto_organize: skipping after Exception", exc_info=True)
                        continue
                    if not info:
                        continue
                    cat = (info.get("model") or {}).get("type", "")
                    creator = ""
                    if info.get("model") and info["model"].get("creator"):
                        creator = info["model"]["creator"].get("username", "")
                    base_model_info = ""
                    for tag in (info.get("model") or {}).get("tags", []):
                        if tag.get("name", "").lower() in (
                            "sd 1.5", "sdxl", "sd 2", "flux", "pixart", "playground v2"
                        ):
                            base_model_info = tag["name"].replace(" ", "_").lower()
                            break
                    # cat / creator come from the Civitai response, so each
                    # part is reduced to one safe component before it is
                    # turned into a directory.
                    folder_parts = [p for p in (
                        _safe_name(cat), _safe_name(base_model_info), _safe_name(creator)
                    ) if p]
                    if not folder_parts:
                        continue
                    target_subdir = "/".join(folder_parts)
                    src = folder_paths.get_full_path(mt, name)
                    if not src:
                        continue
                    models_dir = folder_paths.models_dir
                    dest_dir = os.path.join(models_dir, mt, target_subdir)
                    os.makedirs(dest_dir, exist_ok=True)
                    dest = os.path.join(dest_dir, name)
                    if os.path.normpath(src) == os.path.normpath(dest):
                        continue
                    if os.path.exists(dest):
                        continue
                    try:
                        shutil.move(src, dest)
                        # Metadata plus every preview for this model, in both
                        # the current and the legacy <base>.preview.png layout.
                        extras = [utils.sidecar_path_for(src)]
                        extras += utils.preview_paths_for(src)
                        extras += [os.path.splitext(src)[0] + ".preview.png"]
                        for s in extras:
                            if not os.path.isfile(s):
                                continue
                            d = os.path.join(os.path.dirname(dest), os.path.basename(s))
                            if os.path.normpath(s) != os.path.normpath(d):
                                os.rename(s, d)
                        moved += 1
                    except Exception:
                        logger.debug("auto_organize: ignoring Exception", exc_info=True)
            return moved

        loop = asyncio.get_event_loop()
        moved = await loop.run_in_executor(None, _work)
        return web.json_response({"success": True, "moved": moved})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


# ── HF Browse ─────────────────────────────────────────────────────────

def _parse_hf_repo(raw):
    """Parse a HF repo identifier or URL into (repo_id, repo_type).

    Handles models, datasets and spaces, full URLs, and trailing
    /tree|/blob|/resolve path segments.
    """
    s = (raw or "").strip()
    m = re.search(r'huggingface\.co/(.+)$', s)
    if m:
        s = m.group(1)
    s = s.strip('/')
    repo_type = "model"
    tm = re.match(r'^(datasets|spaces|models)/(.+)$', s)
    if tm:
        repo_type = {"datasets": "dataset", "spaces": "space", "models": "model"}[tm.group(1)]
        s = tm.group(2)
    s = re.sub(r'/(tree|blob|resolve|blame|commits|discussions|files)/.*$', '', s).strip('/')
    parts = [p for p in s.split('/') if p]
    repo_id = f"{parts[0]}/{parts[1]}" if len(parts) >= 2 else s
    return repo_id, repo_type


def _hf_api_base(repo_id, repo_type):
    seg = {"dataset": "datasets", "space": "spaces"}.get(repo_type)
    return f"https://huggingface.co/api/{seg}/{repo_id}" if seg else f"https://huggingface.co/api/models/{repo_id}"


def _hf_resolve_base(repo_id, repo_type):
    seg = {"dataset": "datasets", "space": "spaces"}.get(repo_type)
    return f"https://huggingface.co/{seg}/{repo_id}" if seg else f"https://huggingface.co/{repo_id}"


@routes.get("/civitai/hf-search")
async def hf_search(request):
    try:
        query = request.query.get("query", "")
        pipeline_tag = request.query.get("pipeline_tag", "")
        library = request.query.get("library", "")
        author = request.query.get("author", "")
        sort = request.query.get("sort", "lastModified")
        direction = request.query.get("direction", "-1")
        limit = int(request.query.get("limit", 30))
        skip = int(request.query.get("skip", 0))
        cursor = request.query.get("cursor", "")
        tags = request.query.get("tags", "")
        gated = request.query.get("gated", "")

        hf_url = "https://huggingface.co/api/models"
        params = {"search": query, "sort": sort, "direction": direction, "limit": limit}
        # Hugging Face pages with a cursor in the Link header; `skip` is the
        # fallback so a client can still ask for "the next N" without one.
        if cursor:
            params["cursor"] = cursor
        elif skip:
            params["skip"] = skip
        if pipeline_tag:
            params["task"] = pipeline_tag
        if library:
            params["library"] = library
        if author:
            params["author"] = author
        if tags:
            params["filter"] = tags
        if gated.lower() in ("true", "false"):
            params["gated"] = gated.lower()

        headers = {"User-Agent": "Mozilla/5.0"}
        token = utils.db_manager.get_setting("hf_token", "")
        if token:
            headers["Authorization"] = f"Bearer {token}"
        loop = asyncio.get_event_loop()
        resp = await loop.run_in_executor(
            None, lambda: requests.get(hf_url, params=params, timeout=15, headers=headers)
        )
        resp.raise_for_status()
        items = resp.json()
        next_cursor = ""
        link = resp.headers.get("Link") or resp.headers.get("link") or ""
        if link and 'rel="next"' in link:
            m = re.search(r'<[^>]*[?&]cursor=([^&>\'"]+)', link)
            if m:
                next_cursor = urllib.parse.unquote(m.group(1))
        return web.json_response({
            "items": items,
            "hasMore": bool(next_cursor) or len(items) >= limit,
            "nextCursor": next_cursor,
            "skip": skip + len(items),
            "limit": limit,
        })
    except Exception as e:
        return web.json_response({"items": [], "error": str(e)})


@routes.get("/civitai/hf-lookup")
async def hf_lookup(request):
    try:
        raw = request.query.get("repo", "")
        if not raw:
            return web.json_response({"error": "Missing repo"}, status=400)
        repo_id, repo_type = _parse_hf_repo(raw)
        if repo_id.find("/") < 0:
            return web.json_response({"error": "Invalid repo format (use user/repo)"}, status=400)
        headers = {"User-Agent": "Mozilla/5.0"}
        token = utils.db_manager.get_setting("hf_token", "")
        if token:
            headers["Authorization"] = f"Bearer {token}"
        loop = asyncio.get_event_loop()
        # If type wasn't explicit in the input, try model then dataset then space.
        candidates = [repo_type] if repo_type != "model" else ["model", "dataset", "space"]
        last_error = None
        for rt in candidates:
            api_url = _hf_api_base(repo_id, rt)
            try:
                resp = await loop.run_in_executor(
                    None, lambda u=api_url: requests.get(u, timeout=15, headers=headers)
                )
                resp.raise_for_status()
                data = resp.json()
                data["repo_type"] = rt
                data.setdefault("id", repo_id)
                return web.json_response(data)
            except requests.exceptions.HTTPError as e:
                last_error = e
                if e.response.status_code == 404:
                    continue
                if e.response.status_code == 401:
                    # Gated/private: confirm existence via resolve, keep this type.
                    try:
                        check_url = f"{_hf_resolve_base(repo_id, rt)}/resolve/main/config.json"
                        r2 = await loop.run_in_executor(
                            None, lambda u=check_url: requests.head(u, timeout=10, headers=headers, allow_redirects=True)
                        )
                        if r2.status_code < 400:
                            return web.json_response({"id": repo_id, "repo_type": rt, "gated": True})
                    except Exception:
                        logger.debug("hf_lookup: ignoring Exception", exc_info=True)
                    return web.json_response({"error": "Unauthorized \u2014 set your HF token in Settings"}, status=401)
                return web.json_response({"error": f"HTTP {e.response.status_code}"}, status=e.response.status_code)
        # All candidates 404'd
        return web.json_response({"error": f"Repo not found: {repo_id}. If gated, set HF token in Settings."}, status=404)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.get("/civitai/hf-files")
async def hf_files(request):
    try:
        repo_id = request.query.get("repo_id", "")
        path = request.query.get("path", "")
        repo_type = request.query.get("repo_type", "model")
        if not repo_id:
            return web.json_response({"error": "Missing repo_id"}, status=400)
        api_url = _hf_api_base(repo_id, repo_type)
        if path:
            api_url += f"/tree/{path}"
        headers = {"User-Agent": "Mozilla/5.0"}
        token = utils.db_manager.get_setting("hf_token", "")
        if token:
            headers["Authorization"] = f"Bearer {token}"
        loop = asyncio.get_event_loop()
        resp = await loop.run_in_executor(
            None, lambda: requests.get(api_url, timeout=15, headers=headers)
        )
        resp.raise_for_status()
        return web.json_response(resp.json())
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


# ── Settings ──────────────────────────────────────────────────────────

@routes.get("/civitai/settings")
async def get_settings(request):
    return web.json_response({
        "baseUrl": f"https://{utils._get_active_domain()}",
        "saveMetadata": utils.db_manager.get_setting("save_metadata", True),
        "savePreview": utils.db_manager.get_setting("save_preview", True),
        "save_metadata": utils.db_manager.get_setting("save_metadata", True),
        "save_preview": utils.db_manager.get_setting("save_preview", True),
        "computeSHA": utils.db_manager.get_setting("compute_sha", True),
        "nsfw_default": utils.db_manager.get_setting("nsfw_default", ""),
        "civitaiToken": bool(utils.db_manager.get_setting("civitai_api_key")),
        "hfToken": bool(utils.db_manager.get_setting("hf_token")),
        "network_choice": utils.db_manager.get_setting("network_choice", "com"),
        "nsfw_blur": utils.db_manager.get_setting("nsfw_blur", True),
        "nsfw_blur_level": utils.db_manager.get_setting("nsfw_blur_level", "R"),
        "name_template": utils.db_manager.get_setting("name_template", "") or "",
        "refresh_after_download": utils.db_manager.get_setting("refresh_after_download", True),
        "saved_searches": utils.db_manager.get_setting("saved_searches", []) or [],
        "theme": utils.db_manager.get_setting("theme", "dark"),
        "compact_grid": utils.db_manager.get_setting("compact_grid", False),
        "image_quality": utils.db_manager.get_setting("image_quality", "balanced"),
        "has_api_key": bool(utils.db_manager.get_setting("civitai_api_key")),
        "has_token": bool(utils.db_manager.get_setting("hf_token")),
        "verify_sha256": utils.db_manager.get_setting("compute_sha", True),
    })


@routes.post("/civitai/settings")
async def save_settings(request):
    try:
        data = await request.json()
        bool_keys = {"save_metadata", "save_preview", "compute_sha", "nsfw_blur",
                     "compact_grid", "refresh_after_download"}
        # name_template is saved even when empty: clearing it is how you go
        # back to Civitai's own file names.
        str_keys = {"nsfw_default", "network_choice", "theme", "nsfw_blur_level",
                    "name_template"}
        for key in bool_keys:
            if key in data:
                utils.db_manager.set_setting(key, bool(data[key]))
        for key in str_keys:
            if key in data:
                utils.db_manager.set_setting(key, str(data[key]))
        if "image_quality" in data:
            iq = str(data["image_quality"])
            utils.db_manager.set_setting(
                "image_quality", iq if iq in ("saver", "balanced", "high") else "balanced")
        if "civitai_api_key" in data:
            utils.db_manager.set_setting("civitai_api_key", data["civitai_api_key"])
        if "api_key" in data:
            utils.db_manager.set_setting("civitai_api_key", data["api_key"])
        if "verify_sha256" in data:
            utils.db_manager.set_setting("compute_sha", data["verify_sha256"])
        if "hf_token" in data:
            utils.db_manager.set_setting("hf_token", data["hf_token"])
        if "saved_searches" in data:
            saved = data["saved_searches"]
            utils.db_manager.set_setting(
                "saved_searches", saved if isinstance(saved, list) else [])
        return web.json_response({
            "success": True,
            "has_api_key": bool(utils.db_manager.get_setting("civitai_api_key")),
            "has_token": bool(utils.db_manager.get_setting("hf_token")),
        })
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.get("/civitai/test")
async def test_api(request):
    try:
        domain = utils._get_active_domain()
        t0 = time.time()
        await loop.run_in_executor(
            None, lambda: utils.CivitaiAPIUtils._request_with_retry(f"https://{domain}/api/v1/models?limit=1")
        )
        latency = int((time.time() - t0) * 1000)
        return web.json_response({"success": True, "latency": latency})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)})


@routes.get("/civitai/test-hf")
async def test_hf(request):
    try:
        t0 = time.time()
        headers = {"User-Agent": "Mozilla/5.0"}
        resp = await loop.run_in_executor(
            None, lambda: requests.get(
                "https://huggingface.co/api/models?limit=1",
                timeout=10, headers=headers,
            )
        )
        resp.raise_for_status()
        latency = int((time.time() - t0) * 1000)
        return web.json_response({"success": True, "latency": latency})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)})


@routes.post("/civitai/clear-cache")
async def clear_cache(request):
    try:
        data = await request.json() if request.can_read_body else {}
        cache_type = data.get("cache_type", "all")
        if cache_type in ("analysis", "all"):
            utils.db_manager.clear_analysis_cache()
        if cache_type in ("api", "all"):
            utils.db_manager.clear_api_responses()
        if cache_type in ("triggers", "all"):
            utils.db_manager.clear_all_triggers()
        return web.json_response({"success": True})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.post("/civitai/export-list")
async def export_model_list(request):
    try:
        lines = []
        for mt in ["checkpoints", "loras", "vae", "text_encoders", "unet", "diffusion_models"]:
            try:
                for name in folder_paths.get_filename_list(mt):
                    full = folder_paths.get_full_path(mt, name)
                    if full:
                        lines.append(full)
            except Exception:
                logger.debug("export_model_list: skipping after Exception", exc_info=True)
                continue
        text = "\n".join(lines)
        return web.json_response({"success": True, "text": text, "count": len(lines)})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.get("/civitai/model-info")
async def model_info(request):
    try:
        filepath = request.query.get("path", "")
        ok, filepath = _safe_model_path(filepath)
        if not ok:
            return web.json_response({"error": filepath or "File not found"}, status=404)
        loop = asyncio.get_event_loop()
        # Hashing a multi-GB checkpoint must never sit on the event loop.
        hash_val = await loop.run_in_executor(
            None, utils.CivitaiAPIUtils.calculate_sha256, filepath
        )
        info = None
        if hash_val:
            info = await loop.run_in_executor(
                None, utils.CivitaiAPIUtils.get_model_version_info_by_hash, hash_val
            )
        json_path = os.path.splitext(filepath)[0] + ".civitai.json"
        metadata = await loop.run_in_executor(None, _read_json, json_path)
        return web.json_response({
            "hash": hash_val,
            "civitai": info,
            "metadata": metadata,
            "filename": os.path.basename(filepath),
            "size": os.path.getsize(filepath),
        })
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


print("[ComfyUI-CivitAiHF-Downloader] Server routes registered")


# ── Bookmarks (server-side) ───────────────────────────────────────────
# Storage rules live in bookmarks_store.py (source-aware identity, so Hugging
# Face and Civitai bookmarks can coexist) — these routes are thin wrappers.

from . import bookmarks_store


@routes.get("/civitai/bookmarks")
async def list_bookmarks(request):
    return web.json_response({"items": bookmarks_store.load()})


@routes.post("/civitai/bookmarks")
async def save_bookmark(request):
    try:
        data = await request.json()
        ok, message, bookmark_id = bookmarks_store.add(data)
        if not ok:
            status = 400 if message == "Bad payload" else 200
            return web.json_response({"success": False, "message": message or "Bad payload"}, status=status)
        return web.json_response({"success": True, "id": bookmark_id,
                                  "count": len(bookmarks_store.load())})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


@routes.post("/civitai/bookmarks-delete")
async def delete_bookmark(request):
    try:
        data = await request.json()
        removed, left = bookmarks_store.remove(data)
        if not removed:
            return web.json_response({"success": False, "message": "Not found"})
        return web.json_response({"success": True, "count": left})
    except Exception as e:
        return web.json_response({"success": False, "error": str(e)}, status=500)


# ── Missing utility endpoints ───────────────────────────────────────────

@routes.get("/civitai/folders")
async def list_folders(request):
    try:
        all_types = [
            "checkpoints", "loras", "vae", "controlnet", "embeddings",
            "upscale_models", "clip_vision", "unet", "diffusion_models",
            "instantid", "ipadapter", "photomaker", "style_models",
            "text_encoders", "wildcards", "audio_encoders",
            "background_removal", "clip", "configs", "detection",
            "diffusers", "frame_interpolation", "geometry_estimation",
            "gligen", "latent_upscale_models", "model_patches",
            "optical_flow", "vae_approx",
        ]
        folders = []
        for sub in all_types:
            sub_path = os.path.join(folder_paths.models_dir, sub)
            exists = os.path.isdir(sub_path)
            folders.append({"name": sub, "exists": exists})
        # Also discover any extra subfolders in models_dir not in our list
        try:
            for entry in os.scandir(folder_paths.models_dir):
                if entry.is_dir() and entry.name not in all_types and not entry.name.startswith('.'):
                    folders.append({"name": entry.name, "exists": True})
        except Exception:
            logger.debug("list_folders: ignoring Exception", exc_info=True)
        return web.json_response({"folders": [f["name"] for f in folders]})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.post("/civitai/hf/download")
async def hf_download(request):
    try:
        body = await request.json()
        repo_id = body.get("repo_id", "")
        repo_type = body.get("repo_type", "model")
        revision = body.get("revision", "main")
        path = body.get("path", "")
        save_as = body.get("save_as", "auto")
        subfolder = body.get("subfolder", "")
        overwrite = body.get("overwrite", False)
        save_metadata = body.get("save_metadata", False)
        save_preview = body.get("save_preview", False)
        preserve_subfolders = bool(body.get("preserve_subfolders", False))
        if not repo_id or not path:
            return web.json_response({"error": "Missing repo_id or path"}, status=400)
        filename = _safe_name(path.split("/")[-1]) or "model.safetensors"
        # "Keep subfolders": a repo file at unet/model.safetensors lands in
        # <dest>/unet/ rather than being flattened into <dest>/. Each part is
        # sanitised because the repo path reaches the filesystem.
        rel_dir = ""
        if preserve_subfolders:
            rel_dir = "/".join(
                p for p in (_safe_name(part) for part in path.replace("\\", "/").split("/")[:-1])
                if p)
        ok, dest = _safe_download_path(
            save_as if save_as != "auto" else "loras", subfolder, rel_dir, filename)
        if not ok:
            return web.json_response({"error": dest}, status=400)
        dest_dir = os.path.dirname(dest)
        os.makedirs(dest_dir, exist_ok=True)
        if os.path.exists(dest) and not overwrite:
            # Auto-rename: file.safetensors -> file_2.safetensors
            base_name, ext = os.path.splitext(filename)
            counter = 2
            while os.path.exists(dest):
                dest = os.path.join(dest_dir, f"{base_name}_{counter}{ext}")
                counter += 1
            filename = os.path.basename(dest)
        url = f"{_hf_resolve_base(repo_id, repo_type)}/resolve/{revision}/{urllib.parse.quote(path, safe='/')}"
        task_id = f"hf_{int(time.time())}_{hashlib.md5(f'{repo_id}:{path}'.encode()).hexdigest()[:8]}"
        DOWNLOAD_TASKS[task_id] = {
            "id": task_id, "url": url, "filename": filename,
            "source": "hf", "hf_repo_id": repo_id, "hf_path": path,
            "progress": 0, "speed": 0, "status": "downloading",
            "path": dest, "cancelled": False, "started_at": time.time(),
            "retry_endpoint": "/civitai/hf/download",
            "retry_payload": {
                "repo_id": repo_id, "repo_type": repo_type, "revision": revision,
                "path": path, "save_as": save_as, "subfolder": subfolder,
                "overwrite": True, "preserve_subfolders": preserve_subfolders,
                "save_metadata": save_metadata,
                "save_preview": save_preview,
            },
        }

        def _hf_dl_blocking():
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=600) as resp:
                total = int(resp.headers.get("Content-Length", 0))
                downloaded = 0
                start_t = time.time()
                with open(dest, "wb") as f:
                    while True:
                        if DOWNLOAD_TASKS.get(task_id, {}).get("cancelled"):
                            DOWNLOAD_TASKS[task_id]["status"] = "cancelled"
                            f.close()
                            if os.path.exists(dest):
                                os.remove(dest)
                            return True
                        chunk = resp.read(8192)
                        if not chunk:
                            break
                        f.write(chunk)
                        downloaded += len(chunk)
                        elapsed = time.time() - start_t
                        speed = downloaded / elapsed if elapsed > 0 else 0
                        progress = int(downloaded / total * 100) if total > 0 else 0
                        if task_id in DOWNLOAD_TASKS:
                            DOWNLOAD_TASKS[task_id].update({
                                "progress": progress, "speed": speed,
                                "downloaded": downloaded, "total": total,
                            })
            return False

        async def _hf_dl():
            try:
                loop = asyncio.get_event_loop()
                # Run blocking network + disk I/O in a thread so the event loop
                # stays responsive (progress polling, other requests, etc.)
                cancelled = await loop.run_in_executor(None, _hf_dl_blocking)
                if cancelled:
                    return
                if task_id in DOWNLOAD_TASKS:
                    DOWNLOAD_TASKS[task_id]["status"] = "completed"
                    DOWNLOAD_TASKS[task_id]["progress"] = 100
                # Compute hash after HF download
                file_hash = ""
                try:
                    file_hash = await loop.run_in_executor(
                        None, utils.CivitaiAPIUtils.calculate_sha256, dest
                    )
                    if task_id in DOWNLOAD_TASKS:
                        DOWNLOAD_TASKS[task_id]["hash"] = file_hash
                except Exception:
                    logger.warning("could not hash the downloaded file %s", dest, exc_info=True)
                # Save metadata with hash
                try:
                    vi = await loop.run_in_executor(
                        None, utils.CivitaiAPIUtils.get_model_version_info_by_hash, file_hash
                    ) if file_hash else None
                    if vi:
                        meta_path = os.path.splitext(dest)[0] + ".civitai.json"
                        if "hashes" not in vi:
                            vi["hashes"] = {}
                        vi["hashes"]["SHA256"] = file_hash
                        await loop.run_in_executor(None, _write_json, meta_path, vi)
                except Exception:
                    logger.warning("could not save metadata for the downloaded file %s", dest, exc_info=True)
                _record_history(task_id, DOWNLOAD_TASKS.get(task_id, {}).get("status", "completed"))
            except Exception as e:
                if task_id in DOWNLOAD_TASKS:
                    DOWNLOAD_TASKS[task_id]["status"] = "error"
                    DOWNLOAD_TASKS[task_id]["error"] = str(e)
                    _record_history(task_id, "error")

        asyncio.ensure_future(_hf_dl())
        return web.json_response({"id": task_id, "filename": filename, "dest": dest})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.post("/civitai/hf/token")
async def set_hf_token(request):
    try:
        body = await request.json()
        token = body.get("token", "")
        utils.db_manager.set_setting("hf_token", token)
        return web.json_response({"ok": True})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.get("/civitai/ping")
async def ping(request):
    domain = utils._get_active_domain()
    try:
        loop = asyncio.get_event_loop()
        r = await loop.run_in_executor(
            None, lambda: requests.get(f"https://{domain}/api/v1/models?limit=1", timeout=10)
        )
        return web.json_response({
            "ok": r.ok, "status": r.status_code, "domain": domain,
            "has_api_key": bool(utils.db_manager.get_setting("civitai_api_key")),
            "has_token": bool(utils.db_manager.get_setting("hf_token")),
        })
    except Exception as e:
        return web.json_response({"ok": False, "error": str(e), "domain": domain})


@routes.post("/civitai/cache/clear")
async def clear_cache_v2(request):
    try:
        utils.db_manager.clear_analysis_cache()
        return web.json_response({"ok": True, "message": "Cache cleared"})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.get("/civitai/local-previews")
async def get_local_previews(request):
    """Return all preview images + per-image prompts for a local model."""
    try:
        path = request.query.get("path", "")
        ok, path = _safe_model_path(path)
        if not ok:
            return web.json_response({"images": [], "error": path})
        pv_w = request.query.get("w", "450") or "450"
        pv_q = request.query.get("q", "72") or "72"
        if not pv_w.isdigit():
            pv_w = "450"
        if not pv_q.isdigit():
            pv_q = "72"
        # Same set of files delete-model removes, so what the detail view
        # shows and what a delete cleans up can never disagree.
        images_meta = []
        sidecar = _read_json(utils.sidecar_path_for(path))
        if sidecar:
            images_meta = sidecar.get("images") or []
        previews = []
        for idx, found in enumerate(p for p in utils.preview_paths_for(path) if os.path.isfile(p)):
            meta = images_meta[idx] if idx < len(images_meta) and isinstance(images_meta[idx], dict) else {}
            m = meta.get("meta") or {}
            m = m if isinstance(m, dict) else {}
            previews.append({
                "url": (f"/civitai/local-preview?path="
                        f"{urllib.parse.quote(os.path.abspath(found))}&w={pv_w}&q={pv_q}"),
                "prompt": m.get("prompt", ""),
                "negativePrompt": m.get("negativePrompt", ""),
                "seed": m.get("seed", ""),
                "width": m.get("width", ""),
                "height": m.get("height", ""),
            })
        return web.json_response({"images": previews})
    except Exception as e:
        return web.json_response({"images": [], "error": str(e)})


print("[ComfyUI-CivitAiHF-Downloader] Extra routes registered")


# ── Lazy metadata loading for local models ─────────────────────────

@routes.get("/civitai/local-metadata")
async def get_local_metadata(request):
    """Load .civitai.json metadata for a specific local model (lazy load)."""
    try:
        path = request.query.get("path", "")
        ok, path = _safe_model_path(path)
        if not ok:
            return web.json_response({"metadata": {}, "error": path})
        loop = asyncio.get_event_loop()
        metadata = await loop.run_in_executor(None, _load_sidecar, path)
        return web.json_response({"metadata": metadata})
    except Exception as e:
        return web.json_response({"metadata": {}, "error": str(e)})


def _load_sidecar(path):
    """Load .civitai.json sidecar for a model file."""
    base = os.path.splitext(path)[0]
    json_path = base + ".civitai.json"
    if os.path.isfile(json_path):
        try:
            with open(json_path) as f:
                return json.load(f)
        except Exception:
            logger.warning("could not read the metadata sidecar %s", json_path, exc_info=True)
    return {}


# ── Prompt Fetcher (node ↔ UI bridge) ──────────────────────────────────

@routes.post("/civitai/prompt-fetcher")
async def set_prompt_fetcher(request):
    """Receive positive/negative prompts from the UI and store for the Prompt Fetcher node."""
    try:
        body = await request.json()
        positive = body.get("positive", "")
        negative = body.get("negative", "")
        from .nodes import set_prompts
        set_prompts(positive, negative)
        return web.json_response({"ok": True})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@routes.get("/civitai/prompt-fetcher")
async def get_prompt_fetcher(request):
    """Return the current prompts stored in the Prompt Fetcher node."""
    try:
        from .nodes import get_prompts
        prompts = get_prompts()
        return web.json_response(prompts)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)
