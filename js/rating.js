/**
 * rating.js — Civitai Content Bands (PG / PG-13 / R / X / XXX)
 * =============================================================
 * Single source of truth for how this extension *categorises* models,
 * LoRAs and showcase images, and for deciding which thumbnails get blurred.
 *
 * Civitai's own five strict tiers [1]:
 *   PG    — Safe for Work. Standard, universally safe content, zero adult material.
 *   PG-13 — Lightly Risqué. Revealing clothing (short skirts, navels, cleavage),
 *           sexy attire, light action violence, mild blood/gore.
 *   R     — Risqué / Mature. Adult themes, partial nudity (bikinis, underwear,
 *           leotards), sensual but non-explicit situations, graphic violence.
 *   X     — Graphic Nudity. NSFW. Explicit graphic nudity, clear anatomy, adult
 *           objects or settings, without full sexual acts.
 *   XXX   — Overtly Sexual. NSFW. Explicit sexual acts, highly graphic
 *           presentation, or deeply disturbing concepts.
 *
 * How Civitai reports the tier (all three shapes are handled here):
 *   • numeric bitmask  — nsfwLevel: 1=PG, 2=PG-13, 4=R, 8=X, 16=XXX, 32=Blocked [2]
 *   • string enum      — nsfwLevel: "None" | "Soft" | "Mature" | "X" | "XXX" | "Blocked"
 *   • boolean fallback — nsfw: true / false
 *
 * [1] https://education.civitai.com/civitais-guide-to-content-levels/
 * [2] https://github.com/civitai/civitai/wiki/REST-API-Reference
 *
 * BLURRING: only the NSFW bands (X and XXX) are blurred by default — R is
 * "mature" but not blurred, matching Civitai's own distinction. Users can move
 * the threshold (Off / R+ / X+ / XXX) in Settings; the value lives in
 * `window.__nsfwBlurLevel` and is persisted server-side as `nsfw_blur_level`.
 */

/* ── The five bands ─────────────────────────────────────────────────── */

export const CONTENT_BANDS = [
  {
    id: "PG",
    bit: 1,
    label: "Safe for Work",
    blurb: "Standard, universally safe content. Completely Safe For Work (SFW) with absolutely zero adult material.",
    sfw: true,
    nsfw: false,
    color: "#2e7d32",
    textColor: "#ffffff",
  },
  {
    id: "PG-13",
    bit: 2,
    label: "Lightly Risqué",
    blurb: "Focuses on revealing clothing (short skirts, navels, cleavage), sexy attire, light action violence, or mild blood/gore.",
    sfw: true,
    nsfw: false,
    color: "#b26a00",
    textColor: "#ffffff",
  },
  {
    id: "R",
    bit: 4,
    label: "Risqué / Mature",
    blurb: "Adult themes, partial nudity (bikinis, underwear, leotards), sensual but non-explicit situations, and graphic violence.",
    sfw: false,
    nsfw: false,
    color: "#c62828",
    textColor: "#ffffff",
  },
  {
    id: "X",
    bit: 8,
    label: "Graphic Nudity",
    blurb: "Not Safe For Work (NSFW). Explicit graphic nudity, clear anatomy, and adult objects or settings without depicting full sexual acts.",
    sfw: false,
    nsfw: true,
    color: "#6a1b9a",
    textColor: "#ffffff",
  },
  {
    id: "XXX",
    bit: 16,
    label: "Overtly Sexual",
    blurb: "Not Safe For Work (NSFW). Explicit sexual acts, highly graphic presentation, or deeply disturbing concepts.",
    sfw: false,
    nsfw: true,
    color: "#111111",
    textColor: "#ffffff",
  },
];

/** Ordinal order, lowest → highest. Used for "R and up" style thresholds. */
export const BAND_ORDER = CONTENT_BANDS.map(function (b) { return b.id; });

export const BAND_BY_ID = CONTENT_BANDS.reduce(function (acc, b) {
  acc[b.id] = b;
  acc[b.id.toUpperCase().replace(/\s/g, "")] = b;
  return acc;
}, {});

/** Civitai's extra bit (32) is "Blocked" — treated as the most restrictive band. */
const BLOCKED_BIT = 32;

/** Blur threshold used when the user has not chosen one yet. */
export const DEFAULT_BLUR_THRESHOLD = "X";

/** Options offered in Settings (value → human label). */
export const BLUR_THRESHOLDS = [
  { value: "off", label: "Off — never blur" },
  { value: "R", label: "R and up (R · X · XXX)" },
  { value: "X", label: "X and up (X · XXX) — NSFW only" },
  { value: "XXX", label: "XXX only" },
];

/** CSS applied to a blurred thumbnail (hovering removes it — see civitai.css). */
export const BLUR_CLASS = "cvt-blur";

/** String aliases seen in the wild → band id. */
const STRING_ALIASES = {
  "": "PG",
  none: "PG",
  pg: "PG",
  g: "PG",
  everyone: "PG",
  safe: "PG",
  sfw: "PG",
  "0": "PG",
  soft: "PG-13",
  pg13: "PG-13",
  "pg-13": "PG-13",
  teen: "PG-13",
  light: "PG-13",
  "1": "PG-13",
  mature: "R",
  r: "R",
  r15: "R",
  adult: "R",
  risque: "R",
  risqué: "R",
  "2": "R",
  x: "X",
  r18: "X",
  "r-18": "X",
  "r18+": "X",
  nsfw: "X",
  explicit: "X",
  "3": "X",
  xxx: "XXX",
  blocked: "XXX",
  banned: "XXX",
  "4": "XXX",
};

/* ── Normalisation ──────────────────────────────────────────────────── */

/** Rank of a band id (0 = PG … 4 = XXX). Unknown ids rank as PG. */
export function bandRank(id) {
  var i = BAND_ORDER.indexOf(String(id || "").toUpperCase());
  return i < 0 ? 0 : i;
}

/** Highest band of two, useful for taking the max over a model's images. */
export function maxBand(a, b) {
  return bandRank(a) >= bandRank(b) ? a : b;
}

/**
 * Turn a raw Civitai value into a band id.
 * Accepts the numeric bitmask, the string enum, or a boolean.
 * Returns null when nothing usable is present.
 */
export function bandIdFromValue(value) {
  if (value == null) return null;

  // boolean — Civitai's legacy `nsfw: true` flag, with no tier attached.
  if (typeof value === "boolean") return value ? "R" : "PG";

  var s = String(value).trim();
  if (s === "" || s === "null" || s === "undefined") return null;

  // numeric (bitmask preferred, legacy 0–4 ordinal as fallback)
  var n = Number(s);
  if (s !== "" && isFinite(n)) {
    n = Math.floor(n);
    if (n <= 0) return "PG";
    var highest = 0;
    CONTENT_BANDS.forEach(function (b) { if (n & b.bit) highest = b.bit; });
    if (n & BLOCKED_BIT) highest = BLOCKED_BIT;
    if (highest === BLOCKED_BIT) return "XXX";
    if (highest) {
      var hit = CONTENT_BANDS.filter(function (b) { return b.bit === highest; })[0];
      if (hit) return hit.id;
    }
    // not a recognised bitmask — assume the old 0/1/2/3/4 ordinal scale
    if (n <= 4) return BAND_ORDER[Math.min(n, 4)];
    return "XXX";
  }

  var key = s.toLowerCase().replace(/[\s_]+/g, "");
  if (STRING_ALIASES[key] != null) return STRING_ALIASES[key];
  key = s.toLowerCase();
  if (STRING_ALIASES[key] != null) return STRING_ALIASES[key];
  return null;
}

/** Band object for a raw value (never null — falls back to PG). */
export function bandFromValue(value) {
  return BAND_BY_ID[bandIdFromValue(value)] || BAND_BY_ID.PG;
}

/** Band id for a model / version / image object. */
export function bandIdOfItem(item) {
  if (!item || typeof item !== "object") return "PG";
  var keys = ["nsfwLevel", "nsfw_level", "rating", "nsfwRating", "level", "nsfw"];
  for (var i = 0; i < keys.length; i++) {
    var v = item[keys[i]];
    if (v == null || v === "" || v === "null" || v === "undefined") continue;
    // a plain `nsfw: true` (no tier) is a weak signal — remember it, keep looking
    var id = bandIdFromValue(v);
    if (id) {
      if (keys[i] === "nsfw" && typeof v === "boolean") {
        return id === "PG" ? "PG" : id; // false → PG, true → R (flagged, unblurred)
      }
      return id;
    }
  }
  return "PG";
}

/** Band object for a model / version / image object. */
export function bandOfItem(item) {
  return BAND_BY_ID[bandIdOfItem(item)] || BAND_BY_ID.PG;
}

/**
 * Band id of a single showcase image.
 * Falls back to the parent model's band when the image carries no tier of its
 * own (the compact /models response often omits per-image levels).
 */
export function bandIdOfImage(img, fallbackItem) {
  if (!img || typeof img !== "object") return "PG";
  var own = null;
  ["nsfwLevel", "nsfw_level", "rating", "nsfwRating", "level"].forEach(function (k) {
    if (own) return;
    var v = img[k];
    if (v == null || v === "" || v === "null" || v === "undefined") return;
    own = bandIdFromValue(v);
  });
  if (own) return own;
  if (typeof img.nsfw === "boolean") return img.nsfw ? "R" : "PG";
  return fallbackItem ? bandIdOfItem(fallbackItem) : "PG";
}

/**
 * Band id for a *model*: the highest tier among the model itself and every
 * preview image it ships, so a model with one XXX preview is categorised XXX.
 */
export function bandIdOfModel(m) {
  if (!m || typeof m !== "object") return "PG";
  var worst = bandIdOfItem(m);
  var versions = m.modelVersions || [];
  versions.forEach(function (v) {
    if (!v) return;
    worst = maxBand(worst, bandIdOfItem(v));
    (v.images || []).forEach(function (im) {
      worst = maxBand(worst, bandIdOfImage(im, m));
    });
  });
  (m.images || []).forEach(function (im) {
    worst = maxBand(worst, bandIdOfImage(im, m));
  });
  return worst;
}

/** Band object for a model. */
export function bandOfModel(m) {
  return BAND_BY_ID[bandIdOfModel(m)] || BAND_BY_ID.PG;
}

/* ── Filtering ──────────────────────────────────────────────────────── */

/** "PG,PG-13" → ["PG","PG-13"] (unknown ids dropped, order normalised). */
export function parseBandSelection(str) {
  if (!str) return [];
  var picked = String(str).split(",").map(function (s) { return s.trim(); }).filter(Boolean);
  return BAND_ORDER.filter(function (id) { return picked.indexOf(id) >= 0; });
}

/** ["PG","X"] → "PG,X" */
export function serializeBandSelection(ids) {
  return (ids || []).join(",");
}

/**
 * Does `bandId` pass the filter?
 * An empty selection means "no filter" (show everything).
 */
export function bandMatches(bandId, selectedIds) {
  if (!selectedIds || !selectedIds.length) return true;
  return selectedIds.indexOf(bandId) >= 0;
}

/** Filter helper for a list of models / images. */
export function filterByBands(items, selectedIds, isImage) {
  if (!selectedIds || !selectedIds.length) return items || [];
  return (items || []).filter(function (it) {
    var id = isImage ? bandIdOfImage(it) : bandIdOfModel(it);
    return bandMatches(id, selectedIds);
  });
}

/** True when the selection needs Civitai's `nsfw=true` query flag. */
export function needsNsfwQuery(selectedIds) {
  if (!selectedIds || !selectedIds.length) return false;
  return selectedIds.some(function (id) { return !BAND_BY_ID[id] || BAND_BY_ID[id].nsfw || id === "R"; });
}

/* ── Blurring ───────────────────────────────────────────────────────── */

/** Threshold currently in effect (falls back to the default). */
export function currentBlurThreshold() {
  var t = window.__nsfwBlurLevel;
  if (t == null || t === "") return DEFAULT_BLUR_THRESHOLD;
  t = String(t);
  if (t === "off" || t === "none" || t === "false") return "off";
  return BAND_BY_ID[t] ? t : DEFAULT_BLUR_THRESHOLD;
}

/**
 * Should an item in `bandId` be blurred?
 * Honours the master switch (`window.__nsfwBlurEnabled`) and the threshold.
 */
export function isBlurred(bandId, threshold) {
  if (window.__nsfwBlurEnabled === false) return false;
  var thr = threshold || currentBlurThreshold();
  if (thr === "off") return false;
  return bandRank(bandId) >= bandRank(thr);
}

/**
 * Apply (or clear) the blur on a thumbnail node.
 * Blur is class-driven so CSS can un-blur on hover — no inline filter needed.
 */
export function applyBlur(node, bandId, opts) {
  if (!node) return false;
  opts = opts || {};
  var on = isBlurred(bandId, opts.threshold);
  if (on) {
    node.classList.add(BLUR_CLASS);
    node.dataset.cvtBand = bandId;
    node.title = bandId + " — hover to reveal";
  } else {
    node.classList.remove(BLUR_CLASS);
    delete node.dataset.cvtBand;
    if (node.title === bandId + " — hover to reveal") node.title = "";
  }
  return on;
}

/* ── UI helpers ─────────────────────────────────────────────────────── */

/** Small coloured tier badge, e.g. ● PG-13, with the band definition as tooltip. */
export function makeBandBadge(bandId, opts) {
  opts = opts || {};
  var band = BAND_BY_ID[bandId] || BAND_BY_ID.PG;
  var span = document.createElement("span");
  span.className = "cvt-badge cvt-band-badge band-" + band.id.toLowerCase().replace(/[^a-z0-9]/g, "");
  span.style.background = band.color;
  span.style.borderColor = band.color;
  span.style.color = band.textColor || "#fff";
  span.textContent = opts.showLabel ? band.id + " · " + band.label : band.id;
  span.title = band.id + " — " + band.label + "\n" + band.blurb;
  return span;
}

/**
 * Five checkboxes, one per band, coloured with the official band colours.
 * Returns a row element exposing `_getVal()` → "PG,X" (empty string = no filter).
 */
export function buildBandCheckboxes(selectedStr, onChange) {
  var selected = parseBandSelection(selectedStr);
  var boxes = {};
  var row = document.createElement("div");
  row.className = "cvt-band-filter";
  row.style.display = "flex";
  row.style.gap = "6px";
  row.style.alignItems = "center";
  row.style.flexWrap = "wrap";

  CONTENT_BANDS.forEach(function (band) {
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = band.id;
    cb.checked = selected.indexOf(band.id) >= 0;
    cb.onchange = function () { if (typeof onChange === "function") onChange(); };

    var swatch = document.createElement("i");
    swatch.style.cssText = "display:inline-block;width:7px;height:7px;border-radius:2px;background:" + band.color + ";";

    var lbl = document.createElement("label");
    lbl.style.cssText = "display:inline-flex;align-items:center;gap:3px;cursor:pointer;font-size:11px;white-space:nowrap;color:var(--civ-text-dim);";
    lbl.title = band.id + " — " + band.label + "\n" + band.blurb;
    lbl.appendChild(cb);
    lbl.appendChild(swatch);
    lbl.appendChild(document.createTextNode(band.id));
    row.appendChild(lbl);
    boxes[band.id] = cb;
  });

  var clear = document.createElement("button");
  clear.type = "button";
  clear.textContent = "All";
  clear.style.cssText = "font-size:10px;padding:0 5px;cursor:pointer;";
  clear.title = "Clear the content-band filter (show every tier)";
  clear.onclick = function () {
    CONTENT_BANDS.forEach(function (b) { boxes[b.id].checked = false; });
    if (typeof onChange === "function") onChange();
  };
  row.appendChild(clear);

  row._cbs = boxes;
  row._getVal = function () {
    return serializeBandSelection(BAND_ORDER.filter(function (id) { return boxes[id].checked; }));
  };
  row._setVal = function (str) {
    var sel = parseBandSelection(str);
    CONTENT_BANDS.forEach(function (b) { boxes[b.id].checked = sel.indexOf(b.id) >= 0; });
  };
  return row;
}

/** Dropdown used in Settings to pick how much gets blurred. */
export function buildBlurThresholdSelect(current) {
  var sel = document.createElement("select");
  sel.className = "cvt-select-sm";
  BLUR_THRESHOLDS.forEach(function (t) {
    var opt = document.createElement("option");
    opt.value = t.value;
    opt.textContent = t.label;
    sel.appendChild(opt);
  });
  sel.value = current || DEFAULT_BLUR_THRESHOLD;
  sel.onchange = function () { window.__nsfwBlurLevel = sel.value; };
  return sel;
}

/* ── Legacy / debug surface ─────────────────────────────────────────── */

// Kept so anything still reaching for globals (or the browser console) works.
window.CivitaiBands = {
  CONTENT_BANDS: CONTENT_BANDS,
  BAND_ORDER: BAND_ORDER,
  bandIdOfModel: bandIdOfModel,
  bandIdOfImage: bandIdOfImage,
  bandIdFromValue: bandIdFromValue,
  isBlurred: isBlurred,
  currentBlurThreshold: currentBlurThreshold,
};
