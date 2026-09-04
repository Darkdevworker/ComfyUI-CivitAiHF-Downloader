(pane) {
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
function renderSettings(pane) {
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
  cbNsfwBlur.onchange = function() { window.__nsfwBlurEnabled = cbNsfwBlur.checked; };
  var cbCompact = el("input", { type: "checkbox" });
  cbCompact.onchange = function() { if (cbCompact.checked) S.root.classList.add("compact"); else S.root.classList.remove("compact"); };
  [[cbMeta,"\uD83D\uDCC4 Save .civitai.json metadata alongside models"],
   [cbPrev,"\uD83D\uDDBC\uFE0F Save preview images alongside models"],
   [cbHash,"\uD83D\uDD10 Verify SHA256 hash after download"],
   [cbNsfwBlur,"\uD83D\uDE48 Blur NSFW content in card grid and previews"],
   [cbCompact,"\uD83D\uDCCA Compact grid mode (smaller cards, more columns)"]].forEach(function(item) {
    prefsGroup.appendChild(el("label", { class: "cvt-settings-toggle" }, item[0], el("span", {}, item[1])));
  });
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
  saveBtn.onclick=function(){saveBtn.disabled=true;sStatus.innerHTML="<span style='color:var(--civ-text-mute)'>Saving\u2026</span>";var body={network_choice:baseSel.value==="civitai.red"?"red":baseSel.value==="civitai.work"?"work":"com",save_metadata:cbMeta.checked,save_preview:cbPrev.checked,verify_sha256:cbHash.checked,nsfw_blur:cbNsfwBlur.checked,compact_grid:cbCompact.checked,theme:S.root.classList.contains("light")?"light":"dark"};S.settings.saveMeta=cbMeta.checked;S.settings.savePrev=cbPrev.checked;S.settings.verifySha=cbHash.checked;S.settings.nsfwBlur=cbNsfwBlur.checked;_cache.del("/civitai/settings");_api("/civitai/settings",{method:"POST",body:JSON.stringify(body)}).then(function(){sStatus.innerHTML="<span style='color:#6d6'>\u2713 All settings saved</span>";_toast("Settings saved","ok");}).catch(function(e){sStatus.innerHTML="<span style='color:#e88'>Error: "+e.message+"</span>";}).then(function(){saveBtn.disabled=false;});};
  testBtn.onclick=function(){testBtn.disabled=true;sStatus.innerHTML="<span style='color:var(--civ-text-mute)'>Testing\u2026</span>";_api("/civitai/ping").then(function(r){sStatus.innerHTML=r.has_api_key?"<span style='color:#6d6'>\u2713 Connected \u2014 API key recognised</span>":"<span style='color:#cc9'>Connected \u2014 no API key (public only)</span>";}).catch(function(e){sStatus.innerHTML="<span style='color:#e88'>\u2717 Failed: "+e.message+"</span>";}).then(function(){testBtn.disabled=false;});};
  clearCacheBtn.onclick=function(){clearCacheBtn.disabled=true;_api("/civitai/cache/clear",{method:"POST"}).then(function(r){_cache.clear();_toast("Cache cleared");sStatus.innerHTML="<span style='color:#6d6'>\u2713 Cache cleared</span>";}).catch(function(e){_toast("Clear failed: "+e.message,"error");}).then(function(){clearCacheBtn.disabled=false;});};
}

// ── 6. MOUNT ─────────────────────────────────────────────────────────
try {
app.registerExtension({
  name: "CivitaiHF.Browser",
  setup: function() {
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