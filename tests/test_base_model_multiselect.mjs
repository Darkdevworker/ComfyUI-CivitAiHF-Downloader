/**
 * Civitai section: the base-model filter is a multi-select.
 *
 * It used to be a single-line datalist input, so only one base model could
 * ever be sent even though the server has always accepted a comma-separated
 * `baseModels` list.
 *
 * Run with:  node tests/test_base_model_multiselect.mjs
 *
 * Two halves: the control is exec'd out of js/civitai.js and driven through a
 * minimal DOM shim (so real checkboxes really get ticked), and the wiring is
 * checked statically because the module cannot be loaded outside the browser.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "js", "civitai.js"), "utf8");
const css = fs.readFileSync(path.join(here, "..", "js", "civitai.css"), "utf8");

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; } else { fail++; console.log(`  x ${label}`); }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) { pass++; } else { fail++; console.log(`  x ${label}\n      expected ${b}\n      actual   ${a}`); }
}
function check(text, re, label) {
  if (re.test(text)) { pass++; } else { fail++; console.log(`  x ${label} — not found: ${re}`); }
}
function reject(text, re, label) {
  if (!re.test(text)) { pass++; } else { fail++; console.log(`  x ${label} — should be gone: ${re}`); }
}

// ── a DOM small enough to hold the popup ───────────────────────────────
class ShimNode {}
class ShimClassList {
  constructor() { this.set = new Set(); }
  add(c) { this.set.add(c); }
  remove(c) { this.set.delete(c); }
  contains(c) { return this.set.has(c); }
  toggle(c, on) {
    const want = on === undefined ? !this.set.has(c) : !!on;
    if (want) this.set.add(c); else this.set.delete(c);
    return want;
  }
}
class ShimEl extends ShimNode {
  constructor(tag) {
    super();
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.classList = new ShimClassList();
    this.parentNode = null;
    this._text = "";
    this._listeners = {};
    this._attrs = {};
    this.checked = false;
    this.value = "";
    this.type = "";
  }
  // el() sets `className` directly, so keep classList in step with it
  get className() { return [...this.classList.set].join(" "); }
  set className(v) {
    this.classList.set = new Set(String(v || "").split(/\s+/).filter(Boolean));
  }
  appendChild(child) {
    if (child instanceof ShimText) { this._text += child.text; child.parentNode = this; return child; }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  contains(node) {
    if (node === this) return true;
    return this.children.some((k) => k && k.contains && k.contains(node));
  }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  removeEventListener(t, fn) {
    const a = this._listeners[t] || [];
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  }
  setAttribute(k, v) { this._attrs[k] = v; this[k] = v; if (k === "class") this.className = v; }
  removeAttribute(k) { delete this._attrs[k]; }
  get textContent() { return this._text + this.children.map((c) => c.textContent || "").join(""); }
  set textContent(v) { this._text = v == null ? "" : String(v); this.children = []; }
  set innerHTML(v) { if (v === "") { this.children = []; this._text = ""; } }
  get offsetWidth() { return 240; }
  get offsetHeight() { return 300; }
  getBoundingClientRect() { return { left: 20, top: 100, right: 150, bottom: 130, width: 130, height: 30 }; }
  querySelector(sel) { return findByClass(this, sel.replace(/^\./, "")); }
  focus() {}
}
class ShimText extends ShimNode {
  constructor(text) { super(); this.text = String(text); }
  get textContent() { return this.text; }
}
function findByClass(node, cls) {
  for (const c of node.children || []) {
    if (c.classList && c.classList.contains(cls)) return c;
    const hit = findByClass(c, cls);
    if (hit) return hit;
  }
  return null;
}

function makeDoc() {
  return {
    createElement: (tag) => new ShimEl(tag),
    createTextNode: (t) => new ShimText(t),
    body: new ShimEl("body"),
    _listeners: {},
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
    removeEventListener(t, fn) {
      const a = this._listeners[t] || [];
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
  };
}
const shimWindow = {
  innerWidth: 1200,
  innerHeight: 800,
  _listeners: {},
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
  removeEventListener(t, fn) {
    const a = this._listeners[t] || [];
    const i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  },
};

// ── run the real control ───────────────────────────────────────────────
function slice(from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error("cannot slice " + from);
  return src.slice(a, b);
}

const code = [
  slice("const CIVITAI_BASE_MODELS = [", "];") + "];",
  slice("function el(tag, attrs, ...children) {", "\nconst CIVITAI_TYPES"),
  slice("function buildBaseModelMultiSelect(selected, onChange) {", "\nfunction renderBrowse(pane) {"),
  "\nreturn { buildBaseModelMultiSelect, CIVITAI_BASE_MODELS };",
].join("\n");

const factory = new Function("document", "window", "Node", "S", "console", code);

console.log("the whole list is offered");
const doc = makeDoc();
const { buildBaseModelMultiSelect, CIVITAI_BASE_MODELS } = factory(
  doc, shimWindow, ShimNode, { root: { classList: new ShimClassList() } }, console);
const names = CIVITAI_BASE_MODELS.filter((b) => b);
ok(names.length > 30, `${names.length} base models to choose from`);

let changes = 0;
const ctl = buildBaseModelMultiSelect([], () => { changes++; });
const btn = ctl.children[0];

console.log("it starts empty and says so");
eq(ctl._getVal(), [], "nothing selected");
eq(btn.textContent, "Base model", "the button reads 'Base model'");
ok(!btn.classList.contains("active"), "and is not highlighted");

console.log("opening shows one checkbox per base model");
btn.onclick({ stopPropagation() {} });
const pop = doc.body.children[doc.body.children.length - 1];
ok(!!pop, "the popup is attached");
ok(pop.classList.contains("cvt-bm-pop"), "with the popup class");
const list = pop.children[1];
eq(list.children.length, names.length, `all ${names.length} models are listed`);

function rowFor(name) {
  return list.children.find((r) => r.children.some((c) => c.value === name));
}
function tick(name) {
  const cb = rowFor(name).children.find((c) => c.tagName === "INPUT");
  cb.checked = true;
  cb.onchange();
  return cb;
}
function untick(name) {
  const cb = rowFor(name).children.find((c) => c.tagName === "INPUT");
  cb.checked = false;
  cb.onchange();
  return cb;
}

console.log("ticking several keeps them all");
tick("SD 1.5");
eq(ctl._getVal(), ["SD 1.5"], "one selected");
eq(btn.textContent, "SD 1.5", "the button shows it");
ok(btn.classList.contains("active"), "and highlights");

tick("SDXL 1.0");
tick("Flux.1 D");
tick("Illustrious");
eq(ctl._getVal(), ["SD 1.5", "SDXL 1.0", "Flux.1 D", "Illustrious"], "four selected, in order");
eq(btn.textContent, "SD 1.5 +3", "the button summarises them");
ok(changes >= 4, `onChange fired for each tick (${changes} times)`);

console.log("unticking removes just that one");
untick("SDXL 1.0");
eq(ctl._getVal(), ["SD 1.5", "Flux.1 D", "Illustrious"], "the others stay");
eq(btn.textContent, "SD 1.5 +2", "and the count follows");

console.log("ticking does not search");
reject(code, /\/civitai\/search/, "the control never calls the search endpoint");
reject(code, /_runSearch|_resetAndSearch/, "and never triggers a search itself");
reject(code, /setTimeout|setInterval|debounce/, "nor fires one on a timer");

console.log("the filter box narrows the list");
const filter = pop.children[0];
filter.value = "flux";
filter.oninput();
const shown = list.children.map((r) => r.children.find((c) => c.tagName === "INPUT").value);
ok(shown.length > 0 && shown.every((n) => n.toLowerCase().includes("flux")),
  `only Flux entries remain: ${shown.join(", ")}`);
filter.value = "zzzz-nothing";
filter.oninput();
eq(list.children.length, 1, "an empty state is shown when nothing matches");
ok(list.children[0].classList.contains("cvt-bm-empty"), "and it is marked as such");
filter.value = "";
filter.oninput();
eq(list.children.length, names.length, "clearing the filter brings them back");
eq(ctl._getVal().length, 3, "and does not disturb the selection");

console.log("'All' clears the selection");
const foot = pop.children[2];
foot.children[0].onclick();
eq(ctl._getVal(), [], "everything is cleared");
eq(btn.textContent, "Base model", "and the button resets");
ok(!btn.classList.contains("active"), "and is no longer highlighted");

console.log("closing detaches the popup");
const popCount = doc.body.children.length;
foot.children[2].onclick();
eq(doc.body.children.length, popCount - 1, "the popup is removed from the body");

console.log("a saved selection can be restored");
const restored = buildBaseModelMultiSelect(["Pony", "SD 1.5"], () => {});
eq(restored._getVal(), ["Pony", "SD 1.5"], "the values come back");
eq(restored.children[0].textContent, "Pony +1", "and the button shows them");
restored._setVal([]);
eq(restored._getVal(), [], "_setVal clears them");
restored._setVal(["Qwen"]);
eq(restored.children[0].textContent, "Qwen", "_setVal repaints");

console.log("_getVal hands back a copy, not the live array");
const live = ctl._getVal();
live.push("tampered");
eq(ctl._getVal().length, 0, "pushing onto the result does not change the control");

// ── wiring ─────────────────────────────────────────────────────────────
console.log("state holds a list now");
check(src, /baseModels: \[\], username: "", loading: false/, "S.civitai.baseModels starts as an array");
reject(src, /S\.civitai\.baseModel\b/, "the old single-value field is gone");
reject(src, /datalist/, "the datalist is gone");
reject(src, /baseIn|baseDl|baseListId/, "and so is the input it fed");

console.log("the selection reaches the request");
check(src, /params\.set\("baseModels", S\.civitai\.baseModels\.join\(","\)\);/,
  "the search sends every pick, comma separated");
check(src, /if \(S\.civitai\.baseModels && S\.civitai\.baseModels\.length\) \{/,
  "but only when something is picked");
check(src, /S\.civitai\.baseModels = baseCtl\._getVal\(\);/, "and reads them at search time");
check(src, /var baseCtl = buildBaseModelMultiSelect\(/, "the control is built in the search bar");
check(src, /row2\.appendChild\(userIn\); row2\.appendChild\(baseCtl\); row2\.appendChild\(goBtn\);/,
  "and sits where the old input did");

console.log("styling exists for both themes");
for (const cls of ["cvt-bm", "cvt-bm-btn", "cvt-bm-pop", "cvt-bm-list",
  "cvt-bm-item", "cvt-bm-filter", "cvt-bm-foot", "cvt-bm-mini"]) {
  ok(css.includes("." + cls), `.${cls} is styled`);
}
check(css, /\.cvt-bm-btn\.active/, "the active state is styled");
check(css, /\.cvt-bm-pop\.light/, "the popup carries the light theme (it lives outside .cvt-root)");
check(css, /accent-color/, "checkboxes are styled for the dark panel");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
