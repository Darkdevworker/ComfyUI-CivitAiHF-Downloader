import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// ── el() helper – lightweight DOM builder ──────────────────────────
function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    if (typeof c === "string" || typeof c === "number") node.appendChild(document.createTextNode(c));
    else if (c instanceof Node) node.appendChild(c);
    else if (Array.isArray(c)) for (const x of c.flat(Infinity)) if (x instanceof Node) node.appendChild(x);
  }
  return node;
}

// ── State ───────────────────────────────────────────────────────────
const S = {
  curTab: "civitai",
  civitai: { items: [], page: 1, query: "", type: "", sort: "Newest", nsfw: false },
  hf: { items: [], query: "", sort: "lastModified" },
  downloads: [],
  local: { models: [], filter: "" },
  settings: { baseUrl: "civitai.com", saveMeta: true, savePrev: true, verify: true, nsfw: false, hasApiKey: false, hasHfToken: false },
  modal: null, lightbox: null,
};

// ── Helpers ─────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }
function _txt(t) { return document.createTextNode(t); }
function _api(path, opts = {}) { return api.fetchApi(path, opts).then(r => r.json()); }
function _fmtBytes(n) { if (!n) return "—"; const u = ["B","KB","MB","GB","TB"]; let i = 0; let s = n; while (s >= 1024 && i < 4) { s /= 1024; i++; } return s.toFixed(i > 1 ? 1 : 0) + " " + u[i]; }
function _fmtNum(n) { if (n == null) return "?"; if (n < 1e3) return String(n); if (n < 1e6) return (n/1e3).toFixed(n<1e4?1:0)+"K"; if (n < 1e9) return (n/1e6).toFixed(n<1e7?1:0)+"M"; return (n/1e9).toFixed(1)+"B"; }
function _toast(msg, type = "ok") {
  let wrap = document.querySelector(".cvt-toast-wrap");
  if (!wrap) { wrap = el("div", { class: "cvt-toast-wrap" }); document.body.appendChild(wrap); }
  const t = el("div", { class: `cvt-toast ${type}` }, msg);
  wrap.appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .3s"; setTimeout(() => t.remove(), 300); }, 3000);
}

// ── Load CSS ────────────────────────────────────────────────────────
(function injectCSS() {
  if (document.getElementById("cvt-css")) return;
  const link = document.createElement("link");
  link.id = "cvt-css"; link.rel = "stylesheet";
  try { link.href = new URL("civitai.css", import.meta.url).href; }
  catch(e) { link.href = "/extensions/ComfyUI-CivitAiHF-Downloader/civitai.css"; }
  document.head.appendChild(link);
})();

// ── Build root UI ───────────────────────────────────────────────────
const TABS = [
  ["civitai", "Browse", "🔍"], ["hf", "HF", "🤗"],
  ["downloads", "Downloads", "⬇"], ["local", "Local", "📁"], ["settings", "⚙", "⚙"],
];

function buildUI() {
  const root = el("div", { class: "cvt-root" });
  const tabBar = el("div", { class: "cvt-tabs" });
  const panes = {};
  TABS.forEach(([id, label, icon]) => {
    const btn = el("button", { class: `cvt-tab${id==="civitai"?" active":""}`, dataset: { tab: id } },
      el("span", { class: "tab-emoji" }, icon), " ", label);
    btn.onclick = () => switchTab(id, tabBar, panes);
    tabBar.appendChild(btn);
    const pane = el("div", { class: `cvt-pane${id==="civitai"?" active":""}`, id: `cvt-pane-${id}` });
    panes[id] = pane;
    root.appendChild(pane);
  });
  root.insertBefore(tabBar, root.firstChild);
  // Populate initial active tab
  renderBrowse(panes.civitai);
  return { root, tabBar, panes };
}

function switchTab(id, tabBar, panes) {
  S.curTab = id;
  tabBar.querySelectorAll(".cvt-tab").forEach(b => b.classList.toggle("active", b.dataset.tab === id));
  Object.entries(panes).forEach(([k, p]) => p.classList.toggle("active", k === id));
  const pane = panes[id];
  if (!pane) return;
  pane.innerHTML = "";
  if (id === "civitai") renderBrowse(pane);
  else if (id === "hf") renderHF(pane);
  else if (id === "downloads") renderDownloads(pane);
  else if (id === "local") renderLocal(pane);
  else if (id === "settings") renderSettings(pane);
}

// ── Emoji animations (reusable) ─────────────────────────────────────
const _emojiAnim = { "🔍":"emoji-float", "🤗":"emoji-bounce", "⬇":"emoji-pulse", "📁":"emoji-wiggle", "⚙":"emoji-spin" };

// =====================================================================
// 1. BROWSE — Civitai model search
// =====================================================================
let _browseBuilt = false;
function renderBrowse(pane) {
  _browseBuilt = true;
  const sb = el("div", { class: "cvt-searchbar" });

  const row1 = el("div", { class: "cvt-row" });
  const qIn = el("input", { type: "text", placeholder: "Search Civitai…", id: "cvt-q" });
  const sortSel = el("select", { id: "cvt-sort" },
    ...(["Newest","Most Downloaded","Highest Rated"].map(s => el("option", { value: s }, s))));
  row1.append(qIn, sortSel);
  sb.appendChild(row1);

  const row2 = el("div", { class: "cvt-row" });
  const nsfwCb = el("input", { type: "checkbox", id: "cvt-nsfw" });
  const nsfwLbl = el("label", { style: { display:"flex",alignItems:"center",gap:"4px",fontSize:"12px",whiteSpace:"nowrap",color:"var(--civ-text-dim)" } }, nsfwCb, " NSFW");
  const typeSel = el("select", { id: "cvt-type", style: { flex:"0 0 auto" } },
    ...(["","Checkpoint","LORA","TextualInversion","VAE"].map(t => el("option", { value: t }, t || "All types"))));
  const goBtn = el("button", { class: "cvt-btn" }, el("span", { class: "emoji-btn emoji-float" }, "🔍"), " Search");
  row2.append(nsfwLbl, typeSel, goBtn);
  sb.appendChild(row2);
  pane.appendChild(sb);

  const grid = el("div", { class: "cvt-grid", id: "cvt-grid" });
  const empty = el("div", { class: "cvt-empty" }, "Use the search bar above to find models on Civitai.");
  pane.append(grid, empty);
  const pager = el("div", { class: "cvt-pager" });
  const prevBtn = el("button", { class: "cvt-btn ghost", disabled: "true" }, "← Prev");
  const pageInfo = el("span", { class: "page-info" }, "Page 1");
  const nextBtn = el("button", { class: "cvt-btn ghost" }, "Next →");
  pager.append(prevBtn, pageInfo, nextBtn);
  pane.appendChild(pager);

  async function search() {
    grid.innerHTML = `<div class="cvt-spinner"></div>`;
    empty.style.display = "none";
    S.civitai.query = qIn.value;
    S.civitai.sort = sortSel.value;
    S.civitai.nsfw = nsfwCb.checked;
    S.civitai.type = typeSel.value;
    const params = new URLSearchParams({ query: S.civitai.query, sort: S.civitai.sort, page: S.civitai.page, nsfw: S.civitai.nsfw, type: S.civitai.type });
    try {
      const d = await _api(`/civitai/search?${params}`);
      S.civitai.items = d.items || [];
      grid.innerHTML = "";
      if (!S.civitai.items.length) { empty.style.display = "block"; empty.textContent = "No models found."; return; }
      S.civitai.items.forEach(m => grid.appendChild(_card(m)));
      pageInfo.textContent = `Page ${S.civitai.page}`;
      prevBtn.disabled = S.civitai.page <= 1;
    } catch (e) { grid.innerHTML = ""; empty.style.display = "block"; empty.innerHTML = `<span style="color:#f88">Error: ${e.message}</span>`; }
  }

  goBtn.onclick = () => { S.civitai.page = 1; search(); };
  qIn.onkeydown = e => { if (e.key === "Enter") { S.civitai.page = 1; search(); } };
  prevBtn.onclick = () => { if (S.civitai.page > 1) { S.civitai.page--; search(); } };
  nextBtn.onclick = () => { S.civitai.page++; search(); };
}

function _card(m) {
  const imgUrl = m.images?.[0]?.url || m.images?.[0]?.url || "";
  const card = el("div", { class: "cvt-card" });
  const thumb = el("div", { class: "thumb", style: { background: `url(${imgUrl}) center/cover`, aspectRatio: "3/4" } });
  if (!imgUrl) thumb.style.background = "linear-gradient(135deg,#1a1a1a,#0f0f0f)";
  if (m.nsfw) thumb.classList.add("cvt-nsfw-blur");
  card.appendChild(thumb);
  const body = el("div", { class: "body" },
    el("div", { class: "title" }, m.name || "Untitled"),
    el("div", { class: "meta" },
      el("span", {}, m.type || "?"),
      el("span", {}, `⬇ ${_fmtNum(m.downloadCount||0)}`),
      m.nsfw ? el("span", { class: "cvt-badge nsfw" }, "NSFW") : null,
    ),
  );
  card.appendChild(body);
  card.onclick = () => openDetail(m);
  return card;
}

// ── Detail Modal ────────────────────────────────────────────────────
async function openDetail(model) {
  closeModal();
  const bg = el("div", { class: "cvt-modal-bg" });
  const wrap = el("div", { class: "cvt-modal-wrap" });
  const close = el("button", { class: "close" }, "×");
  const modal = el("div", { class: "cvt-modal" });
  wrap.append(close, modal); bg.appendChild(wrap);
  S.modal = bg; document.body.appendChild(bg);
  close.onclick = closeModal; bg.onclick = e => { if (e.target === bg) closeModal(); };

  const left = el("div", { class: "left" });
  const right = el("div", { class: "right" });
  modal.append(left, right);

  left.append(el("h2", {}, model.name || ""));
  left.append(el("div", { class: "sub" }, `by ${model.creator?.username || "?"} · ${model.type || ""}`));
  const gallery = el("div", { class: "gallery", id: "cvt-gallery" });
  gallery.innerHTML = `<div class="cvt-spinner"></div>`;
  left.appendChild(gallery);

  right.innerHTML = `<div class="cvt-spinner"></div>`;

  try {
    const vd = await _api(`/civitai/model-versions?id=${model.id}`);
    const versions = vd.items || [];
    if (!versions.length) { right.innerHTML = `<div class="cvt-empty">No versions</div>`; return; }
    const v = versions[0];
    _renderVersion(v, right, gallery, model);
  } catch (e) { right.innerHTML = `<div class="cvt-empty">Error: ${e.message}</div>`; }
}

function _renderVersion(v, right, gallery, model) {
  right.innerHTML = "";
  right.append(el("div", { style: { fontSize:"14px", fontWeight:600, marginBottom:"6px" } }, v.name || "Version"),
    el("div", { class: "sub" }, v.model?.type ? `Base: ${v.model.type}` : ""));

  // Files
  const files = (v.files || []).map((f, i) => {
    const row = el("div", { class: "f" },
      el("span", {}, `${f.name || `file_${i}`}${f.primary?" ★":""}`),
      el("span", { style: { display:"flex", gap:"4px", alignItems:"center" } },
        el("span", { style: { color:"var(--civ-text-mute)" } }, _fmtBytes((f.sizeKB||0)*1024)),
        el("button", { class: "cvt-btn ghost", style: { padding:"2px 8px", fontSize:"10px" }, dataset: { url: f.downloadUrl, name: f.name } }, "⬇")));
    return row;
  });
  const fl = el("div", { class: "cvt-files-list" });
  files.forEach(f => fl.appendChild(f));
  right.append(el("label", {}, "Files"), fl);

  // Trigger words
  if (v.trainedWords?.length) {
    const tw = el("div", { style: { margin:"8px 0", fontSize:"11px" } },
      el("div", { style: { color:"var(--civ-text-mute)", marginBottom:"4px", fontSize:"10px", textTransform:"uppercase", fontWeight:600 } }, "Trigger Words:"));
    v.trainedWords.forEach(t => tw.appendChild(el("code", { style: { background:"#333", padding:"2px 6px", borderRadius:"3px", margin:"2px", fontSize:"11px" } }, t)));
    right.appendChild(tw);
  }

  // Description
  if (v.description) {
    const desc = el("div", { class: "cvt-files-list", style: { maxHeight:"80px", padding:"8px 10px", marginTop:"8px", fontSize:"11.5px", lineHeight:1.5 } });
    desc.innerHTML = v.description;
    right.appendChild(desc);
  }

  // Download options
  right.append(el("label", { style: { marginTop:"10px" } }, "Subfolder"));
  const subRow = el("div", { class: "cvt-row", style: { alignItems:"center" } });
  const subIn = el("input", { type: "text", placeholder: "optional", style: { flex:1 } });
  const autoCb = el("input", { type: "checkbox", id: "cvt-autofold" });
  subRow.append(subIn, el("label", { style: { display:"flex", alignItems:"center", gap:"4px", fontSize:"11px", whiteSpace:"nowrap" } }, autoCb, " auto"));
  right.append(subRow);
  const dlBtn = el("button", { class: "cvt-btn", style: { width:"100%", marginTop:"8px", padding:"10px 0" } }, "⬇ Download All");
  right.appendChild(dlBtn);
  dlBtn.onclick = () => {
    const sf = subIn.value || (autoCb.checked ? (v.name||"").replace(/[^a-zA-Z0-9_-]/g,"_").toLowerCase() : "");
    right.querySelectorAll(".cvt-files-list .f button").forEach(b => {
      const url = b.dataset.url; const name = b.dataset.name;
      if (url) _startDl(url, name, sf);
    });
  };

  // Images
  _api(`/civitai/images?versionId=${v.id}&page=1`).then(d => {
    gallery.innerHTML = "";
    const items = d.items || [];
    if (!items.length) { gallery.innerHTML = `<div class="cvt-empty" style="grid-column:1/-1">No images</div>`; return; }
    items.forEach(img => {
      const wrapper = el("div", { style: { position:"relative", cursor:"pointer" } });
      const nsfw = img.nsfw || img.nsfwLevel > 1;
      const imgEl = el("img", { src: img.url, class: nsfw ? "cvt-nsfw-blur" : "", loading: "lazy" });
      wrapper.appendChild(imgEl);
      wrapper.onclick = () => openLightbox(img, model);
      gallery.appendChild(wrapper);
    });
  });
}

// ── Lightbox ────────────────────────────────────────────────────────
function openLightbox(img, model) {
  closeLightbox();
  const bg = el("div", { class: "cvt-lightbox-bg" });
  const content = el("div", { style: { display:"flex", alignItems:"flex-start", maxWidth:"96vw", maxHeight:"90vh" } });
  const iEl = el("img", { src: img.url, style: { maxWidth:"65vw", maxHeight:"88vh", objectFit:"contain", borderRadius:"var(--civ-radius)", boxShadow:"0 20px 60px rgba(0,0,0,.7)" } });
  content.appendChild(iEl);

  const meta = img.meta || {};
  const panel = el("div", { class: "cvt-gen-panel" });
  panel.append(el("div", { class: "cvt-gen-heading" }, "Generation Parameters"));

  const fields = [
    ["prompt", "Positive Prompt", true], ["negativePrompt", "Negative Prompt", true],
    ["Model", "Model"], ["seed", "Seed"], ["steps", "Steps"],
    ["cfgScale", "CFG"], ["sampler", "Sampler"], ["scheduler", "Scheduler"],
    ["Size", "Size"], ["Denoising strength", "Denoising"],
  ];
  fields.forEach(([k, t, isPrompt]) => {
    const val = meta[k];
    if (!val) return;
    if (isPrompt) {
      const box = el("div", { class: "cvt-prompt-box" });
      box.append(el("div", { class: "cvt-gen-label" }, t),
        el("div", { class: "cvt-prompt-text" }, val),
        el("button", { class: "cvt-btn ghost", style: { marginTop:"4px", fontSize:"10px", padding:"3px 10px" }, onclick: () => { navigator.clipboard.writeText(val).then(()=>_toast("Copied!")); } }, "📋 Copy"));
      panel.appendChild(box);
    } else {
      panel.append(el("div", { class: "cvt-gen-row" },
        el("span", { class: "cvt-gen-label" }, t),
        el("span", { class: "cvt-gen-value" }, String(val))));
    }
  });
  content.appendChild(panel);
  bg.appendChild(content);
  S.lightbox = bg; document.body.appendChild(bg);
  bg.onclick = e => { if (e.target === bg) closeLightbox(); };
}

function closeLightbox() { if (S.lightbox) { S.lightbox.remove(); S.lightbox = null; } }
function closeModal() { if (S.modal) { S.modal.remove(); S.modal = null; } }

document.addEventListener("keydown", function(e) { if (e.key === "Escape") { closeModal(); closeLightbox(); } });

// ── Download helper ──────────────────────────────────────────────────
async function _startDl(url, name, subfolder) {
  try {
    await _api("/civitai/download", { method: "POST", body: JSON.stringify({ url, filename: name, subfolder }) });
    _toast(`Queued: ${name}`);
  } catch (e) { _toast(`Download failed: ${e.message}`, "error"); }
}

// =====================================================================
// 2. HUGGING FACE
// =====================================================================
function renderHF(pane) {
  const sb = el("div", { class: "cvt-searchbar" });
  const row1 = el("div", { class: "cvt-row" });
  const qIn = el("input", { type: "text", placeholder: "Search Hugging Face…", id: "cvt-hf-q" });
  const sortSel = el("select", { id: "cvt-hf-sort" },
    ...(["lastModified","downloads","likes"].map(s => el("option", { value: s }, s))));
  row1.append(qIn, sortSel);
  sb.appendChild(row1);
  const row2 = el("div", { class: "cvt-row" });
  const goBtn = el("button", { class: "cvt-btn" }, el("span", { class: "emoji-btn emoji-float" }, "🔍"), " Search HF");
  row2.appendChild(goBtn);
  sb.appendChild(row2);
  pane.appendChild(sb);

  const grid = el("div", { class: "cvt-grid", id: "cvt-hf-grid" });
  pane.appendChild(grid);

  goBtn.onclick = _srch;
  qIn.onkeydown = e => { if (e.key === "Enter") _srch(); };

  async function _srch() {
    grid.innerHTML = `<div class="cvt-spinner"></div>`;
    S.hf.query = qIn.value; S.hf.sort = sortSel.value;
    const params = new URLSearchParams({ query: S.hf.query, sort: S.hf.sort });
    try {
      const d = await _api(`/civitai/hf-search?${params}`);
      S.hf.items = d.items || [];
      grid.innerHTML = "";
      if (!S.hf.items.length) { grid.innerHTML = `<div class="cvt-empty" style="grid-column:1/-1">No models found</div>`; return; }
      S.hf.items.forEach(m => {
        const card = el("div", { class: "cvt-card" });
        const rep = m.modelId || m.id || "";
        const ini = rep.split("/").map(s=>s[0]).join("").toUpperCase().slice(0,2) || "HF";
        card.appendChild(el("div", { class: "thumb", style: { display:"flex", alignItems:"center", justifyContent:"center", background:"linear-gradient(135deg,#3a2a5a,#1e3a5a)", color:"#fff", fontSize:"28px", fontWeight:700 } }, ini));
        const body = el("div", { class: "body" },
          el("div", { class: "title" }, rep),
          el("div", { class: "meta" },
            el("span", {}, `⬇ ${_fmtNum(m.downloads||0)}`),
            el("span", {}, `❤ ${_fmtNum(m.likes||0)}`)));
        card.appendChild(body);
        card.onclick = () => _hfDetail(rep, m);
        grid.appendChild(card);
      });
    } catch (e) { grid.innerHTML = `<div class="cvt-empty" style="grid-column:1/-1;color:#f88">Error: ${e.message}</div>`; }
  }
}

async function _hfDetail(repoId, data) {
  const bg = el("div", { class: "cvt-modal-bg" });
  const wrap = el("div", { class: "cvt-modal-wrap" });
  const close = el("button", { class: "close" }, "×");
  const modal = el("div", { class: "cvt-modal" });
  wrap.append(close, modal); bg.appendChild(wrap); document.body.appendChild(bg);
  close.onclick = () => bg.remove(); bg.onclick = e => { if (e.target===bg) bg.remove(); };

  const left = el("div", { class: "left" });
  const right = el("div", { class: "right" });
  modal.append(left, right);
  left.append(el("h2", {}, repoId), el("div", { class: "sub" }, "Loading…"));

  try {
    const [u, n] = repoId.split("/");
    const info = data && data.siblings ? data : await _api(`/civitai/hf-files?repo_id=${encodeURIComponent(repoId)}`);
    const files = Array.isArray(info) ? info : info.siblings || [];
    left.querySelector(".sub").textContent = `${files.length} files`;
    const fl = el("div", { class: "cvt-files-list", style: { maxHeight:"60vh", flex:1, marginTop:"8px" } });
    files.forEach(f => {
      const fn = f.rfilename || f.path || "";
      const row = el("div", { class: "f" },
        el("span", { style: { overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" } }, fn),
        el("span", { style: { display:"flex", gap:"4px", alignItems:"center" } },
          el("span", { style: { color:"var(--civ-text-mute)" } }, f.size ? _fmtBytes(f.size) : ""),
          /\.(safetensors|ckpt|pt|pth|gguf|bin)$/i.test(fn) ? el("button", { class: "cvt-btn ghost", style: { padding:"2px 8px", fontSize:"10px" }, dataset: { repo: repoId, path: fn } }, "⬇") : null));
      fl.appendChild(row);
    });
    left.appendChild(fl);

    right.append(el("label", {}, "Save to folder"));
    const folderIn = el("input", { type: "text", placeholder: "loras / checkpoints / vae …", style: { marginTop:"4px" } });
    right.append(folderIn);
    const subIn = el("input", { type: "text", placeholder: "subfolder (optional)", style: { marginTop:"4px" } });
    right.append(el("label", {}, "Subfolder"), subIn);
    const dlBtn = el("button", { class: "cvt-btn", style: { width:"100%", marginTop:"12px", padding:"10px 0" } }, "⬇ Download All");
    right.appendChild(dlBtn);
    dlBtn.onclick = () => {
      fl.querySelectorAll(".f button").forEach(b => {
        const path = b.dataset.path; const repo = b.dataset.repo;
        if (path && repo) {
          const name = path.split("/").pop();
          const subfolder = subIn.value || "";
          const type = folderIn.value || "loras";
          _startDl(`https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(path)}`, name, `${type}/${subfolder}`.replace(/\/+$/,""));
        }
      });
    };
  } catch (e) { left.innerHTML = `<div class="cvt-empty">Error: ${e.message}</div>`; }
}

// =====================================================================
// 3. DOWNLOADS
// =====================================================================
let _dlTimer = null;
function renderDownloads(pane) {
  const header = el("div", { style: { marginBottom:"10px", fontWeight:600, fontSize:"14px" } }, "Downloads Queue");
  pane.appendChild(header);
  const list = el("div", { id: "cvt-dl-list" });
  pane.appendChild(list);
  _pollDl(list);
}

async function _pollDl(list) {
  try {
    const d = await _api("/civitai/downloads");
    S.downloads = d.items || [];
    list.innerHTML = "";
    if (!S.downloads.length) { list.appendChild(el("div", { class: "cvt-empty" }, "No downloads yet.")); return; }
    S.downloads.forEach(j => {
      const pct = j.progress || 0;
      const row = el("div", { class: `cvt-job ${j.status || "running"}` });
      const top = el("div", { class: "top" });
      top.append(el("div", { class: "name" },
        el("span", { class: `cvt-status-dot ${j.status || "running"}` }),
        " ", j.filename || "?"));
      if (j.status === "downloading" || j.status === "running") {
        const cnl = el("button", { class: "cvt-btn ghost", style: { padding:"2px 8px", fontSize:"11px" } }, "✕");
        cnl.onclick = async () => { await _api("/civitai/download-cancel", { method:"POST", body:JSON.stringify({task_id:j.id}) }); };
        top.appendChild(cnl);
      }
      row.appendChild(top);
      row.appendChild(el("div", { class: "sub" }, `${pct}% · ${_fmtBytes(j.downloaded||0)} / ${_fmtBytes(j.total||0)}${j.speed ? " · "+_fmtBytes(j.speed)+"/s" : ""}${j.error ? " · "+j.error : ""}`));
      const bar = el("div", { class: "bar" });
      bar.appendChild(el("div", { style: { width:`${pct}%` } }));
      row.appendChild(bar);
      list.appendChild(row);
    });
  } catch(e) { /* silent */ }
  if (_dlTimer) clearInterval(_dlTimer);
  _dlTimer = setInterval(() => _pollDl(list), 2000);
}

// =====================================================================
// 4. LOCAL MODELS
// =====================================================================
function renderLocal(pane) {
  const row = el("div", { class: "cvt-row", style: { marginBottom:"10px", flexWrap:"wrap" } });
  const filterIn = el("input", { type: "text", placeholder: "Filter…", style: { flex:"1", minWidth:"100px" } });
  const scanBtn = el("button", { class: "cvt-btn ghost" }, "🔍 Scan");
  const tagBtn = el("button", { class: "cvt-btn ghost" }, "🏷 Auto-Tag");
  const cleanBtn = el("button", { class: "cvt-btn ghost" }, "🧹 Cleanup");
  const orgBtn = el("button", { class: "cvt-btn ghost" }, "📂 Organize");
  const expBtn = el("button", { class: "cvt-btn ghost" }, "📋 Export");
  row.append(filterIn, scanBtn, tagBtn, cleanBtn, orgBtn, expBtn);
  pane.appendChild(row);
  const list = el("div", { class: "cvt-local-list", id: "cvt-local-list" });
  list.appendChild(el("div", { class: "cvt-empty" }, 'Click "Scan" to list local models.'));
  pane.appendChild(list);

  scanBtn.onclick = async () => {
    scanBtn.textContent = "Scanning…"; scanBtn.disabled = true;
    try {
      const d = await _api("/civitai/local-models?force_refresh=true");
      S.local.models = d.models || [];
      _renderLocalList(list, filterIn);
      _toast(`Found ${S.local.models.length} models`);
    } catch(e) { _toast("Scan failed: "+e.message, "error"); }
    scanBtn.textContent = "🔍 Scan"; scanBtn.disabled = false;
  };
  filterIn.oninput = () => _renderLocalList(list, filterIn);
  tagBtn.onclick = async () => { tagBtn.textContent = "…"; await _api("/civitai/auto-tag", { method:"POST", body:"{}" }); tagBtn.textContent = "🏷 Auto-Tag"; _toast("Auto-tag complete"); };
  cleanBtn.onclick = async () => { const r=await _api("/civitai/cleanup-scan", { method:"POST" }); _toast(`Found ${(r.issues||[]).length} issues`); };
  orgBtn.onclick = async () => { const r=await _api("/civitai/auto-organize", { method:"POST" }); _toast(`Organized ${r.moved} files`); scanBtn.click(); };
  expBtn.onclick = async () => { const r=await _api("/civitai/export-list"); if(r.text){ await navigator.clipboard.writeText(r.text); _toast(`Copied ${r.count} paths`); } };
}

function _renderLocalList(list, filterIn) {
  const q = (filterIn.value||"").toLowerCase();
  const filtered = S.local.models.filter(m => m.name?.toLowerCase().includes(q) || m.type?.includes(q));
  list.innerHTML = "";
  if (!filtered.length) { list.appendChild(el("div", { class: "cvt-empty" }, "No models")); return; }
  const header = el("div", { style: { display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:"8px" } },
    el("span", { class: "cvt-local-count" }, `${filtered.length} model(s)`));
  list.appendChild(header);
  filtered.slice(0, 200).forEach(m => {
    const card = el("div", { class: "cvt-local-card" });
    const hdr = el("div", { style: { display:"flex", justifyContent:"space-between", alignItems:"center" } },
      el("h3", {}, m.name || ""),
      el("button", { class: "cvt-btn ghost", style: { padding:"2px 8px", fontSize:"11px", color:"#f66" } }, "🗑"));
    hdr.lastChild.onclick = async e => { e.stopPropagation(); if (!confirm(`Delete ${m.name}?`)) return; await _api("/civitai/delete-model", { method:"POST", body:JSON.stringify({path:m.path}) }); S.local.models = S.local.models.filter(x=>x.path!==m.path); _renderLocalList(list, filterIn); };
    card.appendChild(hdr);
    const meta = el("div", { class: "cvt-local-meta" });
    meta.append(el("div", {}, el("strong", {}, "Type: "), m.type || "?"), el("div", {}, el("strong", {}, "Size: "), m.size || "?"));
    if (m.civitai?.name) meta.appendChild(el("div", {}, el("strong", {}, "Civitai: "), m.civitai.name));
    card.appendChild(meta);
    if (m.civitai?.url) card.appendChild(el("div", { style: { fontSize:"11px" } }, el("a", { href: m.civitai.url, target:"_blank", style: { color:"var(--civ-text)" } }, "🌐 View on Civitai")));
    const actions = el("div", { class: "cvt-local-actions" });
    const cp = el("button", { class: "cvt-btn ghost", style: { fontSize:"11px", padding:"3px 10px" } }, "📋 Copy Path");
    cp.onclick = async () => { await navigator.clipboard.writeText(m.path || m.name); _toast("Copied"); };
    actions.appendChild(cp);
    card.appendChild(actions);
    list.appendChild(card);
  });
}

// =====================================================================
// 5. SETTINGS
// =====================================================================
async function renderSettings(pane) {
  const s = el("div", { class: "cvt-settings" });

  // API Key
  const apiGroup = el("div", { class: "group" });
  apiGroup.append(el("label", {}, "Civitai API Key (required for private/gated models)"));
  const apiRow = el("div", { class: "cvt-row", style: { marginTop:"6px" } });
  const apiIn = el("input", { type: "password", placeholder: "civitai_…", style: { flex:1 } });
  const saveApi = el("button", { class: "cvt-btn", style: { padding:"5px 12px", fontSize:"11px" } }, "💾 Save");
  const clearApi = el("button", { class: "cvt-btn ghost", style: { padding:"5px 12px", fontSize:"11px" } }, "🗑 Clear");
  apiRow.append(apiIn, saveApi, clearApi);
  apiGroup.appendChild(apiRow);
  apiGroup.appendChild(el("div", { class: "hint" }, "Get a token at civitai.com/user/account → API Keys."));
  s.appendChild(apiGroup);

  // HF Token
  const hfGroup = el("div", { class: "group" });
  hfGroup.append(el("label", {}, "🤗 Hugging Face Token"));
  const hfRow = el("div", { class: "cvt-row", style: { marginTop:"6px" } });
  const hfIn = el("input", { type: "password", placeholder: "hf_…", style: { flex:1 } });
  const saveHf = el("button", { class: "cvt-btn", style: { padding:"5px 12px", fontSize:"11px" } }, "💾 Save");
  const clearHf = el("button", { class: "cvt-btn ghost", style: { padding:"5px 12px", fontSize:"11px" } }, "🗑 Clear");
  hfRow.append(hfIn, saveHf, clearHf);
  hfGroup.appendChild(hfRow);
  hfGroup.appendChild(el("div", { class: "hint" }, "Get one at huggingface.co/settings/tokens."));
  s.appendChild(hfGroup);

  // Defaults
  const defGroup = el("div", { class: "group" });
  defGroup.append(el("label", {}, "Defaults"));
  const baseSel = el("select", { style: { marginTop:"6px" } },
    ...(["civitai.com","civitai.work"].map(v => el("option", { value: v }, v))));
  defGroup.appendChild(baseSel);
  const cbMeta = el("input", { type: "checkbox" });
  const cbPrev = el("input", { type: "checkbox" });
  defGroup.append(
    el("label", { class: "check" }, cbMeta, " Save .civitai.json"),
    el("label", { class: "check" }, cbPrev, " Save .preview.png"));
  s.appendChild(defGroup);

  // Quick actions
  const qaGroup = el("div", { class: "group" });
  qaGroup.append(el("label", {}, "Quick Actions"));
  const qaRow = el("div", { class: "cvt-row", style: { marginTop:"8px", flexWrap:"wrap" } });
  const qaBtns = [
    ["🏷 Auto-Tag", async () => { await _api("/civitai/auto-tag", { method:"POST", body:"{}" }); _toast("Tagged"); }],
    ["🧹 Cleanup", async () => { const r=await _api("/civitai/cleanup-scan", { method:"POST" }); _toast(`Found ${(r.issues||[]).length} issues`); }],
    ["📂 Organize", async () => { const r=await _api("/civitai/auto-organize", { method:"POST" }); _toast(`Organized ${r.moved} files`); }],
    ["📋 Export", async () => { const r=await _api("/civitai/export-list"); if(r.text){ await navigator.clipboard.writeText(r.text); _toast(`Copied ${r.count} paths`); } }],
    ["🔍 Rescan", async () => { await _api("/civitai/rescan", { method:"POST", body:JSON.stringify({force:true}) }); _toast("Rescanned"); }],
  ];
  qaBtns.forEach(([label, fn]) => {
    const btn = el("button", { class: "cvt-btn ghost", style: { padding:"5px 12px", fontSize:"11px" } }, label);
    btn.onclick = fn;
    qaRow.appendChild(btn);
  });
  qaGroup.appendChild(qaRow);
  s.appendChild(qaGroup);

  pane.appendChild(s);

  // Load settings
  try {
    const cfg = await _api("/civitai/settings");
    baseSel.value = cfg.baseUrl?.includes("work") ? "civitai.work" : "civitai.com";
    cbMeta.checked = cfg.saveMetadata !== false;
    cbPrev.checked = cfg.savePreview !== false;
  } catch(e) {}

  saveApi.onclick = async () => { await _api("/civitai/settings", { method:"POST", body:JSON.stringify({civitai_api_key:apiIn.value}) }); _toast("API key saved"); apiIn.value=""; };
  clearApi.onclick = async () => { if(!confirm("Remove API key?")) return; await _api("/civitai/settings", { method:"POST", body:JSON.stringify({civitai_api_key:""}) }); _toast("API key cleared"); };
  saveHf.onclick = async () => { await _api("/civitai/settings", { method:"POST", body:JSON.stringify({hf_token:hfIn.value}) }); _toast("HF token saved"); hfIn.value=""; };
  clearHf.onclick = async () => { if(!confirm("Remove HF token?")) return; await _api("/civitai/settings", { method:"POST", body:JSON.stringify({hf_token:""}) }); _toast("HF token cleared"); };
  baseSel.onchange = async () => { await _api("/civitai/settings", { method:"POST", body:JSON.stringify({network_choice:baseSel.value==="civitai.work"?"work":"com"}) }); _toast("Base URL updated"); };
  cbMeta.onchange = async () => { await _api("/civitai/settings",{ method:"POST",body:JSON.stringify({save_metadata:cbMeta.checked}) }); };
  cbPrev.onchange = async () => { await _api("/civitai/settings",{ method:"POST",body:JSON.stringify({save_preview:cbPrev.checked}) }); };
}

// =====================================================================
// 6. MOUNT
// =====================================================================
let _mountState = { mounted: false, ui: null };

function mount() {
  if (_mountState.mounted) return;
  if (!app.extensionManager?.registerSidebarTab) return false;

  app.extensionManager.registerSidebarTab({
    id: "civitai-hf",
    icon: "pi pi-globe",
    title: "Civitai+HF",
    tooltip: "Civitai & Hugging Face Downloader",
    type: "custom",
    render: (root) => {
      root.innerHTML = "";
      const { root: ui, tabBar, panes } = buildUI();
      _mountState.ui = { tabBar, panes };
      root.appendChild(ui);
    },
  });
  _mountState.mounted = true;
  return true;
}

app.registerExtension({
  name: "CivitaiHF.Browser",
  async setup() {
    if (mount()) return;
    let tries = 0;
    const t = setInterval(() => { if (mount() || ++tries > 20) clearInterval(t); }, 250);
  },
});
