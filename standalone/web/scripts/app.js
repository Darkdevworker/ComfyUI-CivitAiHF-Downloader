/**
 * Stand-in for ComfyUI's `scripts/app.js`.
 *
 * Provides just the four things the extension touches:
 *
 *   app.registerExtension({name, setup})   — run setup() straight away
 *   app.extensionManager.registerSidebarTab({...})
 *   app.refreshComboInNodes()
 *   (plus a couple of no-ops so stray calls do not throw)
 *
 * It builds the same shape ComfyUI gives an extension: a narrow icon rail on
 * the left, and a panel on the right that `render(root)` paints into.
 */

const tabs = [];
let rail = null;
let stage = null;
let activeId = null;

function ensureLayout() {
  if (rail && stage) return;
  rail = document.getElementById("civ-rail");
  stage = document.getElementById("civ-stage");
}

function paintRail() {
  ensureLayout();
  if (!rail) return;
  rail.innerHTML = "";
  tabs.forEach(function (tab) {
    const btn = document.createElement("button");
    btn.className = "civ-rail-btn" + (tab.id === activeId ? " active" : "");
    btn.title = tab.tooltip || tab.title || tab.id;
    btn.textContent = tab.title || tab.id;
    // The extension tags the button it wants styled (see installSidebarLogo
    // in js/logo.js); keep the same data attribute so that code finds it.
    btn.dataset.testid = tab.id + "-tab-button";
    btn.setAttribute("aria-label", btn.title);
    btn.addEventListener("click", function () { openTab(tab.id); });
    rail.appendChild(btn);
  });
}

function openTab(id) {
  ensureLayout();
  const tab = tabs.find(function (t) { return t.id === id; });
  if (!tab || !stage) return;
  activeId = id;
  paintRail();
  stage.innerHTML = "";
  stage.setAttribute("data-tab", id);
  try {
    tab.render(stage);
  } catch (e) {
    console.error("[standalone] render error:", e);
    stage.innerHTML =
      '<pre style="color:#f88;padding:16px;white-space:pre-wrap">' +
      String(e && e.stack || e) + "</pre>";
  }
}

class ExtensionManager {
  registerSidebarTab(def) {
    if (!def || !def.id) throw new Error("registerSidebarTab needs an id");
    // ComfyUI replaces a tab with the same id; do the same so a reload does
    // not stack duplicates.
    const at = tabs.findIndex(function (t) { return t.id === def.id; });
    if (at >= 0) tabs[at] = def; else tabs.push(def);
    paintRail();
    if (!activeId) openTab(def.id);
    return def;
  }
  getTabs() { return tabs.slice(); }
}

export const app = {
  extensionManager: new ExtensionManager(),
  registerExtension(ext) {
    // ComfyUI defers setup() until the frontend boots. Here there is nothing
    // to wait for, so run it immediately — but guard it, because an exception
    // in one extension must not stop the rest of the page.
    try {
      if (ext && typeof ext.setup === "function") ext.setup();
      else if (typeof ext === "function") ext(app);
    } catch (e) {
      console.error("[standalone] setup failed for", ext && ext.name, e);
    }
  },
  refreshComboInNodes() {
    // No node graph here. Resolve, so callers' .then() still runs.
    return Promise.resolve();
  },
  registerExtensionMode() {},
  getWidgetType() { return null; },
  ui: { settings: { addSetting() {} } },
};

export default app;
