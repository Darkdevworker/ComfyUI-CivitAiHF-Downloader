/**
 * A failed request has to say why.
 *
 * Run with:  node tests/test_api_errors.mjs
 *
 * _api is exec'd out of js/civitai.js and pointed at a stub fetchApi that
 * answers with the same shapes our server really returns: a JSON body with
 * an `error` field, a plain-text body, and an empty one.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "js", "civitai.js"), "utf8");

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; } else { fail++; console.log(`  x ${label}`); }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) { pass++; } else { fail++; console.log(`  x ${label}\n      expected ${b}\n      actual   ${a}`); }
}

function slice(from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error("cannot slice " + from);
  return src.slice(a, b);
}

const warnings = [];

const code = [
  slice("var _cache = new (function() {", "var _activeJobs = 0;"),
  slice("function _api(path, opts) {", "function _fmtBytes(n) {"),
  "var api = { fetchApi: function (p, o) { return __next(p, o); } };",
  "let __next = function () { return Promise.resolve({ ok: true }); };",
  "let __warns = [];",
  "var console = { warn: function () { __warns.push([].slice.call(arguments).join(' ')); } };",
  "return { _api: _api, setResponse: function (fn) { __next = fn; },",
  "         warns: function () { return __warns; } };",
].join("\n");

const made = new Function(code)();
const { _api, setResponse, warns } = made;

// A response shaped the way aiohttp's web.json_response is.
function jsonResponse(status, body, extra) {
  const text = JSON.stringify(body);
  return Promise.resolve(Object.assign({
    ok: status < 400,
    status,
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(body),
  }, extra || {}));
}
function textResponse(status, text) {
  return Promise.resolve({
    ok: status < 400,
    status,
    text: () => Promise.resolve(text),
    json: () => Promise.reject(new Error("not json")),
  });
}

async function messageFor(response) {
  setResponse(() => response);
  try {
    await _api("/civitai/download", { method: "POST" });
    return null;
  } catch (e) {
    return { message: e.message, status: e.status, transient: e.transient };
  }
}

console.log("a refused request reports the server's reason, not just a number");
let r = await messageFor(jsonResponse(400, {
  error: "A folder already exists called DreamShaper \u2014 give the file a different name.",
}));
eq(r.status, 400, "the status is still available for callers that branch on it");
eq(r.message,
   "A folder already exists called DreamShaper \u2014 give the file a different name.",
   "and the message is the one the server wrote");
eq(r.transient, false, "a 400 is not worth retrying");

r = await messageFor(jsonResponse(400, {
  error: "Nothing to download \u2014 open the model and pick a version/file first.",
}));
eq(r.message, "Nothing to download \u2014 open the model and pick a version/file first.",
   "a different refusal reads differently");

r = await messageFor(jsonResponse(403, { error: "This model needs an API key." }));
eq(r.message, "This model needs an API key.", "so does a 403");
eq(r.status, 403, "with its own status");

console.log("responses without a JSON error field degrade sensibly");
r = await messageFor(textResponse(400, "Path is outside the ComfyUI models directories"));
eq(r.message, "Path is outside the ComfyUI models directories",
   "a plain-text body is shown as-is");

r = await messageFor(textResponse(400, "x".repeat(600)));
ok(/^HTTP 400$/.test(r.message), "an enormous body falls back to the status");
ok(r.message.length < 40, "so the toast stays readable");

r = await messageFor(textResponse(400, ""));
eq(r.message, "HTTP 400", "and an empty body does too");

r = await messageFor(jsonResponse(500, { detail: "boom" }));
eq(r.message, "HTTP 500", "JSON without an `error` field keeps the status");
eq(r.transient, true, "a 500 is marked transient so callers can retry");

console.log("the detail is logged, so it survives a dismissed toast");
const w = warns();
ok(w.length >= 5, "each failure is written to the console");
ok(/POST \/civitai\/download \u2192 400/.test(w[0]), "with the method, path and status");
ok(/A folder already exists/.test(w[0]), "and the reason");

console.log("a successful request is untouched");
setResponse(() => jsonResponse(200, { items: [{ id: 1 }] }));
const good = await _api("/civitai/search?query=x");
eq(good.items.length, 1, "the parsed body still comes back");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
