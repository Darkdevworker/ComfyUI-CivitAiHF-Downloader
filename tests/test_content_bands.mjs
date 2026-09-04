/**
 * Content-band logic tests — run with:  node tests/test_content_bands.mjs
 * Covers the five Civitai tiers, the bitmask/string/boolean normalisation,
 * model-level categorisation, filtering and the blur threshold.
 */
global.window = { __nsfwBlurEnabled: true, __nsfwBlurLevel: "X" };

const {
  CONTENT_BANDS, BAND_ORDER, bandIdFromValue, bandIdOfModel, bandIdOfImage,
  parseBandSelection, serializeBandSelection, filterByBands, needsNsfwQuery,
  isBlurred, currentBlurThreshold,
} = await import("../js/rating.js");

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; }
  else { fail++; console.log(`  ✗ ${label}\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`); }
}

console.log("bands");
eq(CONTENT_BANDS.length, 5, "five bands exist");
eq(BAND_ORDER, ["PG", "PG-13", "R", "X", "XXX"], "band order");
eq(CONTENT_BANDS.filter(b => b.nsfw).map(b => b.id), ["X", "XXX"], "only X/XXX are NSFW");

console.log("normalisation — numeric bitmask");
eq(bandIdFromValue(1), "PG", "1 -> PG");
eq(bandIdFromValue(2), "PG-13", "2 -> PG-13");
eq(bandIdFromValue(4), "R", "4 -> R");
eq(bandIdFromValue(8), "X", "8 -> X");
eq(bandIdFromValue(16), "XXX", "16 -> XXX");
eq(bandIdFromValue(32), "XXX", "32 (blocked) -> XXX");
eq(bandIdFromValue(3), "PG-13", "3 (PG|PG-13) -> PG-13");
eq(bandIdFromValue(12), "X", "12 (R|X) -> X");
eq(bandIdFromValue(24), "XXX", "24 (X|XXX) -> XXX");
eq(bandIdFromValue(0), "PG", "0 -> PG");

console.log("normalisation — enum strings + booleans");
eq(bandIdFromValue("None"), "PG", "None -> PG");
eq(bandIdFromValue("Soft"), "PG-13", "Soft -> PG-13");
eq(bandIdFromValue("Mature"), "R", "Mature -> R");
eq(bandIdFromValue("X"), "X", "X -> X");
eq(bandIdFromValue("XXX"), "XXX", "XXX -> XXX");
eq(bandIdFromValue("Blocked"), "XXX", "Blocked -> XXX");
eq(bandIdFromValue(true), "R", "nsfw:true (no tier) -> R");
eq(bandIdFromValue(false), "PG", "nsfw:false -> PG");
eq(bandIdFromValue(null), null, "missing -> null");
eq(bandIdFromValue(""), null, "empty -> null");

console.log("model categorisation (highest tier wins)");
eq(bandIdOfModel({ nsfwLevel: 4, modelVersions: [{ images: [{ nsfwLevel: 16 }, { nsfwLevel: 1 }] }] }), "XXX",
  "model with one XXX preview is XXX");
eq(bandIdOfModel({ modelVersions: [{ images: [{ nsfwLevel: 2 }] }] }), "PG-13", "only PG-13 previews -> PG-13");
eq(bandIdOfModel({}), "PG", "no data -> PG");
eq(bandIdOfImage({ nsfwLevel: 8 }, { nsfwLevel: 1 }), "X", "image level beats model level");
eq(bandIdOfImage({}, { nsfwLevel: 16 }), "XXX", "image inherits model level");

console.log("filter selection");
eq(parseBandSelection("PG,X"), ["PG", "X"], "parse selection");
eq(parseBandSelection(""), [], "empty selection = no filter");
eq(serializeBandSelection(["R", "XXX"]), "R,XXX", "serialise selection");
const items = [{ nsfwLevel: 1 }, { nsfwLevel: 4 }, { nsfwLevel: 8 }, { nsfwLevel: 16 }, {}];
eq(filterByBands(items, ["X"]).length, 1, "filter X only");
eq(filterByBands(items, ["PG"]).length, 2, "filter PG only (incl. unrated)");
eq(filterByBands(items, []).length, 5, "no filter keeps everything");
eq(needsNsfwQuery(["PG"]), false, "PG does not need nsfw=true");
eq(needsNsfwQuery(["X"]), true, "X needs nsfw=true");

console.log("blur threshold (default X)");
eq(currentBlurThreshold(), "X", "default threshold X");
eq(isBlurred("PG"), false, "PG not blurred");
eq(isBlurred("PG-13"), false, "PG-13 not blurred");
eq(isBlurred("R"), false, "R not blurred by default");
eq(isBlurred("X"), true, "X blurred");
eq(isBlurred("XXX"), true, "XXX blurred");
window.__nsfwBlurLevel = "R";
eq(isBlurred("R"), true, "threshold R blurs R");
window.__nsfwBlurLevel = "XXX";
eq(isBlurred("X"), false, "threshold XXX leaves X visible");
window.__nsfwBlurLevel = "off";
eq(isBlurred("XXX"), false, "threshold off never blurs");
window.__nsfwBlurLevel = "X";
window.__nsfwBlurEnabled = false;
eq(isBlurred("XXX"), false, "master switch disables blur");
window.__nsfwBlurEnabled = true;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
