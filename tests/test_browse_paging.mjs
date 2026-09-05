/**
 * Paging for the search grids (Civitai browse + Hugging Face): both use
 * discrete pages with Prev/Next rather than loading as you scroll, and both
 * report how far through the results you are.
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

function section(name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) { console.error(`${name}() not found`); process.exit(1); }
  return src.slice(at, src.indexOf("\nfunction ", at + 10));
}
const browse = section("renderBrowse");
const hf = section("renderHF");

let pass = 0, fail = 0;
function check(text, re, label) {
  if (re.test(text)) { pass++; } else { fail++; console.log(`  x ${label} — not found: ${re}`); }
}
function reject(text, re, label) {
  if (!re.test(text)) { pass++; } else { fail++; console.log(`  x ${label} — should be gone: ${re}`); }
}
const has = (re, label) => check(browse, re, label);
const hasNot = (re, label) => reject(browse, re, label);
const hfHas = (re, label) => check(hf, re, label);
const hfHasNot = (re, label) => reject(hf, re, label);

console.log("civitai grid — page navigation");
has(/var prevBtn = el\("button", \{ class: "cvt-btn ghost" \}, "\\u2190 Prev"\);/, "a Prev button");
has(/var nextBtn = el\("button", \{ class: "cvt-btn ghost" \}, "Next \\u2192"\);/, "a Next button");
has(/prevBtn\.onclick = function\(\) \{ _goPage\(-1\); \};/, "Prev steps back a page");
has(/nextBtn\.onclick = function\(\) \{ _goPage\(1\); \};/, "Next steps forward a page");
has(/function _goPage\(delta\)/, "one action handles both directions");
has(/S\.civitai\.cursorStack\.push\(S\.civitai\.cursor\);/, "Next remembers where it was");
has(/S\.civitai\.cursor = S\.civitai\.nextCursor;/, "Next follows the cursor Civitai gives");
has(/if \(!S\.civitai\.nextCursor\) return;/, "Next stops at the last page");
has(/S\.civitai\.cursor = S\.civitai\.cursorStack\.pop\(\) \|\| "";/, "Prev steps back through the stack");
has(/if \(!S\.civitai\.cursorStack\.length\) return;/, "Prev stops on the first page");
has(/S\.civitai\.page \+= 1;/, "the page number goes up");
has(/S\.civitai\.page -= 1;/, "the page number comes back down");
has(/_scrollResultsTop\(\);/, "a new page starts at the top");

console.log("civitai grid — one page at a time");
has(/S\.civitai\.items = items;/, "the page replaces the previous results");
has(/grid\.innerHTML = "";/, "the grid is cleared for each page");
has(/items\.forEach\(function\(m\) \{ frag\.appendChild\(_card\(m\)\); \}\);/, "cards are built for the page");
has(/function _runSearch\(attempt\) \{/, "search has no append mode any more");
hasNot(/_appendMode/, "no append mode left");
hasNot(/S\.civitai\.seen/, "no cross-page de-duplication needed");
hasNot(/S\.civitai\.items\.concat/, "pages do not accumulate");

console.log("civitai grid — no scroll loading");
hasNot(/IntersectionObserver/, "nothing loads on scroll");
hasNot(/sentinel/, "no scroll sentinel");
hasNot(/moreBtn/, "no load-more button");
hasNot(/Load more/, "no load-more label");

console.log("civitai grid — footer");
has(/var bits = \["Page " \+ page\];/, "the footer names the page");
has(/"Showing " \+ first \+ "\\u2013" \+ \(first \+ count - 1\)/, "the footer shows the range on screen");
has(/_fmtNum\(S\.civitai\.total\) \+ " models"/, "the footer shows the total Civitai reports");
has(/if \(meta\.totalItems\) S\.civitai\.total = meta\.totalItems;/, "the total comes from the API metadata");
has(/S\.civitai\.nextCursor = meta\.nextCursor \|\| null;/, "the next cursor is kept");
has(/needsNsfwQuery\(parseBandSelection\(S\.civitai\.nsfw\)\)/, "checks whether adult results are excluded");
has(/adult hidden/, "flags when adult models are excluded");
has(/prevBtn\.disabled = !S\.civitai\.cursorStack\.length;/, "Prev is disabled on page 1");
has(/nextBtn\.disabled = !S\.civitai\.nextCursor;/, "Next is disabled on the last page");

console.log("civitai grid — reset");
has(/S\.civitai\.page = 1;/, "a new search starts at page 1");
has(/S\.civitai\.cursorStack = \[\];/, "a new search clears the page history");

console.log("hugging face grid — page navigation");
hfHas(/var prevBtn = el\("button", \{ class: "cvt-btn ghost" \}, "\\u2190 Prev"\);/, "a Prev button");
hfHas(/var nextBtn = el\("button", \{ class: "cvt-btn ghost" \}, "Next \\u2192"\);/, "a Next button");
hfHas(/function _goHFPage\(delta\)/, "one action handles both directions");
hfHas(/skip: String\(\(\(S\.hf\.page \|\| 1\) - 1\) \* HF_PAGE\),/, "the offset follows the page number");
hfHas(/if \(delta > 0 && S\.hf\.done\) return;/, "Next stops at the last page");
hfHas(/if \(next < 1\) return;/, "Prev stops on the first page");
hfHas(/_scrollHFTop\(\);/, "a new page starts at the top");
hfHas(/S\.hf\.items = items;/, "the page replaces the previous results");
hfHas(/S\.hf\.done = !d\.hasMore \|\| !items\.length;/, "knows when there is nothing more");
hfHas(/prevBtn\.disabled = page <= 1;/, "Prev is disabled on page 1");
hfHas(/nextBtn\.disabled = S\.hf\.done;/, "Next is disabled on the last page");
hfHas(/var bits = \["Page " \+ page\];/, "the footer names the page");
hfHas(/S\.hf\.page = 1;/, "a new search starts at page 1");
hfHasNot(/IntersectionObserver/, "nothing loads on scroll");
hfHasNot(/sentinel/, "no scroll sentinel");
hfHasNot(/moreBtn/, "no load-more button");
hfHasNot(/S\.hf\.seen/, "no cross-page de-duplication needed");
hfHasNot(/S\.hf\.skip/, "no running offset kept in state");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
