/**
 * Sidebar-logo tests — run with:  node tests/test_logo.mjs
 * Checks that installSidebarLogo() exposes the PNG to CSS and tags the right
 * sidebar button, and that makeLogo() builds an <img> pointing at the logo.
 */
const buttons = [];
function makeEl(tag) {
  const classes = new Set();
  const attrs = {};
  const node = {
    tagName: (tag || "").toUpperCase(),
    children: [], style: {}, dataset: {}, textContent: "", className: "",
    attrs,
    classList: {
      add: (c) => { classes.add(c); node.className = [...classes].join(" "); },
      remove: (c) => { classes.delete(c); node.className = [...classes].join(" "); },
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    setAttribute: (k, v) => { attrs[k] = String(v); },
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

const { CIVITAI_LOGO_PNG, installSidebarLogo, makeLogo } = await import("../js/logo.js");

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

console.log("makeLogo");
const img = makeLogo(18, "Civitai");
eq(img.tagName, "IMG", "creates an <img>");
eq(img.src, CIVITAI_LOGO_PNG, "src is the logo");
eq(img.alt, "Civitai", "alt text set");
eq(img.style.width, "18px", "sized as asked");
ok(img.className.includes("cvt-logo"), "carries the .cvt-logo class");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
