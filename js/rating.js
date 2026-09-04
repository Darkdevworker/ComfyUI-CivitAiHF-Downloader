// Content rating system: PG / PG-13 / R / X / XXX
const NSFW_RATINGS = [
  { label: "PG", value: "" },
  { label: "PG13", value: "Soft" },
  { label: "R", value: "Mature" },
  { label: "X", value: "X" },
  { label: "XXX", value: "XXX" },
];

function _buildRatingCheckboxes(selectedStr, onChange) {
  var selected = selectedStr ? selectedStr.split(",").filter(Boolean) : [];
  var cbs = {};
  var row = document.createElement("div");
  row.style.display = "flex"; row.style.gap = "4px"; row.style.alignItems = "center"; row.style.flexWrap = "wrap";
  NSFW_RATINGS.forEach(function(r) {
    var cb = document.createElement("input");
    cb.type = "checkbox"; cb.value = r.value;
    var checked = r.value ? selected.indexOf(r.value) >= 0 : selected.length === 0;
    cb.checked = checked;
    cb.onchange = onChange;
    cbs[r.label] = cb;
    var lbl = document.createElement("label");
    lbl.style.display = "inline-flex"; lbl.style.alignItems = "center"; lbl.style.gap = "2px"; lbl.style.cursor = "pointer"; lbl.style.fontSize = "11px"; lbl.style.whiteSpace = "nowrap"; lbl.style.color = "var(--civ-text-dim)";
    lbl.appendChild(cb); lbl.appendChild(document.createTextNode(" " + r.label));
    row.appendChild(lbl);
  });
  row._cbs = cbs;
  row._getVal = function() {
    var vals = [];
    NSFW_RATINGS.forEach(function(r) {
      if (r.value && cbs[r.label].checked) vals.push(r.value);
    });
    return vals.join(",");
  };
  return row;
}

function _nsfwFlags(val) {
  if (!val) return { hasPG13: false, hasR: false, hasX: false, hasXXX: false };
  return {
    hasPG13: val.indexOf("Soft") >= 0,
    hasR: val.indexOf("Mature") >= 0,
    hasX: val.indexOf("X") >= 0,
    hasXXX: val.indexOf("XXX") >= 0,
  };
}

function _matchNsfw(item, flags) {
  if (!item) return false;
  // Removed blanket boolean check — evaluate actual tier
  var lvl = item.nsfwLevel != null ? item.nsfwLevel : item.rating;
  if (lvl == null || lvl === "" || lvl === "null" || lvl === "undefined") {
    return item.nsfw !== false;
  }
  var n = Number(lvl);
  if (!isNaN(n)) {
    if (n <= 0 || n === 0) return false;
    if (n <= 1) return flags.hasPG13;
    if (n <= 2) return flags.hasR;
    return flags.hasX || flags.hasXXX;
  }
  var s = String(lvl).toLowerCase().trim();
  if (s === "none" || s === "pg" || s === "g" || s === "everyone") return false;
  if (s === "soft" || s === "pg13" || s === "pg-13" || s === "teen") return flags.hasPG13;
  if (s === "mature" || s === "r" || s === "r15" || s === "adult") return flags.hasR;
  if (s === "x" || s === "xxx" || s === "r18" || s === "r-18" || s === "r18+" || s === "explicit" || s === "nsfw") {
    return flags.hasX || flags.hasXXX;
  }
  return true;
}

function getTierLabel(m) {
  var ratingVal = m.nsfwLevel || m.rating || m.nsfw || "";
  var s = String(ratingVal).toLowerCase().trim();
  var label = "PG";
  if (s === "soft" || s === "pg13" || s === "pg-13" || s === "teen") label = "PG-13";
  else if (s === "mature" || s === "r" || s === "r15" || s === "adult") label = "R";
  else if (s === "x" || s === "r18" || s === "r-18") label = "X";
  else if (s === "xxx" || s === "explicit" || s === "nsfw" || s !== "" && s !== "none" && s !== "pg" && s !== "g" && s !== "everyone") label = "X";
  return label;
}

function makeRatingBadge(tierLabel) {
  var span = document.createElement("span");
  span.className = "cvt-badge rating-badge";
  span.style.fontSize = "9px"; span.style.padding = "1px 4px"; span.style.color = "#fff"; span.style.borderRadius = "3px"; span.style.marginLeft = "4px";
  if (tierLabel === "PG") span.style.background = "#2a5a2a";
  else if (tierLabel === "PG-13") span.style.background = "#5a4a2a";
  else if (tierLabel === "R") span.style.background = "#5a2a2a";
  else span.style.background = "#3a1a1a"; // X / XXX
  span.textContent = tierLabel;
  return span;
}
