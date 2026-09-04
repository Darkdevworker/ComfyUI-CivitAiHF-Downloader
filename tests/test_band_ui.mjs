/**
 * DOM-side tests for the band helpers (badge, filter row, blur class).
 * Run with:  node tests/test_band_ui.mjs
 * Uses a tiny DOM stub so it runs anywhere — no jsdom needed.
 */
const registry = [];   // every stub node, so querySelectorAll can find them

function makeEl(tag) {
  const classes = new Set();
  const node = {
    tagName: (tag || "").toUpperCase(),
    children: [], style: {}, dataset: {}, title: "", textContent: "", className: "",
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    _classes: classes,
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
