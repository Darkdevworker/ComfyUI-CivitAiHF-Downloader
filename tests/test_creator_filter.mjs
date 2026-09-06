/**
 * Civitai: filtering by creator.
 *
 * A field in the search bar, plus a clickable creator name on every card and
 * in the detail modal — clicking "find everything by this person" is one
 * click from wherever you noticed them.
 *
 * Run with:  node tests/test_creator_filter.mjs
 *
 * _creatorSpan is exec'd out of js/civitai.js and driven through a small DOM
 * shim; the wiring is checked statically, because the module cannot be
 * loaded outside the browser.
 *
 * Civitai's API takes `username` and honours it (checked live: asking for
 * one creator returns only their models, a bogus name returns none).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "js", "civitai.js"), "utf8");
const css = fs.readFileSync(path.join(here, "..", "js", "civitai.css"), "utf8");
const srv = fs.readFileSync(path.join(here, "..", "server.py"), "utf8");

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; } else { fail++; console.log(`  x ${label}`); }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) { pass++; } else { fail++; console.log(`  x ${label}\n      expected ${b}\n      actual   ${a}`); }
}
function has(text, needle, label) {
  const hit = typeof needle === "string" ? text.includes(needle) : needle.test(text);
  if (hit) { pass++; } else { fail++; console.log(`  x ${label} — not found: ${needle}`); }
}
const check = has;
function reject(text, needle, label) {
  const hit = typeof needle === "string" ? text.includes(needle) : needle.test(text);
  if (!hit) { pass++; } else { fail++; console.log(`  x ${label} — should be gone: ${needle}`); }
}

// ── run _creatorSpan for real ──────────────────────────────────────────
class ShimNode {}
class ShimText extends ShimNode {
  constructor(t) { super(); this.text = String(t); }
  get textContent() { return this.text; }
}
class ShimEl extends ShimNode {
  constructor(tag) {
    super();
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.className = "";
    this._text = "";
    this._classSet = new Set();
    this.classList = {
      add: (c) => this._classSet.add(c),
      remove: (c) => this._classSet.delete(c),
      contains: (c) => this._classSet.has(c),
      toggle: (c, on) => (on ? this._classSet.add(c) : this._classSet.delete(c)),
    };
  }
  appendChild(c) {
    if (c instanceof ShimText) { this._text += c.text; return c; }
    this.children.push(c);
    return c;
  }
  // el() routes `onclick` attrs through addEventListener; mirror it onto the
  // property too so the test can fire it the way a browser would.
  addEventListener(type, fn) {
    (this._listeners = this._listeners || {})[type] = fn;
    this["on" + type] = fn;
  }
  setAttribute(k, v) { this[k] = v; if (k === "class") this.className = v; }
  get textContent() { return this._text + this.children.map((c) => c.textContent || "").join(""); }
  set textContent(v) { this._text = v == null ? "" : String(v); this.children = []; }
}
const shimDocument = {
  createElement: (t) => new ShimEl(t),
  createTextNode: (t) => new ShimText(t),
};

function slice(from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error("cannot slice " + from);
  return src.slice(a, b);
}

const code = [
  slice("function el(tag, attrs, ...children) {", "\nconst CIVITAI_TYPES"),
  slice("var _creatorFilterHook = null;", "\nfunction _card(m) {"),
  "let closeModalCalls = 0;\nfunction closeModal() { closeModalCalls++; }\n",
  "\nreturn { _creatorSpan, setHook: (h) => { _creatorFilterHook = h; }, " +
  "reset: () => { closeModalCalls = 0; }, calls: () => closeModalCalls };",
].join("\n");

const made = new Function("document", "Node", code)(shimDocument, ShimNode);
const { _creatorSpan, setHook, reset, calls } = made;

console.log("the creator name is a link, not plain text");
const span = _creatorSpan("SG_161222");
eq(span.className, "cvt-creator", "it carries the creator class");
eq(span.textContent, "SG_161222", "and shows the name");
ok(/Show only SG_161222/.test(span.title || span.getAttribute?.("title") || ""),
  "with a tooltip saying what clicking does");

console.log("clicking it filters by that creator");
let got = null;
setHook((name) => { got = name; });
reset();
let stopped = false;
span.onclick({ stopPropagation() { stopped = true; } });
eq(got, "SG_161222", "the hook receives the creator name");
ok(stopped, "and the event is stopped before the card behind it opens");

console.log("  a card click does not close anything");
const span2 = _creatorSpan("someone");
eq(typeof span2.onclick, "function", "an onclick handler is attached");
reset();
span2.onclick({ stopPropagation() {} });
eq(calls(), 0, "the modal is left alone");

console.log("  in the detail modal it closes the modal first");
reset();
const span3 = _creatorSpan("someone", { closeModal: true });
span3.onclick({ stopPropagation() {} });
eq(calls(), 1, "closeModal runs before the filter is applied");

console.log("a model with no creator still renders");
const fallback = _creatorSpan("");
eq(fallback.textContent, "?", "an unknown creator shows a question mark");
eq(fallback.className, "", "and is not clickable");

// ── wiring ─────────────────────────────────────────────────────────────
console.log("the search bar has a creator field");
check(src, /username: "", loading: false/, "S.civitai.username exists in state");
check(src, /var userIn = el\("input", \{ type: "text", id: "cvt-creator", placeholder: "Creator\\u2026"/,
  "a Creator input is built");
check(src, /userIn\.onkeydown = function\(e\) \{ if \(e\.key === "Enter"\) \{ _resetAndSearch\(\); \} \};/,
  "Enter in it searches");
check(src, /row2\.appendChild\(userIn\);/, "and it sits in the filter row");

console.log("the choice reaches the request");
check(src, /if \(S\.civitai\.username\) params\.set\("username", S\.civitai\.username\);/,
  "username is sent when it is set");
check(src, /S\.civitai\.username = \(userIn\.value \|\| ""\)\.trim\(\);/,
  "and read back at search time");

console.log("clicking a creator fills the field and searches");
check(src, /_creatorFilterHook = function\(name\) \{/, "the pane registers a hook");
check(src, /userIn\.value = S\.civitai\.username;/, "it fills the visible field");
check(src, /_resetAndSearch\(\);/, "and runs the search");
check(src, /_creatorSpan\(\(m\.creator && m\.creator\.username\) \|\| ""\)/, "cards use the clickable name");
check(src, /_creatorSpan\(\(model\.creator && model\.creator\.username\) \|\| "", \{ closeModal: true \}\)/,
  "the detail modal does too, and closes itself first");

console.log("the server passes it through, and caches per creator");
check(srv, 'username = request.query.get("username", "")', "the route reads username");
check(srv, 'if username:\n            params["username"] = username', "and forwards it to Civitai");
check(srv, /\{nsfw\}:\{username\}:\{tag\}/, "the cache key includes the creator");
reject(srv, /\{nsfw\}:\{cursor\}/, "it is no longer possible for two creators to share a cached page");

console.log("styling");
check(css, /\.cvt-creator \{/, ".cvt-creator is styled");
check(css, /\.cvt-creator:hover/, "with a hover state");
check(css, /text-decoration: underline dotted/, "so it reads as a link without shouting");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
