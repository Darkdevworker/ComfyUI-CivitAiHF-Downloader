/**
 * Does the standalone runner still stand in for everything ComfyUI provides?
 *
 * Run with:  node standalone/test_standalone.mjs
 *
 * Two halves, because the extension's contract with ComfyUI is easy to break
 * by accident:
 *
 *   1. Static — every name the frontend imports from ComfyUI's scripts must
 *      exist in our shims. Miss one and `api.fetchApi` or `app.registerExtension`
 *      is simply undefined at runtime, with no import error to warn you.
 *   2. Boot — actually run js/civitai.js against the shims and check the UI
 *      builds (tabs, panes, band chips).
 *
 * The boot half needs jsdom, which is not a dependency of this project. If it
 * is missing the boot half is skipped rather than failed, so this file stays
 * runnable on a bare checkout:  npm i jsdom  to enable it.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

let pass = 0, fail = 0, skipped = 0;
function ok(cond, label) {
  if (cond) pass++;
  else { fail++; console.log(`  ✗ ${label}`); }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) pass++;
  else { fail++; console.log(`  ✗ ${label}\n      expected ${b}\n      actual   ${a}`); }
}
function skip(label) { skipped++; console.log(`  – ${label} (jsdom not installed)`); }

/* ── 1. every ComfyUI name the frontend imports must exist ─────────── */

console.log("shims satisfy the extension's imports");

const civSrc = fs.readFileSync(path.join(root, "js", "civitai.js"), "utf8");
const wanted = [];
for (const m of civSrc.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)) {
  const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
  wanted.push({ names, from: m[2] });
}
ok(wanted.length > 0, "found the extension's import statements");

const shims = {
  "../../scripts/api.js": path.join(here, "web", "scripts", "api.js"),
  "../../scripts/app.js": path.join(here, "web", "scripts", "app.js"),
  "./logo.js": path.join(root, "js", "logo.js"),
  "./rating.js": path.join(root, "js", "rating.js"),
};

// The shims must not need a DOM merely to be imported, or the checks below
// cannot run headless.
global.window = global.window || {
  __nsfwBlurEnabled: true, __nsfwBlurLevel: "R",
  addEventListener() {}, removeEventListener() {},
};
global.document = global.document || {
  createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, appendChild() {}, setAttribute() {} }),
  createElementNS: () => ({ setAttribute() {}, style: {}, classList: { add() {} } }),
  createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
  querySelectorAll: () => [], querySelector: () => null,
  addEventListener() {}, removeEventListener() {},
  documentElement: { style: { setProperty() {} } }, body: {},
};

const mods = {};
for (const [key, file] of Object.entries(shims)) {
  ok(fs.existsSync(file), `shim for ${key} exists at ${path.relative(root, file)}`);
  mods[key] = await import(file);
}

let checked = 0;
for (const { names, from } of wanted) {
  const mod = mods[from];
  if (!mod) continue;
  for (const n of names) {
    checked++;
    ok(n in mod, `${from} exports ${n}`);
  }
}
ok(checked >= 20, `checked ${checked} named imports`);

// and the specific members the extension calls
const { app } = mods["../../scripts/app.js"];
const { api } = mods["../../scripts/api.js"];
ok(typeof app.registerExtension === "function", "app.registerExtension");
ok(typeof app.extensionManager?.registerSidebarTab === "function",
   "app.extensionManager.registerSidebarTab");
ok(typeof app.refreshComboInNodes === "function", "app.refreshComboInNodes");
ok(typeof api?.fetchApi === "function", "api.fetchApi exists as a named export");

/* ── 2. boot the real frontend against the shims ───────────────────── */

console.log("the extension boots without ComfyUI");

let JSDOM = null;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  JSDOM = null;
}

if (!JSDOM) {
  skip("js/civitai.js builds its UI");
} else {
  // Reproduce the server's URL layout: the frontend reaches ComfyUI's scripts
  // as ../../scripts/*.js from /js/, which the server maps to /scripts/.
  const serve = fs.mkdtempSync("/tmp/civhf-standalone-");
  const scriptsDir = path.join(serve, "scripts");
  const jsDir = path.join(serve, "root", "js");
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(path.dirname(jsDir), { recursive: true });
  fs.cpSync(path.join(here, "web", "scripts"), scriptsDir, { recursive: true });
  fs.cpSync(path.join(root, "js"), jsDir, { recursive: true });

  const dom = new JSDOM(
    `<!DOCTYPE html><html><body><nav id="civ-rail"></nav><div id="civ-stage"></div></body></html>`,
    { url: "http://localhost/", pretendToBeVisual: true }
  );
  // No network in tests: every request resolves empty rather than hanging.
  dom.window.fetch = async () => ({
    ok: true, status: 200,
    text: async () => "{}",
    json: async () => ({}),
  });

  const w = dom.window;
  for (const k of ["window", "document", "navigator", "HTMLElement", "Node",
                   "CustomEvent", "Event", "fetch", "getComputedStyle",
                   "requestAnimationFrame", "localStorage", "MutationObserver",
                   "ResizeObserver", "IntersectionObserver", "URL", "location"]) {
    global[k] = w[k] !== undefined ? w[k] : global[k];
  }
  global.window = w;
  global.document = w.document;
  global.self = w;

  const errors = [];
  w.addEventListener("error", (e) => errors.push(e.message));

  await import(path.join(jsDir, "civitai.js"));
  await new Promise((r) => setTimeout(r, 300));

  const stage = w.document.getElementById("civ-stage");
  const rail = w.document.getElementById("civ-rail");

  eq(rail.querySelectorAll("button").length, 1, "one sidebar tab registered");
  eq(stage.children.length, 1, "the panel rendered into the stage");
  eq((stage.firstElementChild || {}).className, "cvt-root", "root element is .cvt-root");

  const tabs = [...stage.querySelectorAll(".cvt-tab")];
  eq(tabs.length, 6, "all six tabs are in the tab bar");
  eq(stage.querySelectorAll(".cvt-tab .cvt-icon").length, 6,
     "each tab carries a vector mark");
  eq(stage.querySelectorAll("[id^=cvt-pane-]").length, 6, "six panes exist");
  eq(stage.querySelectorAll(".cvt-band-box").length, 5, "five band chips are painted");
  eq(stage.querySelectorAll(".cvt-band-tick").length, 5, "each chip has its tick");
  ok(stage.querySelectorAll("input").length > 0, "the search bar has controls");
  eq(errors, [], "no runtime errors while booting");

  fs.rmSync(serve, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
process.exit(fail ? 1 : 0);
