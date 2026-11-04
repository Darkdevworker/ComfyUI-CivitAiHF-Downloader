/**
 * DOM-side tests for the band helpers (badge, filter row, blur class).
 * Run with:  node tests/test_band_ui.mjs
 * Uses a tiny DOM stub so it runs anywhere — no jsdom needed.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const registry = [];   // every stub node, so querySelectorAll can find them

function makeEl(tag) {
  const classes = new Set();
  const node = {
    tagName: (tag || "").toUpperCase(),
    children: [], style: {}, dataset: {}, title: "", textContent: "",
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    _classes: classes,
    // keep className and classList in step the way a real element does, so
    // code that sets one and tests that read the other both work
    get className() { return [...classes].join(" "); },
    set className(v) {
      classes.clear();
      String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
    },
    appendChild(c) { this.children.push(c); return c; },
  };
  registry.push(node);
  return node;
}
global.document = {
  createElement: makeEl,
  createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
  querySelectorAll(sel) {
    if (sel !== "[data-cvt-band]") return [];
    return registry.filter((n) => n.dataset.cvtBand != null);
  },
};
global.window = { __nsfwBlurEnabled: true, __nsfwBlurLevel: "X" };

const {
  makeBandBadge, buildBandCheckboxes, buildBlurThresholdSelect, applyBlur, reapplyBlur,
  parseBandSelection, isBlurred,
} = await import("../js/rating.js");

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else { fail++; console.log(`  ✗ ${label}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`); }
}
function ok(cond, label) {
  if (cond) pass++;
  else { fail++; console.log(`  ✗ ${label}`); }
}
function has(text, re, label) {
  if (re.test(text)) pass++;
  else { fail++; console.log(`  ✗ ${label} — not found: ${re}`); }
}

console.log("badges");
const pgBadge = makeBandBadge("PG");
eq(pgBadge.textContent, "PG", "PG badge label");
eq(pgBadge.style.background, "#2e7d32", "PG badge uses the band colour");
eq(pgBadge.title.indexOf("Safe for Work") > 0, true, "PG tooltip carries the band definition");
const xBadge = makeBandBadge("X");
eq(xBadge.textContent, "X", "X badge label");
eq(xBadge.style.background, "#6a1b9a", "X badge colour");
eq(makeBandBadge("bogus").textContent, "PG", "unknown band falls back to PG");

console.log("filter row");
const row = buildBandCheckboxes("PG,X", () => {});
eq(row.children.length, 6, "5 band labels + an All button");
eq(row._getVal(), "PG,X", "round-trips the selection");
row._cbs["R"].checked = true;
eq(row._getVal(), "PG,R,X", "ticking R updates the value");
row._setVal("XXX");
eq(row._getVal(), "XXX", "_setVal applies a selection");
eq(parseBandSelection(row._getVal()), ["XXX"], "parse round-trip");

console.log("the row keeps all five bands on one line");
eq(row.style.flexWrap, "nowrap", "the labels never wrap onto a second row");
eq(row.style.whiteSpace, "nowrap", "and a label itself never breaks");
eq(row.style.overflowX, "auto", "a panel too narrow to fit them scrolls instead");

console.log("All / Clear flips both ways");
const allBtn = row.children[5];
eq(row.children.length, 6, "still 5 labels + one toggle");
row._setVal("");
eq(allBtn.textContent, "All", "with nothing ticked it offers to tick them all");
allBtn.onclick();
eq(row._getVal(), "PG,PG-13,R,X,XXX", "clicking All ticks every band — adult models included");
eq(allBtn.textContent, "Clear", "and it now offers to untick them");
allBtn.onclick();
eq(row._getVal(), "", "clicking Clear unticks every band");
eq(allBtn.textContent, "All", "and it offers All again");

console.log("  the label follows the checkboxes, not just the button");
row._setVal("PG,R");
eq(allBtn.textContent, "All", "a partial selection still offers All");
["PG-13", "X", "XXX"].forEach(function (id) {
  row._cbs[id].checked = true;
  row._cbs[id].onchange();
});
eq(allBtn.textContent, "Clear", "ticking the last one by hand flips the label");
row._cbs["R"].checked = false;
row._cbs["R"].onchange();
eq(allBtn.textContent, "All", "unticking one flips it back");
row._setVal("PG,PG-13,R,X,XXX");
eq(allBtn.textContent, "Clear", "_setVal keeps the label in step");

console.log("threshold select");
const sel = buildBlurThresholdSelect("X");
eq(sel.value, "X", "select shows the current threshold");
eq(sel.children.length, 4, "off / R+ / X+ / XXX options");

console.log("blur application");
const thumb = makeEl("div");
eq(applyBlur(thumb, "XXX"), true, "XXX gets blurred");
eq(thumb.classList.contains("cvt-blur"), true, "cvt-blur class applied");
eq(applyBlur(thumb, "PG"), false, "PG is not blurred");
eq(thumb.classList.contains("cvt-blur"), false, "cvt-blur class removed");
const rThumb = makeEl("div");
window.__nsfwBlurLevel = "R";
eq(applyBlur(rThumb, "R"), true, "R blurs once the threshold is R");
window.__nsfwBlurLevel = "X";
const offThumb = makeEl("div");
window.__nsfwBlurLevel = "off";
eq(applyBlur(offThumb, "XXX"), false, "threshold off never blurs");
window.__nsfwBlurLevel = "X";
window.__nsfwBlurEnabled = false;
eq(isBlurred("XXX"), false, "master switch disables blur");
window.__nsfwBlurEnabled = true;

console.log("re-blur without re-rendering (settings dropdown change)");
const card = makeEl("div");
applyBlur(card, "XXX");
eq(card.dataset.cvtBand, "XXX", "band is remembered on the node");
eq(card.classList.contains("cvt-blur"), true, "XXX blurred at threshold X");
window.__nsfwBlurLevel = "off";
eq(reapplyBlur(document) > 0, true, "reapplyBlur finds rendered nodes");
eq(card.classList.contains("cvt-blur"), false, "threshold off -> card un-blurred");
eq(card.dataset.cvtBand, "XXX", "band still remembered while visible");
window.__nsfwBlurLevel = "X";
reapplyBlur(document);
eq(card.classList.contains("cvt-blur"), true, "raising the threshold re-blurs the same card");
const pgCard = makeEl("div");
applyBlur(pgCard, "PG");
window.__nsfwBlurLevel = "R";
reapplyBlur(document);
eq(pgCard.classList.contains("cvt-blur"), false, "PG stays visible at threshold R");

console.log("ticking a band never searches on its own");
// static: the browse panel lives in civitai.js, which imports ComfyUI modules
const panel = fs.readFileSync(path.join(here, "..", "js", "civitai.js"), "utf8");
const css = fs.readFileSync(path.join(here, "..", "js", "civitai.css"), "utf8");

/* ── the painted band boxes ────────────────────────────────────────────
 * Each band is an outlined square in its own colour with a white tick when
 * on, replacing the native checkbox + swatch. The real checkbox has to
 * survive (keyboard, screen readers) even though it is hidden. */
console.log("painted band boxes");
const BAND_PALETTE = [
  ["PG", "#2e7d32"], ["PG-13", "#b26a00"], ["R", "#c62828"],
  ["X", "#6a1b9a"], ["XXX", "#111111"],
];
const INVISIBLE_LUMA = 0.15;   // bands below this are invisible as an outline
const TARGET_LUMA = 0.32;      // ...and get lifted to here
function luma(hex) {
  const n = parseInt(String(hex).replace("#", ""), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}
eq(row.children.length, 6, "row still holds five bands plus All");

for (let i = 0; i < BAND_PALETTE.length; i++) {
  const [id, colour] = BAND_PALETTE[i];
  const lbl = row.children[i];
  eq(lbl.children.length, 3, `${id}: label holds checkbox, box and text`);
  const [cb, box, text] = lbl.children;
  eq(cb.type, "checkbox", `${id}: a real checkbox survives for keyboard + a11y`);
  eq(cb.value, id, `${id}: checkbox carries the band id`);
  eq(box._classes.has("cvt-band-box"), true, `${id}: box is tagged for CSS`);
  eq(box.children.length, 1, `${id}: box holds exactly the tick`);
  eq(box.children[0]._classes.has("cvt-band-tick"), true, `${id}: tick is tagged for CSS`);
  eq(text.textContent, id, `${id}: the band id is still readable text`);
  has(box.children[0].innerHTML, /<svg[\s\S]*<path/, `${id}: tick is real inline SVG`);
  // The painted colour has to be visible on a near-black panel. XXX is
  // #111111, right for a filled badge but invisible as an outline, so it is
  // the one band that gets lifted. Everything else is legible as drawn and
  // must keep its exact palette colour.
  if (luma(colour) >= INVISIBLE_LUMA) {
    eq(box.style.borderColor, colour, `${id}: keeps its palette colour unchanged`);
  } else {
    ok(luma(box.style.borderColor) >= TARGET_LUMA - 1e-9,
       `${id}: lifted from ${colour} to ${box.style.borderColor}, clearing the target`);
  }
  eq(box.style.background, box.style.borderColor + "4D", `${id}: fill is 30% of the chip colour`);
}
ok(luma(row.children[4].children[1].style.borderColor) > luma("#111111"),
   "XXX is lifted out of the near-black range rather than painted #111111");

// CSS has to do its half: hide the native box, show the tick when checked
has(css, /\.cvt-band > \.cvt-band-cb:checked \+ \.cvt-band-box > \.cvt-band-tick/,
  "CSS reveals the tick when the box is checked");
has(css, /\.cvt-band > \.cvt-band-cb \{[^}]*opacity: 0/,
  "CSS hides the native checkbox visually (but keeps it focusable)");
has(css, /\.cvt-band > \.cvt-band-cb:focus-visible \+ \.cvt-band-box/,
  "CSS shows a focus ring on the painted box");
// Just the band row. It runs up to the chip row, which legitimately does
// call _resetAndSearch — removing a chip is meant to re-run the search,
// unlike ticking a band.
const bandRowEnd = panel.indexOf("sb.appendChild(ratingRow);");
const bandRow = panel.slice(panel.indexOf("// ---- Content band row"),
                            bandRowEnd + "sb.appendChild(ratingRow);".length);
function panelHas(re, label) {
  if (re.test(bandRow)) { pass++; } else { fail++; console.log(`  x ${label} — not found: ${re}`); }
}
function panelHasNot(re, label) {
  if (!re.test(bandRow)) { pass++; } else { fail++; console.log(`  x ${label} — should be gone: ${re}`); }
}
panelHasNot(/setTimeout/, "no debounce timer on the band row");
panelHasNot(/_resetAndSearch/, "ticking a band does not re-run the search");
panelHasNot(/_bandTimer/, "no debounce state left");
panelHasNot(/_runSearch/, "no search call of any kind from the band row");
panelHas(/S\.civitai\.nsfw = ratingRow\._getVal\(\);/, "the tick is recorded for the next search");
panelHasNot(/press Search to apply/, "the 'press Search to apply' hint is gone");
panelHasNot(/"Bands:"/, "and so is the label that shared the line with the row");
panelHas(/sb\.appendChild\(ratingRow\);/, "the row is given the search bar's whole width");
panelHasNot(/cvt-row[^\n]*ratingRow/, "it no longer sits inside a row that splits the space");
eq((panel.match(/S\.civitai\.nsfw = ratingRow\._getVal\(\);/g) || []).length, 2,
   "the band value is read both on tick and when a search runs");
eq(panel.indexOf("_resetAndSearch(); }, 350)"), -1, "the old debounced call is gone");
eq(/goBtn\.onclick = function\(\) \{ _resetAndSearch\(\); \};/.test(panel), true,
   "the Search button still runs the search");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
