import os
import sys
import asyncio
import traceback

current_dir = os.path.dirname(os.path.abspath(__file__))
if current_dir not in sys.path:
    sys.path.append(current_dir)

# ── Graceful imports — catch and report errors instead of silently dying ──

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
WEB_DIRECTORY = "./js"

try:
    from . import server
    print("[ComfyUI-CivitAiHF-Downloader] Server loaded")
except Exception as e:
    print(f"[ComfyUI-CivitAiHF-Downloader] ERROR loading server: {e}")
    traceback.print_exc()

try:
    from .nodes import NODE_CLASS_MAPPINGS as node_mappings, NODE_DISPLAY_NAME_MAPPINGS as node_display
    NODE_CLASS_MAPPINGS.update(node_mappings)
    NODE_DISPLAY_NAME_MAPPINGS.update(node_display)
    print("[ComfyUI-CivitAiHF-Downloader] Nodes loaded")
except Exception as e:
    print(f"[ComfyUI-CivitAiHF-Downloader] ERROR loading nodes: {e}")
    traceback.print_exc()

try:
    from .nodes_display import NODE_CLASS_MAPPINGS as display_mappings, NODE_DISPLAY_NAME_MAPPINGS as display_display
    NODE_CLASS_MAPPINGS.update(display_mappings)
    NODE_DISPLAY_NAME_MAPPINGS.update(display_display)
except Exception:
    pass

try:
    from . import utils
    main_loop = asyncio.get_event_loop()
    utils.initiate_background_scan(main_loop)
except Exception:
    pass

print(f"[ComfyUI-CivitAiHF-Downloader] Extension loaded — {len(NODE_CLASS_MAPPINGS)} nodes, WEB_DIRECTORY={WEB_DIRECTORY}")
