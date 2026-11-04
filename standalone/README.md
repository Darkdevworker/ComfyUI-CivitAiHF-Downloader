# Running without ComfyUI

The downloader panel is a ComfyUI *sidebar extension*, but it barely touches
ComfyUI. That makes it cheap to run on its own — useful for working on the UI,
testing a download, or browsing without starting a full ComfyUI instance.

## Run it

```bash
python standalone/run.py
```

Then open <http://127.0.0.1:8189/>.

```bash
# point it at a real ComfyUI models folder
python standalone/run.py --models-dir /path/to/ComfyUI/models

# other options
python standalone/run.py --port 8190 --host 0.0.0.0 --no-browser
```

| Flag | Default | |
|---|---|---|
| `--models-dir` | `./models` | where files are browsed from and downloaded to (also `$CIVITAIHF_MODELS_DIR`) |
| `--host` | `127.0.0.1` | interface to bind |
| `--port` | `8189` | port to listen on |
| `--no-browser` | off | do not open a browser automatically |

Requirements are the ones the extension already needs: `aiohttp`, `requests`,
`tqdm`. Nothing extra.

## How it works

The extension reaches into ComfyUI in exactly two places:

```python
server.py:17   from server import PromptServer
server.py:44   routes = PromptServer.instance.routes
*.py           folder_paths.{models_dir, get_filename_list, get_full_path}
```

Everything else — all 44 routes, the downloader, the SQLite store, the content
bands — is self-contained. So `run.py`:

1. puts `standalone/shim/` first on `sys.path`, so `folder_paths` and `server`
   resolve to the stand-ins there;
2. imports the extension unchanged, as a package named `civhf` (the checkout
   directory has a hyphen, which is not a legal package name, and `server.py`
   uses relative imports so it cannot be loaded as a top-level module);
3. mounts `server_mod.routes` on a plain `aiohttp` app;
4. serves the real `js/` alongside a small host page.

On the browser side, `js/civitai.js` imports `../../scripts/app.js` and
`../../scripts/api.js`. The server maps `/scripts/` to shims that provide the
four things the extension actually uses: `app.registerExtension`,
`app.extensionManager.registerSidebarTab`, `app.refreshComboInNodes` and
`api.fetchApi`.

**No file in the extension is modified.** If a code path ever reaches for
another ComfyUI API, it will raise in the console rather than silently do the
wrong thing.

## What you get / don't get

You get the whole panel: Civitai and Hugging Face search, downloads and their
progress, local models, bookmarks, settings. Searches hit the real APIs, so you
need network access; gated models need an API key, set from the Settings tab as
usual. Downloads land in the models directory you pointed at.

You do **not** get the node graph. There is no workflow canvas and no ComfyUI
node here, so "Refresh node lists" is a no-op and the node classes are not
loaded.

## Layout

```
standalone/
  run.py                  launcher (shims → import → aiohttp → serve)
  shim/
    folder_paths.py       models dir + file listing, backed by a real folder
    server.py             PromptServer holding an aiohttp RouteTableDef
  web/
    index.html            host page: an icon rail and a stage
    scripts/
      app.js              registerExtension / registerSidebarTab / refreshComboInNodes
      api.js              api.fetchApi
  test_standalone.mjs     checks the shims still satisfy the extension
```

## Testing it

```bash
node standalone/test_standalone.mjs
```

Two halves. The static half checks every name the frontend imports from
ComfyUI exists in the shims — miss one and you get `undefined` at runtime with
no import error to warn you. The boot half runs the real `js/civitai.js`
against the shims and asserts the UI builds (6 tabs, 6 panes, 5 band chips).

The boot half needs [jsdom](https://www.npmjs.com/package/jsdom), which is not
a project dependency. Without it that half is skipped, not failed, so the file
stays runnable on a bare checkout:

```bash
npm i jsdom && node standalone/test_standalone.mjs
```
