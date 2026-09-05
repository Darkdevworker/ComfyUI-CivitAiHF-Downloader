/**
 * What happens right after a download is queued — run with:
 *   node tests/test_queue_feedback.mjs
 *
 * Two things were broken in the Civitai model view:
 *   1. "Queued: —" showed a blank id, because the route answered with
 *      {"task_id": ...} while the UI read job.id (the HF route answers
 *      with "id", which is why only the Civitai view was blank).
 *   2. Clicking "Downloads" appeared to do nothing: it did switch tabs,
 *      but the detail modal (position: fixed, z-index: 10000) stayed on
 *      top covering the panel.
 *
 * Static checks — js/civitai.js imports ComfyUI runtime modules.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const js = fs.readFileSync(path.join(root, "js", "civitai.js"), "utf8");
const py = fs.readFileSync(path.join(root, "server.py"), "utf8");

let pass = 0, fail = 0;
function has(text, re, label) {
  if (re.test(text)) { pass++; } else { fail++; console.log(`  x ${label} — not found: ${re}`); }
}
function hasNot(text, re, label) {
  if (!re.test(text)) { pass++; } else { fail++; console.log(`  x ${label} — should be gone: ${re}`); }
}

const civRoute = py.slice(py.indexOf('@routes.post("/civitai/download")'),
                          py.indexOf('@routes.get("/civitai/downloads")'));
const hfRoute = py.slice(py.indexOf('@routes.post("/civitai/hf/download")'));

console.log("the queued id is shown, not blank");
has(civRoute, /"task_id": task_id, "id": task_id/, "the Civitai route returns id alongside task_id");
has(civRoute, /"id": "meta_" \+ str\(model_version_id\)/, "so does the metadata-only response");
has(hfRoute, /"id": task_id/, "the HF route already returns id");
has(js, /job\.task_id \|\| job\.id/, "the UI accepts either field");
hasNot(js, /appendChild\(el\("b", \{\}, job\.id\)\)/, "it no longer reads only job.id");

console.log("clicking Downloads actually shows Downloads");
const civLink = js.slice(js.indexOf('var dlLink = el("a", { href: "#", style: { color:"var(--civ-accent-dim)"'),
                         js.indexOf('var dlLink = el("a", { href: "#", style: { color:"var(--civ-accent-dim)"') + 500);
has(civLink, /closeModal\(\);/, "the Civitai link closes the detail modal first");
has(civLink, /civitai:show-tab/, "then asks the panel to switch tabs");
has(civLink, /detail: "downloads"/, "to the Downloads tab");
has(js, /root\.addEventListener\("civitai:show-tab"/, "the panel listens for that request");
has(js, /var tab = tabBar\.querySelector\('\[data-tab="' \+ which \+ '"\]'\);/, "finds the tab by data-tab");
has(js, /if \(tab\) tab\.click\(\);/, "and clicks it");
has(js, /dataset: \{ tab: id \}/, "every tab carries a data-tab to be found by");
has(js, /function closeModal\(\)/, "closeModal exists");

console.log("the HF link behaves the same way");
const hfLink = js.slice(js.indexOf('var dlLink = el("a", { href: "#", style: { color:"#ec9"'),
                        js.indexOf('var dlLink = el("a", { href: "#", style: { color:"#ec9"') + 400);
has(hfLink, /closeModal\(\);/, "the HF link closes the modal too");
hasNot(hfLink, /bg\.remove\(\);/, "and no longer detaches the modal behind closeModal's back");

console.log("switching to Downloads starts it up");
has(js, /else if \(id === "downloads"\) renderDownloads\(pane\);/, "first visit renders the tab");
const rd = js.slice(js.indexOf("function renderDownloads("), js.indexOf("\nfunction ", js.indexOf("function renderDownloads(") + 10));
has(rd, /_pollDl\(\);\s*\}\s*$/, "rendering starts polling");
has(js, /\} else if \(id === "downloads"\) \{\s*\/\/ Always refresh[\s\S]{0,120}_pollDl\(\);/, "re-opening refreshes");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
