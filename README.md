# ComfyUI-CivitAiHF-Downloader

A ComfyUI custom node extension for browsing, searching, and downloading models from **Civitai** and **Hugging Face** directly within the ComfyUI interface.

## Features

### Civitai Integration
- **Search & Browse** — Search Civitai models by query, type, sort order, time period, and base model
- **Cursor-based pagination** — Browse through results with next/previous navigation
- **NSFW Filtering** — Per-level rating checkboxes (PG, PG13, R, X, XXX) with client-side strict filtering and blur toggle
- **Detail Modal** — View model info, description, stats (likes/downloads), version selector, and gallery images with prompt/negative prompt display
- **Direct Download** — Download any model version with configurable metadata saving (.civitai.json, preview images)
- **Lookup** — Resolve any Civitai URL, model ID, version ID, SHA256 hash, or AIR identifier

### Hugging Face Integration
- Search models by query, pipeline tag, library, author, and sort order
- Display model info including total weight file size from sibling files
- Download models directly

### Local Model Management
- Browse locally downloaded models with search filter
- 2-column grid display with hover preview (prompt/negative prompt from cached `/civitai/local-previews`)
- Detail modal with large preview image and horizontal thumbnail strip
- Metadata viewing for locally saved models

### Downloads Panel
- Real-time progress tracking for active downloads
- Completed download history

### Settings
- Toggle between `civitai.com`, `civitai.red`, and `civitai.work` domains
- Enable/disable metadata and preview image saving
- Toggle NSFW blur
- Compute SHA256 on download
- Configure Civitai API key and Hugging Face token

## Installation

1. Navigate to your ComfyUI `custom_nodes` directory:
   ```bash
   cd ComfyUI/custom_nodes
   ```
2. Clone the repository:
   ```bash
   git clone https://github.com/darkpool999/ComfyUI-CivitAiHF-Downloader.git
   ```
3. Install Python dependencies:
   ```bash
   pip install requests
   ```
4. Restart ComfyUI

## Usage

After installation, a **CivitAI** tab appears in the ComfyUI sidebar with five sub-tabs:

| Tab | Description |
|-----|-------------|
| **CivitAI** | Search and browse Civitai models, lookup by URL/ID/hash, filter by type/rating, download |
| **Hugging Face** | Search Hugging Face models by pipeline, library, or author |
| **Downloads** | View active and completed download progress |
| **Local** | Browse downloaded models with previews and metadata |
| **Settings** | Configure domain, API keys, download options, and NSFW blur |

### Quick Start

1. Open the **CivitAI** tab
2. Type a search query (or leave empty to browse latest)
3. Select model type, sort order, and time period
4. Choose NSFW rating filters (PG/PG13/R/X/XXX)
5. Click **Search** (or press Enter)
6. Click any model card to open the detail modal
7. Select a version and click **Download**

### Lookup

Paste any of the following into the lookup field at the top of the CivitAI tab:
- Civitai model URL (e.g., `https://civitai.com/models/12345`)
- Numeric model or version ID
- SHA256 hash
- AIR identifier (urn:air:...)

## Files

| File | Purpose |
|------|---------|
| `__init__.py` | Extension entry point, registers `WEB_DIRECTORY` |
| `server.py` | All API endpoints (search, lookup, download, local management, settings) |
| `utils.py` | Database manager, Civitai API utilities, hash/version extraction |
| `js/civitai.js` | Full sidebar UI (tabs, modals, lightbox, downloads, settings, pagination) |
| `js/civitai.css` | Noir Premium dark theme with glassmorphism effects |

## API Endpoints

- `GET /civitai/search` — Search Civitai models
- `GET /civitai/lookup` — Lookup model/version by hash, URL, or ID
- `GET /civitai/model/{id}` — Fetch model data (updates stats)
- `POST /civitai/download` — Download a model version
- `GET /civitai/downloads` — List active/completed downloads
- `DELETE /civitai/downloads/{id}` — Cancel or remove a download
- `GET /civitai/local` — List locally downloaded models
- `GET /civitai/local-previews` — Get cached previews for local models
- `GET /civitai/local-preview` — Serve local preview image
- `GET /civitai/local-detail` — Get local model detail
- `GET /civitai/local-metadata` — Get local model metadata
- `POST /civitai/settings` — Save settings
- `GET /civitai/settings` — Load settings
- `POST /civitai/scan-local` — Scan for local models

## License

MIT
