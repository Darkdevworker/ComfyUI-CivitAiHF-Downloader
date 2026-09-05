/**
 * Bookmark card view — run with:  node tests/test_bookmark_ui.mjs
 *
 * Covers the card grid, the filters, click-through to the model detail, and
 * the stale-list bug: removing a bookmark deleted it on the server but the
 * card stayed on screen, because _api() caches GETs and the reload simply
 * re-rendered the cached list.
 *
 * Static checks over js/civitai.js — the module imports ComfyUI runtime
 * modules, so it cannot be loaded outside the browser.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "js", "civitai.js"), "utf8");

function fn(name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) { console.error(`${name}() not found`); process.exit(1); }
  return src.slice(at, src.indexOf("\nfunction ", at + 10));
}
const card = fn("_bookmarkCard");
const open = fn("_openBookmark");
const dl = fn("_downloadBookmark");
const render = fn("renderBookmarks");

let pass = 0, fail = 0;
function has(text, re, label) {
  if (re.test(text)) { pass++; } else { fail++; console.log(`  x ${label} — not found: ${re}`); }
}
function hasNot(text, re, label) {
  if (!re.test(text)) { pass++; } else { fail++; console.log(`  x ${label} — should be gone: ${re}`); }
}

console.log("removal leaves no stale card behind");
has(card, /_cache\.del\("\/civitai\/bookmarks"\);/, "the cached list is expired on delete");
has(card, /if \(card\.parentNode\) card\.remove\(\);/, "the card is taken off screen at once");
has(card, /rmBtn\.disabled = true;/, "the remove button is disabled while it is in flight");
has(card, /if \(r && r\.success === false\)/, "a delete the server could not match is reported as a failure");
has(card, /"Could not remove: "/, "and says so instead of claiming success");
hasNot(dl, /b\.id,/, "the bookmark's own id is never sent as a version id");
has(card, /rmBtn\.disabled = false;/, "it is re-enabled if the delete fails");
has(render, /_apiFresh\("\/civitai\/bookmarks"\)/, "the reload bypasses the GET cache");
hasNot(render, /_api\("\/civitai\/bookmarks"\)/, "the reload does not read the cached list");
has(card, /id: b\.id \|\| "", source: src,/, "the delete identifies the bookmark by its own id");
has(card, /model_version_id: b\.model_version_id \|\| 0, repo_id: b\.repo_id \|\| ""/,
    "and still sends the fields older payloads relied on");

console.log("card view");
has(render, /class: "cvt-grid", id: "cvt-bm-grid"/, "bookmarks render into a card grid");
has(render, /\["all", "All"\], \["civitai", "Civitai"\], \["hf", "Hugging Face"\]/, "All / Civitai / Hugging Face filters");
has(render, /" \\u00B7 " \+ civ \+ " Civitai \\u00B7 " \+ hf \+ " HF"/, "header counts Civitai and HF separately");
has(render, /No bookmarks yet/, "empty state tells you how to add one");
has(card, /_bmSource\(b\)/, "each card knows which source it came from");
has(card, /src === "hf" \? "HF" : "Civitai"/, "cards carry a source chip");
has(card, /bandIdOfImage\(\{ nsfwLevel: b\.nsfw_level \}\)/, "Civitai cards show their content band");
has(card, /applyBlur\(thumb, band\)/, "and blur it the same way the browse grid does");

console.log("clicking a card opens the model");
has(card, /card\.onclick = function\(\) \{ _openBookmark\(b\); \};/, "the card opens the bookmark");
has(open, /_bmSource\(b\) === "hf"/, "HF bookmarks are handled separately");
has(open, /_hfDetail\(b\.repo_id, b\.repo_type \|\| "model"\);/, "HF opens the repo detail");
has(open, /\/civitai\/lookup\?model_id=/, "Civitai is resolved through the lookup route");
has(open, /openDetail\(r\.data\);/, "and then the normal model detail opens");

console.log("downloading from a card");
has(card, /dlBtn\.onclick = function\(e\) \{ e\.stopPropagation\(\); _downloadBookmark\(b\); \};/,
    "the download button acts on that bookmark");
has(dl, /"\/civitai\/download"/, "Civitai bookmarks queue a download");
has(dl, /if \(_bmSource\(b\) === "hf"\) \{ _openBookmark\(b\); return; \}/,
    "HF bookmarks open the repo so a file can be picked");
has(dl, /_bmFolderForType\(b\.type\)/, "Civitai bookmarks pick the folder from the model type");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
