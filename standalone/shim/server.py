"""
Stand-in for ComfyUI's `server` module.

The extension only ever touches one thing in here:

    routes = PromptServer.instance.routes

which is an aiohttp RouteTableDef that every `@routes.get(...)` decorator
appends to. So this shim is little more than a holder for that table — the
launcher picks it up afterwards and hands it to a plain aiohttp app.
"""

from aiohttp import web


class PromptServer:
    instance = None

    def __init__(self):
        self.routes = web.RouteTableDef()

    # A few members exist in ComfyUI's version and are cheap to stub, so a
    # stray call degrades to a no-op instead of an AttributeError.
    def send_sync(self, event, data, sid=None):
        return None


PromptServer.instance = PromptServer()
