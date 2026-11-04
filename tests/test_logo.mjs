/**
 * Sidebar-logo tests — run with:  node tests/test_logo.mjs
 * Checks that installSidebarLogo() exposes the PNG to CSS and tags the right
 * sidebar button, and that makeLogo() builds an <img> pointing at the logo.
 */
import { readFileSync } from "node:fs";

const buttons = [];
function makeEl(tag) {
  const classes = new Set();
  const attrs = {};
  const node = {
    tagName: (tag || "").toUpperCase(),
    children: [], style: {}, dataset: {}, textContent: "", className: "",
    innerHTML: "", attrs,
    classList: {
      add: (c) => { classes.add(c); node.className = [...classes].join(" "); },
      remove: (c) => { classes.delete(c); node.className = [...classes].join(" "); },
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute(k, v) {
      attrs[k] = String(v);
      // keep classList/className in sync the way a real element does
      if (k === "class") {
        classes.clear();
        String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
        node.className = [...classes].join(" ");
      }
    },
    appendChild(c) { this.children.push(c); return c; },
  };
  return node;
}
function sidebarButton(testId, ariaLabel, extraClass) {
  const b = makeEl("button");
  b.className = "side-bar-button" + (extraClass ? " " + extraClass : "");
  if (testId) b.setAttribute("data-testid", testId);
  if (ariaLabel) b.setAttribute("aria-label", ariaLabel);
  b.classList.contains("side-bar-button");
  const i = makeEl("i");
  i.className = "pi pi-globe side-bar-button-icon";
  b.appendChild(i);
  buttons.push(b);
  return b;
}

const cssVars = {};
global.document = {
  documentElement: { style: { setProperty: (k, v) => { cssVars[k] = v; } } },
  createElement: makeEl,
  createElementNS: (_ns, tag) => makeEl(tag),
  createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
  querySelectorAll(sel) {
    // support the comma-separated selector lists installSidebarLogo() uses
    const out = [];
    sel.split(",").map((s) => s.trim()).forEach((part) => {
      let matches = [];
      const attr = part.match(/^\[data-testid="(.+?)"\]$/);
      const sub = part.match(/^\[class\*="(.+?)"\]$/);
      if (attr) matches = buttons.filter((b) => b.getAttribute("data-testid") === attr[1]);
      else if (sub) matches = buttons.filter((b) => b.className.includes(sub[1]));
      else if (part.startsWith(".")) matches = buttons.filter((b) => b.classList.contains(part.slice(1)));
      matches.forEach((m) => { if (!out.includes(m)) out.push(m); });
    });
    return out;
  },
  querySelector(sel) {
    if (sel === ".cvt-sidebar-tab") return buttons.find((b) => b.classList.contains("cvt-sidebar-tab")) || null;
    return null;
  },
};
global.window = {};

const {
  CIVITAI_LOGO_PNG, DOWNLOADS_LOGO_PNG, TAB_LOGOS, installSidebarLogo, makeLogo,
  ICONS, ICONS_BRANDED, svgIcon,
} = await import("../js/logo.js");

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else { fail++; console.log(`  ✗ ${label}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`); }
}
function ok(cond, label) { eq(!!cond, true, label); }

console.log("logo asset");
ok(CIVITAI_LOGO_PNG.startsWith("data:image/png;base64,"), "logo is an inline PNG data URI");
ok(CIVITAI_LOGO_PNG.length > 500, "logo data URI is populated");

console.log("sidebar tagging");
const ours = sidebarButton("civitai-hf-tab-button", "Civitai & Hugging Face Downloader");
const other = sidebarButton("queue-tab-button", "Queue");
installSidebarLogo("civitai-hf", "Civitai");
eq(ours.classList.contains("cvt-sidebar-tab"), true, "our tab is tagged");
eq(other.classList.contains("cvt-sidebar-tab"), false, "other tabs are untouched");
ok((cssVars["--cvt-sidebar-logo"] || "").includes(CIVITAI_LOGO_PNG.slice(0, 60)),
  "--cvt-sidebar-logo points at the logo");

console.log("fallback: no data-testid (older frontends)");
const buttons2 = [];
buttons.length = 0;
const legacy = sidebarButton(null, "Civitai & Hugging Face Downloader");
const legacyOther = sidebarButton(null, "Workflows");
installSidebarLogo("civitai-hf", "Civitai");
eq(legacy.classList.contains("cvt-sidebar-tab"), true, "matched by aria-label");
eq(legacyOther.classList.contains("cvt-sidebar-tab"), false, "other legacy tabs untouched");

console.log("tab logo map");
ok(DOWNLOADS_LOGO_PNG.startsWith("data:image/png;base64,"), "downloads icon is an inline PNG");
eq(Object.keys(TAB_LOGOS).sort(), ["civitai", "downloads"], "civitai + downloads have image marks");
eq(TAB_LOGOS.civitai, CIVITAI_LOGO_PNG, "civitai maps to the C logo");
eq(TAB_LOGOS.downloads, DOWNLOADS_LOGO_PNG, "downloads maps to the green arrow");
eq(TAB_LOGOS.hf, undefined, "HF keeps its emoji");
eq(TAB_LOGOS.local, undefined, "Local keeps its emoji");
eq(TAB_LOGOS.settings, undefined, "Settings keeps its emoji");

console.log("makeLogo");
const img = makeLogo(18, "Civitai");
eq(img.tagName, "IMG", "creates an <img>");
eq(img.src, CIVITAI_LOGO_PNG, "src is the logo");
eq(img.alt, "Civitai", "alt text set");
eq(img.style.width, "18px", "sized as asked");
ok(img.className.includes("cvt-logo"), "carries the .cvt-logo class");

/* ── the vector icon set ─────────────────────────────────────────── */

console.log("icon set");
const names = Object.keys(ICONS);
ok(names.length >= 24, `icon set is populated (${names.length} marks)`);

// [viewBox, markup] with at least one real shape in it
for (const n of names) {
  const rec = ICONS[n];
  ok(Array.isArray(rec) && rec.length === 2, `${n}: [viewBox, markup]`);
  const [vb, markup] = rec || [];
  ok(/^\s*-?[\d.]+\s+-?[\d.]+\s+[\d.]+\s+[\d.]+\s*$/.test(vb || ""), `${n}: viewBox "${vb}" is four numbers`);
  ok(/<(path|rect|circle|g)\b/.test(markup || ""), `${n}: markup draws something`);
}

// Inlined SVGs share one DOM — a repeated id would let one icon's <defs>
// hijack another's fill/stroke/filter. Every id must be unique across the set.
const ids = [];
for (const n of names) for (const m of (ICONS[n][1] || "").matchAll(/id="([^"]+)"/g)) ids.push(m[1]);
const dupes = ids.filter((x, i) => ids.indexOf(x) !== i);
eq([...new Set(dupes)], [], "no duplicate element ids across the icon set");

// Brand marks and chrome shapes keep their own colours; everything else must
// use currentColor so it dims/activates with the control it sits in.
for (const n of names) {
  const branded = ICONS_BRANDED.includes(n);
  const markup = ICONS[n][1] || "";
  const hasColour = /fill="#[0-9A-Fa-f]{3,8}"|stroke="#[0-9A-Fa-f]{3,8}"/.test(markup);
  eq(hasColour, branded, `${n}: ${branded ? "keeps" : "does not keep"} hard-coded colours`);
  if (!branded) ok(markup.includes("currentColor"), `${n}: uses currentColor`);
}

// Regression: a hand-authored icon may put stroke="currentColor" on its root
// <svg> rather than on each path. The set only stores inner markup, so those
// inherited attributes have to be hoisted onto a wrapper <g> or the mark
// renders with no stroke at all.
for (const n of names) {
  const markup = ICONS[n][1] || "";
  const bare = markup.match(/<(path|rect|circle)\b[^>]*>/g) || [];
  const nested = /<g\b[^>]*stroke=|<g\b[^>]*fill="#/.test(markup);
  const allCarryTheirOwn = bare.length > 0 && bare.every((t) => /stroke="|fill="/.test(t));
  ok(nested || allCarryTheirOwn, `${n}: shapes carry their own paint (or inherit from a <g>)`);
}

console.log("svgIcon()");
const sv = svgIcon("refresh", 20);
eq(sv.tagName, "SVG", "creates an <svg>");
eq(sv.getAttribute("viewBox"), ICONS.refresh[0], "viewBox copied from the set");
eq(sv.getAttribute("width"), "20", "width applied");
eq(sv.getAttribute("height"), "20", "height applied");
ok(sv.className.includes("cvt-icon"), "carries the .cvt-icon class");
eq(sv.getAttribute("aria-hidden"), "true", "hidden from assistive tech");
eq(sv.innerHTML, ICONS.refresh[1], "markup injected verbatim");

const svCls = svgIcon("download", 15, "extra");
ok(svCls.className.includes("extra"), "extra class appended");

eq(svgIcon("does-not-exist", 16), null, "unknown name returns null (callers fall back)");
eq(svgIcon(undefined, 16), null, "undefined name returns null");
ok(svgIcon("civitai", 16) !== null, "default size works");

// The tab bar names its marks as strings — a typo there would silently fall
// back to an emoji with no error anywhere.
console.log("TABS reference real icons");
const civSrc = readFileSync(new URL("../js/civitai.js", import.meta.url), "utf8");
const tabsBlock = civSrc.match(/const TABS = \[([\s\S]*?)\n\];/);
ok(!!tabsBlock, "found the TABS array");
const referenced = [...(tabsBlock ? tabsBlock[1] : "").matchAll(/\["([a-z]+)",\s*"[^"]*",\s*"[^"]*",\s*"[^"]*",\s*"([^"]+)"\]/g)]
  .map((m) => ({ tab: m[1], mark: m[2] }));
ok(referenced.length === 6, `all six tabs declare a mark (found ${referenced.length})`);
for (const r of referenced) {
  ok(!!ICONS[r.mark], `tab "${r.tab}" -> icon "${r.mark}" exists`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
