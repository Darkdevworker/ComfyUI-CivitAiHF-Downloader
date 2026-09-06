"""
Download history.

The queue clears itself, so once a job is done there is no record that it
ever happened. This keeps one: enough to re-fetch something, to work out
where a file in a library of hundreds came from, or to see what failed.

Kept free of ComfyUI imports (no folder_paths / aiohttp) so the rules can be
unit-tested on their own — see tests/test_download_history.py.
"""

import json
import os
import threading
import time

_HISTORY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             "download_history.json")
_LOCK = threading.Lock()

# A year of downloads is plenty; the file is small but it should not grow
# without bound on a machine that fetches models every day.
MAX_ENTRIES = 500


def history_path():
    """Location of download_history.json (monkeypatchable in tests)."""
    return _HISTORY_FILE


def load():
    """Finished downloads, newest first."""
    path = history_path()
    if not os.path.exists(path):
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            items = json.load(f)
    except Exception:
        return []
    return [i for i in items if isinstance(i, dict)] if isinstance(items, list) else []


def _write(items):
    path = history_path()
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(items, f, indent=1, ensure_ascii=False)
    os.replace(tmp, path)


def add(entry):
    """Record a finished download, replacing any entry with the same id."""
    if not isinstance(entry, dict):
        return load()
    with _LOCK:
        items = load()
        entry = dict(entry)
        if not entry.get("id"):
            entry["id"] = f"{time.time():.6f}"
        if not entry.get("finished_at"):
            entry["finished_at"] = time.time()
        items = [e for e in items if str(e.get("id")) != str(entry["id"])]
        items.insert(0, entry)
        items = items[:MAX_ENTRIES]
        _write(items)
        return items


def remove(entry_id):
    """Drop one entry. Returns what is left."""
    with _LOCK:
        items = [e for e in load() if str(e.get("id")) != str(entry_id)]
        _write(items)
        return items


def clear():
    """Forget everything."""
    with _LOCK:
        _write([])
        return []
