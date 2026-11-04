#!/usr/bin/env python3
"""
Run the Civitai / Hugging Face Downloader backend and UI without ComfyUI.

    python standalone/run.py
    python standalone/run.py --models-dir /path/to/ComfyUI/models --port 8189

What this does
--------------
The extension's backend was written to be dropped into ComfyUI, but it only
actually reaches into ComfyUI in two places:

    server.py:17   from server import PromptServer
    server.py:44   routes = PromptServer.instance.routes
    *.py           folder_paths.{models_dir,get_filename_list,get_full_path}

Everything else — all 44 routes, the downloader, the database, the content
bands — is self-contained. So this script supplies two small stand-ins (in
standalone/shim/), imports the extension unchanged, mounts its routes on a
plain aiohttp app, and serves the real js/ with a tiny host page.

Nothing in the extension is modified. If a code path ever reaches for another
ComfyUI API, it will fail loudly in the console rather than silently
misbehave.

What you get
------------
The full browser/download/local/bookmarks/settings UI, talking to the real
backend. Downloads land in the models directory you point at. Searches hit
Civitai and Hugging Face for real, so you need network access and (for gated
models) an API key, which you set from the Settings tab as usual.

What you do not get
-------------------
The node graph. There are no ComfyUI nodes here and no workflow canvas —
this is the sidebar panel on its own. "Refresh node lists" is a no-op.
"""

import argparse
import asyncio
import importlib.util
import os
import sys
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)          # the extension's own directory
SHIM = os.path.join(HERE, "shim")
WEB = os.path.join(HERE, "web")


def parse_args():
    p = argparse.ArgumentParser(
        description="Run the Civitai/HF Downloader UI without ComfyUI.")
    p.add_argument("--models-dir", default=None,
                   help="models directory to browse and download into "
                        "(default: ./models, or $CIVITAIHF_MODELS_DIR)")
    p.add_argument("--host", default="127.0.0.1",
                   help="interface to bind (default 127.0.0.1)")
    p.add_argument("--port", type=int, default=8189,
                   help="port to listen on (default 8189)")
    p.add_argument("--no-browser", action="store_true",
                   help="do not open a browser window")
    return p.parse_args()


def install_shims(models_dir):
    """
    Put standalone/shim/ at the front of sys.path so `import folder_paths`
    and `from server import PromptServer` resolve to our stand-ins.

    Deliberately NOT adding ROOT to sys.path: the extension is loaded
    explicitly as a package below, and having ROOT importable would shadow
    the `server` shim with the extension's own server.py.
    """
    if models_dir:
        os.environ["CIVITAIHF_MODELS_DIR"] = os.path.abspath(models_dir)
    sys.path.insert(0, SHIM)
    # Prove the shims are reachable before anything imports them indirectly.
    import folder_paths  # noqa: F401
    # ComfyUI creates these on first run and its code assumes they exist;
    # an empty models dir would make every download resolve outside the
    # allowed roots and get rejected by the path checks.
    os.makedirs(folder_paths.models_dir, exist_ok=True)
    for _folder, (_paths, _ext) in folder_paths.folder_names_and_paths.items():
        for _p in _paths:
            os.makedirs(_p, exist_ok=True)
    return folder_paths


def load_extension():
    """
    Import the extension as a package named `civhf`.

    The directory has a hyphen in it, which is not a legal Python package
    name, and server.py uses relative imports (`from . import utils`) so it
    cannot be imported as a top-level module. Loading it under a chosen name
    with submodule_search_locations solves both.
    """
    init = os.path.join(ROOT, "__init__.py")
    if not os.path.isfile(init):
        sys.exit("Cannot find __init__.py next to standalone/ — is the "
                 "checkout intact? (%s)" % init)
    spec = importlib.util.spec_from_file_location(
        "civhf", init, submodule_search_locations=[ROOT])
    pkg = importlib.util.module_from_spec(spec)
    sys.modules["civhf"] = pkg
    spec.loader.exec_module(pkg)      # runs __init__.py, which imports server
    return sys.modules["civhf.server"]


async def main_async(args):
    from aiohttp import web

    folder_paths = install_shims(args.models_dir)
    print("[standalone] models dir : %s" % folder_paths.models_dir)

    server_mod = load_extension()

    app = web.Application()
    # Every route the extension registered, exactly as ComfyUI would mount it.
    app.add_routes(server_mod.routes)

    # The real frontend, unmodified.
    app.router.add_static("/js", os.path.join(ROOT, "js"))
    # The two ComfyUI scripts the frontend imports as ../../scripts/*.js
    app.router.add_static("/scripts", os.path.join(WEB, "scripts"))

    async def index(request):
        return web.FileResponse(os.path.join(WEB, "index.html"))
    app.router.add_get("/", index)

    # The extension keeps a background scan alive; start it here the way
    # __init__.py does inside ComfyUI.
    try:
        import civhf.utils as utils
        loop = asyncio.get_event_loop()
        utils.initiate_background_scan(loop)
    except Exception as e:
        print("[standalone] background scan not started: %s" % e)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, args.host, args.port)
    await site.start()

    url = "http://%s:%d/" % (args.host, args.port)
    print("[standalone] routes     : %d" % len(server_mod.routes._items))
    print("[standalone] ready       : %s" % url)
    print("[standalone] Ctrl-C to stop")
    if not args.no_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass

    try:
        while True:
            await asyncio.sleep(3600)
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        await runner.cleanup()


def main():
    args = parse_args()
    try:
        asyncio.run(main_async(args))
    except KeyboardInterrupt:
        print("\n[standalone] stopped")


if __name__ == "__main__":
    main()
