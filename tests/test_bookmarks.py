"""
Bookmark identity tests — run with:  python3 tests/test_bookmarks.py

Covers the bug where every Hugging Face bookmark was keyed as "0" (they have
no Civitai model_version_id), so only one could ever be saved.
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import bookmarks_store as bs  # noqa: E402

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


class tmpfile(object):
    """Point the store at a scratch bookmarks.json for the duration."""

    def __enter__(self):
        self._orig = bs._BOOKMARKS_FILE
        self._dir = tempfile.mkdtemp()
        bs._BOOKMARKS_FILE = os.path.join(self._dir, "bookmarks.json")
        return bs._BOOKMARKS_FILE

    def __exit__(self, *a):
        bs._BOOKMARKS_FILE = self._orig


print("source detection")
eq(bs.source_of({"source": "civitai"}), "civitai", "explicit civitai")
eq(bs.source_of({"source": "hf"}), "hf", "explicit hf")
eq(bs.source_of({"source": "HuggingFace"}), "hf", "huggingface alias")
eq(bs.source_of({"repo_id": "user/repo"}), "hf", "repo_id with no source")
eq(bs.source_of({"model_version_id": 123}), "civitai", "no repo id -> civitai")
eq(bs.source_of({}), "civitai", "empty entry -> civitai")

print("keys")
eq(bs.key_of({"source": "civitai", "model_version_id": 123}), "civitai:123", "civitai keyed on version id")
eq(bs.key_of({"source": "civitai", "model_version_id": 0, "model_id": 9}), "civitai:9", "falls back to model id")
eq(bs.key_of({"repo_id": "User/Repo"}), "hf:user/repo", "hf keyed on repo id (case-insensitive)")
eq(bs.key_of({"source": "hf", "repo_id": "a/b"}), "hf:a/b", "explicit hf")

with tmpfile():
    print("saving both sources")
    ok_hf1, _, id1 = bs.add({"name": "stabilityai/sdxl", "source": "hf", "repo_id": "stabilityai/sdxl",
                             "model_version_id": 0, "model_id": 0})
    ok_hf2, _, id2 = bs.add({"name": "black-forest-labs/flux", "source": "hf",
                             "repo_id": "black-forest-labs/FLUX.1-dev", "model_version_id": 0, "model_id": 0})
    ok_civ, _, id3 = bs.add({"name": "Cool LoRA", "source": "civitai", "model_version_id": 555,
                             "model_id": 42, "type": "LORA"})
    ok(ok_hf1 and ok_hf2, "two different HF repos both save")
    ok(ok_civ, "a Civitai bookmark saves alongside them")
    eq(id1, "hf:stabilityai/sdxl", "first HF id")
    eq(id2, "hf:black-forest-labs/flux.1-dev", "second HF id")
    eq(len(bs.load()), 3, "all three stored")

    print("duplicates are rejected")
    dup_hf, msg_hf, _ = bs.add({"name": "stabilityai/sdxl", "source": "hf", "repo_id": "stabilityai/sdxl",
                                "model_version_id": 0})
    eq(dup_hf, False, "same HF repo twice is a duplicate")
    eq(msg_hf, "Already bookmarked", "duplicate message")
    dup_civ, _, _ = bs.add({"name": "Cool LoRA", "source": "civitai", "model_version_id": 555})
    eq(dup_civ, False, "same Civitai version twice is a duplicate")
    diff_case, _, _ = bs.add({"source": "hf", "repo_id": "StabilityAI/SDXL"})
    eq(diff_case, False, "repo id match is case-insensitive")
    eq(len(bs.load()), 3, "still three after duplicates")

    print("deleting per source")
    removed, left = bs.remove({"id": "hf:stabilityai/sdxl"})
    ok(removed, "delete HF bookmark by id")
    eq(left, 2, "two left")
    eq([b["name"] for b in bs.load()], ["black-forest-labs/flux", "Cool LoRA"], "the right one was removed")

    removed, left = bs.remove({"id": "civitai:555", "source": "civitai", "model_version_id": 555})
    ok(removed, "delete Civitai bookmark by id")
    eq(left, 1, "one left — the HF one survived a Civitai delete")

print("legacy bookmarks (saved before sources existed)")
with tmpfile():
    with open(bs.bookmarks_path(), "w", encoding="utf-8") as fh:
        fh.write('[{"name": "Old LoRA", "model_version_id": 777, "model_id": 7, "type": "LORA"},'
                 ' {"name": "Old HF", "model_version_id": 0, "repo_id": "old/repo"}]')
    items = bs.load()
    eq(items[0]["source"], "civitai", "legacy civitai entry backfilled")
    eq(items[0]["id"], "civitai:777", "legacy civitai id backfilled")
    eq(items[1]["source"], "hf", "legacy hf entry detected via repo_id")
    eq(items[1]["id"], "hf:old/repo", "legacy hf id backfilled")
    removed, left = bs.remove({"model_version_id": 777})
    ok(removed, "legacy delete by model_version_id still works")
    eq(left, 1, "HF entry untouched")

print("bad payloads")
with tmpfile():
    ok_add, msg, _ = bs.add("not a dict")
    eq(ok_add, False, "non-dict payload rejected")
    removed, _ = bs.remove({})
    eq(removed, False, "empty delete matches nothing")

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
