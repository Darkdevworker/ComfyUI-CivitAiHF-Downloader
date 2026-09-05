/**
 * Paging for the Civitai browse grid: a search must be able to return more
 * than the first page of results (the grid used to show exactly `limit`
 * models and only advance when a small Prev/Next pager was clicked).
 *
 * Run with:  node tests/test_browse_paging.mjs
 *
 * These are static checks over js/civitai.js — the module imports ComfyUI
 * runtime modules, so it cannot be loaded outside the browser.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "js", "civitai.js"), "utf8");

// just the browse section, so the checks can't pass on code elsewhere
const at = src.indexOf("function renderBrowse(");
if (at < 0) { console.error("renderBrowse() not found"); process.exit(1); }
const browse = src.slice(at, src.indexOf("\nfunction ", at + 10));

let pass = 0, fail = 0;
function has(re, label) {
  if (re.test(browse)) { pass++; } else { fail++; console.log(`  x ${label} — not found: ${re}`); }
}
function hasNot(re, label) {
  if (!re.test(browse)) { pass++; } else { fail++; console.log(`  x ${label} — should be gone: ${re}`); }
}

console.log("loading more pages");
has(/function _loadMore\(\)/, "there is a load-more action");
has(/if \(S\.civitai\.loading \|\| !S\.civitai\.nextCursor\) return;/, "waits for a cursor and no in-flight request");
has(/S\.civitai\.cursor = S\.civitai\.nextCursor;/, "advances to the next cursor");
has(/_runSearch\(1, true\)/, "asks for the next page in append mode");
has(/function _runSearch\(attempt, append\)/, "_runSearch takes an append flag");
has(/if \(typeof append === "boolean"\) _appendMode = append;/, "append flag is honoured");

console.log("pages stack instead of replacing");
has(/if \(!_appendMode\) \{ grid\.innerHTML = ""; S\.civitai\.items = \[\]; \}/, "grid is only cleared on a fresh search");
has(/S\.civitai\.items = S\.civitai\.items\.concat\(fresh\);/, "new results are appended");
has(/if \(!_appendMode\) \{\s*_renderSkeletons\(grid, S\.civitai\.limit\);/, "skeletons only on a fresh search");
has(/moreBtn\.disabled = true; moreBtn\.textContent = "Loading\\u2026";/, "the button shows loading while appending");

console.log("no duplicates across pages");
has(/S\.civitai\.seen\[k\]/, "models already shown are skipped");
has(/if \(S\.civitai\.seen\[k\]\) return false;/, "a repeated model is filtered out");

console.log("result count");
has(/var meta = \(d && d\.metadata\) \|\| \{\};/, "reads the API metadata");
has(/if \(meta\.totalItems\) S\.civitai\.total = meta\.totalItems;/, "records the total Civitai reports");
has(/S\.civitai\.nextCursor = meta\.nextCursor \|\| null;/, "keeps the next cursor");
has(/Showing " \+ loaded \+ " of " \+ _fmtNum\(total\) \+ " models"/, "footer shows \"Showing N of TOTAL\"");
has(/var sfwOnly = !needsNsfwQuery\(parseBandSelection\(S\.civitai\.nsfw\)\);/, "works out whether adult results are being excluded");
has(/adult hidden/, "the count says when adult models are excluded");

console.log("automatic loading");
has(/IntersectionObserver/, "an observer watches for the end of the grid");
has(/rootMargin: "400px 0px"/, "the next page loads before the bottom is reached");
has(/observe\(sentinel\)/, "a sentinel element is watched");
has(/pane\._moreObserver =/, "the observer is kept alive on the pane");

console.log("reset behaviour");
has(/S\.civitai\.seen = \{\};/, "a new search clears the seen set");
has(/S\.civitai\.loaded = 0;/, "a new search resets the loaded count");
has(/S\.civitai\.total = 0;/, "a new search resets the total");
has(/_runSearch\(1, false\);/, "a new search runs in replace mode");

console.log("old pager removed");
hasNot(/prevBtn/, "no Prev button left");
hasNot(/nextBtn/, "no Next button left");
hasNot(/pageInfo\.textContent = "Page "/, "no bare page-number readout");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
