"""
Bookmark storage for the ComfyUI CivitAI + Hugging Face Downloader.

Kept free of ComfyUI imports (no folder_paths / aiohttp) so the rules can be
unit-tested on their own — see tests/test_bookmarks.py.

A bookmark is one of:

  Civitai      {"source": "civitai", "model_id": …, "model_version_id": …,
                "name": …, "filename": …, "type": …, "image": …,
                "nsfw_level": …}
  Hugging Face {"source": "hf", "repo_id": "user/repo", "repo_type": "model",
                "name": …, "filename": …}

Why this module exists: Hugging Face bookmarks have no Civitai version id and
used to be saved with ``model_version_id: 0``, so every HF repo was keyed as
"0". Only one HF bookmark could ever be stored, and deleting it wiped them
all. Identity is now derived per source.
"""

import json
import os
import threading

_BOOKMARKS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bookmarks.json")
_LOCK = threading.Lock()

HF_ALIASES = ("hf", "huggingface", "hugging_face", "hugging-face")
CIVITAI_ALIASES = ("civitai", "civ", "civita")


def bookmarks_path():
    """Location of bookmarks.json (monkeypatchable in tests)."""
    return _BOOKMARKS_FILE


def load():
    """Read bookmarks.json, backfilling `source` and `id` on older entries."""
    path = bookmarks_path()
    items = []
    if os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                items = json.load(fh)
        except Exception:
            items = []
    if not isinstance(items, list):
        items = []
    for entry in items:
        if isinstance(entry, dict):
            entry.setdefault("source", source_of(entry))
            entry.setdefault("id", key_of(entry))
    return items


def save(items):
    path = bookmarks_path()
    try:
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(items, fh, indent=2, ensure_ascii=False)
        return True
    except Exception:
        return False


def source_of(entry):
    """Which site a bookmark came from: "hf" or "civitai"."""
    if not isinstance(entry, dict):
        return "civitai"
    src = str(entry.get("source") or "").strip().lower()
    if src in HF_ALIASES:
        return "hf"
    if src in CIVITAI_ALIASES:
        return "civitai"
    return "hf" if entry.get("repo_id") else "civitai"


def key_of(entry):
    """Stable identity for a bookmark, per source (e.g. "hf:user/repo")."""
    if source_of(entry) == "hf":
        ident = entry.get("repo_id") or entry.get("id") or entry.get("name") or ""
        return "hf:" + str(ident).strip().lower()
    ident = (entry.get("model_version_id") or entry.get("model_id")
             or entry.get("id") or entry.get("name") or "")
    return "civitai:" + str(ident)


def matches(entry, payload):
    """Does a stored bookmark correspond to this save/delete payload?"""
    if not isinstance(entry, dict):
        return False
    given_id = payload.get("id")
    if given_id is not None and str(given_id) != "":
        if str(entry.get("id") or "") == str(given_id):
            return True
    if key_of(entry) == key_of(payload):
        return True
    # clients that only send a single field (older builds)
    if payload.get("model_version_id"):
        if str(entry.get("model_version_id") or "") == str(payload["model_version_id"]):
            return True
    if payload.get("repo_id"):
        if str(entry.get("repo_id") or "").strip().lower() == str(payload["repo_id"]).strip().lower():
            return True
    return False


def add(payload):
    """
    Append a bookmark.

    Returns (ok, message, bookmark_id). ok is False when it is a duplicate.
    """
    if not isinstance(payload, dict):
        return False, "Bad payload", ""
    with _LOCK:
        items = load()
        entry = dict(payload)
        entry["source"] = source_of(entry)
        if entry["source"] != "hf":
            entry.setdefault("repo_id", "")
        entry["id"] = key_of(entry)
        if any(matches(existing, entry) for existing in items):
            return False, "Already bookmarked", entry["id"]
        items.append(entry)
        save(items)
        return True, "", entry["id"]


def remove(payload):
    """Delete the bookmark matching this payload. Returns (removed, count_left)."""
    with _LOCK:
        items = load()
        remaining = [b for b in items if not matches(b, payload or {})]
        if len(remaining) == len(items):
            return False, len(items)
        save(remaining)
        return True, len(remaining)
