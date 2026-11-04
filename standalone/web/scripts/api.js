/**
 * Stand-in for ComfyUI's `scripts/api.js`.
 *
 * The extension only uses `api.fetchApi(path, opts)`. ComfyUI's version adds
 * a client id and handles ComfyUI's own error shape; every route this
 * extension calls is a plain absolute path like "/civitai/search", so a thin
 * fetch wrapper is enough.
 */

export async function fetchApi(route, options) {
  if (typeof route !== "string") {
    throw new Error("fetchApi: route must be a string");
  }
  const res = await fetch(route, options || {});
  if (!res.ok && res.status === 403) {
    // ComfyUI surfaces auth failures as a thrown 403; keep the same shape.
    const err = new Error("Forbidden");
    err.status = 403;
    err.response = res;
    throw err;
  }
  return res;
}

/**
 * ComfyUI exports an `api` *object* and the extension does
 * `import { api } from "../../scripts/api.js"`, so the named export has to
 * exist — exporting only `fetchApi` leaves `api` undefined and every request
 * throws on `api.fetchApi`.
 */
export const api = {
  fetchApi,
  apiURL: function (route) { return route; },
  addEventListener: function () {},
  getPrompt: function () {},
  getHistory: function () {},
  getNodeDefs: function () {},
};

export default api;
