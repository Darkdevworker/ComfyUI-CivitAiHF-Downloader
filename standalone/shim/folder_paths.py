"""
Stand-in for ComfyUI's `folder_paths`, so the extension's backend can run on
its own.

Only three things are actually used by the extension:

    folder_paths.models_dir
    folder_paths.get_filename_list(folder)
    folder_paths.get_full_path(folder, filename)

plus `folder_names_and_paths`, which server._model_roots() walks to decide
which directories a request is allowed to touch. That feeds the path-safety
checks, so it has to be populated properly — leaving it empty would make
every download resolve to "outside the models directories".

Set CIVITAIHF_MODELS_DIR to point at a real ComfyUI models folder (defaults
to ./models next to wherever you launch from).
"""

import os

models_dir = os.path.abspath(
    os.environ.get("CIVITAIHF_MODELS_DIR")
    or os.path.join(os.getcwd(), "models")
)

# The folders ComfyUI itself knows about, plus the ones this extension's
# SUPPORTED_MODEL_TYPES map onto. Extra folders are harmless; missing ones
# just report as empty.
FOLDERS = [
    "checkpoints", "loras", "vae", "embeddings", "diffusion_models",
    "text_encoders", "hypernetworks", "controlnet", "upscale_models",
    "clip_vision", "unet", "instantid", "clip", "style_models",
    "model_patches", "photomaker", "gligen", "audio_encoders",
    "diffusers", "wildcards", "workflows",
]

EXTENSIONS = {
    ".ckpt", ".safetensors", ".pt", ".pth", ".bin", ".gguf", ".onnx",
    ".sft", ".yaml", ".json", ".txt", ".webp", ".png", ".jpg", ".jpeg",
}

# {folder: ([paths], extensions)} — same shape ComfyUI uses.
folder_names_and_paths = {}
for _f in FOLDERS:
    folder_names_and_paths[_f] = ([os.path.join(models_dir, _f)], set(EXTENSIONS))


def add_path(folder, path):
    """Register another search path for a folder (ComfyUI calls this too)."""
    entry = folder_names_and_paths.setdefault(folder, ([], set(EXTENSIONS)))
    if path not in entry[0]:
        entry[0].append(path)


def get_directory_by_type(folder):
    entry = folder_names_and_paths.get(folder)
    return entry[0][0] if entry and entry[0] else None


def get_filename_list(folder):
    """
    Every file under the folder, as paths relative to it (subdirs included,
    so `loras/sdxl/foo.safetensors` comes back whole). Returns [] for an
    unknown folder rather than None, because callers iterate the result.
    """
    entry = folder_names_and_paths.get(folder)
    if not entry:
        return []
    out = []
    for root in entry[0]:
        if not os.path.isdir(root):
            continue
        for dirpath, _dirs, files in os.walk(root):
            for name in files:
                full = os.path.join(dirpath, name)
                out.append(os.path.relpath(full, root).replace("\\", "/"))
    return sorted(out)


def get_full_path(folder, filename):
    """
    Resolve `filename` inside `folder`.

    ComfyUI returns None for an unknown folder; this does the same. Within a
    known folder it joins and returns the path even if the file does not
    exist yet — downloads legitimately resolve to a destination that is about
    to be created, and callers that need the file check for it themselves.
    """
    entry = folder_names_and_paths.get(folder)
    if not entry:
        return None
    filename = str(filename).replace("\\", "/")
    if os.path.isabs(filename):
        return filename
    for root in entry[0]:
        candidate = os.path.join(root, filename)
        if os.path.exists(candidate):
            return candidate
    return os.path.join(entry[0][0], filename) if entry[0] else None


def get_folder_paths(folder):
    entry = folder_names_and_paths.get(folder)
    return list(entry[0]) if entry else []


def filename_list(folder):
    return get_filename_list(folder)
