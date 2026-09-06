/**
 * Three UI changes to the browse grid:
 *   quick actions on the card, a pager pinned to the bottom, and the active
 *   filters shown as removable chips.
 *
 * Run with:  node tests/test_card_chips_pager.mjs
 *
 * _card and _quickDownload are exec'd out of js/civitai.js and driven through
 * a small DOM shim; the chips and the pager are checked statically, because
 * the panel cannot be rendered outside ComfyUI.
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
function has(text, needle, label) {
  const hit = typeof needle === "string" ? text.includes(needle) : needle.test(text);
  if (hit) { pass++; } else { fail++; console.log(`  x ${label} — not found: ${needle}`); }
}
function reject(text, needle, label) {
  const hit = typeof needle === "string" ? text.includes(needle) : needle.test(text);
  if (!hit) { pass++; } else { fail++; console.log(`  x ${label} — should be gone: ${needle}`); }
}

// ── a DOM shim ────────────────────────────────────────────────────────
class ShimText {
  constructor(t) { this.text = String(t); }
  get textContent() { return this.text; }
}
class ShimEl {
  constructor(tag) {
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
  // property too, so a click can be fired the way a browser would.
  addEventListener(type, fn) { this["on" + type] = fn; }
  setAttribute(k, v) { this[k] = v; if (k === "class") this.className = v; }
  get textContent() { return this._text + this.children.map((c) => c.textContent || "").join(""); }
  set textContent(v) { this._text = v == null ? "" : String(v); this.children = []; }
  set innerHTML(v) { if (v === "") { this.children = []; this._text = ""; } }
}
const shimDocument = {
  createElement: (t) => new ShimEl(t),
  createTextNode: (t) => new ShimText(t),
  body: new ShimEl("body"),
};

function slice(from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error("cannot slice " + from);
  return src.slice(a, b);
}

// ── run the real _card ────────────────────────────────────────────────
const toasts = [];
const posts = [];
const code = [
  slice("function el(tag, attrs, ...children) {", "\nconst CIVITAI_TYPES"),
  slice("function _quickDownload(m, version, file) {", "\n// ── Detail Modal ──"),
  "let __toasts = [], __posts = [];",
  "function _toast(msg, kind) { __toasts.push([msg, kind]); }",
  "function _guessFolder(type) { return 'loras'; }",
  "function _sanitizeModelName(n) { return n.replace(/\\s+/g, '_'); }",
  "function _ensureDlPolling() {}",
  "function _imgUrl(u) { return u; }",
  "function applyBlur(node) { return false; }",
  "function bandIdOfModel() { return 'PG'; }",
  "function bandIdOfImage() { return 'PG'; }",
  "function makeBandBadge(id) { return el('span', { class: 'cvt-badge' }, id); }",
  "function _creatorSpan(n) { return el('span', {}, n || '?'); }",
  "function openDetail() {}",
  "var S = { settings: { saveMeta: true, savePrev: false } };",
  "function _api(url, opts) {",
  "  __posts.push([url, opts && opts.body ? JSON.parse(opts.body) : null]);",
  "  return Promise.resolve({ task_id: 't1', filename: 'model.safetensors' });",
  "}",
  "return { _card: _card, _quickDownload: _quickDownload,",
  "         toasts: () => __toasts, posts: () => __posts,",
  "         reset: () => { __toasts = []; __posts = []; } };",
].join("\n");

const made = new Function("document", "Node", code)(shimDocument, ShimEl);
const { _card, _quickDownload, toasts: seenToasts, posts: seenPosts, reset } = made;

// _api is stubbed with a resolved promise, so its .then runs on a microtask
const flush = () => new Promise((r) => setTimeout(r, 0));

const MODEL = {
  id: 4242, name: "Hinata Hyuga/ Naruto", type: "LORA",
  creator: { username: "Marlosart" },
  modelVersions: [{
    id: 991, downloadUrl: "https://civitai.com/api/download/models/991",
    files: [
      { name: "extra.safetensors", downloadUrl: "https://x/extra?fileId=2" },
      { name: "naruto.safetensors", downloadUrl: "https://x/naruto?fileId=1", primary: true },
    ],
    images: [{ url: "u", nsfwLevel: 1 }],
  }],
};

console.log("the card carries both quick actions");
const card = _card(MODEL);
const actions = card.children.filter((c) => c.className === "cvt-card-actions")[0];
ok(!!actions, "there is an actions cluster on the card");
eq(actions.children.length, 2, "with two buttons: bookmark and download");
eq(actions.children[0].title, "Bookmark this model", "the first bookmarks");
eq(actions.children[1].textContent, "↓", "the second is the download arrow");
eq(actions.children[1].title, "Download the latest version's primary file",
   "and says what it will fetch");

console.log("downloading from the card does not open the modal");
let opened = false;
reset();
let stopped = false;
actions.children[1].onclick({ stopPropagation() { stopped = true; } });
ok(stopped, "the click does not reach the card behind it");
eq(seenPosts().length, 1, "one request went out");
const [url, body] = seenPosts()[0];
eq(url, "/civitai/download", "to the download endpoint");
eq(body.model_version_id, 991, "for the newest version");
eq(body.url, "https://x/naruto?fileId=1",
   "and the primary file's own URL, so the picked variant is what lands");
eq(body.filename, "naruto.safetensors", "with that file's name");
eq(body.save_as, "loras", "into the folder the model type implies");
eq(body.subfolder, "Hinata_Hyuga/_Naruto", "under a folder named after the model");
eq(body.metadata_only, false, "as a real download, not metadata only");
eq(body.save_metadata, true, "honouring the metadata setting");
eq(body.save_preview, false, "and the preview setting");
await flush();
ok(/^Queued/.test(seenToasts()[0][0]), "and the user is told it was queued");

console.log("  a model with no file says so instead of queueing nothing");
reset();
const noFile = _card({ id: 1, name: "No files", type: "LORA", modelVersions: [{ id: 5 }] });
const noFileActs = noFile.children.filter((c) => c.className === "cvt-card-actions")[0];
eq(noFileActs.children[1].title, "This model has no downloadable file",
   "the button explains why it will not work");
noFileActs.children[1].onclick({ stopPropagation() {} });
eq(seenPosts().length, 0, "and nothing is sent");
ok(/No downloadable file/.test(seenToasts()[0][0]), "the click reports it instead");

console.log("  a model with no versions at all does not break the card");
const bare = _card({ id: 2, name: "Bare", type: "Checkpoint" });
const bareActs = bare.children.filter((c) => c.className === "cvt-card-actions")[0];
eq(bareActs.children.length, 2, "both buttons still render");
eq(bareActs.children[1].title, "This model has no downloadable file", "with the download disabled");

console.log("bookmarking still works, and stays out of the card's click");
reset();
actions.children[0].onclick({ stopPropagation() {} });
eq(seenPosts()[0][0], "/civitai/bookmarks", "the bookmark endpoint is used");
eq(seenPosts()[0][1].source, "civitai", "tagged as a Civitai bookmark");
eq(seenPosts()[0][1].model_id, 4242, "with the model id");

// ── the pager ─────────────────────────────────────────────────────────
console.log("the pager is pinned to the bottom of the pane");
const pagerRule = css.slice(css.indexOf(".cvt-pager {"), css.indexOf(".cvt-pager .page-info"));
has(pagerRule, "position: sticky", "it sticks");
has(pagerRule, "bottom: 0", "to the bottom of the scrolling pane");
has(pagerRule, "z-index: 6", "above the cards that scroll under it");
has(pagerRule, "backdrop-filter", "with a blurred background");
has(pagerRule, /background: var\(--civ-glass-strong\)/, "so cards do not show through");
has(css, ".cvt-root.light .cvt-pager", "and the light theme gives it its own background");

// ── the chips ─────────────────────────────────────────────────────────
console.log("active filters appear as chips that can be removed");
has(src, 'var chipRow = el("div", { class: "cvt-chiprow"', "there is a chip row");
has(src, 'function _renderChips() {', "rendered by a function of its own");
has(src, "_renderChips();", "called once the results are in");
has(src, 'if (!chips.length) { chipRow.style.display = "none"; return; }',
    "hidden when nothing is filtering");
for (const [key, label] of [["Type", "type"], ["Period", "period"], ["Creator", "creator"],
                            ["Base", "base model"], ["Bands", "content bands"]]) {
  has(src, `k: "${key}"`, `a chip for the ${label}`);
}
has(src, 'clear: function () { periodSel.value = "AllTime"; }',
    "removing the period chip restores the default, not an empty value");
has(src, 'clear: function () { baseCtl._setVal([]); }',
    "removing the base chip clears every picked base model");
has(src, 'clear: function () { ratingRow._setVal(""); }',
    "removing the band chip unticks the bands");
has(src, "bandSel.length < BAND_ORDER.length",
    "ticking every band is not shown as a filter, since it filters nothing out");
has(src, 'c.clear(); _resetAndSearch();', "removing a chip runs the search again");
has(src, '"Clear all"', "and there is a way to drop the lot at once");
has(src, "chips.length > 1", "offered only when there is more than one to clear");

console.log("styling");
for (const cls of ["cvt-chiprow", "cvt-chip", "cvt-chip-k", "cvt-chip-x",
                   "cvt-chip-clear", "cvt-card-actions", "cvt-card-act"]) {
  has(css, "." + cls + " {", `.${cls} is styled`);
}
has(css, ".cvt-card:hover .cvt-card-actions", "the actions appear when the card is hovered");
has(css, ".cvt-card:focus-within .cvt-card-actions", "and when the keyboard reaches them");
has(css, "pointer-events: none;", "but they ignore clicks while hidden");
has(css, ".cvt-root.compact .cvt-card-act", "and shrink with compact mode");
has(css, ".cvt-root.light .cvt-chip", "with a light theme for the chips too");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
