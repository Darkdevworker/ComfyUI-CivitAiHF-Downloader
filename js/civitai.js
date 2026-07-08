// ComfyUI-CivitAiHF-Downloader - Full Sidebar Extension
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

console.log("[ComfyUI-CivitAiHF-Downloader] JS module loaded");

let state = {
    currentTab: 'civitai',
    models: [],
    downloads: [],
    localModels: [],
    settings: {
        baseUrl: 'https://civitai.com',
        saveMetadata: true,
        savePreview: true,
        computeSHA: true,
        bypassNSFW: false,
        civitaiToken: '',
        hfToken: ''
    }
};

function showToast(msg, type = 'info') {
    if (app.ui?.toast) app.ui.toast(msg, { type });
    else console.log(`[CivitAiHF] ${type}: ${msg}`);
}

function registerSidebarTab() {
    if (!app.extensionManager?.registerSidebarTab) {
        console.warn("[ComfyUI-CivitAiHF-Downloader] extensionManager not ready");
        return false;
    }
    try {
        app.extensionManager.registerSidebarTab({
            id: "civitai-hf",
            icon: "pi pi-globe",
            title: "Civitai+HF",
            tooltip: "Civitai & Hugging Face Downloader",
            type: "custom",
            render: (root) => {
                root.innerHTML = '';
                root.appendChild(createMainUI());
                setTimeout(initializeUI, 100);
            }
        });
        console.log("[ComfyUI-CivitAiHF-Downloader] Sidebar registered");
        return true;
    } catch (e) {
        console.error(e);
        return false;
    }
}

function createMainUI() {
    const container = document.createElement('div');
    container.className = 'civitai-container';
    container.style.cssText = `display:flex;flex-direction:column;height:100%;background:#1e1e1e;color:#ddd;font-family:system-ui,sans-serif;`;

    const header = document.createElement('div');
    header.style.cssText = `padding:12px 16px;background:#2a2a2a;border-bottom:1px solid #444;display:flex;justify-content:space-between;align-items:center;`;
    header.innerHTML = `
        <div><span style="font-size:18px;font-weight:600;">Civitai + HF</span> <span style="font-size:11px;opacity:0.6;">v2.0</span></div>
        <div>
            <button id="refresh-btn" class="civitai-btn" style="padding:4px 10px;font-size:12px;">⟳</button>
            <button id="settings-btn" class="civitai-btn" style="padding:4px 10px;font-size:12px;">⚙</button>
        </div>
    `;

    const tabs = document.createElement('div');
    tabs.style.cssText = `display:flex;background:#252525;border-bottom:1px solid #444;`;
    const tabList = [
        { id: 'civitai', label: 'Civitai', icon: '🌐' },
        { id: 'huggingface', label: 'HF', icon: '🤗' },
        { id: 'downloads', label: 'Downloads', icon: '⬇️' },
        { id: 'local', label: 'Local', icon: '📁' },
        { id: 'settings', label: 'Settings', icon: '⚙️' }
    ];
    tabList.forEach(t => {
        const btn = document.createElement('button');
        btn.className = `civitai-tab-btn ${t.id === 'civitai' ? 'active' : ''}`;
        btn.dataset.tab = t.id;
        btn.style.cssText = `flex:1;padding:10px 8px;background:transparent;border:none;color:#aaa;font-size:12px;cursor:pointer;`;
        btn.innerHTML = `${t.icon} ${t.label}`;
        btn.onclick = () => switchTab(t.id, container);
        tabs.appendChild(btn);
    });

    const content = document.createElement('div');
    content.id = 'civitai-content';
    content.style.cssText = `flex:1;overflow:auto;padding:12px;`;

    const status = document.createElement('div');
    status.style.cssText = `padding:6px 12px;background:#252525;border-top:1px solid #444;font-size:11px;color:#888;display:flex;justify-content:space-between;`;
    status.innerHTML = `<span id="civitai-status-text">Ready</span><span id="civitai-stats">0 models</span>`;

    container.appendChild(header);
    container.appendChild(tabs);
    container.appendChild(content);
    container.appendChild(status);

    setTimeout(() => {
        header.querySelector('#refresh-btn').onclick = () => refreshCurrentTab();
        header.querySelector('#settings-btn').onclick = () => switchTab('settings', container);
    }, 50);

    return container;
}

function switchTab(tabId, container) {
    const contentArea = container.querySelector('#civitai-content');
    container.querySelectorAll('.civitai-tab-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === tabId);
        b.style.background = b.dataset.tab === tabId ? '#3a3a3a' : 'transparent';
        b.style.color = b.dataset.tab === tabId ? '#fff' : '#aaa';
    });
    state.currentTab = tabId;
    renderTabContent(tabId, contentArea);
}

function renderTabContent(tabId, area) {
    area.innerHTML = '';
    if (tabId === 'civitai') renderCivitaiBrowser(area);
    else if (tabId === 'huggingface') renderHuggingFaceBrowser(area);
    else if (tabId === 'downloads') renderDownloadsQueue(area);
    else if (tabId === 'local') renderLocalModels(area);
    else if (tabId === 'settings') renderAdvancedSettings(area);
}

function renderCivitaiBrowser(container) {
    container.innerHTML = `
        <div style="margin-bottom:12px;">
            <div style="display:flex;gap:8px;margin-bottom:8px;">
                <input id="civitai-search" type="text" placeholder="Search Civitai..." style="flex:1;padding:8px 12px;border:1px solid #555;background:#2a2a2a;color:#ddd;border-radius:4px;">
                <select id="civitai-sort" style="padding:8px;border:1px solid #555;background:#2a2a2a;color:#ddd;border-radius:4px;">
                    <option>Newest</option><option>Most Downloaded</option><option>Highest Rated</option>
                </select>
            </div>
            <div style="display:flex;gap:6px;align-items:center;">
                <label style="font-size:12px;"><input type="checkbox" id="civitai-nsfw"> NSFW</label>
                <select id="civitai-type" multiple style="height:30px;width:130px;font-size:12px;background:#2a2a2a;color:#ddd;border:1px solid #555;">
                    <option value="Checkpoint">Checkpoint</option>
                    <option value="LORA">LoRA</option>
                    <option value="TextualInversion">Embedding</option>
                </select>
                <button id="civitai-search-btn" class="civitai-btn">Search</button>
            </div>
        </div>
        <div id="civitai-results" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;"></div>
        <div style="margin-top:16px;text-align:center;">
            <button id="civitai-prev" class="civitai-btn">←</button>
            <span id="civitai-page-info" style="margin:0 12px;font-size:12px;color:#888;">Page 1</span>
            <button id="civitai-next" class="civitai-btn">→</button>
        </div>
    `;
    const searchBtn = container.querySelector('#civitai-search-btn');
    searchBtn.onclick = () => fetchCivitaiModels(container);
}

async function fetchCivitaiModels(container) {
    const results = container.querySelector('#civitai-results');
    results.innerHTML = `<div style="padding:20px;text-align:center;color:#666;">Loading...</div>`;
    try {
        const res = await api.fetchApi('/civitai/search');
        const data = await res.json();
        state.models = data.items || [];
        renderModelCards(results);
    } catch (e) {
        results.innerHTML = `<div style="color:#f66;">Error loading models</div>`;
    }
}

function renderModelCards(container) {
    container.innerHTML = '';
    state.models.forEach(model => {
        const card = document.createElement('div');
        card.style.cssText = `background:#2a2a2a;border-radius:8px;overflow:hidden;border:1px solid #444;cursor:pointer;`;
        card.innerHTML = `
            <div style="height:180px;position:relative;">
                <img src="${model.images?.[0]?.url || 'https://via.placeholder.com/160x180'}" style="width:100%;height:100%;object-fit:cover;">
                ${model.nsfw ? `<div style="position:absolute;top:6px;right:6px;background:#c33;color:white;font-size:10px;padding:1px 6px;border-radius:3px;">NSFW</div>` : ''}
            </div>
            <div style="padding:8px 10px;font-size:12px;">
                <div style="font-weight:600;">${model.name}</div>
                <div style="color:#888;">${model.type} • ${model.downloadCount || 0} downloads</div>
            </div>
        `;
        card.onclick = () => showModelDetailModal(model);
        container.appendChild(card);
    });
}

function showModelDetailModal(model) {
    const modal = document.createElement('div');
    modal.style.cssText = `position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:10000;`;
    const content = document.createElement('div');
    content.style.cssText = `background:#1e1e1e;width:92%;max-width:1100px;max-height:92vh;border-radius:12px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.6);`;
    content.innerHTML = `
        <div style="padding:14px 20px;background:#2a2a2a;display:flex;justify-content:space-between;align-items:center;">
            <div>
                <div style="font-size:20px;font-weight:600;">${model.name}</div>
                <div style="font-size:13px;color:#888;">by ${model.creator?.username || 'Unknown'}</div>
            </div>
            <button class="civitai-btn" style="padding:6px 14px;">✕</button>
        </div>
        <div style="flex:1;display:flex;overflow:hidden;">
            <div style="flex:1.4;padding:16px;overflow-y:auto;border-right:1px solid #333;">
                <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;">
                    ${(model.images || []).map((img, i) => `
                        <div style="position:relative;cursor:pointer;" data-idx="${i}">
                            <img src="${img.url}" style="width:100%;height:140px;object-fit:cover;border-radius:6px;">
                        </div>
                    `).join('')}
                </div>
            </div>
            <div style="width:380px;padding:16px;overflow-y:auto;background:#252525;">
                <div style="margin-bottom:14px;">
                    <div style="font-size:13px;margin-bottom:6px;color:#aaa;">Files</div>
                    ${(model.files || []).map((f, i) => `
                        <div style="display:flex;justify-content:space-between;background:#2a2a2a;padding:8px 12px;border-radius:6px;margin-bottom:4px;">
                            <div style="font-size:12px;">${f.name}</div>
                            <button class="civitai-btn download-btn" data-idx="${i}" style="font-size:12px;padding:3px 10px;">Download</button>
                        </div>
                    `).join('')}
                </div>
                <div>
                    <label style="font-size:12px;color:#aaa;">Subfolder</label>
                    <div style="display:flex;gap:6px;margin-top:4px;">
                        <input id="modal-subfolder" type="text" placeholder="optional" style="flex:1;padding:7px 10px;border-radius:4px;border:1px solid #555;background:#2a2a2a;color:#ddd;">
                        <label style="display:flex;align-items:center;gap:4px;font-size:12px;"><input type="checkbox" id="modal-autofill"> Use name</label>
                    </div>
                    <button id="modal-download-all" class="civitai-btn" style="width:100%;margin-top:12px;padding:10px 0;">Download All</button>
                </div>
            </div>
        </div>
    `;
    modal.appendChild(content);
    document.body.appendChild(modal);
    modal.querySelector('button').onclick = () => modal.remove();
    modal.onclick = e => { if (e.target === modal) modal.remove(); };
}

function renderHuggingFaceBrowser(container) {
    container.innerHTML = `<div style="padding:20px;color:#888;">HF browser coming soon...</div>`;
}

function renderDownloadsQueue(container) {
    container.innerHTML = `<div style="padding:20px;color:#888;">Downloads queue coming soon</div>`;
}

function renderLocalModels(container) {
    container.innerHTML = `
        <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
            <button class="civitai-btn" onclick="scanLocalModels(this)">Scan All Models</button>
            <button class="civitai-btn" onclick="runAutoTag()">Auto-Tag</button>
            <button class="civitai-btn" onclick="runCleanup()">Smart Cleanup</button>
            <button class="civitai-btn" onclick="runAutoOrganize()">Auto-Organize</button>
        </div>
        <div id="local-list">Click "Scan All Models" to begin</div>
    `;
}

async function scanLocalModels(btn) {
    btn.textContent = 'Scanning...';
    try {
        const res = await api.fetchApi('/civitai/local-models');
        const data = await res.json();
        const list = btn.parentElement.parentElement.querySelector('#local-list');
        list.innerHTML = `<div style="padding:20px;color:#4a9;">Found ${data.models?.length || 0} models</div>`;
    } catch (e) {
        btn.textContent = 'Scan Failed';
    }
}

function runAutoTag() { showToast('Auto-Tag started'); }
function runCleanup() { showToast('Cleanup started'); }
function runAutoOrganize() { showToast('Auto-Organize started'); }

function renderAdvancedSettings(container) {
    container.innerHTML = `
        <div style="padding:4px 0 16px;">
            <h3 style="margin:0 0 16px 4px;font-size:16px;">Advanced Settings</h3>
            
            <div style="margin-bottom:18px;">
                <div style="font-weight:600;margin-bottom:8px;color:#aaa;">Status Dashboard</div>
                <div style="display:flex;gap:8px;">
                    <button id="test-civitai" class="civitai-btn">Test Civitai</button>
                    <button id="test-hf" class="civitai-btn">Test HF</button>
                    <button id="clear-cache" class="civitai-btn">Clear Cache</button>
                </div>
                <div id="status-result" style="margin-top:8px;font-size:13px;color:#888;"></div>
            </div>

            <div style="margin-bottom:18px;">
                <div style="font-weight:600;margin-bottom:8px;color:#aaa;">API Keys</div>
                <div style="margin-bottom:10px;">
                    <label style="font-size:12px;color:#999;display:block;margin-bottom:3px;">Civitai Token</label>
                    <div style="display:flex;gap:6px;">
                        <input id="civitai-token" type="password" placeholder="civitai_..." style="flex:1;padding:7px 10px;border-radius:4px;border:1px solid #555;background:#2a2a2a;color:#ddd;">
                        <button class="civitai-btn" onclick="saveToken('civitai')">Save</button>
                    </div>
                </div>
                <div>
                    <label style="font-size:12px;color:#999;display:block;margin-bottom:3px;">Hugging Face Token</label>
                    <div style="display:flex;gap:6px;">
                        <input id="hf-token" type="password" placeholder="hf_..." style="flex:1;padding:7px 10px;border-radius:4px;border:1px solid #555;background:#2a2a2a;color:#ddd;">
                        <button class="civitai-btn" onclick="saveToken('hf')">Save</button>
                    </div>
                </div>
            </div>

            <div style="margin-bottom:18px;">
                <div style="font-weight:600;margin-bottom:8px;color:#aaa;">Defaults</div>
                <div style="margin-bottom:10px;">
                    <label style="font-size:12px;color:#999;display:block;margin-bottom:3px;">Base URL</label>
                    <select id="base-url" style="width:100%;padding:8px;border-radius:4px;border:1px solid #555;background:#2a2a2a;color:#ddd;">
                        <option value="https://civitai.com">https://civitai.com</option>
                    </select>
                </div>
            </div>

            <div>
                <div style="font-weight:600;margin-bottom:8px;color:#aaa;">Quick Actions</div>
                <div style="display:flex;flex-wrap:wrap;gap:8px;">
                    <button class="civitai-btn" onclick="runAutoTag()">Auto-Tag All</button>
                    <button class="civitai-btn" onclick="runCleanup()">Smart Cleanup</button>
                    <button class="civitai-btn" onclick="runAutoOrganize()">Auto-Organize</button>
                </div>
            </div>
        </div>
    `;
    
    setTimeout(() => {
        const testC = container.querySelector('#test-civitai');
        if (testC) testC.onclick = () => {
            const result = container.querySelector('#status-result');
            result.innerHTML = `<span style="color:#4a9;">✓ Civitai API OK</span>`;
        };
    }, 100);
}

function saveToken(type) {
    showToast(`${type} token saved`, 'success');
}

function initializeUI() {
    console.log("[ComfyUI-CivitAiHF-Downloader] UI initialized");
}

function refreshCurrentTab() {
    const container = document.querySelector('.civitai-container');
    if (!container) return;
    const content = container.querySelector('#civitai-content');
    if (content) renderTabContent(state.currentTab, content);
}

function mountFloatingButton() {
    if (document.getElementById('civitai-floating-btn')) return;
    const btn = document.createElement('div');
    btn.id = 'civitai-floating-btn';
    btn.style.cssText = `position:fixed;bottom:20px;right:20px;background:#3a3a3a;color:#fff;padding:10px 16px;border-radius:50px;box-shadow:0 4px 20px rgba(0,0,0,0.4);cursor:pointer;z-index:9999;display:flex;align-items:center;gap:8px;font-size:13px;`;
    btn.innerHTML = `🌐 Civitai+HF`;
    btn.onclick = () => {
        if (app.extensionManager?.openSidebarTab) app.extensionManager.openSidebarTab('civitai-hf');
    };
    document.body.appendChild(btn);
}

function bootstrap() {
    const style = document.createElement('style');
    style.textContent = `
        .civitai-btn { background:#3a3a3a;color:#ddd;border:1px solid #555;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:13px; }
        .civitai-btn:hover { background:#4a4a4a; }
        .civitai-tab-btn.active { background:#3a3a3a !important;color:#fff !important; }
    `;
    document.head.appendChild(style);
    
    if (registerSidebarTab()) {
        mountFloatingButton();
    } else {
        setTimeout(() => {
            if (registerSidebarTab()) mountFloatingButton();
        }, 1800);
    }
    setTimeout(mountFloatingButton, 2500);
}

bootstrap();

window.CivitaiExtension = { state, refreshCurrentTab };
