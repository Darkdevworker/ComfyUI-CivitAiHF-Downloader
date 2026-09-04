import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { installSidebarLogo, makeLogo } from "./logo.js";
import {
  CONTENT_BANDS, BAND_ORDER, parseBandSelection, needsNsfwQuery,
  bandIdOfModel, bandIdOfImage, bandOfModel, filterByBands,
  makeBandBadge, buildBandCheckboxes, buildBlurThresholdSelect,
  applyBlur, reapplyBlur, isBlurred, DEFAULT_BLUR_THRESHOLD,
} from "./rating.js";

// Convenience wrapper: rating.bandMatches() bound to a selection array
function bandMatchesSelection(bandId, selectedIds) {
  if (!selectedIds || !selectedIds.length) return true;
  return selectedIds.indexOf(bandId) >= 0;
}

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (typeof v === "boolean") { if (v) node.setAttribute(k, ""); else node.removeAttribute(k); }
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    if (typeof c === "string" || typeof c === "number") node.appendChild(document.createTextNode(c));
    else if (c instanceof Node) node.appendChild(c);
    else if (Array.isArray(c)) c.flat().forEach(x => { if (x instanceof Node) node.appendChild(x); });
  }
  return node;
}

const CIVITAI_TYPES = [
  "", "Checkpoint", "LORA", "LoCon", "DoRA", "TextualInversion",
  "Hypernetwork", "AestheticGradient", "Controlnet", "VAE",
  "Upscaler", "MotionModule", "Poses", "Wildcards", "Workflows", "Other",
];
const CIVITAI_SORTS = [
  "Highest Rated", "Most Downloaded", "Most Liked", "Most Discussed",
  "Most Collected", "Most Images", "Newest", "Oldest", "Relevancy",
];
const CIVITAI_PERIODS = ["AllTime", "Year", "Month", "Week", "Day"];
const CIVITAI_BASE_MODELS = [
  "", "SD 1.4", "SD 1.5", "SD 1.5 LCM", "SD 1.5 Hyper",
  "SD 2.0", "SD 2.0 768", "SD 2.1", "SD 2.1 768", "SD 2.1 Unclip",
  "SDXL 0.9", "SDXL 1.0", "SDXL 1.0 LCM", "SDXL Distilled", "SDXL Lightning",
  "Pony", "Illustrious", "NoobAI",
  "Stable Cascade",
  "Flux.1 D", "Flux.1 S", "Flux.1 Kontext", "Flux.1 Krea",
  "Z-Image", "ZImageBase", "ZImageTurbo",
  "Qwen", "Qwen 2",
  "Hunyuan 1", "Hunyuan Video",
  "Wan Video", "Wan Video 1.3B t2v", "Wan Video 14B t2v", "Wan Video 14B i2v 480p",
  "LTXV", "LTXV 2.3", "CogVideoX", "Mochi", "SVD XT",
  "AuraFlow", "Chroma", "HiDream", "Kolors", "Lumina",
  "PixArt a", "PixArt E", "Playground v2", "ODOR", "Other",
];
const HF_PIPELINES = [
  "", "text-to-image", "image-to-image", "image-to-video",
  "text-to-video", "video-to-video", "image-to-3d", "text-to-3d",
  "depth-estimation", "image-segmentation",
  "automatic-speech-recognition", "text-to-speech",
  "text-generation", "feature-extraction", "sentence-similarity",
];
const HF_LIBRARIES = ["", "diffusers", "transformers", "gguf", "onnx",
                      "sentence-transformers", "peft", "safetensors"];
const HF_SORTS = ["downloads", "likes", "trending_score", "createdAt", "lastModified"];
// ── Content bands (PG / PG-13 / R / X / XXX) live in ./rating.js ─────
//   _matchNsfw / _nsfwFlags / NSFW_RATINGS were removed: they duplicated
//   rating.js and mis-read Civitai's bitmask nsfwLevel (1/2/4/8/16).
//   Use bandIdOfModel() / bandIdOfImage() / filterByBands() / applyBlur().

// ── TTL Cache ─────────────────────────────────────────────────────
var _cache = new (function() {
  this._map = new Map(); this._inflight = new Map(); this._max = 80; this._ttl = 60000;
  this.get = function(k) { var e = this._map.get(k); if (!e) return null; if (e.exp < Date.now()) { this._map.delete(k); return null; } this._map.delete(k); this._map.set(k, e); return e.v; };
  this.set = function(k, v) { this._map.set(k, { v: v, exp: Date.now() + this._ttl }); if (this._map.size > this._max) { var ok = this._map.keys().next().value; this._map.delete(ok); } };
  this.clear = function() { this._map.clear(); this._inflight.clear(); };
  this.del = function(k) { this._map.delete(k); this._inflight.delete(k); };
})();

var _activeJobs = 0;
var _jobsTimer = null;
var _hintTimer = null;
var _localPromptCache = {};
window.__nsfwBlurEnabled = true;

var S = {
  curTab: "civitai", civitai: { items: [], query: "", type: "", sort: "Highest Rated", nsfw: "", period: "AllTime", baseModel: "", loading: false,
    cursor: "", cursorStack: [], nextCursor: null, limit: 24 },
  hf: { items: [], query: "", sort: "lastModified", pipeline_tag: "", library: "", author: "" },
  downloads: [], dlFilter: "all", local: { models: [], filter: "" },
  settings: { baseUrl: "civitai.com", saveMeta: true, savePrev: true, nsfwBlur: true },
  modal: null, lightbox: null,
  root: null,
};

function _api(path, opts) {
  var method = (opts && opts.method || "GET").toUpperCase();
  var cacheKey = method === "GET" ? path : null;
  if (cacheKey) {
    var cached = _cache.get(cacheKey);
    if (cached) return Promise.resolve(cached);
    var pending = _cache._inflight.get(cacheKey);
    if (pending) return pending;
  }
  var p = api.fetchApi(path, opts || {}).then(function(r) {
    if (!r.ok) {
      var err = new Error("HTTP " + r.status);
      err.status = r.status;
      err.transient = [408, 425, 429, 500, 502, 503, 504].indexOf(r.status) >= 0;
      throw err;
    }
    return r.json().catch(function() { return {}; });
  }).then(function(json) {
    if (cacheKey) { var items = json && json.items; if (!items || items.length > 0) _cache.set(cacheKey, json); }
    return json;
  });
  if (cacheKey) { _cache._inflight.set(cacheKey, p); p.then(function() { _cache._inflight.delete(cacheKey); }, function() { _cache._inflight.delete(cacheKey); }); }
  return p;
}

function _fmtBytes(n) { if (!n) return "\u2014"; const u = ["B","KB","MB","GB","TB"]; let i = 0; let s = n; while (s >= 1024 && i < 4) { s /= 1024; i++; } return s.toFixed(i > 1 ? 1 : 0) + " " + u[i]; }
function _fmtNum(n) { if (n == null) return "?"; if (n < 1e3) return String(n); if (n < 1e6) return (n/1e3).toFixed(n<1e4?1:0)+"K"; if (n < 1e9) return (n/1e6).toFixed(n<1e7?1:0)+"M"; return (n/1e9).toFixed(1)+"B"; }
var _THUMB_QUALITY = 60;
function _thumbUrl(url, w) {
  if (!url) return url;
  w = w || 450;
  var t = "width=" + w + ",quality=" + _THUMB_QUALITY;
  // Civitai CDN uses a path transform segment between the UUID and the filename,
  // e.g. /original=true/ , /width=NNN/ , or /width=NNN,quality=90/ .
  // A smaller width + lower quality dramatically reduces payload (originals are multi-MB).
  if (url.indexOf("image.civitai.com") >= 0) {
    // Already a width= transform (with optional extra params) -> replace it
    if (/\/width=\d+(?:,[^/]*)?(?=\/)/.test(url)) {
      return url.replace(/\/width=\d+(?:,[^/]*)?(?=\/)/, "/" + t);
    }
    // original=true (optionally with extra params) -> replace with width+quality
    if (/\/original=true(?:,[^/]*)?(?=\/)/.test(url)) {
      return url.replace(/\/original=true(?:,[^/]*)?(?=\/)/, "/" + t);
    }
    // No transform segment -> insert before the filename
    return url.replace(/\/([^/]+\.(?:jpe?g|png|webp|gif|avif))(\?|$)/i, "/" + t + "/$1$2");
  }
  var sep = url.indexOf("?") >= 0 ? "&" : "?";
  return url + sep + "width=" + w + "&quality=" + _THUMB_QUALITY;
}

function _flashHint(sb, text) {
  if (_hintTimer) clearTimeout(_hintTimer);
  var h = sb.querySelector(".cvt-flash");
  if (!h) { h = el("div", { class: "cvt-flash" }); sb.appendChild(h); }
  h.textContent = text;
  _hintTimer = setTimeout(function() { h.textContent = ""; }, 4000);
}

function _renderSkeletons(grid, n) {
  n = n || 12;
  grid.innerHTML = "";
  for (var i = 0; i < n; i++) grid.appendChild(el("div", { class: "cvt-skel" }));
}

function _toast(msg, type) {
  let wrap = document.querySelector(".cvt-toast-wrap");
  if (!wrap) { wrap = el("div", { class: "cvt-toast-wrap" }); document.body.appendChild(wrap); }
  const t = el("div", { class: "cvt-toast " + (type || "ok") }, msg);
  wrap.appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .3s"; setTimeout(() => t.remove(), 300); }, 3000);
}

(function injectCSS() {
  if (document.getElementById("cvt-css")) return;
  const link = document.createElement("link");
  link.id = "cvt-css"; link.rel = "stylesheet";
  try { link.href = new URL("civitai.css", import.meta.url).href; }
  catch (e) { link.href = "civitai.css"; }
  document.head.appendChild(link);
})();



const TABS = [
  ["civitai", "Civitai", "\uD83C\uDDE8", "emoji-float"],
  ["hf", "HF", "\uD83E\uDD17", "emoji-bounce"],
  ["downloads", "Downloads", "\u2B07", "emoji-pulse"],
  ["local", "Local", "\uD83D\uDCC1", "emoji-wiggle"],
  ["bookmarks", "Bookmarks", "\u2B50", "emoji-wiggle"],
  ["settings", "Settings", "\u2699\uFE0F", "emoji-spin"],
];

function buildUI() {
  var root = el("div", { class: "cvt-root" });
  S.root = root;

  // Custom tab switching events
  root.addEventListener("civitai:show-tab", function(e) {
    var which = e.detail;
    var tab = tabBar.querySelector('[data-tab="' + which + '"]');
    if (tab) tab.click();
  });

  var tabBar = el("div", { class: "cvt-tabs" });
  tabBar.appendChild(makeLogo(16));   // Civitai "C" mark (assets/civitai-icon.png)
  var panes = {};
  TABS.forEach(function(t) {
    var id = t[0], label = t[1], icon = t[2], anim = t[3];
    var emojiSpan = el("span", { class: "tab-emoji" }, icon);
    var btn = el("button", { class: "cvt-tab" + (id === "civitai" ? " active" : ""), dataset: { tab: id } },
      emojiSpan, " ", label);
    // Only the active tab animates (UX guideline: avoid excessive motion)
    if (id === "civitai") emojiSpan.classList.add(anim);
    btn._anim = anim; btn._emoji = emojiSpan;
    btn.onclick = function() { _switchTab(id, tabBar, panes); };
    tabBar.appendChild(btn);
    var pane = el("div", { class: "cvt-pane" + (id === "civitai" ? " active" : ""), id: "cvt-pane-" + id });
    panes[id] = pane;
    root.appendChild(pane);
  });
  root.insertBefore(tabBar, root.firstChild);
  // Re-blur everything already on screen (cards, gallery, lightbox) when the
  // blur setting changes. We deliberately do NOT re-render the tab: that would
  // rebuild the Settings form you are editing and drop the current results.
  window.__cvtReapplyBlur = function() {
    reapplyBlur(document);
  };
  renderBrowse(panes.civitai); panes.civitai._rendered = true;
  // Theme toggle button
  var themeBtn = el("button", { class: "cvt-theme-toggle", title: "Toggle light/dark theme" }, "\u2600\uFE0F");
  themeBtn.onclick = function() {
    root.classList.toggle("light");
    var isLight = root.classList.contains("light");
    themeBtn.textContent = isLight ? "\uD83C\uDF19" : "\u2600\uFE0F";
    _api("/civitai/settings", { method:"POST", body:JSON.stringify({ theme: isLight ? "light" : "dark" }) }).catch(function(){});
  };
  root.appendChild(themeBtn);

  // Keyboard shortcuts
  root.setAttribute("tabindex", "0");
  root.addEventListener("keydown", function(e) {
    var tag = (e.target.tagName || "").toLowerCase();
    var isInput = tag === "input" || tag === "textarea" || tag === "select";
    // "/" to focus search (always)
    if (e.key === "/" && !isInput) {
      e.preventDefault();
      var activePane = root.querySelector(".cvt-pane.active");
      if (activePane) {
        var search = activePane.querySelector("#cvt-q, #cvt-hf-q") || activePane.querySelector("input[type='text']");
        if (search) search.focus();
      }
      return;
    }
    // "?" to show shortcuts help
    if (e.key === "?" && !isInput) { e.preventDefault(); _showKBHelp(); return; }
    // Number keys 1-5 for tabs
    if (!isInput && e.key >= "1" && e.key <= "5") {
      var idx = parseInt(e.key, 10) - 1;
      var tabs = tabBar.querySelectorAll(".cvt-tab");
      if (tabs[idx]) { e.preventDefault(); tabs[idx].click(); }
      return;
    }
    // Alt+C for compact toggle
    if (e.code === "KeyC" && !isInput && e.altKey) {
      e.preventDefault();
      root.classList.toggle("compact");
      var isCompact = root.classList.contains("compact");
      _api("/civitai/settings", { method:"POST", body:JSON.stringify({ compact_grid: isCompact }) }).catch(function(){});
      _toast(isCompact ? "Compact grid on" : "Normal grid", "ok");
      return;
    }
  });

  // Card keyboard navigation (delegate)
  var _NAV_KEYS = ["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"];
  root.addEventListener("keydown", function(e) {
    var card = e.target.closest ? e.target.closest(".cvt-card") : null;
    if (!card) {
      // No card focused yet: an arrow key focuses the first card in the active grid,
      // unless the user is typing in a form field.
      if (_NAV_KEYS.indexOf(e.key) < 0) return;
      var tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      var activePane = root.querySelector(".cvt-pane.active");
      var firstGrid = activePane && activePane.querySelector(".cvt-grid");
      var firstCard = firstGrid && firstGrid.querySelector(".cvt-card");
      if (firstCard) { e.preventDefault(); firstCard.setAttribute("tabindex", "0"); firstCard.focus(); }
      return;
    }
    var grid = card.parentElement;
    if (!grid || !grid.classList.contains("cvt-grid")) return;
    var cards = Array.from(grid.querySelectorAll(".cvt-card"));
    var idx = cards.indexOf(card);
    var cols = Math.round(grid.offsetWidth / (card.offsetWidth + 10));
    var next = -1;
    if (e.key === "ArrowRight") next = idx + 1;
    else if (e.key === "ArrowLeft") next = idx - 1;
    else if (e.key === "ArrowDown") next = idx + cols;
    else if (e.key === "ArrowUp") next = idx - cols;
    else if (e.key === "Enter") { e.preventDefault(); card.click(); return; }
    if (next >= 0 && next < cards.length && cards[next]) {
      e.preventDefault();
      cards[next].focus();
    }
  });

  // Make cards focusable (MutationObserver — modern API)
  var _cardObserver = new MutationObserver(function(muts) {
    muts.forEach(function(m) {
      m.addedNodes.forEach(function(n) {
        if (n.nodeType === 1 && n.classList && n.classList.contains("cvt-card")) {
          n.setAttribute("tabindex", "0");
        }
      });
    });
  });
  _cardObserver.observe(root, { childList: true, subtree: true });

  // Keyboard shortcuts help overlay
  function _showKBHelp() {
    var overlay = el("div", { class: "cvt-kb-overlay" });
    var panel = el("div", { class: "cvt-kb-panel" });
    panel.appendChild(el("h3", {}, "\u2328\uFE0F Keyboard Shortcuts"));
    var shortcuts = [
      [["/"], "Focus search bar"],
      [["\u2190","\u2191","\u2192","\u2193"], "Navigate cards"],
      [["Enter"], "Open model detail"],
      [["Esc"], "Close modal / lightbox"],
      [["1","2","3","4","5"], "Switch tabs"],
      [["Alt","C"], "Toggle compact grid"],
      [["?"], "Show this help"],
    ];
    shortcuts.forEach(function(s) {
      var row = el("div", { class: "cvt-kb-row" });
      var keys = el("div", { class: "cvt-kb-keys" });
      s[0].forEach(function(k) { keys.appendChild(el("span", { class: "cvt-kb-key" }, k)); });
      row.appendChild(keys);
      row.appendChild(el("span", { class: "cvt-kb-desc" }, s[1]));
      panel.appendChild(row);
    });
    panel.appendChild(el("div", { style: { marginTop:"12px", fontSize:"10px", color:"var(--civ-text-mute)", textAlign:"center" } }, "Click anywhere or press Esc to close"));
    overlay.appendChild(panel);
    overlay.onclick = function() { overlay.remove(); };
    document.body.appendChild(overlay);
  }

  // Load saved settings
  _api("/civitai/settings").then(function(cfg) {
    if (cfg.theme === "light") { root.classList.add("light"); themeBtn.textContent = "\uD83C\uDF19"; }
    if (cfg.compact_grid) root.classList.add("compact");
    S.settings.saveMeta = cfg.save_metadata !== false;
    S.settings.savePrev = cfg.save_preview !== false;
    S.settings.verifySha = cfg.verify_sha256 !== false;
    S.settings.nsfwBlur = cfg.nsfw_blur !== false;
    window.__nsfwBlurEnabled = S.settings.nsfwBlur;
  }).catch(function(){});

  return root;
}

function renderBookmarks(pane) {
  pane.innerHTML = "";
  pane.appendChild(el("h2", { style: { fontSize:"14px", marginBottom:"6px" } }, "\u2B50 Bookmarks"));
  var listEl = el("div");
  pane.appendChild(listEl);
  _api("/civitai/bookmarks").then(function(d) {
    var items = d.items || d || [];
    if (!items.length) {
      listEl.appendChild(el("div", { class: "cvt-empty" }, "No bookmarks yet. Click \u2605 on any model card to save it here."));
      return;
    }
    items.forEach(function(b) {
      var row = el("div", { class: "cvt-row", style: { padding:"6px 0", borderBottom:"1px solid var(--civ-line)", display:"flex", alignItems:"center", gap:"8px" } });
      var info = el("div", { style: { flex:"1" } });
      info.appendChild(el("div", { style: { fontWeight:600, fontSize:"12px" } }, b.name || "Bookmark"));
      info.appendChild(el("div", { style: { fontSize:"10px", color:"var(--civ-text-dim)" } },
        (b.source || "") + (b.type ? " \u00B7 " + b.type : "") + (b.filename ? " \u00B7 " + b.filename : "")));
      row.appendChild(info);
      var btnRow = el("div", { style: { display:"flex", gap:"6px" } });
      var dlBtn = el("button", { class: "cvt-btn cvt-btn-xs" }, "\u2B07 Download");
      dlBtn.onclick = function() {
        var body = {
          model_version_id: b.model_version_id || b.id,
          save_as: (b.type === "Checkpoint" ? "checkpoints" : (b.type === "LORA" || b.type === "LoCon" ? "loras" : b.type === "VAE" ? "vae" : b.type === "Controlnet" ? "controlnet" : b.type === "TextualInversion" ? "embeddings" : b.type === "Hypernetwork" ? "hypernetworks" : b.type === "Upscaler" ? "upscale_models" : "other")),
          filename: b.filename || b.name || "model.safetensors",
          subfolder: b.subfolder || "",
          overwrite: false,
          save_metadata: true, save_preview: true
        };
        _api("/civitai/download", { method:"POST", body: JSON.stringify(body) }).then(function() {
          _toast("Queued: " + (b.filename || b.name || ""), "ok");
        }).catch(function(e) { _toast("Download error: " + e.message, "error"); });
      };
      var delBtn = el("button", { class: "cvt-btn ghost cvt-btn-xs" }, "\u2715");
      delBtn.onclick = function() {
        _api("/civitai/bookmarks-delete", { method:"POST", body: JSON.stringify({ id: b.model_version_id || b.id }) }).then(function() {
          renderBookmarks(pane);
          _toast("Bookmark removed", "ok");
        }).catch(function(e) { _toast("Delete error: " + e.message, "error"); });
      };
      btnRow.appendChild(dlBtn); btnRow.appendChild(delBtn);
      row.appendChild(btnRow);
      listEl.appendChild(row);
    });
  }).catch(function(e) {
    listEl.innerHTML = '<div class="cvt-empty">Failed to load bookmarks: ' + e.message + '</div>';
  });
}

function _switchTab(id, tabBar, panes) {
  S.curTab = id;
  tabBar.querySelectorAll(".cvt-tab").forEach(function(b) {
    var isActive = b.dataset.tab === id;
    b.classList.toggle("active", isActive);
    var anim = b._anim;
    if (b._emoji && anim) {
      b._emoji.classList.toggle(anim, isActive);
    }
  });
  Object.keys(panes).forEach(function(k) { panes[k].classList.toggle("active", k === id); });
  var pane = panes[id];
  if (!pane) return;
  if (!pane._rendered) {
    pane._rendered = true;
    if (id === "civitai") renderBrowse(pane);
    else if (id === "hf") renderHF(pane);
    else if (id === "downloads") renderDownloads(pane);
    else if (id === "local") renderLocal(pane);
    else if (id === "bookmarks") renderBookmarks(pane);
    else if (id === "settings") renderSettings(pane);
  } else if (id === "downloads") {
    // Always refresh (and restart auto-refresh) when re-opening Downloads
    _pollDl();
  } else if (id === "bookmarks") {
    renderBookmarks(pane);
  }
}

function closeLightbox() { if (S._closeLB) { S._closeLB(); S._closeLB = null; } else if (S.lightbox) { S.lightbox.remove(); S.lightbox = null; } }
function closeModal() { if (S.modal) { S.modal.remove(); S.modal = null; } }
document.addEventListener("keydown", function(e) { if (e.key === "Escape") { closeModal(); closeLightbox(); var kbOv = document.querySelector(".cvt-kb-overlay"); if (kbOv) kbOv.remove(); } });

// ── 1. BROWSE ────────────────────────────────────────────────────────
function renderBrowse(pane) {
  pane.innerHTML = "";   // idempotent — a re-render must never stack a second copy
  var sb = el("div", { class: "cvt-searchbar" });

  // ---- Manual entry row (lookup by ID / URL / hash) ----
  var lookupIn = el("input", { type: "text", placeholder: "URL / ID / SHA256 / AIR\u2026", style: { flex:"1", fontFamily:"monospace", fontSize:"11px", background:"#1c1410", borderColor:"#5a3a2a" } });
  var lookupBtn = el("button", { class: "cvt-btn", style: { flex:"0 0 auto" } }, "\uD83C\uDFAF");
  var lookupRow = el("div", { class: "cvt-row", style: { marginBottom:"6px" } });
  lookupRow.appendChild(lookupIn); lookupRow.appendChild(lookupBtn);
  sb.appendChild(lookupRow);

  lookupBtn.onclick = function() { _lookupCivitai(lookupIn.value, lookupIn); };
  lookupIn.onkeydown = function(e) { if (e.key === "Enter") lookupBtn.click(); };

  // ---- Search row 1 ----
  var row1 = el("div", { class: "cvt-row" });
  var qIn = el("input", { type: "text", placeholder: "Search Civitai\u2026", id: "cvt-q", style: { flex:1 } });
  var sortSel = el("select", { id: "cvt-sort", class: "cvt-select-sm", title: "Sort by" });
  CIVITAI_SORTS.forEach(function(s) { sortSel.appendChild(el("option", { value: s }, s)); });
  row1.appendChild(qIn); row1.appendChild(sortSel); sb.appendChild(row1);

  // ---- Search row 2 (free-typeable datalist) ----
  var row2 = el("div", { class: "cvt-row", style: { flexWrap:"wrap", gap:"4px", alignItems:"center" } });
  var typeSel = el("select", { id: "cvt-type", class: "cvt-select-sm", title: "Type" });
  CIVITAI_TYPES.forEach(function(t) { typeSel.appendChild(el("option", { value: t }, t || "All types")); });
  var periodSel = el("select", { id: "cvt-period", class: "cvt-select-sm", title: "Period" });
  CIVITAI_PERIODS.forEach(function(p) { periodSel.appendChild(el("option", { value: p }, p)); });
  var baseListId = "cvt-base-list-" + Math.random().toString(36).slice(2, 8);
  var baseIn = el("input", { type: "text", list: baseListId, placeholder: "Base model\u2026", autocomplete: "off", style: { flex:"0 0 auto", maxWidth:"120px" } });
  var baseDl = el("datalist", { id: baseListId });
  CIVITAI_BASE_MODELS.forEach(function(b) { if (b) baseDl.appendChild(el("option", { value: b })); });
  baseIn.onkeydown = function(e) { if (e.key === "Enter") { _resetAndSearch(); } };
  var goBtn = el("button", { class: "cvt-btn", style: { flex:"0 0 auto" } }, el("span", { class: "emoji-btn emoji-float" }, "\uD83D\uDD0D"), " Search");
  row2.appendChild(typeSel); row2.appendChild(periodSel); row2.appendChild(baseIn); row2.appendChild(goBtn);
  sb.appendChild(row2);
  sb.appendChild(baseDl);
  // ---- Content band row (PG · PG-13 · R · X · XXX) ----
  var _bandTimer = null;
  var ratingRow = buildBandCheckboxes(S.civitai.nsfw || "", function() {
    S.civitai.nsfw = ratingRow._getVal();
    // re-run the search shortly after the last tick (debounced)
    if (_bandTimer) clearTimeout(_bandTimer);
    _bandTimer = setTimeout(function() { _resetAndSearch(); }, 350);
  });
  sb.appendChild(el("div", { class: "cvt-row", style: { marginTop:"4px" } },
    el("span", { style: { fontSize:"10px", color:"var(--civ-text-mute)", marginRight:"2px" } }, "Bands:"),
    ratingRow));
  pane.appendChild(sb);

  var grid = el("div", { class: "cvt-grid", id: "cvt-grid" });
  var empty = el("div", { class: "cvt-empty" }, "\u2728  Type a query and hit Search, or just press Search for the top models.");
  pane.appendChild(grid);
  pane.appendChild(empty);
  var pager = el("div", { class: "cvt-pager" });
  var prevBtn = el("button", { class: "cvt-btn ghost", disabled: true }, "\u2190 Prev");
  var pageInfo = el("span", { class: "page-info" }, "Page 1");
  var nextBtn = el("button", { class: "cvt-btn ghost" }, "Next \u2192");
  pager.appendChild(prevBtn); pager.appendChild(pageInfo); pager.appendChild(nextBtn);
  pane.appendChild(pager);

  function _resetAndSearch() {
    S.civitai.cursor = "";
    S.civitai.cursorStack = [];
    S.civitai.nextCursor = null;
    _cache.clear();
    _runSearch();
  }

  function _lastParams() {
    var params = new URLSearchParams({
      sort: S.civitai.sort, period: S.civitai.period,
      types: S.civitai.type, limit: String(S.civitai.limit),
    });
    // Ask Civitai for NSFW results only when a mature band is ticked
    if (needsNsfwQuery(parseBandSelection(S.civitai.nsfw))) params.set("nsfw", "true");
    if (S.civitai.query) params.set("query", S.civitai.query);
    if (S.civitai.cursor) params.set("cursor", S.civitai.cursor);
    if (S.civitai.baseModel) params.set("baseModels", S.civitai.baseModel);
    return params;
  }

  function _runSearch(attempt) {
    attempt = attempt || 1;
    if (S.civitai.loading) return;
    S.civitai.loading = true;
    _renderSkeletons(grid, S.civitai.limit);
    empty.style.display = "none";
    S.civitai.query = qIn.value;
    S.civitai.sort = sortSel.value;
    S.civitai.nsfw = ratingRow._getVal();
    S.civitai.type = typeSel.value;
    S.civitai.period = periodSel.value;
    S.civitai.baseModel = (baseIn.value || "").trim();
    if (S.civitai.sort === "Relevancy" && !S.civitai.query) {
      S.civitai.sort = "Highest Rated"; sortSel.value = "Highest Rated";
      _flashHint(sb, "\u26A0\uFE0F Relevancy requires a search query \u2014 switched to Highest Rated.");
    }
    var params = _lastParams();
    _api("/civitai/search?" + params.toString()).then(function(d) {
      S.civitai.items = d.items || [];
      // Client-side content-band filter: keep models whose overall tier
      // (model level, or the highest tier among its preview images) is ticked.
      var bandSel = parseBandSelection(S.civitai.nsfw);
      if (bandSel.length) {
        S.civitai.items = filterByBands(S.civitai.items, bandSel, false);
      }
      grid.innerHTML = "";
      if (!S.civitai.items.length) {
        empty.style.display = "block";
        empty.innerHTML = "\uD83D\uDD0E  No models match. Try a different query.";
        pager.innerHTML = "";
        return;
      }
      var frag = document.createDocumentFragment();
      S.civitai.items.forEach(function(m) { frag.appendChild(_card(m)); });
      grid.appendChild(frag);

      S.civitai.nextCursor = d && d.metadata && d.metadata.nextCursor ? d.metadata.nextCursor : null;
      var pageNum = S.civitai.cursorStack.length + 1;
      pageInfo.textContent = "Page " + pageNum;
      prevBtn.disabled = !S.civitai.cursorStack.length;
      nextBtn.disabled = !S.civitai.nextCursor;
    }).catch(function(e) {
      _showSearchError(e, attempt, sb, grid, empty, pager);
    }).then(function() { S.civitai.loading = false; });
  }

  function _showSearchError(e, attempt, sb, grid, empty, pager) {
    grid.innerHTML = "";
    pager.innerHTML = "";
    var isTransient = !!e.transient;
    var code = e.status || 0;
    var heading = isTransient
      ? (code === 429 ? "You\u2019re being rate-limited" : "Civitai is busy right now")
      : (code === 401 ? "Unauthorized" : code === 404 ? "Not found" : "Search failed");

    var box = el("div", { style: { background:"linear-gradient(135deg,rgba(244,114,182,.08),rgba(96,165,250,.08))", border:"1px solid var(--civ-line-strong)", borderRadius:"var(--civ-radius)", padding:"14px 16px", color:"var(--civ-text)" } });
    box.appendChild(el("div", { style: { fontWeight:700, marginBottom:"6px", background:"var(--civ-grad-primary)", WebkitBackgroundClip:"text", backgroundClip:"text", color:"transparent" } }, heading));
    if (e.message) box.appendChild(el("div", { style: { fontSize:"12px", marginBottom:"10px", color:"var(--civ-text-dim)" } }, e.message));

    var retryBtn = el("button", { class: "cvt-btn" }, "\u21BB Retry now");
    retryBtn.onclick = function() { _runSearch(1); };
    box.appendChild(retryBtn);

    if (isTransient && attempt <= 5) {
      var baseDelay = Math.min(30, 3 * Math.pow(2, attempt - 1));
      var remaining = baseDelay;
      var note = el("span", { style: { marginLeft:"10px", fontSize:"11px", color:"#bba" } }, "Auto-retry in " + remaining + "s");
      box.appendChild(note);
      var retryTimer = setInterval(function() {
        remaining -= 1;
        if (remaining <= 0) {
          clearInterval(retryTimer);
          _runSearch(attempt + 1);
        } else {
          note.textContent = "Auto-retry in " + remaining + "s";
        }
      }, 1000);
    }

    empty.style.display = "block";
    empty.innerHTML = "";
    empty.appendChild(box);
  }

  goBtn.onclick = function() { _resetAndSearch(); };
  qIn.onkeydown = function(e) { if (e.key === "Enter") { _resetAndSearch(); } };
  prevBtn.onclick = function() {
    if (S.civitai.cursorStack.length) {
      S.civitai.cursor = S.civitai.cursorStack.pop() || "";
      _runSearch();
    }
  };
  nextBtn.onclick = function() {
    if (S.civitai.nextCursor) {
      if (S.civitai.cursorStack.length > 50) S.civitai.cursorStack.shift();
      S.civitai.cursorStack.push(S.civitai.cursor);
      S.civitai.cursor = S.civitai.nextCursor;
      _runSearch();
    }
  };
}

function _lookupCivitai(raw, fieldEl) {
  var v = (raw || "").trim();
  if (!v) { _toast("Paste a model URL, ID, version ID, or SHA-256 hash.", "error"); return; }
  var params = new URLSearchParams();
  if (/^[A-Fa-f0-9]{64}$/.test(v)) {
    params.set("hash", v);
  } else if (/^[A-Fa-f0-9]{10,12}$/.test(v) && /[A-Fa-f]/.test(v)) {
    params.set("hash", v);
  } else if (/^\d+$/.test(v)) {
    params.set("version_id", v);
  } else {
    params.set("model", v);
  }
  if (fieldEl) fieldEl.disabled = true;
  _api("/civitai/lookup?" + params.toString()).then(function(r) {
    if (r.kind === "model") {
      openDetail(r.data);
    } else if (r.kind === "version") {
      var d = r.data;
      var m = d.model || {};
      openDetail({
        id: d.modelId || m.id || 0,
        name: m.name || d.name || "(version " + d.id + ")",
        type: m.type || d.type || "?",
        description: m.description || d.description || "",
        creator: m.creator || {},
        stats: m.stats || {},
        modelVersions: [d],
      });
    } else {
      _toast("Lookup returned unexpected result", "error");
    }
  }).catch(function(e) {
    if (params.get("version_id")) {
      var p2 = new URLSearchParams({ model_id: params.get("version_id") });
      _api("/civitai/lookup?" + p2.toString()).then(function(r) {
        if (r.kind === "model") openDetail(r.data);
        else _toast("Lookup failed", "error");
      }).catch(function(e2) { _toast("Not found: " + e2.message, "error"); });
    } else {
      _toast("Not found: " + e.message, "error");
    }
  }).then(function() { if (fieldEl) fieldEl.disabled = false; });
}

function _card(m) {
  var imgs = m.images || (m.modelVersions && m.modelVersions[0] && m.modelVersions[0].images) || [];
  var firstImg = imgs[0];
  // Categorise: the model takes the highest tier of itself + its previews,
  // the thumbnail is blurred only when THAT image is X / XXX.
  var modelBand = bandIdOfModel(m);
  var thumbBand = bandIdOfImage(firstImg, m);
  var imgUrl = firstImg ? (typeof firstImg === "string" ? firstImg : firstImg.url || "") : "";
  var card = el("div", { class: "cvt-card", style: { position:"relative" } });
  // Bookmark button (top-right of card)
  var bookmarkBtn = el("button", { class: "cvt-bookmark-btn", title: "Bookmark this model", style: { position:"absolute", top:"4px", right:"4px", zIndex:2, background:"rgba(0,0,0,.5)", border:"none", borderRadius:"50%", width:"28px", height:"28px", color:"#ff8c42", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", lineHeight:1 } }, el("img", { src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAACXBIWXMAAAsTAAALEwEAmpwYAAABpUlEQVR4nO2ZvUoDQRSFv2ASBQmCjYUPIIiFYAKiYmmbN7DxAXwFX0GxshTUNIqIYGdnaSGijdj405kuKmKSkZUJjIOZrLszGyT3gwv7c+ecOcvMFrsgCMJAsgTUgGegCaiE1QSegANgMYuJ54HtFBPuVVvaIxghJ6+MEMGWjWl0DMwBxRSaRaAMnBi6bWCBANQMk8jQN0eG/l4A/e8N2zGInrxvyob+YwD9H2+bNMumG0Xr7eQdc/2HQoX0kAAxUBLAgQSIgZIADiRADJQEcCABYqAkgAMJEAMlARxIgBgoCeBRfAW40RUd/5sABWADaFnfejaBYU8eiYgjPgVcWr1mXQMzKT0S00t8DWhYfae6zGsN3ZvEIxXdxMeAfev+O7AO5HTPKvBq9RwC4/0OMA/cW/dugdlfxk8DV1bvA7DcjwB5vVHtfwO7wKhDY0Rv5rYxpqWvFbIMcGGdvwDVP2hV9Rjl0AwawKxzYDKB3gRw5tD1jm3wqZfRUArNnN7sH1kEeDPE74CKR+2K1uzoR17eiZ52HdgBSgH0S1q7rr0EQRgEvgCZsWa8d9MqpQAAAABJRU5ErkJggg==", style: { width:"16px", height:"16px", display:"block" } }));
  bookmarkBtn.onclick = function(e) {
    e.stopPropagation();
    var payload = {
      name: m.name || "", model_version_id: (m.modelVersions && m.modelVersions[0] && m.modelVersions[0].id) || m.id || 0,
      model_id: m.id || 0, filename: (m.modelVersions && m.modelVersions[0] && m.modelVersions[0].files && m.modelVersions[0].files[0] && m.modelVersions[0].files[0].name) || (m.name || "").replace(/[^a-zA-Z0-9_-]/g,"_") + ".safetensors",
      source: "civitai", type: m.type || ""
    };
    _api("/civitai/bookmarks", { method:"POST", body:JSON.stringify(payload) }).then(function(r) {
      if (r.success) _toast("Bookmarked: " + (m.name || ""), "ok");
      else _toast((r.message || "Already bookmarked"), "ok");
    }).catch(function(err) { _toast("Bookmark failed: " + err.message, "error"); });
  };
  card.appendChild(bookmarkBtn);
  // Content-band badge (PG / PG-13 / R / X / XXX) with the official band colour
  card.appendChild(makeBandBadge(modelBand));
  var thumb = el("div", { class: "thumb", style: { aspectRatio: "3/4", background: "linear-gradient(135deg,#1a1a1a,#0f0f0f)" } });
  if (imgUrl) {
    var img = el("img", { src: _thumbUrl(imgUrl, 400), style: { width:"100%", height:"100%", objectFit:"cover", display:"block" }, onerror: function() { this.outerHTML = '<div style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:24px;opacity:.3">\uD83D\uDDBC</div>'; } });
    thumb.appendChild(img);
  }
  applyBlur(thumb, thumbBand);
  card.appendChild(thumb);
  card.appendChild(el("div", { class: "body" },
    el("div", { class: "title" }, m.name || "Untitled"),
    el("div", { class: "meta" },
      el("span", {}, (m.creator && m.creator.username) || "?"),
      el("span", {}, m.type || "?"),
      makeBandBadge(modelBand))));
  card.onclick = function() { openDetail(m); };
  return card;
}

// ── Detail Modal ────────────────────────────────────────────────────
var _curDetailId = 0;
function openDetail(model) {
  closeModal();
  var mid = ++_curDetailId;
  var bg = el("div", { class: "cvt-modal-bg" });
  var wrap = el("div", { class: "cvt-modal-wrap" });
  var closeBtn = el("button", { class: "close" }, "\u00D7");
  var modal = el("div", { class: "cvt-modal" });
  wrap.appendChild(closeBtn); wrap.appendChild(modal); bg.appendChild(wrap);
  S.modal = bg; document.body.appendChild(bg);

  var closer = function() { if (_curDetailId === mid) closeModal(); };
  closeBtn.onclick = closer;
  bg.onclick = function(e) { if (e.target === bg) closer(); };

  var left = el("div", { class: "left" });
  var right = el("div", { class: "right" });
  modal.appendChild(left); modal.appendChild(right);

  left.appendChild(el("h2", {}, model.name || ""));
  left.appendChild(el("div", { class: "sub" }, "by " + (model.creator ? model.creator.username || "?" : "?") + " \u00B7 " + (model.type || "")));
  var gallery = el("div", { class: "gallery" });
  gallery.innerHTML = '<div class="cvt-spinner"></div>';
  left.appendChild(gallery);
  right.innerHTML = '<div class="cvt-spinner"></div>';

  // Fetch full model data if incomplete
  var versions = model.modelVersions || [];
  var hasFull = versions.length && versions[0].images && versions[0].files;
  if (!hasFull && model.id) {
    _api("/civitai/model/" + model.id).then(function(data) {
      if (_curDetailId !== mid) return;
      model.description = model.description || data.description;
      model.creator = model.creator || data.creator;
      model.stats = model.stats || data.stats;
      versions = data.modelVersions || [];
      _buildDetailModal(right, gallery, model, versions, mid);
    }).catch(function(e) {
      right.innerHTML = '<div class="cvt-empty">Error: ' + e.message + '</div>';
    });
  } else {
    _buildDetailModal(right, gallery, model, versions, mid);
  }
}

function _buildDetailModal(right, gallery, model, versions, mid) {
  right.innerHTML = "";
  if (!versions.length) { right.innerHTML = '<div class="cvt-empty">No versions</div>'; return; }
  var curVersion = versions[0];

  // ---- Stats (likes + downloads) above version ----
  if (model.stats) {
    var statsRow = el("div", { style: { display:"flex", gap:"10px", fontSize:"11px", color:"var(--civ-text-dim)", marginBottom:"6px" } });
    if (model.stats.thumbsUpCount != null) statsRow.appendChild(el("span", {}, "\u2764 " + _fmtNum(model.stats.thumbsUpCount)));
    if (model.stats.downloadCount != null) statsRow.appendChild(el("span", {}, "\u2B07 " + _fmtNum(model.stats.downloadCount)));
    if (statsRow.children.length) right.appendChild(statsRow);
  }

  // ---- Version selector ----
  var vSel = el("select");
  versions.forEach(function(v) { vSel.appendChild(el("option", { value: v.id }, v.name || "#" + v.id)); });
  right.appendChild(el("label", {}, "Version"));
  right.appendChild(vSel);

  // ---- File selector ----
  right.appendChild(el("label", {}, "File"));
  var fSel = el("select", { size: "1" });
  right.appendChild(fSel);

  // ---- Folder selector ----
  right.appendChild(el("label", {}, "Folder"));
  var folderSel = el("select");
  folderSel.appendChild(el("option", { value: "auto" }, "Auto \u2192 " + _guessFolder(model.type)));
  _api("/civitai/folders").then(function(r) {
    (r.folders || []).forEach(function(f) { folderSel.appendChild(el("option", { value: f }, f)); });
  }).catch(function() {});
  right.appendChild(folderSel);

  // ---- Subfolder + auto checkbox ----
  right.appendChild(el("label", {}, "Subfolder"));
  var subIn = el("input", { type: "text", placeholder: "subfolder\u2026" });
  var autoModelName = _sanitizeModelName(model.name || "", 50);
  var autoCb = el("input", { type: "checkbox", checked: true });
  subIn.value = autoModelName;
  subIn.style.opacity = "0.5";
  autoCb.onchange = function() {
    if (autoCb.checked) { subIn.value = autoModelName; subIn.style.opacity = "0.5"; subIn.readOnly = true; }
    else { subIn.value = ""; subIn.style.opacity = "1"; subIn.readOnly = false; subIn.focus(); }
  };
  var subRow = el("div", { class: "cvt-row", style: { alignItems:"center" } });
  subRow.appendChild(subIn);
  subRow.appendChild(el("label", { style: { display:"inline-flex", alignItems:"center", gap:"2px", fontSize:"9px", color:"var(--civ-text-mute)", flexShrink:0 } }, autoCb, " Auto"));
  right.appendChild(subRow);

  // ---- Checkboxes row ----
  var checksRow = el("div", { style: { display:"flex", gap:"6px", flexWrap:"wrap", marginTop:"4px", fontSize:"9.5px" } });
  var overwriteLbl = el("label", { class: "check", style: { gap:"2px", margin:0 } }, el("input", { type: "checkbox" }), " Re-download");
  var fnameLbl = el("label", { style: { gap:"2px", margin:0, fontSize:"9.5px", display:"flex", alignItems:"center" } }, "Rename:",
    el("input", { type: "text", placeholder: "custom name", style: { width:"90px", marginLeft:"3px", fontSize:"9px", padding:"1px 3px" } }));
  var metaCb = el("input", { type: "checkbox" });
  var prevCb = el("input", { type: "checkbox" });
  metaCb.checked = S.settings.saveMeta;
  prevCb.checked = S.settings.savePrev;
  var metaLbl = el("label", { class: "check", style: { gap:"2px", margin:0 } }, metaCb, " Metadata");
  var prevLbl = el("label", { class: "check", style: { gap:"2px", margin:0 } }, prevCb, " Preview");
  checksRow.appendChild(overwriteLbl); checksRow.appendChild(fnameLbl); checksRow.appendChild(metaLbl); checksRow.appendChild(prevLbl);
  right.appendChild(checksRow);

  // ---- Buttons row ----
  var btnRow = el("div", { style: { display:"flex", gap:"4px", marginTop:"4px" } });
    var dlBtn = el("button", { class: "cvt-btn cvt-btn-xs", style: { flex:"1" } },
    el("span", { class: "emoji-btn" }, "\u2B07"), " Download");
  var metaOnlyBtn = el("button", { class: "cvt-btn ghost cvt-btn-xs", style: { flex:"1" } },
    el("span", { class: "emoji-btn" }, "\uD83D\uDCC4"), " Metadata");
  btnRow.appendChild(dlBtn); btnRow.appendChild(metaOnlyBtn);
  right.appendChild(btnRow);

  var statusLine = el("div", { style: { fontSize:"9.5px", color:"var(--civ-text-dim)", marginTop:"3px" } });
  right.appendChild(statusLine);

  // ---- Files list ----
  right.appendChild(el("label", { style: { marginTop:"6px" } }, "Files"));
  var filesList = el("div", { class: "cvt-files-list" });
  right.appendChild(filesList);

  // ---- Description pane (collapsible) ----
  var desc = el("div", { class: "cvt-desc" });
  var descText = model.description || "";
    desc.innerHTML = descText ? _sanitizeHTML(descText) : "<i>(no description)</i>";
  right.appendChild(el("label", { style: { marginTop:"6px" } }, "About"));
  right.appendChild(desc);

  function _renderVersion(v) {
    curVersion = v;
    // Gallery
    gallery.innerHTML = "";
    var gFrag = document.createDocumentFragment();
    // Each showcase image is categorised on its own; images with no tier of
    // their own inherit the model's band (the compact API omits per-image levels).
    var gSel = parseBandSelection(S.civitai.nsfw);
    var imgs = (v.images || []).filter(function(im) {
      return bandMatchesSelection(bandIdOfImage(im, model), gSel);
    });
    imgs.forEach(function(im) {
      var imgBand = bandIdOfImage(im, model);
      var imgEl = el("img", {
        src: _thumbUrl(im.url, 500), loading: "lazy", decoding: "async",
        style: { cursor: "pointer" }
      });
      // blur ONLY the NSFW images (X / XXX by default) — hover reveals them
      applyBlur(imgEl, imgBand);
      imgEl.onclick = function(e) { e.stopPropagation(); openLightbox(im, model); };
      imgEl.title = imgBand + " — click to view full image + generation params";
      gFrag.appendChild(el("div", { class: "cvt-gal-item" }, imgEl, makeBandBadge(imgBand)));
    });
    gallery.appendChild(gFrag);

    // Enrich images with generation params (meta) — the compact /models response
    // omits meta, so pull it from the version-detail endpoint and match by URL.
    var needsMeta = (v.images || []).some(function(im) { return im && !im.meta; });
    if (needsMeta && v.id && !v._metaEnriched) {
      v._metaEnriched = true;
      _api("/civitai/model-version-detail?id=" + encodeURIComponent(v.id)).then(function(vd) {
        var metaByUrl = {};
        (vd && vd.images || []).forEach(function(vi) { if (vi && vi.url) metaByUrl[vi.url] = vi.meta || null; });
        (v.images || []).forEach(function(im) {
          if (im && !im.meta && metaByUrl[im.url]) im.meta = metaByUrl[im.url];
        });
      }).catch(function() { v._metaEnriched = false; });
    }

    // Files dropdown
    fSel.innerHTML = "";
    var vfiles = v.files || [];
    function _fillFilename() {
      var idx = parseInt(fSel.value || "0", 10);
      var f = vfiles[idx] || {};
      var fnameIn = fnameLbl.querySelector("input");
      if (fnameIn && !fnameIn.value.trim()) {
        fnameIn.value = f.name || "";
      }
    }
    vfiles.forEach(function(f, idx) {
      fSel.appendChild(el("option", { value: idx },
        (f.name || "") + " \u2014 " + (f.metadata && f.metadata.format || "?") + " " + (f.metadata && f.metadata.fp || "") + " " + (f.metadata && f.metadata.size || "") + " (" + _fmtBytes((f.sizeKB||0)*1024) + ")" + (f.primary ? " \u2605" : "")));
      if (f.primary) fSel.value = idx;
    });
    fSel.onchange = _fillFilename;
    _fillFilename();

    // Base model badge
    var baseModel = v.baseModel || model.baseModel || (v.metadata && v.metadata.baseModel) || "";

    // Files list with SHA256 + copy + base model
    filesList.innerHTML = "";
    vfiles.forEach(function(f) {
      var hashStr = (f.hashes && f.hashes.SHA256) || "";
      var hashShort = hashStr.slice(0, 8) || "\u2014";
      var fileRow = el("div", { class: "f" });
      fileRow.appendChild(el("span", {}, (f.name||"") + (f.primary ? " \u2605" : "")));
      var rightSpan = el("span", { style: { display:"inline-flex", alignItems:"center", gap:"4px" } });
      if (baseModel) rightSpan.appendChild(el("span", { class: "cvt-badge", style: { fontSize:"9px", padding:"1px 5px", textTransform:"none" } }, baseModel));
      rightSpan.appendChild(document.createTextNode(_fmtBytes((f.sizeKB||0)*1024)));
      rightSpan.appendChild(el("span", { style: { opacity:".4" } }, "|"));
      var hashEl = el("span", { style: { fontFamily:"monospace", fontSize:"9.5px", cursor:"pointer", borderBottom:"1px dotted rgba(255,255,255,.15)" }, title: "Click to copy SHA256" }, hashShort);
      hashEl.onclick = function(e) {
        e.stopPropagation();
        navigator.clipboard.writeText(hashStr).then(function() {
          _toast("SHA256 copied", "ok");
        }).catch(function() {});
      };
      rightSpan.appendChild(hashEl);
      fileRow.appendChild(rightSpan);
      filesList.appendChild(fileRow);
    });

    // Update subfolder auto-name from the file name (no extension)
    var primaryFile = vfiles.find(function(f) { return f.primary; }) || vfiles[0] || {};
    autoModelName = primaryFile.name ? _sanitizeModelName(primaryFile.name.replace(/\.[^.]+$/, ""), 80) : _sanitizeModelName(v.name || model.name || "", 50);
    if (autoCb.checked) { subIn.value = autoModelName; }
  }

  vSel.onchange = function() {
    var found = null;
    for (var i = 0; i < versions.length; i++) {
      if (String(versions[i].id) === vSel.value) { found = versions[i]; break; }
    }
    if (found) _renderVersion(found);
  };

  // ---- Submit download ----
  function _submitDownload(metadataOnly) {
    var btn = metadataOnly ? metaOnlyBtn : dlBtn;
    btn.disabled = true;
    statusLine.textContent = metadataOnly ? "Fetching metadata\u2026" : "Starting download\u2026";
    var fIdx = parseInt(fSel.value || "0", 10);
    var fls = curVersion.files || [];
    var file = fls[fIdx] || {};
    var body = {
      model_version_id: curVersion.id,
      save_as: folderSel.value === "auto" ? _guessFolder(model.type) : folderSel.value,
      filename: fnameLbl.querySelector("input").value.trim(),
      overwrite: overwriteLbl.querySelector("input").checked,
      format: file.metadata && file.metadata.format || null,
      fp: file.metadata && file.metadata.fp || null,
      size: file.metadata && file.metadata.size || null,
      save_metadata: metaCb.checked,
      save_preview: prevCb.checked,
      metadata_only: metadataOnly,
      subfolder: subIn.value.trim(),
    };
    _api("/civitai/download", { method:"POST", body:JSON.stringify(body) }).then(function(job) {
      statusLine.innerHTML = "";
      statusLine.appendChild(document.createTextNode((metadataOnly ? "Metadata job queued: " : "Queued: ")));
      statusLine.appendChild(el("b", {}, job.id));
      statusLine.appendChild(document.createTextNode(" \u2014 open "));
      var dlLink = el("a", { href: "#", style: { color:"var(--civ-accent-dim)", cursor:"pointer" } }, "Downloads");
      dlLink.onclick = function(e) { e.preventDefault(); if (S.root) S.root.dispatchEvent(new CustomEvent("civitai:show-tab", { detail: "downloads" })); };
      statusLine.appendChild(dlLink);
      statusLine.appendChild(document.createTextNode(" to monitor."));
      // Mini progress bar
      var miniBar = el("div", { style: { width:"100%", height:"3px", background:"rgba(255,255,255,.06)", borderRadius:"2px", marginTop:"4px", overflow:"hidden" } });
      var miniFill = el("div", { style: { width:"30%", height:"100%", background:"linear-gradient(90deg,rgba(255,255,255,.3),rgba(255,255,255,.6),rgba(255,255,255,.3))", backgroundSize:"200% 100%", borderRadius:"2px", animation:"cvt-bar 1.4s linear infinite" } });
      miniBar.appendChild(miniFill);
      statusLine.appendChild(miniBar);
      _toast(metadataOnly ? "Metadata queued" : "Queued: " + (job.filename || job.name || "download"), "ok");
      _ensureDlPolling();
    }).catch(function(e) {
      statusLine.innerHTML = "";
      statusLine.appendChild(el("span", { style: { color:"#fb8e8e" } }, "Error: " + e.message));
      _toast("Download error: " + e.message, "error");
    }).then(function() { btn.disabled = false; });
  }

  dlBtn.onclick = function() { _submitDownload(false); };
  metaOnlyBtn.onclick = function() {
    if (!metaCb.checked && !prevCb.checked) {
      statusLine.innerHTML = "";
      statusLine.appendChild(el("span", { style: { color:"#e88" } }, "Enable at least one of metadata sidecar / preview image."));
      return;
    }
    _submitDownload(true);
  };

  _renderVersion(curVersion);
}

// ── Local Model Detail Modal ────────────────────────────────────────
function openLocalDetail(m, grid, filterIn) {
  closeModal();
  var mid = ++_curDetailId;
  var bg = el("div", { class: "cvt-modal-bg" });
  var wrap = el("div", { class: "cvt-modal-wrap" });
  var closeBtn = el("button", { class: "close" }, "\u00D7");
  var modal = el("div", { class: "cvt-modal" });
  wrap.appendChild(closeBtn); wrap.appendChild(modal); bg.appendChild(wrap);
  S.modal = bg; document.body.appendChild(bg);

  var closer = function() { if (_curDetailId === mid) closeModal(); };
  closeBtn.onclick = closer;
  bg.onclick = function(e) { if (e.target === bg) closer(); };

  var left = el("div", { class: "left" });
  var right = el("div", { class: "right" });
  modal.appendChild(left); modal.appendChild(right);

  // Left: title + gallery (same layout as Browse modal)
  left.appendChild(el("h2", {}, m.name || ""));
  left.appendChild(el("div", { class: "sub" }, (m.type || "") + (m.base_model ? " \u00B7 " + m.base_model : "") + (m.size ? " \u00B7 " + m.size : "")));
  var gallery = el("div", { class: "gallery" });
  gallery.innerHTML = '<div class="cvt-spinner"></div>';
  left.appendChild(gallery);

  var localBand = bandIdOfModel(m);
  var isNsfw = isBlurred(localBand);


  // Fetch all previews from server
  if (m.path) {
    _api("/civitai/local-previews?path=" + encodeURIComponent(m.path)).then(function(r) {
      var imgs = r.images || [];
      if (!imgs.length && m.preview) {
        imgs = [{ url: "/civitai/local-preview?path=" + encodeURIComponent(m.preview) + "&w=300", prompt: "", negativePrompt: "" }];
      }
      gallery.innerHTML = "";
      if (!imgs.length) {
        gallery.innerHTML = '<div style="grid-column:1/-1" class="cvt-empty">No preview images</div>';
        return;
      }
      var gFrag = document.createDocumentFragment();
      imgs.forEach(function(im) {
        var imgSrc = (typeof im === "object") ? im.url : im;
        var prompt = (typeof im === "object") ? (im.prompt || "") : "";
        var negPrompt = (typeof im === "object") ? (im.negativePrompt || "") : "";
        var meta = (typeof im === "object") ? im : {};
        var imgEl = el("img", {
          src: imgSrc, loading: "lazy", decoding: "async",
          style: { cursor: "pointer" }
        });
        // blur only if this local model's band is at/above the threshold
        applyBlur(imgEl, localBand);
        imgEl.onclick = function(e) {
          e.stopPropagation();
          // Adapt local image format to lightbox format (expects img.meta.prompt etc.)
          var lightboxImg = {
            url: imgSrc,
            width: meta.width || 0,
            height: meta.height || 0,
            meta: {
              prompt: prompt || "",
              negativePrompt: negPrompt || "",
              seed: meta.seed,
              sampler: meta.sampler,
              steps: meta.steps,
              cfgScale: meta.cfgScale || meta.cfg_scale,
              Model: meta.model || meta.Model
            }
          };
          openLightbox(lightboxImg, m);
        };
        imgEl.title = "Click to view full image + generation params";
        gFrag.appendChild(imgEl);
      });
      gallery.appendChild(gFrag);
    }).catch(function() {
      gallery.innerHTML = '<div class="cvt-empty">Failed to load previews</div>';
    });
  } else if (m.preview) {
    gallery.innerHTML = "";
    var imgEl = el("img", {
      src: "/civitai/local-preview?path=" + encodeURIComponent(m.preview) + "&w=500",
      loading: "lazy"
    });
    applyBlur(imgEl, localBand);
    gallery.appendChild(imgEl);
  } else {
    gallery.innerHTML = '<div style="grid-column:1/-1" class="cvt-empty">No preview images</div>';
  }

  // Right: details
  var rightContent = el("div", { style: { display:"flex", flexDirection:"column", gap:"6px" } });
  right.appendChild(rightContent);

  // Basic info
  rightContent.appendChild(el("label", {}, "Details"));
  var infoList = el("div", { style: { fontSize:"11px", color:"var(--civ-text-dim)", lineHeight:"1.6" } });
  infoList.appendChild(el("div", {}, el("strong", { style: { color:"var(--civ-text-mute)" } }, "Type: "), m.type || "?"));
  infoList.appendChild(el("div", {}, el("strong", { style: { color:"var(--civ-text-mute)" } }, "Size: "), m.size || "?"));
  if (m.base_model) infoList.appendChild(el("div", {}, el("strong", { style: { color:"var(--civ-text-mute)" } }, "Base Model: "), m.base_model));
  infoList.appendChild(el("div", {}, el("strong", { style: { color:"var(--civ-text-mute)" } }, "Location: "), (m.folder || m.type || "?") + "/"));
  if (m.creator) infoList.appendChild(el("div", {}, el("strong", { style: { color:"var(--civ-text-mute)" } }, "Creator: "), m.creator));
  rightContent.appendChild(infoList);

  // Hash and Civitai lookup
  var civSection = el("div", { style: { marginTop:"6px" } });
  rightContent.appendChild(civSection);
  civSection.appendChild(el("label", {}, "Civitai Lookup"));
  var civStatus = el("div", { style: { fontSize:"10px", color:"var(--civ-text-dim)", padding:"6px 0" } }, "\u23F3 Looking up hash\u2026");
  civSection.appendChild(civStatus);

  // Direct link from metadata
  if (m.model_id) {
    var directLink = el("a", { href: "https://civitai.com/models/" + m.model_id, target: "_blank", style: { display:"inline-block", fontSize:"10px", color:"var(--civ-accent-dim)", marginBottom:"4px" } }, "\uD83C\uDF10 View on Civitai");
    civSection.insertBefore(directLink, civStatus);
  }

  if (m.hash) {
    _api("/civitai/lookup?hash=" + encodeURIComponent(m.hash)).then(function(r) {
      if (_curDetailId !== mid) return;
      if (r.kind === "version" && r.data) {
        var d = r.data;
        var modelData = d.model || {};
        var creator = modelData.creator || {};
        var creatorName = (typeof creator === "object") ? (creator.username || creator.name || "") : creator;
        civStatus.innerHTML = "";
        civStatus.appendChild(el("div", { style: { fontSize:"11px", lineHeight:"1.5" } },
          el("div", {}, el("strong", { style: { color:"var(--civ-text-mute)" } }, "Model: "), modelData.name || d.name || ""),
          el("div", {}, el("strong", { style: { color:"var(--civ-text-mute)" } }, "Creator: "), creatorName || "?"),
          el("div", {}, el("strong", { style: { color:"var(--civ-text-mute)" } }, "Type: "), modelData.type || d.type || "?"),
          el("div", {}, el("strong", { style: { color:"var(--civ-text-mute)" } }, "Base: "), d.baseModel || modelData.baseModel || "?"),
          el("div", {}, el("strong", { style: { color:"var(--civ-text-mute)" } }, "Version: "), d.name || "?")));
        var civBtn = el("button", { class: "cvt-btn ghost cvt-btn-xs", style: { marginTop:"6px" } }, "\uD83C\uDF10 View on Civitai");
        civBtn.onclick = function() { window.open("https://civitai.com/models/" + (modelData.id || ""), "_blank"); };
        civStatus.appendChild(civBtn);

        // Gallery of all Civitai images with prompts
        if (d.images && d.images.length) {
          var galLabel = el("label", { style: { marginTop:"8px", display:"block" } }, "Civitai Gallery");
          rightContent.appendChild(galLabel);
          var civGal = el("div", { style: { display:"flex", gap:"6px", overflowX:"auto", paddingBottom:"4px", maxWidth:"100%" } });
          d.images.forEach(function(im) {
            var imgSrc = (typeof im === "object") ? im.url : im;
            var cMeta = (typeof im === "object") ? (im.meta || {}) : {};
            var prompt = cMeta.prompt || "";
            var negPrompt = cMeta.negativePrompt || "";
            var cThumb = el("img", {
              src: _thumbUrl(imgSrc, 300), loading:"lazy",
              style: { height:"80px", borderRadius:"var(--civ-radius-sm)", cursor:"pointer", flexShrink:0, objectFit:"cover" },
              title: prompt ? prompt.slice(0, 120) : ""
            });
            cThumb.onclick = function(e) {
              e.stopPropagation();
              var lightboxImg = { url: imgSrc, meta: cMeta, width: im.width || 0, height: im.height || 0 };
              openLightbox(lightboxImg, { name: m.name, creator: { username: creatorName } });
            };
            civGal.appendChild(cThumb);
          });
          rightContent.appendChild(civGal);

          // Show model-level description if available
          var fullDesc = modelData.description || d.description || "";
          if (fullDesc && fullDesc !== m.description) {
            rightContent.appendChild(el("label", { style: { marginTop:"6px" } }, "About"));
            var descEl = el("div", { class: "cvt-desc" });
            descEl.innerHTML = _sanitizeHTML(fullDesc);
            rightContent.appendChild(descEl);
          }
        }
      } else {
        civStatus.textContent = "\u26A0 Not found on Civitai";
      }
    }).catch(function(e) {
      if (_curDetailId !== mid) return;
      civStatus.textContent = "\u26A0 Lookup failed: " + (e.message || "error");
    });
  } else {
    civStatus.textContent = "\u26A0 No hash available \u2014 use Refresh to scan files";
  }

  // Tags
  if (m.tags && m.tags.length) {
    rightContent.appendChild(el("label", { style: { marginTop:"6px" } }, "Tags"));
    var tagsContainer = el("div", { class: "cvt-local-tags" });
    m.tags.slice(0, 8).forEach(function(tag) {
      tagsContainer.appendChild(el("span", { class: "cvt-tag" }, "#" + tag));
    });
    rightContent.appendChild(tagsContainer);
  }

  // Description from metadata
  if (m.description) {
    rightContent.appendChild(el("label", { style: { marginTop:"6px" } }, "About"));
    var desc = el("div", { class: "cvt-desc" });
    desc.innerHTML = _sanitizeHTML(m.description) || m.description;
    rightContent.appendChild(desc);
  }

  // Actions
  var actions = el("div", { style: { display:"flex", gap:"6px", marginTop:"8px", flexWrap:"wrap" } });
  var cpBtn = el("button", { class: "cvt-btn ghost cvt-btn-xs", style: { flex:"1" } }, "\uD83D\uDCCB Copy path");
  cpBtn.onclick = function() {
    navigator.clipboard.writeText(m.path || "").then(function() { _toast("Copied!"); }).catch(function() {});
  };
  actions.appendChild(cpBtn);

  var delBtn = el("button", { class: "cvt-btn ghost cvt-btn-xs", style: { flex:"1" } }, "\u2715 Delete");
  delBtn.onclick = function() {
    if (!confirm("Delete \"" + (m.name || "") + "\"?")) return;
    _api("/civitai/delete-model", { method:"POST", body:JSON.stringify({path:m.path}) }).then(function() {
      _toast("Deleted: " + m.name, "ok");
      S.local.models = S.local.models.filter(function(x) { return x.path !== m.path; });
      closer();
      if (grid) _renderLocalGrid(grid, filterIn);
    }).catch(function(e) { _toast("Delete failed: " + e.message, "error"); });
  };
  actions.appendChild(delBtn);
  rightContent.appendChild(actions);
}

function _sanitizeHTML(html) {
  if (!html) return "";
  var doc = new DOMParser().parseFromString(String(html), "text/html");
  // Strip dangerous elements outright
  doc.querySelectorAll("script,style,iframe,object,embed,link,meta,form,input,button").forEach(function(n) { n.remove(); });
  // Strip event handlers and javascript: URLs; force links to open safely
  doc.querySelectorAll("*").forEach(function(n) {
    for (var i = n.attributes.length - 1; i >= 0; i--) {
      var attr = n.attributes[i];
      var name = attr.name.toLowerCase();
      var val = (attr.value || "").trim();
      if (name.indexOf("on") === 0) { n.removeAttribute(attr.name); continue; }
      if ((name === "href" || name === "src" || name === "xlink:href") && /^\s*javascript:/i.test(val)) {
        n.removeAttribute(attr.name);
      }
    }
    if (n.tagName === "A") {
      n.setAttribute("target", "_blank");
      n.setAttribute("rel", "noopener noreferrer");
    }
  });
  return doc.body.innerHTML;
}

function _sanitizeModelName(name, maxLen) {
  maxLen = maxLen || 50;
  return (name || "").replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").substring(0, maxLen);
}

function _guessFolder(type) {
  return ({
    Checkpoint: "checkpoints", LORA: "loras", LoCon: "loras", DoRA: "loras",
    VAE: "vae", Controlnet: "controlnet",
    TextualInversion: "embeddings", Hypernetwork: "hypernetworks",
    Upscaler: "upscale_models", MotionModule: "animatediff_models",
  })[type] || "other";
}

// ── Lightbox ────────────────────────────────────────────────────────
function openLightbox(img, model) {
  closeLightbox();
  var bg = el("div", { class: "cvt-lightbox-bg" });
  var content = el("div", { style: { display:"flex", gap:"20px", alignItems:"flex-start", maxWidth:"96vw", maxHeight:"90vh" } });

  // Left: image
  var imgWrap = el("div", { style: { flex:"0 1 auto", maxHeight:"90vh", display:"flex", flexDirection:"column", alignItems:"center", gap:"8px" } });
  var mainImg = el("img", {
    src: img.url,
    style: { maxWidth:"70vw", maxHeight:"88vh", objectFit:"contain", borderRadius:"var(--civ-radius)", boxShadow:"0 20px 60px rgba(0,0,0,.70)", transition:"transform .25s var(--civ-spring)" }
  });
  if (img.width && img.height) mainImg.style.aspectRatio = img.width + "/" + img.height;
  imgWrap.appendChild(mainImg);

  // NSFW bands stay blurred in the lightbox until explicitly revealed
  var lbBand = bandIdOfImage(img, model);
  if (isBlurred(lbBand)) {
    mainImg.classList.add("cvt-blur-lock");
    var revealBtn = el("button", { class: "cvt-btn ghost cvt-btn-xs" }, "\uD83D\uDC41 Reveal image");
    revealBtn.onclick = function(e) {
      e.stopPropagation();
      var hidden = mainImg.classList.toggle("cvt-blur-lock");
      revealBtn.textContent = hidden ? "\uD83D\uDC41 Reveal image" : "\uD83D\uDE48 Hide image";
    };
    imgWrap.appendChild(el("div", { style: { display:"flex", alignItems:"center", gap:"6px" } },
      makeBandBadge(lbBand, { showLabel: true }), revealBtn));
  }

  // Right: generation parameters panel
  var meta = img.meta || {};
  var panel = el("div", { class: "cvt-gen-panel" });

  // Image info
  panel.appendChild(el("div", { class: "cvt-gen-heading" }, "\uD83D\uDDBC\uFE0F  Info"));
  panel.appendChild(el("div", { class: "cvt-gen-row" },
    el("span", { class: "cvt-gen-label" }, "Dimensions"),
    el("span", {}, img.width && img.height ? img.width + " \u00D7 " + img.height : "\u2014")));
  panel.appendChild(el("div", { class: "cvt-gen-row" },
    el("span", { class: "cvt-gen-label" }, "Content band"),
    makeBandBadge(bandIdOfImage(img, model))));

  if (meta && Object.keys(meta).length) {
    // Positive prompt
    if (meta.prompt) {
      var promptBox = el("div", { class: "cvt-prompt-box" });
      promptBox.appendChild(el("div", { class: "cvt-gen-label" }, "\u2728 Prompt"));
      promptBox.appendChild(el("div", { class: "cvt-prompt-text" }, meta.prompt));
      var cpBtn = el("button", { class: "cvt-btn ghost cvt-copy-btn" }, "\uD83D\uDCCB Copy");
      cpBtn.onclick = function(e) { e.stopPropagation(); navigator.clipboard.writeText(meta.prompt).then(function() { _toast("Positive prompt copied!", "ok"); }); };
      promptBox.appendChild(cpBtn);
      panel.appendChild(promptBox);
    }

    // Negative prompt
    if (meta.negativePrompt) {
      var negBox = el("div", { class: "cvt-prompt-box" });
      negBox.appendChild(el("div", { class: "cvt-gen-label" }, "\uD83D\uDEAB Negative"));
      negBox.appendChild(el("div", { class: "cvt-prompt-text" }, meta.negativePrompt));
      var negCp = el("button", { class: "cvt-btn ghost cvt-copy-btn" }, "\uD83D\uDCCB Copy");
      negCp.onclick = function(e) { e.stopPropagation(); navigator.clipboard.writeText(meta.negativePrompt).then(function() { _toast("Negative prompt copied!", "ok"); }); };
      negBox.appendChild(negCp);
      panel.appendChild(negBox);
    }

    // Generation parameters grid
    panel.appendChild(el("div", { class: "cvt-gen-heading", style: { marginTop:"12px" } }, "\u2699\uFE0F  Params"));
    var params = [
      ["Model", meta.Model || meta.model || "\u2014"],
      ["Sampler", meta.sampler || meta.Sampler || "\u2014"],
      ["Seed", meta.seed != null ? String(meta.seed) : "\u2014"],
      ["CFG", meta.cfgScale != null ? String(meta.cfgScale) : "\u2014"],
      ["Steps", meta.steps != null ? String(meta.steps) : "\u2014"],
      ["Batch", meta.batchSize != null ? String(meta.batchSize) : "\u2014"],
      ["Clip Skip", meta.clipSkip != null ? String(meta.clipSkip) : "\u2014"],
      ["Hires", meta.hiresUpscaler || meta["Hires upscaler"] || "\u2014"],
      ["Denoise", meta.denoisingStrength != null ? String(meta.denoisingStrength) : "\u2014"],
      ["VAE", meta.vae || meta.VAE || "\u2014"],
    ];
    var paramGrid = el("div", { class: "cvt-gen-param-grid" });
    params.forEach(function(p) {
      paramGrid.appendChild(el("div", { class: "cvt-gen-param-row" },
        el("span", { class: "cvt-gen-label" }, p[0]),
        el("span", { class: "cvt-gen-value" }, p[1])));
    });
    panel.appendChild(paramGrid);

    // "Use this prompt" button
    if (meta.prompt) {
      var useBtn = el("button", { class: "cvt-btn", style: { marginTop:"14px", width:"100%" } }, "\u26A1 Use in workflow");
      useBtn.onclick = function(e) {
        e.stopPropagation();
        _api("/civitai/prompt-fetcher", {
          method: "POST",
          body: JSON.stringify({ positive: meta.prompt || "", negative: meta.negativePrompt || "" })
        }).then(function() {
          _toast("\u26A1 Prompts sent to Prompt Fetcher node! Run your workflow to use them.", "ok");
        }).catch(function(err) {
          _toast("Failed: " + err.message, "error");
        });
      };
      panel.appendChild(useBtn);
    }
  } else {
    panel.appendChild(el("div", { style: { color:"var(--civ-text-mute)", fontSize:"11px", marginTop:"8px" } }, "No generation parameters available for this image."));
  }

  content.appendChild(imgWrap);
  content.appendChild(panel);
  bg.appendChild(content);
  S.lightbox = bg;
  document.body.style.overflow = "hidden";
  document.body.appendChild(bg);

  // Close with fade animation
  function _closeLB() {
    bg.style.opacity = "0";
    setTimeout(function() { if (bg.parentNode) bg.remove(); document.body.style.overflow = ""; }, 200);
  }
  bg.onclick = function(e) { if (e.target === bg) _closeLB(); };
  // Override closeLightbox to use fade
  S._closeLB = _closeLB;
}

function _startDl(url, name, subfolder) {
  _api("/civitai/download", { method: "POST", body: JSON.stringify({ url: url, filename: name, subfolder: subfolder || "" }) })
    .then(function() { _toast("Queued: " + name); })
    .catch(function(e) { _toast("Download failed: " + e.message, "error"); });
}

// ── 2. HUGGING FACE ─────────────────────────────────────────────────
function renderHF(pane) {
  pane.innerHTML = "";   // idempotent — a re-render must never stack a second copy
  var sb = el("div", { class: "cvt-searchbar" });

  // ---- Manual entry row (repo URL / ID) ----
  var directIn = el("input", { type: "text", placeholder: "user/repo / URL\u2026", style: { flex:"1", fontFamily:"monospace", fontSize:"11px", background:"#1c1410", borderColor:"#5a3a2a" } });
  var directBtn = el("button", { class: "cvt-btn", style: { flex:"0 0 auto" } }, "\uD83C\uDFAF");
  var directRow = el("div", { class: "cvt-row", style: { marginBottom:"6px" } });
  directRow.appendChild(directIn); directRow.appendChild(directBtn);
  sb.appendChild(directRow);

  directBtn.onclick = function() { _lookupHF(directIn.value, directIn); };
  directIn.onkeydown = function(e) { if (e.key === "Enter") directBtn.click(); };

  // ---- Search ----
  var row1 = el("div", { class: "cvt-row" });
  var qIn = el("input", { type: "text", placeholder: "Search Hugging Face\u2026", id: "cvt-hf-q", style: { flex:1 } });
  var sortSel = el("select", { id: "cvt-hf-sort", class: "cvt-select-sm", title: "Sort by" });
  HF_SORTS.forEach(function(s) { sortSel.appendChild(el("option", { value: s }, s)); });
  row1.appendChild(qIn); row1.appendChild(sortSel); sb.appendChild(row1);

  var row2 = el("div", { class: "cvt-row", style: { flexWrap:"wrap", gap:"4px", alignItems:"center" } });
  var ptSel = el("select", { id: "cvt-hf-pt", class: "cvt-select-sm", title: "Pipeline" });
  HF_PIPELINES.forEach(function(p) { ptSel.appendChild(el("option", { value: p }, p || "Any pipeline")); });
  var libSel = el("select", { id: "cvt-hf-lib", class: "cvt-select-sm", title: "Library" });
  HF_LIBRARIES.forEach(function(l) { libSel.appendChild(el("option", { value: l }, l || "Any library")); });
  var authorIn = el("input", { type: "text", placeholder: "Author", style: { flex:"0 0 auto", width:"100px", fontSize:"11px" } });
  var goBtn = el("button", { class: "cvt-btn", style: { flex:"0 0 auto" } }, "\uD83D\uDD0D");
  row2.appendChild(ptSel); row2.appendChild(libSel); row2.appendChild(authorIn); row2.appendChild(goBtn);
  sb.appendChild(row2);
  pane.appendChild(sb);

  var grid = el("div", { class: "cvt-grid", id: "cvt-hf-grid" });
  pane.appendChild(grid);

  goBtn.onclick = _srch;
  qIn.onkeydown = function(e) { if (e.key === "Enter") _srch(); };

  function _srch() {
    grid.innerHTML = '<div class="cvt-spinner"></div>';
    S.hf.query = qIn.value;
    S.hf.sort = sortSel.value;
    S.hf.pipeline_tag = ptSel.value;
    S.hf.library = libSel.value;
    S.hf.author = authorIn.value;
    var params = new URLSearchParams({
      query: S.hf.query, sort: S.hf.sort,
      limit: "30",
    });
    if (S.hf.pipeline_tag) params.set("pipeline_tag", S.hf.pipeline_tag);
    if (S.hf.library) params.set("library", S.hf.library);
    if (S.hf.author) params.set("author", S.hf.author);
    _api("/civitai/hf-search?" + params.toString()).then(function(d) {
      S.hf.items = d.items || [];
      grid.innerHTML = "";
      if (!S.hf.items.length) { grid.innerHTML = '<div class="cvt-empty" style="grid-column:1/-1">No models found</div>'; return; }
      S.hf.items.forEach(function(m) {
        var rep = m.modelId || m.id || "";
        var ini = rep.split("/").filter(Boolean).map(function(s) { return s[0]; }).join("").toUpperCase().slice(0, 2) || "HF";
        var totalSize = 0;
        if (m.siblings && m.siblings.length) {
          m.siblings.forEach(function(s) {
            if (s.size && /\.(safetensors|ckpt|pt|bin|pth|gguf)$/i.test(s.rfilename || "")) totalSize += s.size;
          });
        }
        var card = el("div", { class: "cvt-card" });
        card.appendChild(el("div", { class: "thumb", style: { display:"flex",alignItems:"center",justifyContent:"center",background:"linear-gradient(135deg,#3a2a5a,#1e3a5a)",color:"#fff",fontSize:"28px",fontWeight:700 } }, ini));
        card.appendChild(el("div", { class: "body" },
          el("div", { class: "title", style: { color:"#ff8c42" } }, rep),
          el("div", { class: "meta" },
            el("span", {}, "\u2B07 " + _fmtNum(m.downloads || 0)),
            el("span", {}, "\u2764 " + _fmtNum(m.likes || 0)),
            totalSize ? el("span", { style: { color:"var(--civ-text-mute)" } }, _fmtBytes(totalSize)) : null)));
        var bookmarkBtn = el("button", { class: "cvt-bookmark-btn", title: "Bookmark this model", style: { position:"absolute", top:"4px", right:"4px", zIndex:2, background:"rgba(0,0,0,.5)", border:"none", borderRadius:"50%", width:"28px", height:"28px", color:"#ff8c42", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", lineHeight:1 } }, el("img", { src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAACXBIWXMAAAsTAAALEwEAmpwYAAABpUlEQVR4nO2ZvUoDQRSFv2ASBQmCjYUPIIiFYAKiYmmbN7DxAXwFX0GxshTUNIqIYGdnaSGijdj405kuKmKSkZUJjIOZrLszGyT3gwv7c+ecOcvMFrsgCMJAsgTUgGegCaiE1QSegANgMYuJ54HtFBPuVVvaIxghJ6+MEMGWjWl0DMwBxRSaRaAMnBi6bWCBANQMk8jQN0eG/l4A/e8N2zGInrxvyob+YwD9H2+bNMumG0Xr7eQdc/2HQoX0kAAxUBLAgQSIgZIADiRADJQEcCABYqAkgAMJEAMlARxIgBgoCeBRfAW40RUd/5sABWADaFnfejaBYU8eiYgjPgVcWr1mXQMzKT0S00t8DWhYfae6zGsN3ZvEIxXdxMeAfev+O7AO5HTPKvBq9RwC4/0OMA/cW/dugdlfxk8DV1bvA7DcjwB5vVHtfwO7wKhDY0Rv5rYxpqWvFbIMcGGdvwDVP2hV9Rjl0AwawKxzYDKB3gRw5tD1jm3wqZfRUArNnN7sH1kEeDPE74CKR+2K1uzoR17eiZ52HdgBSgH0S1q7rr0EQRgEvgCZsWa8d9MqpQAAAABJRU5ErkJggg==", style: { width:"16px", height:"16px", display:"block" } }));
        bookmarkBtn.onclick = function(e) {
          e.stopPropagation();
          var payload = {
            name: rep || "", model_version_id: 0, model_id: 0,
            filename: (rep || "").replace(/[^a-zA-Z0-9_-]/g,"_") + ".safetensors",
            source: "hf", repo_id: rep || "", repo_type: "model"
          };
          _api("/civitai/bookmarks", { method:"POST", body:JSON.stringify(payload) }).then(function(r) {
            if (r.success) _toast("Bookmarked: " + (rep || ""), "ok");
            else _toast((r.message || "Already bookmarked"), "ok");
          }).catch(function(err) { _toast("Bookmark failed: " + err.message, "error"); });
        };
        card.appendChild(bookmarkBtn);
        card.onclick = function() { _hfDetail(rep); };
        grid.appendChild(card);
      });
    }).catch(function(e) { grid.innerHTML = '<div class="cvt-empty" style="grid-column:1/-1;color:#f88">Error: ' + e.message + '</div>'; });
  }
}

function _lookupHF(raw, fieldEl) {
  var v = (raw || "").trim();
  if (!v) { _toast("Enter a repo in format: user/repo or paste a HuggingFace URL", "error"); return; }
  // Parse full HF URLs incl. datasets/spaces: https://huggingface.co/datasets/user/repo/tree/main
  var m = v.match(/huggingface\.co\/(.+)$/);
  if (m) v = m[1];
  v = v.replace(/^\/+/, "");
  var repoType = "model";
  var tm = v.match(/^(datasets|spaces|models)\/(.+)$/);
  if (tm) {
    repoType = { datasets: "dataset", spaces: "space", models: "model" }[tm[1]];
    v = tm[2];
  }
  // Strip trailing /tree/main or other path parts
  v = v.replace(/\/(tree|blob|resolve|blame|commits|discussions|files)\/.*$/, "");
  v = v.replace(/\/+$/, "");
  var vp = v.split("/").filter(Boolean);
  if (vp.length >= 2) v = vp[0] + "/" + vp[1];
  if (v.indexOf("/") < 0) { _toast("Enter a repo in format: user/repo", "error"); return; }
  if (fieldEl) fieldEl.disabled = true;
  _api("/civitai/hf-lookup?repo=" + encodeURIComponent(v)).then(function(data) {
    if (data && data.id) {
      _hfDetail(data.id, data.repo_type || repoType);
    } else {
      _toast("Repo not found", "error");
    }
  }).catch(function(e) { _toast("Lookup failed: " + e.message, "error"); })
  .then(function() { if (fieldEl) fieldEl.disabled = false; });
}

function _hfDetail(repoIdOrData, repoType) {
  var repoId = typeof repoIdOrData === "string" ? repoIdOrData : (repoIdOrData.id || "");
  repoType = repoType || (typeof repoIdOrData === "object" && repoIdOrData.repo_type) || "model";
  if (!repoId || repoId.indexOf("/") < 0) { _toast("Invalid repo ID", "error"); return; }
  var bg = el("div", { class: "cvt-modal-bg" });
  var wrap = el("div", { class: "cvt-modal-wrap" });
  var closeBtn = el("button", { class: "close" }, "\u00D7");
  var modal = el("div", { class: "cvt-modal" });
  wrap.appendChild(closeBtn); wrap.appendChild(modal); bg.appendChild(wrap);
  document.body.appendChild(bg);
  closeBtn.onclick = function() { bg.remove(); };
  bg.onclick = function(e) { if (e.target === bg) bg.remove(); };

  var left = el("div", { class: "left" });
  var right = el("div", { class: "right" });
  modal.appendChild(left); modal.appendChild(right);
  left.appendChild(el("h2", { style: { color:"#ff8c42" } }, repoId));
  var bookmarkBtnDetail = el("button", { class: "cvt-bookmark-btn", title: "Bookmark this model", style: { marginTop:"6px", background:"rgba(0,0,0,.5)", border:"1px solid #ff8c42", borderRadius:"4px", padding:"4px 8px", color:"#ff8c42", fontSize:"12px", cursor:"pointer", display:"inline-flex", alignItems:"center", gap:"4px" } }, el("img", { src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAACXBIWXMAAAsTAAALEwEAmpwYAAABpUlEQVR4nO2ZvUoDQRSFv2ASBQmCjYUPIIiFYAKiYmmbN7DxAXwFX0GxshTUNIqIYGdnaSGijdj405kuKmKSkZUJjIOZrLszGyT3gwv7c+ecOcvMFrsgCMJAsgTUgGegCaiE1QSegANgMYuJ54HtFBPuVVvaIxghJ6+MEMGWjWl0DMwBxRSaRaAMnBi6bWCBANQMk8jQN0eG/l4A/e8N2zGInrxvyob+YwD9H2+bNMumG0Xr7eQdc/2HQoX0kAAxUBLAgQSIgZIADiRADJQEcCABYqAkgAMJEAMlARxIgBgoCeBRfAW40RUd/5sABWADaFnfejaBYU8eiYgjPgVcWr1mXQMzKT0S00t8DWhYfae6zGsN3ZvEIxXdxMeAfev+O7AO5HTPKvBq9RwC4/0OMA/cW/dugdlfxk8DV1bvA7DcjwB5vVHtfwO7wKhDY0Rv5rYxpqWvFbIMcGGdvwDVP2hV9Rjl0AwawKxzYDKB3gRw5tD1jm3wqZfRUArNnN7sH1kEeDPE74CKR+2K1uzoR17eiZ52HdgBSgH0S1q7rr0EQRgEvgCZsWa8d9MqpQAAAABJRU5ErkJggg==", style: { width:"14px", height:"14px", display:"block" } }), " Bookmark");
  bookmarkBtnDetail.onclick = function(e) {
    e.stopPropagation();
    var payload = {
      name: repoId || "", model_version_id: 0, model_id: 0,
      filename: (repoId || "").replace(/[^a-zA-Z0-9_-]/g,"_") + ".safetensors",
      source: "hf", repo_id: repoId || "", repo_type: repoType || "model"
    };
    _api("/civitai/bookmarks", { method:"POST", body:JSON.stringify(payload) }).then(function(r) {
      if (r.success) _toast("Bookmarked: " + (repoId || ""), "ok");
      else _toast((r.message || "Already bookmarked"), "ok");
    }).catch(function(err) { _toast("Bookmark failed: " + err.message, "error"); });
  };
  left.appendChild(bookmarkBtnDetail);
  left.appendChild(el("div", { class: "sub" }, "Loading\u2026"));

  _api("/civitai/hf-files?repo_id=" + encodeURIComponent(repoId) + "&repo_type=" + encodeURIComponent(repoType)).then(function(info) {
    var files = Array.isArray(info) ? info : info.siblings || [];
    var data = info.data || info;
    var pt = data.pipeline_tag || data.library_name || "?";
    left.querySelector(".sub").innerHTML = "";
    left.querySelector(".sub").textContent = "task: " + pt + " \u00B7 \u2B07 " + _fmtNum(data.downloads || 0) + " \u00B7 \u2764 " + _fmtNum(data.likes || 0);

    // Revision input
    right.appendChild(el("label", {}, "Branch / commit"));
    var revIn = el("input", { type: "text", value: "main", style: { marginTop:"4px" } });
    right.appendChild(revIn);

    // Weights filter
    right.appendChild(el("label", {}, "Files"));
    var filterRow = el("div", { class: "cvt-row", style: { marginTop:"4px" } });
    var onlyWeights = el("input", { type: "checkbox", checked: true });
    filterRow.appendChild(el("label", { style: { display:"flex", alignItems:"center", gap:"4px", fontSize:"11px" } }, onlyWeights, " weights only"));
    right.appendChild(filterRow);

    // File list as select
    var fileSel = el("select", { size: "12", style: { width:"100%", marginTop:"4px", padding:"4px", minHeight:"180px" } });
    right.appendChild(fileSel);

    function fillFiles() {
      var sibs = files.slice();
      sibs.sort(function(a, b) { return (a.rfilename || "").localeCompare(b.rfilename || ""); });
      fileSel.innerHTML = "";
      for (var i = 0; i < sibs.length; i++) {
        var fn = sibs[i].rfilename || "";
        if (onlyWeights.checked && !/\.(safetensors|ckpt|pt|bin|pth|gguf|onnx|pkl|npz)$/i.test(fn)) continue;
        var sz = sibs[i].size ? "  (" + _fmtBytes(sibs[i].size) + ")" : "";
        fileSel.appendChild(el("option", { value: fn }, fn + sz));
      }
      // Auto-pick biggest .safetensors
      var best = null, bestSize = 0;
      for (var j = 0; j < fileSel.options.length; j++) {
        var sib = files.find(function(x) { return x.rfilename === fileSel.options[j].value; });
        if (sib && /\.safetensors$/i.test(fileSel.options[j].value) && (sib.size || 0) > bestSize) {
          best = fileSel.options[j].value; bestSize = sib.size || 0;
        }
      }
      if (best) fileSel.value = best;
    }
    onlyWeights.onchange = fillFiles;
    fillFiles();

    // Folder dropdown
    right.appendChild(el("label", { style: { marginTop:"10px" } }, "Folder"));
    var folderSel = el("select");
    folderSel.appendChild(el("option", { value: "auto" }, "Auto"));
    _api("/civitai/folders").then(function(r) {
      (r.folders || []).forEach(function(f) { folderSel.appendChild(el("option", { value: f }, f)); });
    }).catch(function() {});
    right.appendChild(folderSel);

    // Subfolder + overwrite
    right.appendChild(el("label", {}, "Subfolder"));
    var subIn = el("input", { type: "text", placeholder: "subfolder\u2026", style: { marginTop:"4px" } });
    right.appendChild(subIn);

    var overwriteLbl = el("label", { class: "check", style: { display:"flex", alignItems:"center", gap:"6px", marginTop:"8px" } },
      el("input", { type: "checkbox" }), " Overwrite");
    right.appendChild(overwriteLbl);
    var subfolderLbl = el("label", { class: "check", style: { display:"flex", alignItems:"center", gap:"6px", marginTop:"4px" } },
      el("input", { type: "checkbox" }), " Keep subfolders");
    right.appendChild(subfolderLbl);

    // Metadata + preview checkboxes
    var metaCb = el("input", { type: "checkbox" });
    var prevCb = el("input", { type: "checkbox" });
    metaCb.checked = S.settings.saveMeta;
    prevCb.checked = S.settings.savePrev;
    right.appendChild(el("label", { class: "check", style: { display:"flex", alignItems:"center", gap:"6px", marginTop:"6px" } }, metaCb, " Save .civitai.json"));
    right.appendChild(el("label", { class: "check", style: { display:"flex", alignItems:"center", gap:"6px", marginTop:"4px" } }, prevCb, " Save preview"));

    // Download + Metadata only buttons
    var dlBtn = el("button", { class: "cvt-btn cvt-btn-xs", style: { marginTop:"10px", width:"100%" } },
      el("span", { class: "emoji-btn" }, "\u2B07"), " Download");
    var metaOnlyBtn = el("button", { class: "cvt-btn ghost cvt-btn-xs", style: { marginTop:"6px", width:"100%" } }, "\uD83D\uDCC4 Meta");
    right.appendChild(dlBtn); right.appendChild(metaOnlyBtn);

    var statusLine = el("div", { class: "sub", style: { marginTop:"10px" } });
    right.appendChild(statusLine);

    function _submitHF(metadataOnly) {
      var btn = metadataOnly ? metaOnlyBtn : dlBtn;
      var path = fileSel.value;
      if (!path && !metadataOnly) {         statusLine.innerHTML = "<span style='color:#e88'>Pick a file first.</span>"; return; }
      btn.disabled = true;
      statusLine.textContent = metadataOnly ? "Fetching metadata\u2026" : "Starting download\u2026";
      var body = {
        repo_id: repoId,
        repo_type: repoType,
        revision: revIn.value.trim() || "main",
        path: path,
        save_as: folderSel.value || "auto",
        subfolder: subIn.value.trim(),
        overwrite: overwriteLbl.querySelector("input").checked,
        preserve_subfolders: subfolderLbl.querySelector("input").checked,
        save_metadata: metaCb.checked,
        save_preview: prevCb.checked,
        metadata_only: metadataOnly,
      };
      _api("/civitai/hf/download", { method:"POST", body:JSON.stringify(body) }).then(function(job) {
        statusLine.innerHTML = "";
        statusLine.appendChild(document.createTextNode("Queued: "));
        statusLine.appendChild(el("b", {}, job.id));
        statusLine.appendChild(document.createTextNode(" \u2014 open "));
        var dlLink = el("a", { href: "#", style: { color:"#ec9", cursor:"pointer" } }, "Downloads");
        dlLink.onclick = function(e) {
          e.preventDefault(); bg.remove();
          if (S.root) S.root.dispatchEvent(new CustomEvent("civitai:show-tab", { detail: "downloads" }));
        };
        statusLine.appendChild(dlLink);
        statusLine.appendChild(document.createTextNode(" to monitor."));
        _toast(metadataOnly ? "HF metadata queued" : "HF queued: " + (job.filename || path), "ok");
        _ensureDlPolling();
      }).catch(function(e) {
        statusLine.innerHTML = "";
        statusLine.appendChild(el("span", { style: { color:"#fb8e8e" } }, "Error: " + e.message));
        _toast("HF error: " + e.message, "error");
      }).then(function() { btn.disabled = false; });
    }

    dlBtn.onclick = function() { _submitHF(false); };
    metaOnlyBtn.onclick = function() {
      if (!metaCb.checked && !prevCb.checked) {
        statusLine.innerHTML = "<span style='color:#e88'>Enable at least one of metadata sidecar / preview image.</span>";
        return;
      }
      _submitHF(true);
    };

    // File list on left
    left.appendChild(el("label", { style: { marginTop:"8px" } }, "Files"));
    var fl = el("div", { class: "cvt-files-list", style: { flex:"0 0 auto", marginTop:"4px" } });
    files.forEach(function(f) {
      var fn = f.rfilename || f.path || "";
      var isWeight = /\.(safetensors|ckpt|pt|pth|gguf|bin)$/i.test(fn);
      var row = el("div", { class: "f" });
      row.appendChild(el("span", { style: { overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", flex:1 } }, fn));
      var rightSpan = el("span", { style: { display:"inline-flex", gap:"4px", alignItems:"center", flexShrink:0 } });
      rightSpan.appendChild(el("span", { style: { color:"var(--civ-text-mute)" } }, f.size ? _fmtBytes(f.size) : ""));
      if (isWeight) {
        var dlBtn2 = el("button", { class: "cvt-btn ghost", style: { padding:"2px 8px", fontSize:"10px" } }, "\u2B07");
        dlBtn2.onclick = function() {
          var name = fn.split("/").pop();
          var sf = subIn.value || "";
          var fldr = folderSel.value || "loras";
          var seg = repoType === "dataset" ? "datasets/" : (repoType === "space" ? "spaces/" : "");
          _startDl("https://huggingface.co/" + seg + repoId + "/resolve/main/" + encodeURIComponent(fn), name, fldr + (sf ? "/" + sf : ""));
        };
        rightSpan.appendChild(dlBtn2);
      }
      row.appendChild(rightSpan);
      fl.appendChild(row);
    });
    left.appendChild(fl);
  }).catch(function(e) { left.innerHTML = '<div class="cvt-empty">Error: ' + e.message + '</div>'; });
}

// ── 3. DOWNLOADS ────────────────────────────────────────────────────
var _dlTimer = null;
var _dlPolling = false;
var _dlListEl = null;
var _dlHeader = null;
var _dlCountEl = null;
var _dlRows = {};
var _dlClearBtn = null;
var _dlChips = {};
var _dlSummaryEl = null;
var _dlSummaryText = null;
var _dlSummaryBar = null;
var DL_FILTERS = [["all","All"],["active","Active"],["done","Done"],["failed","Failed"]];

function renderDownloads(pane) {
  pane.innerHTML = "";   // idempotent — a re-render must never stack a second copy
  _dlListEl = null;
  _dlRows = {};

  // Header (static)
  _dlHeader = el("div", { style: { marginBottom:"10px", paddingBottom:"8px", borderBottom:"1px solid var(--civ-line)", flexShrink:0 } });

  var topRow = el("div", { class: "cvt-row" });
  var refreshBtn = el("button", { class: "cvt-btn ghost" },
    el("span", { class: "emoji-btn emoji-spin-slow" }, "\u21BB"), " Refresh");
  refreshBtn.onclick = _pollDl;

  var clearBtn = el("button", { class: "cvt-btn ghost" },
    el("span", { class: "emoji-btn" }, "\uD83E\uDDF9"), " Clear completed");
  clearBtn.onclick = function() {
    clearBtn.disabled = true;
    _api("/civitai/downloads-clear", { method:"POST", body:JSON.stringify({}) }).then(function(r) {
      _toast((r && r.cleared ? r.cleared : 0) + " job(s) cleared", "ok");
      _pollDl();
    }).catch(function(e) { _toast("Clear failed: " + e.message, "error"); })
      .then(function() { clearBtn.disabled = false; });
  };
  _dlClearBtn = clearBtn;

  _dlCountEl = el("div", { style: { textAlign:"right", fontSize:"11px", color:"var(--civ-text-dim)", flex:"2", alignSelf:"center" } });
  topRow.appendChild(refreshBtn);
  topRow.appendChild(clearBtn);
  topRow.appendChild(_dlCountEl);
  _dlHeader.appendChild(topRow);

  // Status filter chips
  var chipRow = el("div", { class: "cvt-chip-row", style: { display:"flex", gap:"6px", marginTop:"8px", flexWrap:"wrap" } });
  _dlChips = {};
  DL_FILTERS.forEach(function(f) {
    var chip = el("button", { class: "cvt-chip" + (S.dlFilter === f[0] ? " active" : "") }, f[1]);
    chip.onclick = function() {
      S.dlFilter = f[0];
      Object.keys(_dlChips).forEach(function(k) {
        _dlChips[k].classList.toggle("active", k === f[0]);
      });
      _dlRows = {};
      if (_dlListEl) _dlListEl.innerHTML = "";
      _pollDl();
    };
    _dlChips[f[0]] = chip;
    chipRow.appendChild(chip);
  });
  _dlHeader.appendChild(chipRow);

  // Aggregate progress summary
  _dlSummaryEl = el("div", { class: "cvt-dl-summary", style: { display:"none", marginTop:"8px" } });
  _dlSummaryText = el("div", { style: { fontSize:"10.5px", color:"var(--civ-text-dim)" } });
  var sBar = el("div", { class: "bar", style: { width:"100%", height:"5px", background:"rgba(255,255,255,.04)", borderRadius:"3px", overflow:"hidden", marginTop:"5px" } });
  _dlSummaryBar = el("div", { style: { height:"100%", width:"0%", borderRadius:"3px", background:"linear-gradient(90deg, rgba(255,255,255,.50), rgba(255,255,255,.85))", transition:"width .4s var(--civ-ease-out)" } });
  sBar.appendChild(_dlSummaryBar);
  _dlSummaryEl.appendChild(_dlSummaryText);
  _dlSummaryEl.appendChild(sBar);
  _dlHeader.appendChild(_dlSummaryEl);

  pane.appendChild(_dlHeader);

  _dlListEl = el("div");
  pane.appendChild(_dlListEl);
  _pollDl();
}

function _jobMatchesFilter(j, filter) {
  var st = j.status || "";
  if (filter === "all") return true;
  if (filter === "active") return _jobIsActive(st);
  if (filter === "done") return st === "done" || st === "completed";
  if (filter === "failed") return st === "error" || st === "cancelled";
  return true;
}

function _updateDlSummary(jobs) {
  if (!_dlSummaryEl) return;
  var active = jobs.filter(function(j) { return _jobIsActive(j.status); });
  if (!active.length) { _dlSummaryEl.style.display = "none"; return; }
  _dlSummaryEl.style.display = "";

  var totalBytes = 0, doneBytes = 0, speed = 0, haveTotals = true;
  active.forEach(function(j) {
    var t = j.total || 0, d = j.downloaded || 0;
    if (!t) haveTotals = false;
    totalBytes += t; doneBytes += d;
    speed += (j.speed_bps || j.speed || 0);
  });

  var pct = (haveTotals && totalBytes > 0) ? Math.round(doneBytes / totalBytes * 100)
    : Math.round(active.reduce(function(a, j) { return a + (j.progress || 0); }, 0) / active.length);
  _dlSummaryBar.style.width = pct + "%";

  var txt = active.length + " active \u00B7 " + pct + "%";
  if (haveTotals && totalBytes > 0) txt += " \u00B7 " + _fmtBytes(doneBytes) + " / " + _fmtBytes(totalBytes);
  if (speed > 0) {
    txt += " \u00B7 " + _fmtBytes(speed) + "/s";
    if (haveTotals && totalBytes > doneBytes) {
      var eta = Math.round((totalBytes - doneBytes) / speed);
      txt += " \u00B7 ETA " + _fmtDuration(eta);
    }
  }
  _dlSummaryText.textContent = txt;
}

function _fmtDuration(sec) {
  if (!isFinite(sec) || sec < 0) return "\u2013";
  if (sec < 60) return sec + "s";
  var m = Math.floor(sec / 60), s2 = sec % 60;
  if (m < 60) return m + "m " + s2 + "s";
  var h = Math.floor(m / 60);
  return h + "h " + (m % 60) + "m";
}

function _apiFresh(path, opts) {
  _cache.del(path);
  return _api(path, opts);
}

function _pollDl() {
  if (!_dlListEl || !document.body.contains(_dlListEl)) {
    if (_dlTimer) { clearInterval(_dlTimer); _dlTimer = null; }
    _dlPolling = false;
    return;
  }
  if (_dlPolling) return;
  _dlPolling = true;
  _apiFresh("/civitai/downloads").then(function(d) {
    if (!_dlListEl || !document.body.contains(_dlListEl)) return;
    S.downloads = d.items || [];

    // Adaptive heartbeat: stop polling if no active jobs or tab hidden
    _activeJobs = S.downloads.filter(function(j) { return _jobIsActive(j.status); }).length;

    var finished = S.downloads.filter(function(j) { return !_jobIsActive(j.status); }).length;
    if (_dlClearBtn) _dlClearBtn.disabled = finished === 0;

    _updateDlSummary(S.downloads);

    var filter = S.dlFilter || "all";
    var shown = S.downloads.filter(function(j) { return _jobMatchesFilter(j, filter); });

    if (_dlCountEl) {
      _dlCountEl.textContent = (filter === "all")
        ? S.downloads.length + " job(s)"
        : shown.length + " of " + S.downloads.length + " job(s)";
    }

    // True diff rendering: update rows in place, only add/remove when jobs change
    if (!shown.length) {
      _dlRows = {};
      _dlListEl.innerHTML = "";
      _dlListEl.appendChild(el("div", { class: "cvt-empty" },
        S.downloads.length ? "No jobs match this filter." : "No downloads yet."));
    } else {
      // Remove the empty placeholder if present
      var empty = _dlListEl.querySelector(".cvt-empty");
      if (empty) empty.remove();

      var seen = {};
      shown.forEach(function(j, idx) {
        var key = String(j.id);
        seen[key] = true;
        var entry = _dlRows[key];
        if (!entry) {
          entry = _jobRow(j);
          _dlRows[key] = entry;
        } else {
          entry.update(j);
        }
        // Keep DOM order in sync with data order without tearing down
        var expected = _dlListEl.children[idx];
        if (expected !== entry.row) _dlListEl.insertBefore(entry.row, expected || null);
      });

      // Remove rows for jobs that no longer exist / are filtered out
      Object.keys(_dlRows).forEach(function(key) {
        if (!seen[key]) {
          if (_dlRows[key].row.parentNode) _dlRows[key].row.remove();
          delete _dlRows[key];
        }
      });
    }

    // Adaptive heartbeat: only poll when visible and active
    if (_dlTimer) clearInterval(_dlTimer);
    if (_activeJobs > 0 && !document.hidden) {
      _dlTimer = setInterval(_pollDl, 500);
    } else {
      _dlTimer = null;
    }
  }).catch(function(e) { console.warn("Download poll error:", e); _dlPolling = false; }).then(function() { if (_dlPolling) _dlPolling = false; });
}

function _ensureDlPolling() {
  if (!_dlListEl || !document.body.contains(_dlListEl)) return;
  if (!_dlTimer) { _pollDl(); }
}

function _jobIsActive(status) {
  return status === "running" || status === "queued" || status === "downloading";
}

function _jobSubText(j, pct) {
  var subText = pct + "% \u00B7 " + _fmtBytes(j.downloaded || 0) + " / " + _fmtBytes(j.total || 0);
  if (j.speed_bps || j.speed) subText += " \u00B7 " + _fmtBytes(j.speed_bps || j.speed) + "/s";
  if (j.error) subText += " \u00B7 " + j.error;
  return subText;
}

function _jobRow(j) {
  var pct = j.progress != null ? Math.round(j.progress) : 0;
  var row = el("div", { class: "cvt-job " + (j.status || "") });
  var top = el("div", { class: "top" });

  // Source badge
  var srcBadge = j.source === "hf"
    ? el("span", { class: "cvt-badge", style: { background:"#3a4a6a" } }, "\uD83E\uDD17 HF")
    : el("span", { class: "cvt-badge", style: { background:"#5a2a2a" } }, "Civitai");

  var statusDot = el("span", { class: "cvt-status-dot " + (j.status || "") });
  var nameEl = el("div", { class: "name" },
    statusDot,
    " ", srcBadge, " ",
    j.filename || j.name || (j.source === "hf"
      ? (j.hf_repo_id || "") + ":" + (j.hf_path || "")
      : "version " + (j.model_version_id || "")));
  top.appendChild(nameEl);

  // Cancel button (shown while the download is active)
  function makeCancelBtn() {
    var cnl = el("button", { class: "cvt-btn ghost", style: { padding:"2px 6px", fontSize:"11px" }, title:"Cancel this download" }, "Cancel \u2715");
    cnl.onclick = function() {
      _api("/civitai/download-cancel", { method:"POST", body:JSON.stringify({task_id:j.id}) }).then(function() { _pollDl(); });
    };
    return cnl;
  }
  // Retry button (failed / cancelled jobs)
  function _jobFailed(st) { return st === "error" || st === "cancelled"; }
  function makeRetryBtn(job) {
    var r = el("button", { class: "cvt-btn ghost", style: { padding:"2px 6px", fontSize:"11px" }, title: "Retry this download" },
      el("span", { class: "emoji-btn" }, "\u21BB"), " Retry");
    r.onclick = function() {
      var endpoint = job.retry_endpoint || (job.source === "hf" ? "/civitai/hf/download" : "/civitai/download");
      var payload = job.retry_payload;
      if (!payload) {
        payload = job.source === "hf"
          ? { repo_id: job.hf_repo_id, path: job.hf_path, overwrite: true }
          : { url: job.url, model_version_id: job.model_version_id, filename: job.filename, overwrite: true };
      }
      r.disabled = true;
      _api(endpoint, { method:"POST", body:JSON.stringify(payload) }).then(function() {
        _toast("Retrying: " + (job.filename || job.name || "download"), "ok");
        _api("/civitai/downloads-clear", { method:"POST", body:JSON.stringify({ task_id: job.id }) })
          .catch(function() {})
          .then(function() { _pollDl(); _ensureDlPolling(); });
      }).catch(function(e) {
        r.disabled = false;
        _toast("Retry failed: " + e.message, "error");
      });
    };
    return r;
  }

  // Dismiss button (remove a finished job from the list)
  function makeDismissBtn(job) {
    var dz = el("button", { class: "cvt-btn ghost", style: { padding:"2px 6px", fontSize:"11px" }, title: "Remove from list" }, "\u2715");
    dz.onclick = function() {
      _api("/civitai/downloads-clear", { method:"POST", body:JSON.stringify({ task_id: job.id }) })
        .then(function() { _pollDl(); })
        .catch(function(e) { _toast("Could not remove: " + e.message, "error"); });
    };
    return dz;
  }

  var cancelBtn = _jobIsActive(j.status) ? makeCancelBtn() : null;
  var retryBtn = _jobFailed(j.status) ? makeRetryBtn(j) : null;
  var dismissBtn = !_jobIsActive(j.status) ? makeDismissBtn(j) : null;
  var actions = el("div", { style: { display:"flex", gap:"4px", alignItems:"center", flexShrink:0 } });
  if (retryBtn) actions.appendChild(retryBtn);
  if (cancelBtn) actions.appendChild(cancelBtn);
  if (dismissBtn) actions.appendChild(dismissBtn);
  top.appendChild(actions);
  row.appendChild(top);

  // Sub info
  var subEl = el("div", { class: "sub" }, _jobSubText(j, pct));
  row.appendChild(subEl);

  // Progress bar
  var bar = el("div", { class: "bar" });
  var barInner = el("div", { style: { width: pct + "%" } });
  bar.appendChild(barInner);
  row.appendChild(bar);

  // Filepath on success
  var pathEl = null;
  if (j.filepath && (j.status === "done" || j.status === "completed")) {
    pathEl = el("div", { class: "sub", style: { marginTop:"4px", color:"#9c9" } }, "Saved to " + j.filepath);
    row.appendChild(pathEl);
  }

  function update(nj) {
    var npct = nj.progress != null ? Math.round(nj.progress) : 0;
    var status = nj.status || "";

    if (row.className !== "cvt-job " + status) row.className = "cvt-job " + status;
    if (statusDot.className !== "cvt-status-dot " + status) statusDot.className = "cvt-status-dot " + status;

    var newSub = _jobSubText(nj, npct);
    if (subEl.textContent !== newSub) subEl.textContent = newSub;

    var newWidth = npct + "%";
    if (barInner.style.width !== newWidth) barInner.style.width = newWidth;

    // Action buttons follow the job state
    var active = _jobIsActive(status);
    if (active && !cancelBtn) {
      cancelBtn = makeCancelBtn();
      actions.appendChild(cancelBtn);
    } else if (!active && cancelBtn) {
      if (cancelBtn.parentNode) cancelBtn.remove();
      cancelBtn = null;
    }

    var failed = _jobFailed(status);
    if (failed && !retryBtn) {
      retryBtn = makeRetryBtn(nj);
      actions.insertBefore(retryBtn, actions.firstChild);
    } else if (!failed && retryBtn) {
      if (retryBtn.parentNode) retryBtn.remove();
      retryBtn = null;
    }

    if (!active && !dismissBtn) {
      dismissBtn = makeDismissBtn(nj);
      actions.appendChild(dismissBtn);
    } else if (active && dismissBtn) {
      if (dismissBtn.parentNode) dismissBtn.remove();
      dismissBtn = null;
    }

    // Saved-to path appears on completion
    var wantPath = nj.filepath && (status === "done" || status === "completed");
    if (wantPath && !pathEl) {
      pathEl = el("div", { class: "sub", style: { marginTop:"4px", color:"#9c9" } }, "Saved to " + nj.filepath);
      row.appendChild(pathEl);
    } else if (wantPath && pathEl) {
      var txt = "Saved to " + nj.filepath;
      if (pathEl.textContent !== txt) pathEl.textContent = txt;
    } else if (!wantPath && pathEl) {
      if (pathEl.parentNode) pathEl.remove();
      pathEl = null;
    }
  }

  return { row: row, update: update };
}

// Adaptive heartbeat: pause when tab hidden
document.addEventListener("visibilitychange", function() {
  if (!document.hidden && _dlListEl && _activeJobs > 0 && !_dlTimer) {
    _pollDl();
  }
});

// ── 4. LOCAL MODELS ─────────────────────────────────────────────────
function renderLocal(pane, force) {
  // Loading state
  pane.innerHTML = "";
  pane.appendChild(el("div", { class: "cvt-spinner" }));
  pane.appendChild(el("div", { style: { textAlign:"center", marginTop:"8px", fontSize:"11px", color:"var(--civ-text-dim)" } }, "Scanning models folder\u2026"));

  _api("/civitai/local-models" + (force ? "?force_refresh=true" : "")).then(function(d) {
    S.local.models = d.models || [];
    _buildLocalUI(pane, d);
  }).catch(function(e) {
    pane.innerHTML = "";
    var errBox = el("div", { class: "cvt-empty", style: { padding:"30px 20px", textAlign:"center" } },
      el("div", { style: { fontSize:"16px", marginBottom:"8px" } }, "\u26A0\uFE0F"),
      el("div", { style: { fontWeight:600, marginBottom:"6px" } }, "Could not scan local models"),
      el("div", { style: { fontSize:"11px", color:"var(--civ-text-mute)" } }, e.message || "Unknown error"),
      el("button", { class: "cvt-btn ghost", style: { marginTop:"14px" } },
        el("span", { class: "emoji-btn emoji-spin-slow" }, "\u21BB"), " Retry"));
    errBox.querySelector("button").onclick = function() { renderLocal(pane); };
    pane.appendChild(errBox);
  });
}

function _buildLocalUI(pane, data) {
  pane.innerHTML = "";

  // Header
  var header = el("div", { style: { display:"flex", alignItems:"center", gap:"8px", marginBottom:"10px", paddingBottom:"8px", borderBottom:"1px solid var(--civ-line)", flexShrink:0 } });
  var totalSize = 0;
  S.local.models.forEach(function(m) {
    if (m.size) {
      var match = m.size.match(/([\d.]+)\s*(GB|MB|KB|TB)/i);
      if (match) {
        var val = parseFloat(match[1]);
        var unit = match[2].toUpperCase();
        if (unit === "KB") totalSize += val / 1024 / 1024;
        else if (unit === "MB") totalSize += val / 1024;
        else if (unit === "GB") totalSize += val;
        else if (unit === "TB") totalSize += val * 1024;
      }
    }
  });
  var sizeStr = totalSize >= 1 ? totalSize.toFixed(1) + " GB" : (totalSize * 1024).toFixed(0) + " MB";
  var count = el("span", { class: "cvt-local-count", style: { flex:"1", textAlign:"left" } },
    S.local.models.length + " model(s)" + (totalSize > 0 ? " \u00B7 \uD83D\uDCBE " + sizeStr : ""));
  count.title = "Scanned " + (data.count || S.local.models.length) + " models";
    var browseBtn = el("button", { class: "cvt-btn ghost" },
      el("span", { class: "emoji-btn emoji-float" }, "\uD83D\uDD0D"), " Browse");
  browseBtn.onclick = function() { if (S.root) S.root.dispatchEvent(new CustomEvent("civitai:show-tab", { detail: "civitai" })); };
  var refreshBtn = el("button", { class: "cvt-btn ghost" },
    el("span", { class: "emoji-btn emoji-spin-slow" }, "\u21BB"), " Refresh");
  refreshBtn.onclick = function() { renderLocal(pane, true); };
  header.appendChild(count); header.appendChild(browseBtn); header.appendChild(refreshBtn);
  pane.appendChild(header);

  // Filter row
  var filterRow = el("div", { class: "cvt-row", style: { marginBottom:"8px", flexWrap:"wrap" } });
  var filterIn = el("input", { type: "text", placeholder: "Filter models\u2026", style: { flex:"1", minWidth:"100px" } });
  filterRow.appendChild(filterIn);
  var scanBtn = el("button", { class: "cvt-btn ghost", style: { padding:"3px 8px", fontSize:"10px" } }, "\uD83D\uDD0D Scan");
  var tagBtn = el("button", { class: "cvt-btn ghost", style: { padding:"3px 8px", fontSize:"10px" } }, "\uD83C\uDFF7 Tag");
  var cleanBtn = el("button", { class: "cvt-btn ghost", style: { padding:"3px 8px", fontSize:"10px" } }, "\uD83E\uDDF9 Clean");
  var orgBtn = el("button", { class: "cvt-btn ghost", style: { padding:"3px 8px", fontSize:"10px" } }, "\uD83D\uDCC2 Org");
  filterRow.appendChild(scanBtn); filterRow.appendChild(tagBtn); filterRow.appendChild(cleanBtn); filterRow.appendChild(orgBtn);
  pane.appendChild(filterRow);
  scanBtn.onclick = function() { renderLocal(pane, true); };
  tagBtn.onclick = function() { _api("/civitai/auto-tag", { method:"POST", body:"{}" }).then(function() { _toast("Auto-tag complete"); }).catch(function(e) { _toast("Tag error: " + e.message, "error"); }); };
  cleanBtn.onclick = function() { _api("/civitai/cleanup-scan", { method:"POST" }).then(function(r) { _toast("Found " + (r.issues||[]).length + " issues"); }).catch(function(e) { _toast("Cleanup error: " + e.message, "error"); }); };
  orgBtn.onclick = function() { _api("/civitai/auto-organize", { method:"POST" }).then(function(r) { _toast("Organized " + (r.moved||0) + " files"); renderLocal(pane, true); }).catch(function(e) { _toast("Organize error: " + e.message, "error"); }); };

  // Grid container
  var grid = el("div", { class: "cvt-grid", id: "cvt-local-grid" });
  pane.appendChild(grid);

  // Empty state
  if (!S.local.models.length) {
    grid.style.display = "block";
    grid.appendChild(el("div", { class: "cvt-empty", style: { marginTop:"20px" } },
      el("div", { style: { fontSize:"32px", marginBottom:"12px" } }, "\uD83D\uDCED"),
      el("div", { style: { fontSize:"14px", fontWeight:600, marginBottom:"6px" } }, "No models found"),
      el("div", { style: { fontSize:"11px", color:"var(--civ-text-mute)", marginBottom:"16px" } },
        "Download models from the Browse or HF tabs and they'll appear here."),
      el("div", { style: { display:"flex", gap:"8px", justifyContent:"center" } },
        el("button", { class: "cvt-btn", onclick: function() { if (S.root) S.root.dispatchEvent(new CustomEvent("civitai:show-tab", { detail: "civitai" })); } },
          "\uD83D\uDD0D Browse Civitai"),
        el("button", { class: "cvt-btn ghost", onclick: function() { if (S.root) S.root.dispatchEvent(new CustomEvent("civitai:show-tab", { detail: "hf" })); } },
          "\uD83E\uDD17 Browse HuggingFace"))));
    return;
  }

  _renderLocalGrid(grid, filterIn);
  filterIn.oninput = function() { _renderLocalGrid(grid, filterIn); };
}

function _renderLocalGrid(grid, filterIn) {
  var q = (filterIn.value || "").toLowerCase();
  var filtered = S.local.models.filter(function(m) {
    return (m.name || "").toLowerCase().indexOf(q) >= 0 ||
           (m.type || "").toLowerCase().indexOf(q) >= 0 ||
           (m.base_model || "").toLowerCase().indexOf(q) >= 0;
  });
  grid.innerHTML = "";
  if (!filtered.length) {
    grid.style.display = "block";
    grid.appendChild(el("div", { class: "cvt-empty" }, "No models match your filter."));
    return;
  }
  grid.style.display = "";
  filtered.forEach(function(m) {
    grid.appendChild(_localCard(m, grid, filterIn));
  });
}

function _localCard(m, grid, filterIn) {
  var localBand = bandIdOfModel(m);
  var isNsfw = isBlurred(localBand);
  var imgUrl = m.preview ? "/civitai/local-preview?path=" + encodeURIComponent(m.preview) + "&w=450" : "";
  var card = el("div", { class: "cvt-card" });
  var thumb = el("div", { class: "thumb", style: { aspectRatio: "3/4", background: "linear-gradient(135deg,#1a1a1a,#0f0f0f)", position:"relative", overflow:"hidden" } });
  if (imgUrl) {
    thumb.appendChild(el("img", { src: imgUrl, style: { width:"100%", height:"100%", objectFit:"cover", display:"block" }, onerror: function() { this.style.display = "none"; } }));
  }
  applyBlur(thumb, localBand);
  // Hover overlay for prompt info (lazy-fetched, cached globally)
  var promptOverlay = el("div", { style: { position:"absolute", bottom:"0", left:"0", right:"0", transform:"translateY(100%)", transition:"transform .2s var(--civ-ease-out)", background:"linear-gradient(transparent,rgba(0,0,0,.9))", padding:"24px 6px 6px", fontSize:"9px", lineHeight:"1.3", color:"#ddd", display:"flex", flexDirection:"column", gap:"2px", pointerEvents:"none" } });
  thumb.appendChild(promptOverlay);
  thumb.addEventListener("mouseenter", function() {
    promptOverlay.style.transform = "translateY(0)";
    var cached = _localPromptCache[m.path];
    if (cached) {
      promptOverlay.innerHTML = "";
      if (cached.prompt) promptOverlay.appendChild(el("div", { style: { overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" } }, "P: " + cached.prompt));
      if (cached.negativePrompt) promptOverlay.appendChild(el("div", { style: { overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", opacity:".7" } }, "N: " + cached.negativePrompt));
      if (!cached.prompt && !cached.negativePrompt) promptOverlay.appendChild(el("div", { style: { opacity:".5" } }, "No prompt data"));
    } else if (m.path) {
      _api("/civitai/local-previews?path=" + encodeURIComponent(m.path)).then(function(r) {
        var first = (r.images || [])[0] || {};
        _localPromptCache[m.path] = first;
        if (promptOverlay.style.transform !== "translateY(0px)") return;
        promptOverlay.innerHTML = "";
        if (first.prompt) promptOverlay.appendChild(el("div", { style: { overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" } }, "P: " + first.prompt));
        if (first.negativePrompt) promptOverlay.appendChild(el("div", { style: { overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", opacity:".7" } }, "N: " + first.negativePrompt));
        if (!first.prompt && !first.negativePrompt) promptOverlay.appendChild(el("div", { style: { opacity:".5" } }, "No prompt data"));
      }).catch(function() {});
    }
  });
  thumb.addEventListener("mouseleave", function() { promptOverlay.style.transform = "translateY(100%)"; });
  card.appendChild(thumb);

  var body = el("div", { class: "body" });
  body.appendChild(el("div", { class: "title" }, m.name || "Unknown"));

  var meta = el("div", { class: "meta" });
  meta.appendChild(el("span", {}, m.type || "?"));
  if (m.base_model) meta.appendChild(el("span", { style: { fontSize:"9px", opacity:".6" } }, m.base_model));
  meta.appendChild(makeBandBadge(localBand));
  body.appendChild(meta);
  card.appendChild(body);

  card.onclick = function() { openLocalDetail(m, grid, filterIn); };
  return card;
}

// ── 5. SETTINGS ────────────────────────────────────────────────
function renderSettings(pane) {
  pane.innerHTML = "";   // idempotent — a re-render must never stack a second copy
  var s = el("div", { class: "cvt-settings" });

  // API Keys
  s.appendChild(el("div", { class: "cvt-settings-section-title" }, "\uD83D\uDD11 API Keys"));

  var apiGroup = el("div", { class: "group" });
  var apiHeader = el("div", { class: "cvt-settings-row" });
  apiHeader.appendChild(el("span", { class: "cvt-settings-label" }, "Civitai API Key"));
  var apiBadge = el("span", { class: "cvt-settings-badge" }, "not set");
  apiHeader.appendChild(apiBadge);
  apiGroup.appendChild(apiHeader);
  apiGroup.appendChild(el("div", { class: "cvt-settings-hint" }, "Required for private/gated models. Get one at civitai.com/user/account \u2192 API Keys. Starts with civitai_"));
  var apiIn = el("input", { type: "password", placeholder: "Paste your Civitai API key\u2026", autocomplete: "off" });
  apiGroup.appendChild(apiIn);
  var apiBtns = el("div", { class: "cvt-settings-btns" });
  var apiSaveBtn = el("button", { class: "cvt-btn cvt-btn-xs" }, "\uD83D\uDCBE Save");
  var apiShowBtn = el("button", { class: "cvt-btn ghost cvt-btn-xs" }, "\uD83D\uDC41");
  var apiClearBtn = el("button", { class: "cvt-btn ghost cvt-btn-xs" }, "\uD83D\uDDD1");
  apiBtns.appendChild(apiSaveBtn); apiBtns.appendChild(apiShowBtn); apiBtns.appendChild(apiClearBtn);
  apiGroup.appendChild(apiBtns);
  var apiStatus = el("div", { class: "cvt-settings-status" });
  apiGroup.appendChild(apiStatus);
  s.appendChild(apiGroup);

  var hfGroup = el("div", { class: "group" });
  var hfHeader = el("div", { class: "cvt-settings-row" });
  hfHeader.appendChild(el("span", { class: "cvt-settings-label" }, "\uD83E\uDD17 Hugging Face Token"));
  var hfBadge = el("span", { class: "cvt-settings-badge" }, "not set");
  hfHeader.appendChild(hfBadge);
  hfGroup.appendChild(hfHeader);
  hfGroup.appendChild(el("div", { class: "cvt-settings-hint" }, "For private/gated repos. Get one at huggingface.co/settings/tokens"));
  var hfIn = el("input", { type: "password", placeholder: "Paste your HF token\u2026", autocomplete: "off" });
  hfGroup.appendChild(hfIn);
  var hfBtns = el("div", { class: "cvt-settings-btns" });
  var hfSaveBtn = el("button", { class: "cvt-btn cvt-btn-xs" }, "\uD83D\uDCBE Save");
  var hfShowBtn = el("button", { class: "cvt-btn ghost cvt-btn-xs" }, "\uD83D\uDC41");
  var hfClearBtn = el("button", { class: "cvt-btn ghost cvt-btn-xs" }, "\uD83D\uDDD1");
  hfBtns.appendChild(hfSaveBtn); hfBtns.appendChild(hfShowBtn); hfBtns.appendChild(hfClearBtn);
  hfGroup.appendChild(hfBtns);
  var hfStatus = el("div", { class: "cvt-settings-status" });
  hfGroup.appendChild(hfStatus);
  s.appendChild(hfGroup);

  // Preferences
  s.appendChild(el("div", { class: "cvt-settings-section-title" }, "\u2699\uFE0F Preferences"));
  var prefsGroup = el("div", { class: "group" });
  var cbMeta = el("input", { type: "checkbox" });
  var cbPrev = el("input", { type: "checkbox" });
  var cbHash = el("input", { type: "checkbox" });
  var cbNsfwBlur = el("input", { type: "checkbox" });
  cbNsfwBlur.onchange = function() {
    window.__nsfwBlurEnabled = cbNsfwBlur.checked;
    if (typeof window.__cvtReapplyBlur === "function") window.__cvtReapplyBlur();
  };
  // Which bands get blurred — Off / R+ / X+ (default) / XXX
  var blurSel = buildBlurThresholdSelect(window.__nsfwBlurLevel || DEFAULT_BLUR_THRESHOLD);
  blurSel.onchange = function() {
    window.__nsfwBlurLevel = blurSel.value;
    if (typeof window.__cvtReapplyBlur === "function") window.__cvtReapplyBlur();
  };
  var cbCompact = el("input", { type: "checkbox" });
  cbCompact.onchange = function() { if (cbCompact.checked) S.root.classList.add("compact"); else S.root.classList.remove("compact"); };
  [[cbMeta,"\uD83D\uDCC4 Save .civitai.json metadata alongside models"],
   [cbPrev,"\uD83D\uDDBC\uFE0F Save preview images alongside models"],
   [cbHash,"\uD83D\uDD10 Verify SHA256 hash after download"],
   [cbNsfwBlur,"\uD83D\uDE48 Blur NSFW images (X / XXX) in card grid and previews"],
   [cbCompact,"\uD83D\uDCCA Compact grid mode (smaller cards, more columns)"]].forEach(function(item) {
    prefsGroup.appendChild(el("label", { class: "cvt-settings-toggle" }, item[0], el("span", {}, item[1])));
  });
  // Blur threshold + band legend
  prefsGroup.appendChild(el("div", { class: "cvt-settings-row", style: { marginTop:"6px" } },
    el("span", { class: "cvt-settings-label" }, "\uD83D\uDCA7 Blur content rated"),
    blurSel));
  prefsGroup.appendChild(el("div", { class: "cvt-settings-hint" },
    "Only the NSFW bands (X = graphic nudity, XXX = overtly sexual) are blurred by default. " +
    "R (mature) is flagged with a red badge but stays visible — pick \u201cR and up\u201d to blur it too."));
  var legend = el("div", { class: "cvt-band-legend" });
  CONTENT_BANDS.forEach(function(b) {
    legend.appendChild(el("span", { class: "cvt-band-chip", title: b.id + " \u2014 " + b.label + "\n" + b.blurb, style: { borderColor: b.color } },
      el("i", { style: { background: b.color } }), b.id, el("em", {}, b.label)));
  });
  prefsGroup.appendChild(legend);
  s.appendChild(prefsGroup);

  // Network
  s.appendChild(el("div", { class: "cvt-settings-section-title" }, "\uD83C\uDF10 Network"));
  var netGroup = el("div", { class: "group" });
  netGroup.appendChild(el("div", { class: "cvt-settings-row" }, el("span", { class: "cvt-settings-label" }, "Civitai API Domain"), el("span", { class: "cvt-settings-hint", style:{fontSize:"10px"} }, "Switch if main domain is blocked")));
  var baseSel = el("select");
  [{v:"civitai.com",l:"civitai.com (default)"},{v:"civitai.red",l:"civitai.red (mirror)"},{v:"civitai.work",l:"civitai.work (mirror)"}].forEach(function(b) { baseSel.appendChild(el("option", { value: b.v }, b.l)); });
  netGroup.appendChild(baseSel);
  s.appendChild(netGroup);

  // Quick Actions
  s.appendChild(el("div", { class: "cvt-settings-section-title" }, "\u26A1 Quick Actions"));
  var qaGroup = el("div", { class: "group" });
  var qaGrid = el("div", { class: "cvt-settings-actions-grid" });
  [["\uD83D\uDD04 Refresh Nodes","Reload all node model dropdowns",function(){try{var r=app.refreshComboInNodes&&app.refreshComboInNodes();Promise.resolve(r).then(function(){_toast("Nodes refreshed","ok")}).catch(function(e){_toast("Error: "+(e&&e.message||e),"error")});}catch(e){_toast("Error: "+e.message,"error")}}]].forEach(function(a){
    var card = el("div",{class:"cvt-settings-action-card",onclick:a[2]});
    card.appendChild(el("div",{class:"cvt-settings-action-title"},a[0]));
    card.appendChild(el("div",{class:"cvt-settings-action-desc"},a[1]));
    qaGrid.appendChild(card);
  });
  qaGroup.appendChild(qaGrid);
  s.appendChild(qaGroup);

  // Bottom buttons
  var actionBar = el("div",{class:"cvt-settings-bottom"});
  var saveBtn = el("button",{class:"cvt-btn"},"\u2714\uFE0F Save All Settings");
  var testBtn = el("button",{class:"cvt-btn ghost"},"\uD83D\uDD0C Test Connection");
  var clearCacheBtn = el("button",{class:"cvt-btn ghost"},"\uD83E\uDDF9 Clear Cache");
  actionBar.appendChild(saveBtn); actionBar.appendChild(testBtn); actionBar.appendChild(clearCacheBtn);
  s.appendChild(actionBar);
  var sStatus = el("div",{class:"cvt-settings-status",style:{textAlign:"center",marginTop:"6px"}});
  s.appendChild(sStatus);
  pane.appendChild(s);

  // Load settings
  _api("/civitai/settings").then(function(cfg){
    baseSel.value = (cfg.network_choice||"com")==="com"?"civitai.com":(cfg.network_choice==="work"?"civitai.work":"civitai.red");
    cbMeta.checked = cfg.save_metadata!==false;
    cbPrev.checked = cfg.save_preview!==false;
    cbHash.checked = cfg.verify_sha256!==false;
    cbNsfwBlur.checked = cfg.nsfw_blur!==false;
    window.__nsfwBlurEnabled = cfg.nsfw_blur!==false;
    window.__nsfwBlurLevel = cfg.nsfw_blur_level || DEFAULT_BLUR_THRESHOLD;
    blurSel.value = window.__nsfwBlurLevel;
    cbCompact.checked = cfg.compact_grid===true;
    if(cfg.has_api_key){apiBadge.className="cvt-settings-badge active";apiBadge.textContent="connected";}
    if(cfg.has_token){hfBadge.className="cvt-settings-badge active";hfBadge.textContent="connected";}
  }).catch(function(){});

  apiShowBtn.onclick=function(){if(apiIn.type==="password"){apiIn.type="text";apiShowBtn.textContent="\uD83D\uDE48";}else{apiIn.type="password";apiShowBtn.textContent="\uD83D\uDC41";}};
  hfShowBtn.onclick=function(){if(hfIn.type==="password"){hfIn.type="text";hfShowBtn.textContent="\uD83D\uDE48";}else{hfIn.type="password";hfShowBtn.textContent="\uD83D\uDC41";}};
  apiSaveBtn.onclick=function(){var v=apiIn.value.trim();if(!v){apiStatus.innerHTML="<span style='color:#e88'>Paste a key first.</span>";return;}apiSaveBtn.disabled=true;apiStatus.innerHTML="<span style='color:var(--civ-text-mute)'>Saving\u2026</span>";_cache.del("/civitai/settings");_api("/civitai/settings",{method:"POST",body:JSON.stringify({api_key:v})}).then(function(r){apiIn.value="";if(r.has_api_key){apiBadge.className="cvt-settings-badge active";apiBadge.textContent="connected";}apiStatus.innerHTML=r.has_api_key?"<span style='color:#6d6'>\u2713 API key saved</span>":"<span style='color:#cc9'>Key cleared</span>";}).catch(function(e){apiStatus.innerHTML="<span style='color:#e88'>Error: "+e.message+"</span>";}).then(function(){apiSaveBtn.disabled=false;});};
  apiClearBtn.onclick=function(){if(!confirm("Remove the saved Civitai API key?"))return;_api("/civitai/settings",{method:"POST",body:JSON.stringify({api_key:""})}).then(function(){apiIn.value="";apiBadge.className="cvt-settings-badge";apiBadge.textContent="not set";apiStatus.innerHTML="<span style='color:#cc9'>Key removed</span>";}).catch(function(e){apiStatus.innerHTML="<span style='color:#e88'>Error: "+e.message+"</span>";});};
  apiIn.onkeydown=function(e){if(e.key==="Enter")apiSaveBtn.click();};
  hfSaveBtn.onclick=function(){var v=hfIn.value.trim();if(!v){hfStatus.innerHTML="<span style='color:#e88'>Paste a token first.</span>";return;}hfSaveBtn.disabled=true;hfStatus.innerHTML="<span style='color:var(--civ-text-mute)'>Saving\u2026</span>";_api("/civitai/hf/token",{method:"POST",body:JSON.stringify({token:v})}).then(function(r){hfIn.value="";if(r.has_token){hfBadge.className="cvt-settings-badge active";hfBadge.textContent="connected";}hfStatus.innerHTML=r.has_token?"<span style='color:#6d6'>\u2713 Token saved</span>":"<span style='color:#cc9'>Token cleared</span>";}).catch(function(e){hfStatus.innerHTML="<span style='color:#e88'>Error: "+e.message+"</span>";}).then(function(){hfSaveBtn.disabled=false;});};
  hfClearBtn.onclick=function(){if(!confirm("Remove the saved HF token?"))return;_api("/civitai/hf/token",{method:"POST",body:JSON.stringify({token:""})}).then(function(){hfIn.value="";hfBadge.className="cvt-settings-badge";hfBadge.textContent="not set";hfStatus.innerHTML="<span style='color:#cc9'>Token removed</span>";}).catch(function(e){hfStatus.innerHTML="<span style='color:#e88'>Error: "+e.message+"</span>";});};
  hfIn.onkeydown=function(e){if(e.key==="Enter")hfSaveBtn.click();};
  saveBtn.onclick=function(){saveBtn.disabled=true;sStatus.innerHTML="<span style='color:var(--civ-text-mute)'>Saving\u2026</span>";var body={network_choice:baseSel.value==="civitai.red"?"red":baseSel.value==="civitai.work"?"work":"com",save_metadata:cbMeta.checked,save_preview:cbPrev.checked,verify_sha256:cbHash.checked,nsfw_blur:cbNsfwBlur.checked,nsfw_blur_level:blurSel.value,compact_grid:cbCompact.checked,theme:S.root.classList.contains("light")?"light":"dark"};S.settings.saveMeta=cbMeta.checked;S.settings.savePrev=cbPrev.checked;S.settings.verifySha=cbHash.checked;S.settings.nsfwBlur=cbNsfwBlur.checked;window.__nsfwBlurLevel=blurSel.value;_cache.del("/civitai/settings");_api("/civitai/settings",{method:"POST",body:JSON.stringify(body)}).then(function(){sStatus.innerHTML="<span style='color:#6d6'>\u2713 All settings saved</span>";_toast("Settings saved","ok");}).catch(function(e){sStatus.innerHTML="<span style='color:#e88'>Error: "+e.message+"</span>";}).then(function(){saveBtn.disabled=false;});};
  testBtn.onclick=function(){testBtn.disabled=true;sStatus.innerHTML="<span style='color:var(--civ-text-mute)'>Testing\u2026</span>";_api("/civitai/ping").then(function(r){sStatus.innerHTML=r.has_api_key?"<span style='color:#6d6'>\u2713 Connected \u2014 API key recognised</span>":"<span style='color:#cc9'>Connected \u2014 no API key (public only)</span>";}).catch(function(e){sStatus.innerHTML="<span style='color:#e88'>\u2717 Failed: "+e.message+"</span>";}).then(function(){testBtn.disabled=false;});};
  clearCacheBtn.onclick=function(){clearCacheBtn.disabled=true;_api("/civitai/cache/clear",{method:"POST"}).then(function(r){_cache.clear();_toast("Cache cleared");sStatus.innerHTML="<span style='color:#6d6'>\u2713 Cache cleared</span>";}).catch(function(e){_toast("Clear failed: "+e.message,"error");}).then(function(){clearCacheBtn.disabled=false;});};
}

// ── 6. MOUNT ─────────────────────────────────────────────────────────
try {
app.registerExtension({
  name: "CivitaiHF.Browser",
  setup: function() {
    installSidebarLogo("civitai-hf", "Civitai");
    (function tryMount() {
      if (app.extensionManager && app.extensionManager.registerSidebarTab) {
        app.extensionManager.registerSidebarTab({
          id: "civitai-hf",
          icon: "pi pi-globe",
          title: "Civitai+HF",
          tooltip: "Civitai & Hugging Face Downloader",
          type: "custom",
          render: function(root) {
            root.innerHTML = "";
            try {
              root.appendChild(buildUI());
            } catch(e) {
              console.error("[CivitaiHF] buildUI error:", e);
              root.innerHTML = "<div style='color:#f88;padding:20px;font-size:12px;'>Extension error: " + e.message + "<br>Check browser console (F12) for details.</div>";
            }
          },
        });
        return true;
      }
      return false;
    })() || setTimeout(function() {
      (function tryMount() {
        if (app.extensionManager && app.extensionManager.registerSidebarTab) {
          app.extensionManager.registerSidebarTab({
            id: "civitai-hf",
            icon: "pi pi-globe",
            title: "Civitai+HF",
            tooltip: "Civitai & Hugging Face Downloader",
            type: "custom",
            render: function(root) {
              root.innerHTML = "";
              root.appendChild(buildUI());
            },
          });
          return true;
        }
        return false;
      })();
    }, 2000);
  },
});
} catch(initErr) { console.error("[CivitaiHF] Init error:", initErr); }
// Import content rating module
// Rating logic handled by rating.js (PG / PG-13 / R / X / XXX)
