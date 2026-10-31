/**
 * The things a progress bar cannot say.
 *
 * Run with:  node tests/test_job_notes.mjs
 *
 * _jobRow is exec'd out of js/civitai.js and driven through a DOM shim, with
 * ComfyUI's bits stubbed. It covers the two task fields the server sets and
 * the row used to throw away: resumed_from (a download picked up where it
 * left off) and verified (the file matched Civitai's published SHA256 or
 * it did not).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "js", "civitai.js"), "utf8");
const css = fs.readFileSync(path.join(here, "..", "js", "civitai.css"), "utf8");
const py = fs.readFileSync(path.join(here, "..", "server.py"), "utf8");

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

class ShimText {
  constructor(t) { this.text = String(t); }
  get textContent() { return this.text; }
}
class ShimEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = []; this.style = {}; this.dataset = {};
    this.className = ""; this._text = ""; this._classSet = new Set();
    this.classList = {
      add: (c) => this._classSet.add(c),
      remove: (c) => this._classSet.delete(c),
      contains: (c) => this._classSet.has(c),
      toggle: (c, on) => (on ? this._classSet.add(c) : this._classSet.delete(c)),
    };
  }
  appendChild(c) {
    if (c instanceof ShimText) { this._text += c.text; return c; }
    this.children.push(c); return c;
  }
  insertBefore(c, ref) {
    const i = this.children.indexOf(ref);
    this.children.splice(i < 0 ? this.children.length : i, 0, c);
    return c;
  }
  remove() {}
  addEventListener(type, fn) { this["on" + type] = fn; }
  setAttribute(k, v) { this[k] = v; if (k === "class") this.className = v; }
  get firstChild() { return this.children[0]; }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent || "").join("");
  }
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

const code = [
  slice("function el(tag, attrs, ...children) {", "\nconst CIVITAI_TYPES"),
  slice("function _jobIsActive(status)", "\nfunction _jobRow(j) {"),
  slice("function _jobRow(j) {", "\n// Adaptive heartbeat"),
  "function _jobNeedsApiKey(j) { return /\\b(401|403)\\b/.test(String(j.error || '')); }",
  "function _jobSubText(j, pct) { return pct + '%'; }",
  "function _fmtBytes(n) { if (!n) return '\\u2014'; var u=['B','KB','MB','GB'], i=0, s=n;",
  "  while (s >= 1024 && i < 3) { s /= 1024; i++; } return s.toFixed(i ? 1 : 0) + ' ' + u[i]; }",
  "function _api() { return Promise.resolve({}); }",
  "function _pollDl() {}",
  "function _toast(m) { __toasts.push(m); }",
  "let __toasts = [];",
  "var S = { root: { dispatchEvent: function () {} } };",
  "return { _jobRow: _jobRow, _jobIsActive: _jobIsActive, toasts: () => __toasts };",
].join("\n");

const made = new Function("document", "Node", code)(shimDocument, ShimEl);
// _jobRow hands back { row, update }, so the row can be re-rendered in place
const rowFor = (j) => made._jobRow(j);

function noteOf(row) {
  return row.children.filter((c) => c.className.indexOf("cvt-job-note") >= 0)[0];
}
function noteText(row) {
  const n = noteOf(row);
  return n ? n.textContent.trim() : "";
}

console.log("an ordinary download says nothing extra");
let row = rowFor({ id: "a", status: "downloading", progress: 40, filename: "m.safetensors" }).row;
ok(!!noteOf(row), "the note row exists");
eq(noteText(row), "", "and is empty when there is nothing to report");
eq(noteOf(row).style.display, "none", "and hidden rather than left blank");

console.log("a resumed download says where it picked up");
row = rowFor({ id: "b", status: "downloading", progress: 40,
               resumed_from: 8.5 * 1024 * 1024 * 1024,
               filename: "big.safetensors" }).row;
has(noteText(row), "resumed from", "it says it resumed");
has(noteText(row), "GB", "and how much was already on disk");
eq(noteOf(row).style.display, "", "and the row is shown");
const resumed = noteOf(row).children[0];
eq(resumed.className, "cvt-job-resumed", "styled as a resume, not a warning");
has(resumed.title, "interrupted", "with a hover that explains what happened");

console.log("a hash that does not match is called out at once");
row = rowFor({ id: "c", status: "completed", progress: 100, verified: "mismatch",
               hash: "deadbeef", hash_expected: "cafebabe",
               filename: "m.safetensors" }).row;
has(noteText(row), "hash mismatch", "the row says so");
const warn = noteOf(row).children[0];
eq(warn.className, "cvt-job-warn", "in the warning colour");
has(warn.title, "truncated", "and says what it probably means");
has(warn.title, "cafebabe", "naming the hash Civitai published");
has(warn.title, "deadbeef", "and the one the file actually had");

console.log("a hash that matches is worth a quiet tick");
row = rowFor({ id: "d", status: "completed", progress: 100, verified: "ok",
               hash: "cafebabe", filename: "m.safetensors" }).row;
has(noteText(row), "hash verified", "it says the file checked out");
eq(noteOf(row).children[0].className, "cvt-job-ok", "in the good colour");
has(noteOf(row).children[0].title, "cafebabe", "with the hash itself on hover");

console.log("a verified flag with no hash says nothing");
row = rowFor({ id: "e", status: "completed", progress: 100, verified: "ok",
               filename: "m.safetensors" }).row;
eq(noteText(row), "", "there is nothing to show without a hash to show");

console.log("the notes follow the job as it runs");
const live = rowFor({ id: "f", status: "downloading", progress: 10,
                      filename: "m.safetensors" });
row = live.row;
eq(noteText(row), "", "nothing at the start");
live.update({ id: "f", status: "downloading", progress: 50, resumed_from: 1024,
              filename: "m.safetensors" });
has(noteText(row), "resumed", "the resume appears when it happens");
live.update({ id: "f", status: "completed", progress: 100, resumed_from: 1024,
              verified: "mismatch", filename: "m.safetensors" });
has(noteText(row), "resumed", "and both can be true at once");
has(noteText(row), "hash mismatch", "resume first, then the warning");
live.update({ id: "f", status: "completed", progress: 100, filename: "m.safetensors" });
eq(noteText(row), "", "and they clear when the job is replaced");

console.log("the styled parts exist");
has(css, ".cvt-job-resumed {", "resumed is styled");
has(css, ".cvt-job-warn {", "so is the mismatch warning");
has(css, ".cvt-job-ok {", "and the verified tick");

console.log("and the server really does set the fields they read");
has(py, 'DOWNLOAD_TASKS[task_id]["resumed_from"] = resume_from', "resume_from is on the task");
has(py, 'DOWNLOAD_TASKS[task_id]["verified"] = "ok" if same else "mismatch"',
    "so is the outcome of the hash check");
has(py, 'DOWNLOAD_TASKS[task_id]["hash_expected"] = expected', "and the hash Civitai published");
has(py, '"verified": task.get("verified") or "",', "which the history record carries too");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
