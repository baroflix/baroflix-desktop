const { ipcRenderer } = require('electron');

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

// ─── SETTINGS CACHE ──────────────────────────────────────────────────────────
// Pre-fetch at startup so injectAppSettings() can run synchronously.

let cachedSettings   = null;
let cachedAppVersion = '';

Promise.all([
    ipcRenderer.invoke('get-settings-data').catch(() => null),
    ipcRenderer.invoke('get-app-version').catch(() => '')
]).then(([settings, version]) => {
    cachedSettings   = settings;
    cachedAppVersion = version;
});

// ─── ACCENT LINE SYNC ─────────────────────────────────────────────────────────

let lastAccentRaw = '';

/** Resolve any CSS color string → 'r,g,b' via a scratch canvas. */
function parseColorRGB(css) {
    try {
        const c = document.createElement('canvas');
        c.width = c.height = 1;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#ff3d3d'; // reset so stale value doesn't leak
        ctx.fillStyle = css;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return `${d[0]},${d[1]},${d[2]}`;
    } catch (_) { return null; }
}

function syncAccentColor() {
    const raw = getComputedStyle(document.documentElement)
                    .getPropertyValue('--accent').trim();
    if (!raw || raw === lastAccentRaw) return;
    lastAccentRaw = raw;

    const rgb = parseColorRGB(raw);
    if (!rgb) return;

    // Forward to main process → title bar window
    ipcRenderer.send('accent-color-changed', rgb);
}

// ─── APP SETTINGS PANEL (injected into /settings) ────────────────────────────

let settingsInjected = false;

// Inject immediately when the user navigates to /settings instead of waiting
// up to 2 s for the main loop. Retries up to 15 × 50 ms while React renders
// the container, then the loop acts as a final safety net.
function tryInjectSettings(retries = 15) {
    if (window.location.pathname !== '/settings') return;
    if (document.getElementById('bf-app-settings')) return;
    injectAppSettings();
    if (!settingsInjected && retries > 0)
        setTimeout(() => tryInjectSettings(retries - 1), 50);
}

const _origPushState = history.pushState.bind(history);
history.pushState = function (...args) { _origPushState(...args); tryInjectSettings(); };
window.addEventListener('popstate', tryInjectSettings);

function injectAppSettings() {
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

    // Use pre-fetched cache; if it isn't warm yet the 2 s loop will retry
    const cfg        = cachedSettings;
    const appVersion = cachedAppVersion;
    if (!cfg) return;

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
        const saved = {
            customUrl:            'https://baroflix.github.io',
            pipShortcut:          document.getElementById('bf-pip-input').value,
            discordEnabled:       document.getElementById('bf-discord').checked,
            cloudflareDns:        document.getElementById('bf-dns').checked,
            hardwareAcceleration: document.getElementById('bf-hwaccel').checked,
            volumeBoost:          parseInt(document.getElementById('bf-vol-range').value, 10)
        };
        ipcRenderer.send('save-settings', saved);
        if (cachedSettings) Object.assign(cachedSettings, saved); // keep cache in sync
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

function detectPlayer(overrideUrl) {
    try {
        // Prefer the live frame URL from the main process — it tracks internal
        // navigation (e.g. Next Episode) that never updates the DOM src attribute.
        let src = overrideUrl;
        if (!src) {
            const iframe = document.querySelector('iframe[src*="player.videasy.net"]') ||
                           document.querySelector('iframe[src*="videasy.net"]');
            if (!iframe || !iframe.src) return null;
            src = iframe.src;
        }
        if (!src.includes('videasy.net')) return null;

        const url   = new URL(src);
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
async function updatePlaybackTracking(mediaType, id, season, episode, iframeData) {
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

    // iframeData is pre-fetched by the main loop (avoids a second IPC round-trip)
    if (iframeData) {
        return {
            currentTime: iframeData.time,
            isPlaying:   !iframeData.paused
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
        syncAccentColor();

        applyVolumeBoost();

        // ── App settings panel ───────────────────────────────────────────────
        const onSettings = window.location.pathname === '/settings';
        if (onSettings) {
            injectAppSettings();
        } else if (settingsInjected) {
            settingsInjected = false;
        }

        // ── RPC ──────────────────────────────────────────────────────────────
        // Fetch the real frame URL + playback state from the main process.
        // frame.url reflects internal navigation (Next Episode), unlike iframe.src.
        let iframeData = null;
        if (document.querySelector('iframe[src*="videasy.net"]')) {
            try { iframeData = await ipcRenderer.invoke('get-iframe-time'); } catch (_) {}
        }

        const playing = detectPlayer(iframeData?.frameUrl);

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

        const { currentTime, isPlaying } = await updatePlaybackTracking(mediaType, id, season, episode, iframeData);

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
