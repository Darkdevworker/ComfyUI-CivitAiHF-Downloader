/**
 * The last two features: naming templates, and the Downloads tab reacting to
 * a finished download (refreshing ComfyUI's model lists, and keeping a
 * history of what landed).
 *
 * Run with:  node tests/test_templates_history.mjs
 *
 * The template helpers and the refresh bookkeeping are exec'd out of
 * js/civitai.js and driven directly; the settings panel and the saved-search
 * row are checked statically, because they cannot be rendered outside
 * ComfyUI.
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

function slice(from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error("cannot slice " + from);
  return src.slice(a, b);
}

// ── run the real helpers ──────────────────────────────────────────────
const code = [
  slice("/* ── Naming templates", "// ── 3. DOWNLOADS ─"),
  slice("var _dlSeenDone = {};", "// ── Download history ─"),
  slice("function _fmtWhen(ts) {", "function _redownloadFromHistory"),
  "let __refreshes = 0, __histRenders = 0;",
  "var app = { refreshComboInNodes: function () { __refreshes++; } };",
  "function _renderHistory() { __histRenders++; }",
  "function _jobIsActive(s) { return s === 'downloading' || s === 'queued' || s === 'pending'; }",
  "var S = { settings: {} };",
  "return {",
  "  _safePathPart: _safePathPart, _resolveNameTemplate: _resolveNameTemplate,",
  "  _templateToPath: _templateToPath, _nameContext: _nameContext,",
  "  _nameTemplatePreview: _nameTemplatePreview, NAME_TEMPLATE_VARS: NAME_TEMPLATE_VARS,",
  "  _noteFinishedJobs: _noteFinishedJobs, _fmtWhen: _fmtWhen,",
  "  counts: function () { return [__refreshes, __histRenders]; },",
  "  resetCounts: function () { __refreshes = 0; __histRenders = 0; },",
  "  setRefreshSetting: function (v) { S.settings.refreshAfterDownload = v; },",
  "  setApp: function (a) { __app = a; },",
  "};",
].join("\n");

// _refreshComfyUIModels reads the ComfyUI `app` global; stand one in.
globalThis.app = { refreshComboInNodes: () => { globalThis.__ext++; } };
globalThis.__ext = 0;

const made = new Function(code)();
const { _safePathPart, _resolveNameTemplate, _templateToPath, _nameContext,
        _nameTemplatePreview, NAME_TEMPLATE_VARS, _noteFinishedJobs, _fmtWhen,
        counts, resetCounts, setRefreshSetting } = made;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── naming templates ──────────────────────────────────────────────────
console.log("a template decides where a download lands");
const MODEL = {
  id: 12345, name: "DreamShaper XL", type: "Checkpoint",
  creator: { username: "Lykon" },
};
const VERSION = { id: 98765, name: "v2.0 Lightning", baseModel: "SDXL 1.0" };
const FILE = { name: "dreamshaperXL_v20Lightning.safetensors" };
const ctx = _nameContext(MODEL, VERSION, FILE);

eq(ctx.creator, "Lykon", "the creator comes off the model");
eq(ctx.version, "v2.0 Lightning", "the version name comes off the version");
eq(ctx.base_model, "SDXL 1.0", "so does the base model");
eq(ctx.type, "Checkpoint", "and the model type");
eq(ctx.version_id, 98765, "the version id is usable");
eq(ctx.filename, "dreamshaperXL_v20Lightning", "the file name has no extension");
eq(ctx.ext, "safetensors", "and the extension is split off");
eq(_nameContext(MODEL, VERSION, {}).ext, "safetensors",
   "with no file the extension falls back to safetensors");

console.log("unsafe characters cannot escape the target folder");
eq(_safePathPart("AC/DC"), "AC DC", "a slash becomes a space");
eq(_safePathPart("a\\b"), "a b", "a backslash becomes a space");
eq(_safePathPart("../../etc/passwd"), "etc passwd",
   "a traversal attempt cannot escape the folder it belongs in");
eq(_safePathPart('a:b*c?d"e<f>g|h'), "a b c d e f g h", "reserved characters go too");
eq(_safePathPart("   "), "", "whitespace alone is nothing");
eq(_safePathPart(".hidden"), "hidden", "a leading dot is dropped");
ok(_safePathPart("x".repeat(200)).length === 80, "and the result is capped at 80");

console.log("placeholders are filled, unknown ones dropped");
eq(_resolveNameTemplate("{creator}/{model}", ctx), "Lykon/DreamShaper XL",
   "known placeholders are substituted");
eq(_resolveNameTemplate("{creator}/{nope}/{model}", ctx), "Lykon/DreamShaper XL",
   "a placeholder we cannot fill disappears");
eq(_resolveNameTemplate("{creator}//{model}", ctx), "Lykon/DreamShaper XL",
   "repeated slashes collapse");
eq(_resolveNameTemplate("/{creator}/{model}/", ctx), "Lykon/DreamShaper XL",
   "leading and trailing slashes are trimmed");
eq(_resolveNameTemplate("{creator} / {model}", ctx), "Lykon/DreamShaper XL",
   "spaces around a slash are tidied");
eq(_resolveNameTemplate("", ctx), "", "with no template there is no path");
eq(_resolveNameTemplate("//", ctx), "", "a template of only slashes is empty");

console.log("the template splits into a folder and a file name");
eq(_templateToPath("{creator}/{model}/{version}", ctx),
   { subfolder: "Lykon/DreamShaper XL", filename: "v2.0 Lightning.safetensors" },
   "everything before the last slash is the folder");
eq(_templateToPath("{creator}/{filename}", ctx),
   { subfolder: "Lykon", filename: "dreamshaperXL_v20Lightning.safetensors" },
   "an extension already present is not doubled");
eq(_templateToPath("{model}", ctx),
   { subfolder: "", filename: "DreamShaper XL.safetensors" },
   "a bare template is a file at the folder root");
eq(_templateToPath("", ctx), null, "no template means 'use Civitai's name'");
eq(_templateToPath("//", ctx), null, "and so does an empty one");
ok(_templateToPath("{filename}", ctx).filename.endsWith(".safetensors"),
   "the extension survives a template that names only the file");

console.log("settings can show what a template will do");
has(_nameTemplatePreview(""), "Civitai", "with no template it says what happens");
has(_nameTemplatePreview("{creator}/{model}/{version}"),
    "models/Lykon/DreamShaper XL/v2.0 Lightning.safetensors",
    "with one it shows the path it will produce");
ok(NAME_TEMPLATE_VARS.includes("creator") && NAME_TEMPLATE_VARS.includes("base_model")
   && NAME_TEMPLATE_VARS.includes("version_id"),
   "the documented placeholders include creator, base_model and version_id");

// ── refreshing ComfyUI when something lands ───────────────────────────
console.log("a finished download refreshes ComfyUI's model lists");
setRefreshSetting(true);

_noteFinishedJobs([{ id: "a", status: "completed" }], true);
await wait(500);
eq(counts(), [0, 1], "the first poll records but does not announce old jobs");

resetCounts();
_noteFinishedJobs([{ id: "a", status: "completed" }], false);
await wait(500);
eq(counts(), [0, 0], "a job already seen is not reported twice");

_noteFinishedJobs([{ id: "b", status: "completed" }], false);
await wait(500);
eq(counts(), [1, 1], "a newly completed job refreshes once, and re-renders history");

resetCounts();
_noteFinishedJobs([{ id: "c", status: "completed" }, { id: "d", status: "completed" }], false);
await wait(500);
eq(counts(), [1, 1], "several landing together cost one refresh, not one each");

resetCounts();
_noteFinishedJobs([{ id: "e", status: "error" }], false);
await wait(500);
eq(counts(), [0, 1], "a failed download is recorded but does not refresh the lists");

resetCounts();
_noteFinishedJobs([{ id: "f", status: "downloading" }], false);
await wait(500);
eq(counts(), [0, 0], "an active job is not a finished one");

resetCounts();
setRefreshSetting(false);
_noteFinishedJobs([{ id: "g", status: "completed" }], false);
await wait(500);
eq(counts(), [0, 1], "the setting switches the refresh off, but history still updates");
setRefreshSetting(true);

// ── history timestamps ────────────────────────────────────────────────
console.log("history reads in plain language");
const now = Date.now() / 1000;
eq(_fmtWhen(now - 5), "just now", "seconds ago is 'just now'");
eq(_fmtWhen(now - 300), "5m ago", "minutes are minutes");
eq(_fmtWhen(now - 3 * 3600), "3h ago", "hours are hours");
eq(_fmtWhen(now - 2 * 86400), "2d ago", "days are days");
eq(_fmtWhen(0), "", "no timestamp is not a date");

// ── the wiring ────────────────────────────────────────────────────────
console.log("the pieces are wired together");
has(src, "_noteFinishedJobs(S.downloads, !_dlSeenInit);",
    "the poll notices finished jobs");
has(src, "typeof app.refreshComboInNodes === \"function\"",
    "the refresh goes through ComfyUI's own method");
has(src, "/civitai/history?limit=60", "the Downloads tab fetches the history");
has(src, "/civitai/history-clear", "and can clear it");
has(src, "/civitai/history-delete", "and remove one entry");
has(src, "cvt-hist-warn", "a hash mismatch is shown on its row");
has(src, "_redownloadFromHistory(h)", "and an entry can be fetched again");
has(src, "_templateToPath(S.settings.nameTemplate || \"\",",
    "the download modal applies the template");
has(src, "/civitai/settings\", { method: \"POST\",\n      body: JSON.stringify({ saved_searches: list }) })",
    "a saved search is stored through the settings endpoint");
has(src, "cfg.saved_searches", "and read back on load");
has(src, "cfg.name_template", "so is the naming template");
has(src, "cfg.refresh_after_download", "so is the refresh toggle");

has(py, '"name_template": utils.db_manager.get_setting("name_template", "")',
    "the server serves the naming template");
has(py, '"refresh_after_download": utils.db_manager.get_setting("refresh_after_download", True)',
    "and the refresh toggle, defaulting to on");
has(py, '"saved_searches": utils.db_manager.get_setting("saved_searches", [])',
    "and the saved searches");
has(py, '"compact_grid", "refresh_after_download"}',
    "the toggle is saved as a boolean");
has(py, '"nsfw_blur_level",\n                    "name_template"}',
    "the template is saved as a string, empty included");
has(py, 'if "saved_searches" in data:',
    "and a list is stored as a list");
has(py, 'saved if isinstance(saved, list) else []',
    "a non-list cannot poison the setting");

has(css, ".cvt-hist-row {", "history rows are styled");
has(css, ".cvt-tpl-demo {", "so is the template preview");
has(css, ".cvt-saved-row {", "so is the saved-search row");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
