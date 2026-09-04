(pane, force) {
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
  var isNsfw = _matchNsfw(m, { hasPG13:true, hasR:true, hasX:true, hasXXX:true });
  var imgUrl = m.preview ? "/civitai/local-preview?path=" + encodeURIComponent(m.preview) + "&w=450" : "";
  var card = el("div", { class: "cvt-card" });
  var thumb = el("div", { class: "thumb", style: { aspectRatio: "3/4", background: "linear-gradient(135deg,#1a1a1a,#0f0f0f)", position:"relative", overflow:"hidden" } });
  if (imgUrl) {
    thumb.appendChild(el("img", { src: imgUrl, style: { width:"100%", height:"100%", objectFit:"cover", display:"block" }, onerror: function() { this.style.display = "none"; } }));
  }
  if (isNsfw && window.__nsfwBlurEnabled !== false) {
    thumb.style.filter = "blur(20px) grayscale(0.5)";
    thumb.style.willChange = "filter";
    thumb.addEventListener("mouseenter", function() { this.style.filter = "none"; });
    thumb.addEventListener("mouseleave", function() { this.style.filter = "blur(20px) grayscale(0.5)"; });
  }
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
  if (isNsfw) meta.appendChild(el("span", { class: "cvt-badge nsfw" }, "NSFW"));
  body.appendChild(meta);
  card.appendChild(body);

  card.onclick = function() { openLocalDetail(m, grid, filterIn); };
  return card;
}

// ── 5. SETTINGS ────────────────────────────────────────────────
