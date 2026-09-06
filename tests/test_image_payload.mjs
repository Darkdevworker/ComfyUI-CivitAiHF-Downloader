/**
 * Image payload: how much data the grids, the gallery and the lightbox pull,
 * and how fast they appear on a slow connection.
 *
 * Run with:  node tests/test_image_payload.mjs
 *
 * Two halves:
 *   - the URL helpers are exec'd out of js/civitai.js and called for real;
 *   - the render sites are checked statically, because the module imports
 *     ComfyUI runtime modules and cannot be loaded outside the browser.
 *
 * Why the numbers matter (measured against a real 2200px Civitai showcase
 * JPEG): the CDN serves fixed width buckets and, critically, only SOME
 * quality values. Asking for quality=65 or 95 does not error - it returns
 * the untouched 839 KB original. Multiples of ten from 40 to 80 are honoured
 * at every width (30 is refused at width=1200).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "js", "civitai.js"), "utf8");

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  if (actual === expected) { pass++; }
  else { fail++; console.log(`  x ${label}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`); }
}
function ok(cond, label) {
  if (cond) { pass++; } else { fail++; console.log(`  x ${label}`); }
}
function check(text, re, label) {
  if (re.test(text)) { pass++; } else { fail++; console.log(`  x ${label} — not found: ${re}`); }
}
function reject(text, re, label) {
  if (!re.test(text)) { pass++; } else { fail++; console.log(`  x ${label} — should be gone: ${re}`); }
}

// ── run the helpers for real ───────────────────────────────────────────
const start = src.indexOf("var _IMG_PRESETS = {");
const end = src.indexOf("\nfunction _flashHint(");
if (start < 0 || end < 0 || end < start) { console.error("helper block not found"); process.exit(1); }
const helpers = new Function(
  src.slice(start, end) +
  "\nreturn { _IMG, _IMG_PRESETS, _setImageQuality, _safeQuality, _thumbUrl, _imgUrl, _fullUrl };"
)();
const { _IMG_PRESETS, _setImageQuality, _safeQuality, _thumbUrl, _imgUrl, _fullUrl } = helpers;

const CDN = "https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/1c65dc07-2e32-4e76-a0b7-458c450ff1ae";
const ORIGINAL_URL = `${CDN}/original=true/12221824.jpeg`;
const LOCAL = "/civitai/local-preview?path=" + encodeURIComponent("/models/loras/x.safetensors");

console.log("quality values the CDN actually honours");
for (const [name, p] of Object.entries(_IMG_PRESETS)) {
  for (const key of ["cardQ", "galleryQ", "lightboxQ"]) {
    ok([40, 50, 60, 70, 80].includes(p[key]),
      `${name}.${key}=${p[key]} is a quality the CDN accepts (not 30, not 65, not 95)`);
  }
}
console.log("  _safeQuality snaps into that range");
eq(_safeQuality(65), 70, "65 — the value that silently returns the 839 KB original — becomes 70");
eq(_safeQuality(95), 80, "95 is pulled back to 80");
eq(_safeQuality(20), 40, "20 is raised to 40");
eq(_safeQuality(30), 40, "30 is raised to 40 (the CDN refuses 30 at width=1200)");
eq(_safeQuality(undefined), 60, "a missing quality defaults to 60");
eq(_safeQuality("70"), 70, "a string quality is accepted");
eq(_safeQuality("bogus"), 60, "garbage falls back to the default");

console.log("preset widths land on real CDN buckets");
const BUCKETS = [320, 450, 512, 800, 1200, 1600];
for (const [name, p] of Object.entries(_IMG_PRESETS)) {
  ok(BUCKETS.includes(p.card), `${name}.card=${p.card} is a served width`);
  ok(BUCKETS.includes(p.gallery), `${name}.gallery=${p.gallery} is a served width`);
  ok(BUCKETS.includes(p.lightbox), `${name}.lightbox=${p.lightbox} is a served width`);
}

console.log("the three presets are ordered by cost");
const order = ["saver", "balanced", "high"];
for (const kind of ["card", "gallery", "lightbox"]) {
  const q = kind === "card" ? "cardQ" : kind === "gallery" ? "galleryQ" : "lightboxQ";
  for (let i = 1; i < order.length; i++) {
    const a = _IMG_PRESETS[order[i - 1]], b = _IMG_PRESETS[order[i]];
    ok(a[kind] < b[kind] && a[q] <= b[q],
      `${order[i - 1]} asks for a smaller ${kind} image than ${order[i]}`);
  }
}

console.log("_thumbUrl rewrites every shape of Civitai URL");
eq(_thumbUrl(ORIGINAL_URL, 450, 60), `${CDN}/width=450,quality=60/12221824.jpeg`,
  "original=true is replaced by the transform");
eq(_thumbUrl(`${CDN}/width=1600,quality=80/12221824.jpeg`, 450, 60),
  `${CDN}/width=450,quality=60/12221824.jpeg`, "an existing transform is replaced, not appended");
eq(_thumbUrl(`${CDN}/width=1600/12221824.jpeg`, 450, 60),
  `${CDN}/width=450,quality=60/12221824.jpeg`, "width-only gets a quality too");
eq(_thumbUrl(`${CDN}/12221824.jpeg`, 450, 60), `${CDN}/width=450,quality=60/12221824.jpeg`,
  "a bare URL has the transform inserted");
eq(_thumbUrl("", 450, 60), "", "an empty URL stays empty");
eq(_thumbUrl("https://cdn.huggingface.co/a.png", 320, 50),
  "https://cdn.huggingface.co/a.png?width=320&quality=50",
  "non-Civitai hosts get query parameters instead");

console.log("_imgUrl routes each view to its own size");
eq(_imgUrl(ORIGINAL_URL, "card"), `${CDN}/width=450,quality=60/12221824.jpeg`, "card");
eq(_imgUrl(ORIGINAL_URL, "gallery"), `${CDN}/width=512,quality=60/12221824.jpeg`, "gallery");
eq(_imgUrl(ORIGINAL_URL, "lightbox"), `${CDN}/width=1200,quality=60/12221824.jpeg`, "lightbox");

console.log("_imgUrl handles our own /civitai/local-preview endpoint");
const localCard = _imgUrl(LOCAL, "card");
ok(localCard.startsWith("/civitai/local-preview?path="), "the endpoint is preserved");
ok(localCard.includes("path=" + encodeURIComponent("/models/loras/x.safetensors")), "the path survives");
eq(new URLSearchParams(localCard.split("?")[1]).get("w"), "450", "card width is passed as w");
eq(new URLSearchParams(localCard.split("?")[1]).get("q"), "60", "card quality is passed as q");
eq(new URLSearchParams(_imgUrl(LOCAL, "gallery").split("?")[1]).get("w"), "512", "gallery width");
const twice = _imgUrl(_imgUrl(LOCAL, "card"), "gallery");
eq(new URLSearchParams(twice.split("?")[1]).getAll("w").length, 1,
  "re-sizing an already-sized URL replaces w instead of adding a second one");
eq(new URLSearchParams(twice.split("?")[1]).get("w"), "512", "and the new width wins");

console.log("_fullUrl recovers the untouched original");
eq(new URLSearchParams(_fullUrl(_imgUrl(LOCAL, "card")).split("?")[1]).has("w"), false,
  "w is stripped for local images");
eq(new URLSearchParams(_fullUrl(_imgUrl(LOCAL, "card")).split("?")[1]).has("q"), false,
  "q is stripped for local images");
ok(_fullUrl(_imgUrl(LOCAL, "card")).includes("path="), "the path is still there");
eq(_fullUrl(ORIGINAL_URL), ORIGINAL_URL, "a Civitai URL is already the original");

console.log("switching preset changes what gets requested");
_setImageQuality("saver");
eq(_imgUrl(ORIGINAL_URL, "card"), `${CDN}/width=320,quality=50/12221824.jpeg`, "data saver cards");
eq(_imgUrl(ORIGINAL_URL, "lightbox"), `${CDN}/width=800,quality=50/12221824.jpeg`, "data saver lightbox");
_setImageQuality("nonsense");
eq(_imgUrl(ORIGINAL_URL, "card"), `${CDN}/width=450,quality=60/12221824.jpeg`, "an unknown preset falls back to balanced");
_setImageQuality("balanced");

// ── render sites ───────────────────────────────────────────────────────
console.log("grids lazy-load their thumbnails");
const sites = [
  ["civitai search card", /var img = el\("img", \{ src: _imgUrl\(imgUrl, "card"\), loading: "lazy", decoding: "async",/],
  ["bookmark card", /thumb\.appendChild\(el\("img", \{ src: _imgUrl\(b\.image, "card"\),\s*\n\s*loading: "lazy", decoding: "async",/],
  ["local model card", /thumb\.appendChild\(el\("img", \{ src: imgUrl, loading: "lazy", decoding: "async",/],
];
for (const [label, re] of sites) check(src, re, `${label} defers offscreen images`);

console.log("no grid still requests a hardcoded size");
reject(src, /_thumbUrl\([^)]*,\s*(400|500|300)\)/, "no literal thumbnail widths left");
reject(src, /local-preview\?path=" \+ encodeURIComponent\([^)]*\) \+ "&w=\d+"/, "local previews are not hardcoded to one width");

console.log("the gallery and the local detail use the gallery size");
check(src, /src: _imgUrl\(im\.url, "gallery"\), loading: "lazy", decoding: "async",/, "the Civitai gallery");
check(src, /src: _imgUrl\("\/civitai\/local-preview\?path=" \+ encodeURIComponent\(m\.preview\), "gallery"\),/, "local previews");

console.log("the lightbox no longer downloads the original by default");
const lb = src.slice(src.indexOf("function openLightbox("), src.indexOf("// Right: generation parameters panel"));
reject(lb, /src: img\.url,/, "the image is not the untouched original");
check(lb, /var viewUrl = _imgUrl\(img\.url, "lightbox"\);/, "it asks for the lightbox size");
check(lb, /src: viewUrl,/, "and uses it");
check(lb, /var lqipUrl = _imgUrl\(img\.url, "card"\);/, "the cached card thumbnail is the placeholder");
ok(lb.includes(`mainImg.style.backgroundImage = 'url("' + lqipUrl.replace(/"/g, "%22") + '")';`),
  "and is painted while the full one loads");
check(lb, /backgroundSize:"contain", backgroundPosition:"center", backgroundRepeat:"no-repeat"/,
  "the placeholder matches object-fit:contain, so nothing jumps");
check(lb, /var _dropLqip = function\(\) \{ mainImg\.style\.backgroundImage = ""; \};/, "the placeholder is dropped once loaded");
check(lb, /mainImg\.addEventListener\("load", _dropLqip\);/, "on load");
check(lb, /mainImg\.addEventListener\("error", _dropLqip\);/, "and on error");

console.log("full resolution is opt-in and its cost is visible");
check(lb, /var fullUrl = _fullUrl\(img\.url\);/, "the original URL is kept");
check(lb, /"\\uD83D\\uDD0D Full resolution"/, "there is a button for it");
check(lb, /probe\.src = fullUrl;/, "and it is only requested when clicked");
check(lb, /fetch\(fullUrl\)\.then\(function\(r\) \{ return r\.blob\(\); \}\)/, "the payload is measured");
check(lb, /lbSize\.textContent = _fmtBytes\(b\.size\);/, "and shown in bytes");
check(lb, /"\\u2197 Open original"/, "plus a link to open it in a new tab");

console.log("image quality is a saved setting");
check(src, /image_quality:iqSel\.value,theme:/, "it is posted with the other settings");
check(src, /iqSel\.value = cfg\.image_quality \|\| "balanced";/, "it is restored when Settings opens");
check(src, /S\.settings\.imageQuality = cfg\.image_quality \|\| "balanced";/, "and when the panel mounts");
check(src, /_setImageQuality\(S\.settings\.imageQuality\);/, "the mounted panel uses the saved value");
check(src, /\{ v: "saver", l: "\\uD83D\\uDCC9 Data saver \\u2014 smallest, fastest" \}/, "data saver is offered");
check(src, /_setImageQuality\(iqSel\.value\);/, "changing it takes effect immediately");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
