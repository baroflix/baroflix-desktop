const { ipcRenderer } = require('electron');
const path = require('path');
const fs   = require('fs');

// ─── LOGO ────────────────────────────────────────────────────────────────────
// Load as base64 so it works inside https://baroflix.github.io.
// Wrapped in try-catch so a missing file never crashes the whole preload.
let LOGO_B64 = null;
try {
    LOGO_B64 = 'data:image/png;base64,' +
        fs.readFileSync(path.join(__dirname, 'images', 'baroflix_oneline.png')).toString('base64');
} catch (e) {
    console.warn('[baroflix] Could not load logo:', e.message);
}

// ─── STATE ───────────────────────────────────────────────────────────────────

let currentVolumeBoost = 100;
let audioCtx   = null;
let gainNode   = null;
let boundVideo = null;

const mediaCache  = {};
const fetchingNow = new Set();

let lastRpcSnapshot = '';
let lastSentTime    = 0;
let lastSentDate    = 0;

// Playback state — used for pause detection and timestamp extrapolation
let pbKey     = '';   // 'mediaType-id-season-episode' currently tracked
let pbStored  = -1;   // last timestamp read from localStorage
let pbWall    = 0;    // wall clock (ms) when pbStored was last updated
let pbPlaying = false;

let lastIframeTime = -1;
let lastIframeWall = 0;
let iframePlaying = false;

const TMDB_KEY = '15d2ea6d0dc1d476efbca3eba2b9bbfb';

// ─── SETTINGS SYNC ───────────────────────────────────────────────────────────

ipcRenderer.send('get-settings');
ipcRenderer.on('settings-data', (_e, d) => { currentVolumeBoost = d.volumeBoost || 100; });
ipcRenderer.on('apply-volume-boost', (_e, v) => { currentVolumeBoost = v; });

// ─── TITLE BAR ───────────────────────────────────────────────────────────────

function injectTitleBar() {
    if (document.getElementById('bf-bar')) return;
    if (!document.head || !document.body) return;

    if (!document.getElementById('bf-bar-css')) {
        const style = document.createElement('style');
        style.id = 'bf-bar-css';
        style.textContent = `
            #bf-bar {
                position:fixed;top:0;left:0;right:0;height:30px;z-index:9998;
                display:flex;align-items:center;
                background:rgba(9,9,9,.88);
                backdrop-filter:blur(20px) saturate(1.4);
                -webkit-backdrop-filter:blur(20px) saturate(1.4);
                border-bottom:1px solid rgba(255,255,255,.04);
                -webkit-app-region:drag;
                user-select:none;-webkit-user-select:none;
            }
            #bf-bar::before {
                content:'';position:absolute;top:0;left:15%;right:15%;height:1px;
                background:linear-gradient(90deg,transparent,rgba(255,61,61,.5) 35%,rgba(255,100,100,.65) 50%,rgba(255,61,61,.5) 65%,transparent);
                pointer-events:none;
            }
            #bf-bar-logo  { padding:0 0 0 14px;display:flex;align-items:center;-webkit-app-region:no-drag;flex-shrink:0; }
            #bf-bar-drag  { flex:1; }
            #bf-bar-btns  { display:flex;height:100%;-webkit-app-region:no-drag;flex-shrink:0; }
            #bf-bar-btns button {
                display:flex;align-items:center;justify-content:center;
                width:44px;height:100%;border:none;background:transparent;
                color:rgba(255,255,255,.55);cursor:pointer;padding:0;outline:none;
                transition:background .12s,color .12s;-webkit-app-region:no-drag;
            }
            #bf-bar-btns button:hover { background:rgba(255,255,255,.09);color:#fff; }
            #bf-btn-close:hover       { background:#c42b1c!important;color:#fff!important; }
            body   { padding-top:30px!important; }
            header { top:30px!important; }
        `;
        document.head.appendChild(style);
    }

    const bar = document.createElement('div');
    bar.id = 'bf-bar';
    bar.innerHTML = `
        <div id="bf-bar-logo"></div>
        <div id="bf-bar-drag"></div>
        <div id="bf-bar-btns">
            <button id="bf-btn-min" title="Minimize">
                <svg width="10" height="1" viewBox="0 0 10 1" fill="currentColor"><rect width="10" height="1"/></svg>
            </button>
            <button id="bf-btn-max" title="Maximize">
                <svg id="bf-max-icon" width="10" height="10" viewBox="0 0 10 10"
                     fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round">
                    <rect x=".5" y=".5" width="9" height="9"/>
                </svg>
            </button>
            <button id="bf-btn-close" title="Close">
                <svg width="10" height="10" viewBox="0 0 10 10"
                     fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
                    <line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/>
                </svg>
            </button>
        </div>`;
    document.body.insertBefore(bar, document.body.firstChild);

    // Set logo via .src to avoid innerHTML issues with large base64 strings
    const logoEl = document.getElementById('bf-bar-logo');
    if (LOGO_B64) {
        const img = document.createElement('img');
        img.src     = LOGO_B64;
        img.alt     = 'baroflix';
        img.draggable = false;
        img.style.cssText = 'height:20px;width:auto;display:block;opacity:.92;';
        img.onerror = () => {
            logoEl.innerHTML = `<span style="color:#fff;font-weight:900;font-size:12px;font-family:sans-serif;letter-spacing:.3px">BARO<span style="color:#ff3d3d">FLIX</span></span>`;
        };
        logoEl.appendChild(img);
    } else {
        logoEl.innerHTML = `<span style="color:#fff;font-weight:900;font-size:12px;font-family:sans-serif;letter-spacing:.3px">BARO<span style="color:#ff3d3d">FLIX</span></span>`;
    }

    document.getElementById('bf-btn-min').addEventListener('click', () => ipcRenderer.send('window-minimize'));
    document.getElementById('bf-btn-max').addEventListener('click', () => ipcRenderer.send('window-maximize'));
    document.getElementById('bf-btn-close').addEventListener('click', () => ipcRenderer.send('window-close'));

    ipcRenderer.invoke('window-is-maximized').then(isMax => setMaxIcon(isMax)).catch(() => {});
}

function setMaxIcon(isMax) {
    const icon = document.getElementById('bf-max-icon');
    if (!icon) return;
    icon.innerHTML = isMax
        ? `<rect x="2.5" y=".5" width="7" height="7"/>
           <rect x=".5" y="2.5" width="7" height="7" fill="rgba(9,9,9,.85)"/>
           <rect x=".5" y="2.5" width="7" height="7"/>`
        : `<rect x=".5" y=".5" width="9" height="9"/>`;
}

// Register maximize icon updater once (not per injectTitleBar call)
ipcRenderer.on('window-maximized', (_e, isMax) => setMaxIcon(isMax));

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectTitleBar);
} else {
    injectTitleBar();
}

// ─── APP SETTINGS PANEL (injected into /settings) ────────────────────────────

let settingsInjected = false;

async function injectAppSettings() {
    if (document.getElementById('bf-app-settings')) return;
    settingsInjected = false;

    // Find the settings content container (baroflix uses .space-y-6 inside max-w-3xl)
    const container = document.querySelector('.space-y-6') 
                   || document.querySelector('.flex.flex-col.gap-6')
                   || document.querySelector('.max-w-3xl')
                   || document.querySelector('main > div > div')
                   || document.querySelector('main > div')
                   || document.querySelector('main');
    if (!container) return;

    // Load current values from main process
    let cfg = {}, appVersion = '';
    try {
        [cfg, appVersion] = await Promise.all([
            ipcRenderer.invoke('get-settings-data'),
            ipcRenderer.invoke('get-app-version').catch(() => '')
        ]);
    } catch (_) { return; }

    const A = 'var(--accent, #ff3d3d)';

    const panel = document.createElement('section');
    panel.id = 'bf-app-settings';
    panel.style.cssText = `
        border-radius:20px;
        background:rgba(255,255,255,.03);
        border:1px solid rgba(255,255,255,.07);
        padding:20px;
    `;
    panel.innerHTML = `
        <style>
            #bf-app-settings h3 {
                font-size:15px;font-weight:600;color:#fff;margin:0 0 20px;
                display:flex;align-items:center;gap:8px;
            }
            #bf-app-settings h3 svg { color:${A}; }
            .bf-row {
                display:flex;justify-content:space-between;align-items:center;
                padding:12px 0;border-bottom:1px solid rgba(255,255,255,.06);gap:16px;
            }
            .bf-row:last-of-type { border-bottom:none;padding-bottom:0; }
            .bf-lbl { font-size:13.5px;font-weight:500;color:#fff; }
            .bf-hint { font-size:11.5px;color:rgba(255,255,255,.38);margin-top:3px;line-height:1.4; }
            /* Toggle */
            .bf-switch { position:relative;display:inline-block;width:44px;height:23px;flex-shrink:0; }
            .bf-switch input { opacity:0;width:0;height:0; }
            .bf-slider {
                position:absolute;cursor:pointer;inset:0;
                background:#252525;border-radius:23px;
                transition:.22s cubic-bezier(.4,0,.2,1);
            }
            .bf-slider::before {
                content:'';position:absolute;
                height:17px;width:17px;left:3px;bottom:3px;
                background:#fff;border-radius:50%;
                transition:.22s cubic-bezier(.4,0,.2,1);
                box-shadow:0 1px 3px rgba(0,0,0,.5);
            }
            .bf-switch input:checked + .bf-slider { background:${A}; }
            .bf-switch input:checked + .bf-slider::before { transform:translateX(21px); }
            /* Volume */
            #bf-vol-wrap { display:flex;align-items:center;gap:12px;margin-top:10px; }
            #bf-vol-range {
                -webkit-appearance:none;flex-grow:1;height:5px;
                background:#252525;border-radius:3px;outline:none;cursor:pointer;
            }
            #bf-vol-range::-webkit-slider-thumb {
                -webkit-appearance:none;width:15px;height:15px;border-radius:50%;
                background:${A};cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.5);
                transition:transform .1s;
            }
            #bf-vol-range::-webkit-slider-thumb:hover { transform:scale(1.25); }
            #bf-vol-val { font-family:ui-monospace,monospace;font-size:13px;font-weight:700;
                color:${A};min-width:42px;text-align:right; }
            /* Shortcut */
            #bf-pip-input {
                width:100%;margin-top:9px;padding:9px 12px;
                background:#0a0a0a;color:${A};border:1px dashed #3a3a3a;
                border-radius:8px;box-sizing:border-box;
                font-family:ui-monospace,monospace;font-size:13px;font-weight:600;
                text-align:center;cursor:pointer;outline:none;
            }
            #bf-pip-input:focus { border-style:solid;border-color:${A}; }
            /* Save */
            #bf-save-btn {
                width:100%;margin-top:18px;padding:12px;
                background:${A};color:#fff;border:none;border-radius:10px;
                font-size:14px;font-weight:700;cursor:pointer;
                transition:opacity .15s,transform .1s;
                box-shadow:0 4px 14px rgba(255,61,61,.2);
            }
            #bf-save-btn:hover  { opacity:.85; }
            #bf-save-btn:active { transform:scale(.98); }
            #bf-save-ok {
                display:none;text-align:center;margin-top:10px;
                font-size:13px;color:rgba(255,255,255,.45);
            }
            /* Update check */
            #bf-check-update-btn {
                padding:6px 12px;background:transparent;
                color:${A};border:1px solid ${A};border-radius:8px;
                font-size:12px;font-weight:600;cursor:pointer;
                transition:background .15s;white-space:nowrap;flex-shrink:0;
            }
            #bf-check-update-btn:hover:not(:disabled) { background:rgba(255,61,61,.12); }
            #bf-check-update-btn:disabled { opacity:.5;cursor:default; }
            #bf-ver-status { transition:color .3s; }
        </style>

        <h3>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                <rect x="2" y="3" width="20" height="14" rx="2"/>
                <path d="M8 21h8M12 17v4"/>
            </svg>
            app settings
        </h3>

        <!-- Discord RPC -->
        <div class="bf-row">
            <div>
                <div class="bf-lbl">discord rich presence</div>
                <div class="bf-hint">show what you're watching on Discord</div>
            </div>
            <label class="bf-switch">
                <input type="checkbox" id="bf-discord" ${cfg.discordEnabled !== false ? 'checked' : ''} />
                <span class="bf-slider"></span>
            </label>
        </div>

        <!-- Cloudflare DNS -->
        <div class="bf-row">
            <div>
                <div class="bf-lbl">secure DNS (cloudflare 1.1.1.1)</div>
                <div class="bf-hint">bypass ISP-level blocks — requires restart</div>
            </div>
            <label class="bf-switch">
                <input type="checkbox" id="bf-dns" ${cfg.cloudflareDns ? 'checked' : ''} />
                <span class="bf-slider"></span>
            </label>
        </div>

        <!-- Hardware Acceleration -->
        <div class="bf-row">
            <div>
                <div class="bf-lbl">hardware acceleration</div>
                <div class="bf-hint">GPU rendering for smooth 4K playback — requires restart</div>
            </div>
            <label class="bf-switch">
                <input type="checkbox" id="bf-hwaccel" ${cfg.hardwareAcceleration !== false ? 'checked' : ''} />
                <span class="bf-slider"></span>
            </label>
        </div>

        <!-- Volume Boost -->
        <div class="bf-row" style="flex-direction:column;align-items:flex-start;">
            <div class="bf-lbl">audio volume boost</div>
            <div class="bf-hint">amplify beyond the normal maximum — 100% = stream default</div>
            <div id="bf-vol-wrap">
                <input type="range" id="bf-vol-range" min="100" max="300" step="10" value="${cfg.volumeBoost || 100}" />
                <span id="bf-vol-val">${cfg.volumeBoost || 100}%</span>
            </div>
        </div>

        <!-- PiP Shortcut -->
        <div class="bf-row" style="flex-direction:column;align-items:flex-start;">
            <div class="bf-lbl">picture-in-picture shortcut</div>
            <div class="bf-hint">click and press any key combination</div>
            <input type="text" id="bf-pip-input" readonly
                   value="${cfg.pipShortcut || 'CommandOrControl+P'}" />
        </div>

        <!-- Version & Updates -->
        <div class="bf-row" style="align-items:center;">
            <div>
                <div class="bf-lbl">desktop app</div>
                <div class="bf-hint" id="bf-ver-status">${appVersion ? `v${appVersion}` : ''}</div>
            </div>
            <button id="bf-check-update-btn">check for updates</button>
        </div>

        <button id="bf-save-btn">save app settings</button>
        <div id="bf-save-ok">✓ saved</div>
    `;

    container.appendChild(panel);
    settingsInjected = true;

    // Volume display
    document.getElementById('bf-vol-range').addEventListener('input', e => {
        document.getElementById('bf-vol-val').textContent = e.target.value + '%';
    });

    // PiP shortcut recorder
    const pipInput = document.getElementById('bf-pip-input');
    pipInput.addEventListener('keydown', e => {
        e.preventDefault();
        const keys = [];
        if (e.ctrlKey || e.metaKey) keys.push('CommandOrControl');
        if (e.shiftKey) keys.push('Shift');
        if (e.altKey)   keys.push('Alt');
        let k = e.key;
        if (['Control','Shift','Alt','Meta'].includes(k)) return;
        if (k === ' ') k = 'Space';
        else if (k.length === 1) k = k.toUpperCase();
        else if (k.startsWith('Arrow')) k = k.replace('Arrow', '');
        keys.push(k);
        pipInput.value = keys.join('+');
    });

    // Check for updates
    document.getElementById('bf-check-update-btn').addEventListener('click', async () => {
        const btn    = document.getElementById('bf-check-update-btn');
        const status = document.getElementById('bf-ver-status');
        btn.disabled = true;
        btn.textContent = 'checking…';
        const result = await ipcRenderer.invoke('check-for-updates').catch(() => 'error');
        btn.disabled = false;
        btn.textContent = 'check for updates';
        if (result === 'available') {
            status.textContent = 'update available — downloading…';
            status.style.color = A;
        } else if (result === 'not-available') {
            status.textContent = `v${appVersion} — you're up to date ✓`;
            status.style.color = '';
        } else {
            status.textContent = `v${appVersion} — couldn't check for updates`;
            status.style.color = '';
        }
    });

    // Save
    document.getElementById('bf-save-btn').addEventListener('click', () => {
        ipcRenderer.send('save-settings', {
            customUrl:            'https://baroflix.github.io',
            pipShortcut:          document.getElementById('bf-pip-input').value,
            discordEnabled:       document.getElementById('bf-discord').checked,
            cloudflareDns:        document.getElementById('bf-dns').checked,
            hardwareAcceleration: document.getElementById('bf-hwaccel').checked,
            volumeBoost:          parseInt(document.getElementById('bf-vol-range').value, 10)
        });
        const ok = document.getElementById('bf-save-ok');
        ok.style.display = 'block';
        setTimeout(() => { ok.style.display = 'none'; }, 2000);
    });
}

// ─── TMDB ─────────────────────────────────────────────────────────────────────

function toApiType(raw) {
    const s = raw ? String(raw).toLowerCase() : '';
    if (s === 'tv' || s === 'series' || s === 'show' || s === 'episode') return 'tv';
    if (s === 'anime') return 'tv';
    return 'movie';
}

async function fetchMediaInfo(apiType, tmdbId) {
    const key = `${apiType}-${tmdbId}`;
    if (fetchingNow.has(key) || mediaCache[tmdbId]?.fetched) return;
    fetchingNow.add(key);
    try {
        const res  = await fetch(`https://api.themoviedb.org/3/${apiType}/${tmdbId}?api_key=${TMDB_KEY}`);
        const data = await res.json();
        if (!mediaCache[tmdbId]) mediaCache[tmdbId] = { episodeInfo: {} };
        mediaCache[tmdbId].title    = data.title || data.name || '';
        mediaCache[tmdbId].duration = (apiType === 'movie') ? (data.runtime || 0) * 60 : 0;
        mediaCache[tmdbId].poster   = data.poster_path
            ? `https://image.tmdb.org/t/p/w300${data.poster_path}` : '';
        mediaCache[tmdbId].fetched  = true;
    } catch (_) {}
    fetchingNow.delete(key);
}

async function fetchEpisodeInfo(tvId, season, episode) {
    const epKey    = `${season}-${episode}`;
    const fetchKey = `ep-${tvId}-${epKey}`;
    if (mediaCache[tvId]?.episodeInfo?.[epKey] || fetchingNow.has(fetchKey)) return;
    fetchingNow.add(fetchKey);
    try {
        const res  = await fetch(
            `https://api.themoviedb.org/3/tv/${tvId}/season/${season}/episode/${episode}?api_key=${TMDB_KEY}`
        );
        const data = await res.json();
        if (!mediaCache[tvId])             mediaCache[tvId] = { episodeInfo: {} };
        if (!mediaCache[tvId].episodeInfo) mediaCache[tvId].episodeInfo = {};
        mediaCache[tvId].episodeInfo[epKey] = {
            name:     data.name || '',
            duration: data.runtime ? data.runtime * 60 : 0
        };
    } catch (_) {}
    fetchingNow.delete(fetchKey);
}


// ─── PLAYER DETECTION ────────────────────────────────────────────────────────
// Detect the videasy iframe in DOM and parse its URL.
// Baroflix renders <iframe src="https://player.videasy.net/{type}/{id}/..."> via FullscreenPlayer.
// URL paths:  /movie/{id}          /tv/{id}/{season}/{episode}          /anime/{id}/{episode}

function detectPlayer() {
    try {
        const iframe = document.querySelector('iframe[src*="player.videasy.net"]') ||
                       document.querySelector('iframe[src*="videasy.net"]');
        if (!iframe || !iframe.src) return null;

        const url   = new URL(iframe.src);
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length < 2) return null;

        const mediaType = parts[0];             // 'movie' | 'tv' | 'anime'
        const id        = parts[1];
        let   season = 0, episode = 0;

        if (mediaType === 'tv') {
            season  = parseInt(parts[2]) || 1;
            episode = parseInt(parts[3]) || 1;
        } else if (mediaType === 'anime') {
            episode = parseInt(parts[2]) || 1;
        }

        return { mediaType, id, season, episode };
    } catch (_) { return null; }
}

// Track playback state for pause detection and timestamp extrapolation.
// Returns { currentTime, isPlaying }.
async function updatePlaybackTracking(mediaType, id, season, episode) {
    const key = `${mediaType}-${id}-${season}-${episode}`;
    const now = Date.now();

    // Reset tracking when content changes (different show/episode)
    if (key !== pbKey) {
        pbKey     = key;
        pbPlaying = false;
        pbStored  = -1;
        pbWall    = now;

        iframePlaying = false;
        lastIframeTime = -1;
        lastIframeWall = now;
    }

    let dataFromIframe = null;
    try {
        dataFromIframe = await ipcRenderer.invoke('get-iframe-time');
    } catch (_) {}

    if (dataFromIframe !== null) {
        return { 
            currentTime: dataFromIframe.time, 
            isPlaying: !dataFromIframe.paused 
        };
    }

    let stored = 0;
    try {
        const raw = localStorage.getItem('baroflix.progress');
        if (raw) {
            const data = JSON.parse(raw);
            if (typeof data[key] === 'number') stored = data[key];
        }
    } catch (_) {}

    if (stored !== pbStored) {
        // Timestamp changed → video is playing
        pbPlaying = true;
        pbStored  = stored;
        pbWall    = now;
    } else if (pbPlaying && (now - pbWall) > 7000) {
        // Same timestamp for 7 s → paused
        pbPlaying = false;
    }

    if (pbStored < 0) pbStored = stored;

    // Extrapolate actual current position while playing
    const elapsed     = pbPlaying ? (now - pbWall) / 1000 : 0;
    const currentTime = Math.max(0, pbStored + elapsed);

    return { currentTime, isPlaying: pbPlaying };
}

// ─── VOLUME BOOST ─────────────────────────────────────────────────────────────

function applyVolumeBoost() {
    const video = Array.from(document.querySelectorAll('video'))
        .reduce((best, v) => (!best || (v.duration || 0) > (best.duration || 0)) ? v : best, null);
    if (!video) return;
    if (currentVolumeBoost !== 100) {
        if (!audioCtx) {
            try {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                gainNode = audioCtx.createGain();
                gainNode.connect(audioCtx.destination);
            } catch (_) {}
        }
        if (audioCtx && audioCtx.state === 'running' && video !== boundVideo) {
            try { audioCtx.createMediaElementSource(video).connect(gainNode); boundVideo = video; }
            catch (_) { boundVideo = video; }
        }
        if (gainNode) gainNode.gain.value = currentVolumeBoost / 100;
    } else if (gainNode) {
        gainNode.gain.value = 1.0;
    }
}

// ─── MAIN LOOP (2 s) ─────────────────────────────────────────────────────────

let mainLoopRunning = false;
setInterval(async () => {
    if (mainLoopRunning) return;
    mainLoopRunning = true;
    try {
        if (!document.getElementById('bf-bar')) injectTitleBar();

        applyVolumeBoost();

        // ── App settings panel ───────────────────────────────────────────────
        const onSettings = window.location.pathname === '/settings';
        if (onSettings) {
            injectAppSettings();
        } else if (settingsInjected) {
            settingsInjected = false;
        }

        // ── RPC ──────────────────────────────────────────────────────────────
        const playing = detectPlayer();

        if (!playing) {
            const snap = `idle:${window.location.pathname}`;
            if (snap !== lastRpcSnapshot) {
                lastRpcSnapshot = snap;
                ipcRenderer.send('update-playback', {
                    showTitle: null, episodeName: null,
                    currentTime: 0, duration: 0,
                    isPlaying: false, poster: null,
                    url: window.location.href
                });
            }
            return;
        }

        const { mediaType, id, season, episode } = playing;
        const apiType = toApiType(mediaType);

        // Kick off TMDB fetches if not cached yet
        if (!mediaCache[id]?.fetched) fetchMediaInfo(apiType, id);
        if (season && episode)        fetchEpisodeInfo(id, season, episode);

        const cache = mediaCache[id] || {};
        const showTitle = cache.title || '';
        let episodeName = '';
        let duration    = cache.duration || 0;
        const poster    = cache.poster   || '';

        if (season && episode) {
            const epKey  = `${season}-${episode}`;
            const epInfo = cache.episodeInfo?.[epKey];
            episodeName  = `S${String(season).padStart(2,'0')}E${String(episode).padStart(2,'0')}`;
            if (epInfo?.name)     episodeName += `: ${epInfo.name}`;
            if (epInfo?.duration) duration = epInfo.duration;
        }

        const { currentTime, isPlaying } = await updatePlaybackTracking(mediaType, id, season, episode);

        const snap = JSON.stringify({ showTitle, episodeName, poster, duration, isPlaying });
        const now  = Date.now();
        // Resend if state changed OR progress bar would drift >5 s while playing
        const expectedTime = lastSentTime + (isPlaying ? (now - lastSentDate) / 1000 : 0);
        const drift        = Math.abs(currentTime - expectedTime);

        if (snap !== lastRpcSnapshot || (isPlaying && drift > 5)) {
            lastRpcSnapshot = snap;
            lastSentTime    = currentTime;
            lastSentDate    = now;
            ipcRenderer.send('update-playback', {
                showTitle:   showTitle || 'baroflix',
                episodeName,
                currentTime,
                duration,
                isPlaying,
                poster:      poster.length <= 256 ? poster : '',
                url:         window.location.href
            });
        }
    } catch (e) {
        console.warn('RPC loop error:', e);
    } finally {
        mainLoopRunning = false;
    }
}, 2000);
