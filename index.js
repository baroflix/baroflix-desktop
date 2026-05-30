const { app, BrowserWindow, BrowserView, ipcMain, globalShortcut, screen, shell } = require('electron');
const path = require('path');
const Store = require('electron-store');
const DiscordRPC = require('discord-rpc');
const { autoUpdater } = require('electron-updater');

const store = new Store();

if (store.get('hardwareAcceleration', true) === false) {
    app.disableHardwareAcceleration();
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
        const url = commandLine.find(arg => arg.startsWith('baroflix://'));
        if (url && contentView) {
            const defaultUrl = 'https://baroflix.github.io';
            const baseUrl = store.get('customUrl', defaultUrl);
            const finalBaseUrl = baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`;
            try {
                const parsedUrl = new URL(url);
                contentView.webContents.loadURL(finalBaseUrl + (finalBaseUrl.endsWith('/') ? '' : '/') + parsedUrl.hash);
            } catch (e) {
                console.error('Failed to parse deep link URL', e);
            }
        }
    });
}

if (process.defaultApp) {
    if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient('baroflix', process.execPath, [path.resolve(process.argv[1])]);
    }
} else {
    app.setAsDefaultProtocolClient('baroflix');
}

app.on('open-url', (event, url) => {
    event.preventDefault();
    if (contentView && url.startsWith('baroflix://')) {
        const defaultUrl = 'https://baroflix.github.io';
        const baseUrl = store.get('customUrl', defaultUrl);
        const finalBaseUrl = baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`;
        try {
            const parsedUrl = new URL(url);
            contentView.webContents.loadURL(finalBaseUrl + (finalBaseUrl.endsWith('/') ? '' : '/') + parsedUrl.hash);
        } catch (e) {
            console.error('Failed to parse open-url deep link', e);
        }
    }
});

let mainWindow;
let splashWindow;
let contentView;   // BrowserView — holds the website, starts at y = 30
let rpc;

// ─── DISCORD RPC ─────────────────────────────────────────────────────────────
const clientId = '1509971842176389170';
let rpcReady = false;

DiscordRPC.register(clientId);

// ─── SPLASH ───────────────────────────────────────────────────────────────────

function createSplash() {
    splashWindow = new BrowserWindow({
        width: 380, height: 240,
        frame: false, transparent: true,
        backgroundColor: '#00000000',
        alwaysOnTop: true, resizable: false, movable: false, skipTaskbar: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true }
    });
    splashWindow.loadFile('splash.html');
    splashWindow.center();
}

function closeSplash() {
    if (splashWindow && !splashWindow.isDestroyed()) {
        splashWindow.destroy();
        splashWindow = null;
    }
}

// ─── MAIN WINDOW ─────────────────────────────────────────────────────────────

function createWindow() {
    const defaultUrl = 'https://baroflix.github.io';
    const url = store.get('customUrl', defaultUrl);

    // Main window: hosts only the 30 px title bar (titlebar.html).
    // nodeIntegration is required so titlebar.html can use require('electron').
    mainWindow = new BrowserWindow({
        width: 1280, height: 720,
        minWidth: 800, minHeight: 500,
        frame: false, show: false,
        title: 'baroflix',
        backgroundColor: '#090909',
        icon: path.join(__dirname, 'build', process.platform === 'win32' ? 'icon2.ico' : 'icon2.png'),
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile('titlebar.html');

    // Content view: loads the website, positioned below the title bar.
    contentView = new BrowserView({
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            autoplayPolicy: 'no-user-gesture-required'
        }
    });
    mainWindow.addBrowserView(contentView);

    function updateContentBounds() {
        if (!mainWindow || mainWindow.isDestroyed() || !contentView) return;
        const [w, h] = mainWindow.getContentSize();
        contentView.setBounds({ x: 0, y: 30, width: w, height: h - 30 });
    }
    updateContentBounds();
    mainWindow.on('resize', updateContentBounds);

    contentView.webContents.loadURL(url.startsWith('http') ? url : `https://${url}`);

    const splashStart = Date.now();
    contentView.webContents.once('did-finish-load', () => {
        const delay = Math.max(0, 2400 - (Date.now() - splashStart));
        setTimeout(() => { closeSplash(); mainWindow.show(); }, delay);
    });
    // Fallback: always show after 10 s even on slow connections
    setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
            closeSplash(); mainWindow.show();
        }
    }, 10000);

    mainWindow.on('maximize',   () => mainWindow.webContents.send('window-maximized', true));
    mainWindow.on('unmaximize', () => mainWindow.webContents.send('window-maximized', false));

    // ─── Popup blocker (on content view) ─────────────────────────────────────
    contentView.webContents.setWindowOpenHandler(({ url: openedUrl }) => {
        const isOAuth = openedUrl.includes('accounts.google.com') ||
                        openedUrl.includes('supabase.co') ||
                        openedUrl.includes('github.com/login');
        if (isOAuth) shell.openExternal(openedUrl);
        return { action: 'deny' };
    });

    contentView.webContents.on('will-navigate', (event, navUrl) => {
        try {
            const parsed  = new URL(navUrl);
            const base    = store.get('customUrl', defaultUrl);
            const allowed = ['baroflix.github.io', 'localhost', '127.0.0.1',
                             'supabase.co', 'accounts.google.com'];

            if (parsed.hostname.includes('supabase.co') && parsed.pathname.includes('/auth/v1/authorize')) {
                event.preventDefault();
                parsed.searchParams.set('redirect_to', 'baroflix://auth');
                shell.openExternal(parsed.toString());
                return;
            }

            try { allowed.push(new URL(base).hostname); } catch (_) {}
            if (!allowed.some(h => parsed.hostname === h || parsed.hostname.endsWith('.' + h))) {
                event.preventDefault();
            }
        } catch (_) { event.preventDefault(); }
    });

    mainWindow.on('closed', () => { mainWindow = null; contentView = null; });
    registerShortcuts();
}

// ─── PICTURE-IN-PICTURE ──────────────────────────────────────────────────────

let isPipMode   = false;
let prePipBounds = null;

function togglePip() {
    if (!mainWindow) return;
    if (isPipMode) {
        mainWindow.setAlwaysOnTop(false);
        mainWindow.setVisibleOnAllWorkspaces(false);
        if (prePipBounds) mainWindow.setBounds(prePipBounds, true);
        isPipMode = false;
    } else {
        prePipBounds = mainWindow.getBounds();
        const d = screen.getDisplayMatching(prePipBounds);
        const w = 480, h = 270;
        mainWindow.setBounds({
            x: d.workArea.x + d.workArea.width  - w - 20,
            y: d.workArea.y + d.workArea.height - h - 20,
            width: w, height: h
        }, true);
        mainWindow.setAlwaysOnTop(true, 'floating');
        mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        isPipMode = true;
    }
}

// ─── SHORTCUTS ───────────────────────────────────────────────────────────────

function registerShortcuts() {
    globalShortcut.unregisterAll();

    // Ctrl+, → navigate to /settings inside the content view
    globalShortcut.register('CommandOrControl+,', () => {
        if (!contentView) return;
        contentView.webContents.executeJavaScript(
            `window.history.pushState(null,'','/settings');` +
            `window.dispatchEvent(new PopStateEvent('popstate',{state:null}));`
        ).catch(() => {});
    });

    const pip = store.get('pipShortcut', 'CommandOrControl+P');
    try { globalShortcut.register(pip, () => togglePip()); }
    catch (err) { console.log('PiP shortcut failed:', err.message); }
}

// ─── APP LIFECYCLE ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
    autoUpdater.checkForUpdatesAndNotify();

    if (store.get('cloudflareDns', false)) {
        app.configureHostResolver({
            enableBuiltInResolver: true,
            secureDnsMode: 'secure',
            secureDnsServers: [
                'https://cloudflare-dns.com/dns-query',
                'https://dns.google/dns-query'
            ]
        });
    }

    createSplash();
    createWindow();

    rpc = new DiscordRPC.Client({ transport: 'ipc' });
    rpc.on('ready', () => {
        rpcReady = true;
        if (store.get('discordEnabled', true) !== false) {
            setActivityRaw({
                type: 0, name: 'baroflix', details: 'idle',
                largeImageKey: 'icon', largeImageText: 'baroflix'
            });
        }
    });
    rpc.login({ clientId }).catch(err =>
        console.log('Discord RPC failed (is Discord running?):', err.message)
    );

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
app.on('will-quit', () => globalShortcut.unregisterAll());

// ─── IPC — SETTINGS ──────────────────────────────────────────────────────────

// Used by the injected settings panel (invoke = promise-based)
ipcMain.handle('get-settings-data', () => ({
    customUrl:            store.get('customUrl', 'https://baroflix.github.io'),
    pipShortcut:          store.get('pipShortcut', 'CommandOrControl+P'),
    discordEnabled:       store.get('discordEnabled', true),
    cloudflareDns:        store.get('cloudflareDns', false),
    hardwareAcceleration: store.get('hardwareAcceleration', true),
    volumeBoost:          store.get('volumeBoost', 100)
}));

// Legacy send-based (used for initial preload volume sync)
ipcMain.on('get-settings', (event) => {
    event.reply('settings-data', {
        customUrl:            store.get('customUrl', 'https://baroflix.github.io'),
        pipShortcut:          store.get('pipShortcut', 'CommandOrControl+P'),
        discordEnabled:       store.get('discordEnabled', true),
        cloudflareDns:        store.get('cloudflareDns', false),
        hardwareAcceleration: store.get('hardwareAcceleration', true),
        volumeBoost:          store.get('volumeBoost', 100)
    });
});

ipcMain.on('save-settings', (_event, data) => {
    const oldDiscord = store.get('discordEnabled', true);

    store.set('customUrl',            data.customUrl);
    store.set('pipShortcut',          data.pipShortcut);
    store.set('discordEnabled',       data.discordEnabled);
    store.set('cloudflareDns',        data.cloudflareDns);
    store.set('hardwareAcceleration', data.hardwareAcceleration);
    store.set('volumeBoost',          data.volumeBoost);

    registerShortcuts();

    if (rpcReady) {
        if (oldDiscord && !data.discordEnabled) {
            rpc.clearActivity().catch(console.error);
        } else if (!oldDiscord && data.discordEnabled) {
            setActivityRaw({
                type: 0, name: 'baroflix', details: 'idle',
                largeImageKey: 'icon', largeImageText: 'baroflix'
            });
        }
    }

    if (contentView) contentView.webContents.send('apply-volume-boost', data.volumeBoost);
});

ipcMain.handle('get-app-version', () => app.getVersion());

// Forward accent colour from content preload → title bar
ipcMain.on('accent-color-changed', (_event, rgb) => {
    mainWindow?.webContents.send('accent-color', rgb);
});

ipcMain.handle('check-for-updates', () => new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        autoUpdater.removeListener('update-available',     onAvail);
        autoUpdater.removeListener('update-not-available', onNone);
        autoUpdater.removeListener('error',                onErr);
        resolve(result);
    };
    const onAvail = () => done('available');
    const onNone  = () => done('not-available');
    const onErr   = () => done('error');
    const timer   = setTimeout(() => done('error'), 30000);

    autoUpdater.once('update-available',     onAvail);
    autoUpdater.once('update-not-available', onNone);
    autoUpdater.once('error',                onErr);

    try { autoUpdater.checkForUpdates(); }
    catch (_) { done('error'); }
}));

// ─── IPC — WINDOW CONTROLS ───────────────────────────────────────────────────

ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
    if (!mainWindow) return;
    mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('window-close', () => mainWindow?.close());
ipcMain.handle('window-is-maximized', () => mainWindow?.isMaximized() ?? false);

// ─── IPC — DISCORD PLAYBACK ──────────────────────────────────────────────────

ipcMain.handle('get-iframe-time', async (event) => {
    try {
        const getAllFrames = (frame) => {
            let frames = [frame];
            if (frame.frames) {
                for (const child of frame.frames) {
                    frames = frames.concat(getAllFrames(child));
                }
            }
            return frames;
        };
        const allFrames = getAllFrames(event.sender.mainFrame);
        for (const frame of allFrames) {
            if (frame.url && frame.url.includes('videasy.net')) {
                try {
                    const data = await frame.executeJavaScript(`
                        (() => {
                            const v = document.querySelector('video');
                            return v ? { time: v.currentTime, paused: v.paused } : null;
                        })()
                    `);
                    if (data && typeof data.time === 'number') return { ...data, frameUrl: frame.url };
                } catch (e) {}
            }
        }
    } catch (e) {
        console.error('get-iframe-time error:', e);
    }
    return null;
});

ipcMain.on('update-playback', (_event, data) => {
    if (!rpcReady || store.get('discordEnabled', true) === false) return;

    const { showTitle, episodeName, currentTime, duration, isPlaying, poster } = data;

    if (!isPlaying && (!duration || duration === 0)) {
        setActivityRaw({
            type: 0, name: 'baroflix', details: 'browsing',
            largeImageKey: 'icon', largeImageText: 'baroflix',
            buttons: [{ label: 'visit baroflix', url: 'https://baroflix.github.io' }]
        });
        return;
    }

    const activity = {
        type: 3,
        name: showTitle || 'baroflix',
        details: showTitle || 'watching a video',
        state: episodeName || undefined,
        largeImageText: 'baroflix',
        buttons: [{ label: 'visit baroflix', url: 'https://baroflix.github.io' }]
    };

    activity.largeImageKey = (poster && poster.startsWith('http') && poster.length <= 256)
        ? poster : 'icon';

    if (isPlaying && duration > 0) {
        const now = Date.now();
        activity.startTimestamp = Math.floor(now - currentTime * 1000);
        activity.endTimestamp   = Math.floor(activity.startTimestamp + duration * 1000);
    } else if (!isPlaying && duration > 0) {
        activity.state = activity.state ? `${activity.state} (paused)` : 'paused';
    }

    setActivityRaw(activity);
});

// ─── DISCORD HELPER ──────────────────────────────────────────────────────────

function setActivityRaw(args) {
    if (!rpc || typeof rpc.request !== 'function' || !rpcReady) return Promise.resolve();

    let timestamps;
    if (args.startTimestamp != null || args.endTimestamp != null) {
        timestamps = {};
        if (args.startTimestamp != null) timestamps.start = args.startTimestamp;
        if (args.endTimestamp   != null) timestamps.end   = args.endTimestamp;
    }

    const assets = (args.largeImageKey || args.largeImageText) ? {
        large_image: args.largeImageKey,
        large_text:  args.largeImageText,
        small_image: args.smallImageKey,
        small_text:  args.smallImageText
    } : undefined;

    return rpc.request('SET_ACTIVITY', {
        pid: process.pid,
        activity: {
            type:      args.type ?? 0,
            name:      args.name,
            state:     args.state,
            details:   args.details,
            timestamps,
            assets,
            buttons:   args.buttons,
            instance:  false
        }
    }).catch(console.error);
}
