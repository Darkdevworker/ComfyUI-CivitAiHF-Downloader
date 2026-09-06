# ComfyUI CivitAI + Hugging Face Downloader

<p align="center">
  <strong>Browse, search, preview, and download models from Civitai and Hugging Face — directly inside ComfyUI.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/ComfyUI-Extension-blue?logo=data:image/svg+xml;base64,..." alt="ComfyUI">
  <img src="https://img.shields.io/badge/Python-3.8+-green?logo=python" alt="Python">
  <img src="https://img.shields.io/badge/License-GPL--3.0-yellow" alt="GPL-3.0">
</p>

---

## ✨ Features

### 🔍 Browse & Search
- **Civitai** — Search by query, creator, model type, sort order, time period, base model (multi-select), and NSFW rating
- **Hugging Face** — Search by pipeline tag, library, author, and sort order
- **Lookup** — Resolve any Civitai URL, model ID, version ID, or SHA256 hash
- **Page navigation** — step through results with Prev/Next in both grids; the footer shows the range and total (`Page 2 · Showing 25–48 of 57 models`)

### 📥 Downloads
- **Login-required models** — set your Civitai API key in Settings and it is sent with the download; if Civitai still refuses, the job says why (creator requires login / file removed / rate limited) and offers a shortcut to Settings
- **The file you picked is the file you get** — the chosen variant's own URL (with its `fileId`) is what downloads
- **One-click download** with configurable folder, subfolder, and filename
- **Real-time progress** — speed, percentage, downloaded/total size
- **SHA256 hash always saved** — every downloaded model gets its hash stored in `.civitai.json`
- **Metadata & preview images** — optionally save alongside models
- **Batch downloads** from both Civitai and Hugging Face

### 🤗 Hugging Face Browse
- **All matching repos, not just the first 30** — step through pages with Prev/Next, each page fetched by offset
- Footer reports the page and what it holds (`Page 2 · 30 repos` / `Page 6 · 7 repos · end of results`)
- The server follows Hugging Face's `Link` header cursor when it has one, falling back to `skip`

### 🔎 Civitai Browse
- **All the results, not just the first page** — step through them with Prev/Next; a page replaces the grid and jumps back to the top
- Footer shows **"Page 2 · Showing 25–48 of 57 models"** so you can tell how much Civitai actually has
- Flags when Civitai is excluding adult models (`· adult hidden`) — tick X / XXX in the Bands row to include them

### ⭐ Bookmarks
- **Both sources** — Civitai *and* Hugging Face models can be bookmarked (each is keyed on its own id, so HF repos no longer collide)
- **Card grid** with preview, source chip, content band and remove button
- **Click a card** to open that model's full detail view and download it, exactly like the Civitai and HF tabs
- **Filter** by All / Civitai / Hugging Face

### 📂 Local Model Manager
- **Auto-scan** all 29 ComfyUI model folder types
- **Card grid** with preview images, model type, base model, and size
- **Full pages** — Civitai has no per-tier content filter, so the bands are applied server-side and a page keeps fetching until it is full, instead of showing the three or four models that happened to survive
- **Detail modal** — gallery, Civitai lookup, tags, description, copy path, delete
- **Disk usage display** — total model count and storage size in header
- **Filter** by name, type, or base model

### ⚡ Prompt Fetcher Node
- **Single ComfyUI graph node** with two outputs: `positive_prompt` and `negative_prompt`
- **⚡ Use in workflow** button in the lightbox sends prompts directly to the node
- Add the node to your workflow → click Use in workflow → run

### 🎨 UI/UX
- **Dark & Light themes** — toggle via ☀️/🌙 button in the top-right corner
- **Keyboard navigation** — `/` search, `←→↑↓` navigate cards, `Enter` opens, `Esc` closes, `1-5` switch tabs, `?` shows all shortcuts
- **Compact grid mode** — toggle via Settings or `Ctrl+C` for denser card layout
- **Comprehensive animations** — staggered card entrances, shimmer hover effects, spring physics, smooth transitions throughout
- **Content bands** — every model and showcase image is tagged PG / PG-13 / R / X / XXX; tick the ones you want (or hit **All** for every tier, including adult) and press Search to apply them
- **Find a creator's models** — type a Civitai username in the *Creator* field, or click any creator's name on a card or in the detail view to filter to just their models. Combining a creator with a search term searches that creator's models here rather than through Civitai, whose own `username` + `query` combination misses results that are plainly there
- **Fast image loading** — grids lazy-load their thumbnails, previews are re-encoded to WebP on the fly, and the lightbox shows a cached placeholder while the full view downloads. Settings → *Image quality* picks **Data saver** (~12 KB per card, ~52 KB per lightbox image) or **High** (~43 KB / ~277 KB); the untouched original is always one click away
- **NSFW blur** — R / X / XXX are blurred by default (PG and PG-13 stay visible), hover to reveal; the threshold is configurable in Settings
- **Responsive** — adapts to narrow sidebar widths
- **Civitai logo** — the “C” mark is painted onto the sidebar tab (ComfyUI only accepts icon *fonts*, so the PNG is applied over the glyph) and shown in the panel tab bar

### ⚙️ Settings
- **API Keys** — Civitai API key and Hugging Face token with status badges (● connected / ● not set)
- **Preferences** — save metadata, save previews, verify SHA256, NSFW blur + blur threshold, compact grid, image quality
- **Network** — switch between `civitai.com`, `civitai.red`, `civitai.work` domains
- **Quick Actions** — Auto-Tag, Cleanup, Organize, Rescan with one-click cards

---

## 🔞 Content Bands (PG · PG-13 · R · X · XXX)

Civitai splits models, LoRAs and showcase images into five strict tiers. This
extension uses exactly those tiers for **categorising** and for deciding what
to **blur**:

| Band | Name | Examples | Blurred by default |
|------|------|----------|--------------------|
| 🟢 **PG** | Safe for Work | Standard, universally safe content — zero adult material | no |
| 🟠 **PG-13** | Lightly Risqué | Revealing clothing, navels, cleavage, sexy attire, light violence, mild gore | no |
| 🔴 **R** | Risqué / Mature | Adult themes, partial nudity (bikinis, underwear, leotards), sensual but non-explicit situations, graphic violence | no |
| 🟣 **X** | Graphic Nudity | Explicit graphic nudity, clear anatomy, adult objects/settings, no full sexual acts | **yes** |
| ⚫ **XXX** | Overtly Sexual | Explicit sexual acts, highly graphic presentation, deeply disturbing concepts | **yes** |

**How it works**

- **Categorising** — every card shows a coloured band badge. A *model* is
  categorised by the highest tier among its own rating and all of its preview
  images; a *showcase image* is categorised individually (so one XXX preview
  marks the model XXX, while the model's own PG previews stay unblurred).
- **Filtering** — the search bar has five checkboxes, one per band. Ticking
  `PG` + `R` shows only models rated PG or R. Nothing ticked = no filter.
  The same filter applies inside a model's gallery.
- **Blurring** — only the **NSFW** bands are blurred (X and XXX by default).
  R gets a red badge but stays visible, matching Civitai's own behaviour.
  Hovering any blurred thumbnail reveals it.
- **Threshold** — Settings → Preferences → *Blur content rated* lets you pick
  `Off` / `R and up` (default) / `X and up` / `XXX only`. Changing it
  re-renders the tab immediately.
- **Local library** — downloaded models are categorised from their
  `.civitai.json` sidecar (only the `nsfwLevel` key is peeked at during a scan,
  so scanning stays fast).

Civitai reports the tier three different ways and all three are handled:

| Shape | Example | Meaning |
|-------|---------|---------|
| numeric bitmask | `nsfwLevel: 1 / 2 / 4 / 8 / 16 / 32` | PG / PG-13 / R / X / XXX / Blocked |
| string enum | `nsfwLevel: "None" / "Soft" / "Mature" / "X" / "XXX"` | the same five tiers |
| boolean | `nsfw: true` | flagged with no tier → treated as **R** (badged, not blurred) |

> The mapping lives in one place — [`js/rating.js`](js/rating.js) — and is
> mirrored for local scans in `utils.py`.
> Tests: `node tests/test_content_bands.mjs` and `node tests/test_band_ui.mjs`.

---

## 📦 Installation

1. Navigate to your ComfyUI `custom_nodes` directory:
   ```bash
   cd ComfyUI/custom_nodes
   ```

2. Clone this repository:
   ```bash
   git clone https://github.com/Darkdevworker/ComfyUI-CivitAiHF-Downloader.git
   ```

3. Install Python dependencies:
   ```bash
   pip install -r ComfyUI-CivitAiHF-Downloader/requirements.txt
   ```

4. Restart ComfyUI

> **Note:** The extension registers a **CivitAI+HF** tab in the ComfyUI sidebar. No additional configuration is needed — it works out of the box for public models.

---

## 🚀 Quick Start

1. Open the **CivitAI** tab in the ComfyUI sidebar
2. Type a search query (or leave empty for top models)
3. Select filters: model type, sort order, time period, base model (pick several at once), NSFW rating
   Base model and the content bands only record your choice — nothing searches until you press **Search**, so picking five base models still costs one request
4. Click **Search** (or press `Enter`)
5. Click any model card → select version → click **Download**
6. Switch to the **Local** tab to see your downloaded models

### Using the Prompt Fetcher

1. Add the **Prompt Fetcher** node to your ComfyUI workflow
2. Connect `positive_prompt` → your positive CLIP text encoder
3. Connect `negative_prompt` → your negative CLIP text encoder
4. Browse models → open a preview image → click **⚡ Use in workflow**
5. Run your workflow — the node outputs the stored prompts

---

---

## 🗂 Supported Model Folders

All 29 ComfyUI model folder types are supported:

```
audio_encoders    clip_vision       diffusers           geometry_estimation    loras            style_models     vae
background_removal configs          diffusion_models    gligen                 model_patches    text_encoders    vae_approx
checkpoints       controlnet        embeddings          hypernetworks          optical_flow     unet
clip              detection         frame_interpolation latent_upscale_models  photomaker       upscale_models
```

---

## 📁 Project Structure

| File | Purpose |
|------|---------|
| `__init__.py` | Extension entry point, registers sidebar tab |
| `nodes.py` | **Prompt Fetcher** graph node |
| `nodes_display.py` | Markdown Presenter node |
| `server.py` | All API endpoints (search, download, local management, settings, prompt fetcher) |
| `bookmarks_store.py` | Bookmark storage + identity rules (Civitai and Hugging Face side by side) — testable without ComfyUI |
| `utils.py` | Database manager, Civitai/HF API utilities, hash computation, model scanning |
| `js/civitai.js` | Full sidebar UI (tabs, modals, lightbox, downloads, settings, keyboard nav, animations) |
| `js/rating.js` | Content-band definitions (PG / PG-13 / R / X / XXX), rating normalisation, blur + filter helpers |
| `js/logo.js` | Tab marks (Civitai “C”, green download arrow) as data URIs, `installSidebarLogo()` for the sidebar tab, and `TAB_LOGOS` — the list of tabs that use an image instead of an emoji |
| `js/civitai.css` | Dark/Light theme with animations, glassmorphism, responsive layout |

---

## 🔌 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/civitai/search` | Search Civitai models |
| `GET` | `/civitai/lookup` | Lookup by hash, URL, or ID |
| `GET` | `/civitai/model/{id}` | Fetch full model data |
| `POST` | `/civitai/download` | Start a download |
| `GET` | `/civitai/downloads` | List active/completed downloads |
| `POST` | `/civitai/download-cancel` | Cancel a download |
| `GET` | `/civitai/local-models` | List locally downloaded models |
| `GET` | `/civitai/local-previews` | Get preview images for a model |
| `GET` | `/civitai/local-preview` | Serve a resized preview image |
| `POST` | `/civitai/delete-model` | Delete a local model |
| `GET` | `/civitai/hf-search` | Search Hugging Face models |
| `GET` | `/civitai/hf-files` | List files in a HF repo |
| `POST` | `/civitai/hf/download` | Download from Hugging Face |
| `POST` | `/civitai/prompt-fetcher` | Send prompts to Prompt Fetcher node |
| `GET` | `/civitai/prompt-fetcher` | Get current stored prompts |
| `GET` | `/civitai/settings` | Load settings |
| `POST` | `/civitai/settings` | Save settings |
| `POST` | `/civitai/auto-tag` | Tag models with Civitai metadata |
| `POST` | `/civitai/cleanup-scan` | Find orphan files |
| `POST` | `/civitai/auto-organize` | Sort models into subfolders |
| `POST` | `/civitai/rescan` | Force re-scan model folders |
| `GET` | `/civitai/ping` | Test API connection |

---

## 📄 License

GPL-3.0 — see [LICENSE](LICENSE) for details.
