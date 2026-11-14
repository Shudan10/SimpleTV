/*
 * SimpleTV's server: the home screen, the phone remote, and the glue between
 * every way of pressing a button and the browser that is on the TV.
 *
 * Who may do what:
 *   - the TV itself (requests from 127.0.0.1, which is the kiosk browser on
 *     this machine) may do anything;
 *   - a paired phone may do anything a remote does, with its token;
 *   - anyone else on the network may load the remote page and try to pair.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as store from './lib/store.js';
import * as apps from './lib/apps.js';
import * as jellyfin from './lib/jellyfin.js';
import * as audio from './lib/audio.js';
import * as remotes from './lib/remotes.js';
import * as update from './lib/update.js';
import * as qr from './lib/qr.js';
import * as power from './lib/power.js';
import * as autostart from './lib/autostart.js';
import { lanAddress } from './lib/net.js';
import { Browser } from './lib/browser.js';
import { Gamepads } from './lib/gamepad.js';
import { accept as acceptWs } from './lib/ws.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 8480);
const MODE = process.env.SIMPLETV_MODE === 'tv' ? 'tv' : 'window';
const VERSION = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version;
const HOME_URL = `http://127.0.0.1:${PORT}/tv/`;

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
let powerOk = false;
let autostartOn = false;

store.load();

// ------------------------------------------------------------ live parts --

const browser = new Browser({ homeUrl: HOME_URL, log });
const pads = new Gamepads({ log });

const tvClients = new Set(); // server-sent event streams to the home screen
const remoteSockets = new Set();

function broadcast(event, data = {}) {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of tvClients) res.write(line);
}

function nowShowing() {
    return { onHome: browser.onHome !== false, app: browser.app ? { id: browser.app.id, name: browser.app.name, nav: browser.app.nav } : null, screen: browser.connected };
}

function toRemotes(msg) {
    for (const s of remoteSockets) s.send(msg);
}

browser.on('app', () => {
    pads.passthrough = Boolean(browser.app?.gamepad);
    toRemotes({ t: 'showing', ...nowShowing() });
});
browser.on('status', () => toRemotes({ t: 'showing', ...nowShowing() }));
browser.on('home-pressed', () => broadcast('home'));
const padLastSeen = new Map(); // name -> when it was last connected
pads.on('change', (list) => {
    broadcast('controllers', { list });
    const now = Date.now();
    for (const name of list) {
        const last = padLastSeen.get(name);
        if (!last || now - last > 30_000) browser.toast(`${name} connected`).catch(() => {});
        padLastSeen.set(name, now);
    }
});
setInterval(() => {
    for (const name of pads.list()) padLastSeen.set(name, Date.now());
}, 5000);
pads.on('action', (a) => act(a).catch(() => {}));

async function showVolume(s) {
    const text = s.muted ? 'Muted' : `Volume ${s.volume}%`;
    await browser.toast(text, s.muted ? 0 : s.volume);
    toRemotes({ t: 'volume', volume: s.volume, muted: s.muted });
}

// Scrolling on the home screen, turned into steps between rows and tiles.
const scrollAcc = { x: 0, y: 0, at: 0 };
const SCROLL_STEP = 90;
async function scrollAsKeys(dx, dy) {
    const now = Date.now();
    if (now - scrollAcc.at > 400) scrollAcc.x = scrollAcc.y = 0;
    scrollAcc.at = now;
    scrollAcc.x += dx;
    scrollAcc.y += dy;
    while (Math.abs(scrollAcc.y) >= SCROLL_STEP) {
        const down = scrollAcc.y > 0;
        scrollAcc.y -= down ? SCROLL_STEP : -SCROLL_STEP;
        await browser.key(down ? 'down' : 'up');
    }
    while (Math.abs(scrollAcc.x) >= SCROLL_STEP) {
        const right = scrollAcc.x > 0;
        scrollAcc.x -= right ? SCROLL_STEP : -SCROLL_STEP;
        await browser.key(right ? 'right' : 'left');
    }
}

/** Every button press, from the phone, a controller or the API, ends here. */
async function act(a) {
    switch (a.action) {
        case 'key':
            return browser.key(String(a.key));
        case 'text':
            // The home screen has its own keyboard and decides which box the
            // text belongs in; anywhere else it is typed into the page.
            if (browser.onHome) return broadcast('text', { text: String(a.text || '').slice(0, 500) });
            return browser.text(String(a.text || ''));
        case 'move':
            return browser.move(Number(a.dx) || 0, Number(a.dy) || 0);
        case 'click':
            return browser.click();
        case 'scroll':
            if (browser.onHome) return scrollAsKeys(Number(a.dx) || 0, Number(a.dy) || 0);
            return browser.scroll(Number(a.dx) || 0, Number(a.dy) || 0);
        case 'home':
            return browser.home();
        case 'back':
            return browser.back();
        case 'playpause':
            return browser.playPause();
        case 'search':
            if (!browser.onHome) await browser.open(HOME_URL);
            return broadcast('search');
        case 'volume':
            return showVolume(await audio.change(a.step > 0 ? 5 : -5));
        case 'mute':
            return showVolume(await audio.toggleMute());
        default:
            throw new Error(`Unknown action ${a.action}`);
    }
}

// ---------------------------------------------------------------- http ----

const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

function tokenOf(req, url) {
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) return h.slice(7);
    return url.searchParams.get('token');
}

function sendJson(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
}

async function readBody(req) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
        size += c.length;
        if (size > 256 * 1024) throw Object.assign(new Error('Too large.'), { status: 413 });
        chunks.push(c);
    }
    if (!chunks.length) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw Object.assign(new Error('Not JSON.'), { status: 400 });
    }
}

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
    '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep)) return false;
    let stat;
    try {
        stat = fs.statSync(file);
    } catch {
        return false;
    }
    if (!stat.isFile()) return false;
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
    return true;
}

function remoteUrl() {
    return `http://${lanAddress()}:${PORT}/remote/`;
}

function state(local) {
    const cfg = store.load();
    return {
        version: VERSION,
        mode: MODE,
        deviceName: cfg.deviceName,
        screensaverMinutes: cfg.screensaverMinutes,
        uiSounds: cfg.uiSounds !== false,
        apps: apps.all(),
        pinned: cfg.pinned.filter((id) => apps.find(id)),
        jellyfin: jellyfin.status(),
        controllers: pads.list(),
        showing: nowShowing(),
        remoteUrl: remoteUrl(),
        update: update.lastCheck(),
        canPower: powerOk,
        autostart: autostartOn,
        ...(local ? { pairCode: remotes.currentCode(), remotes: remotes.list() } : {}),
    };
}

// [method, regex, handler(req, res, ctx), access] where access is 'tv' (this
// machine only), 'remote' (this machine or a paired phone) or 'open'.
const routes = [
    ['GET', /^\/healthz$/, (req, res) => sendJson(res, 200, { ok: true }), 'open'],
    ['GET', /^\/api\/state$/, (req, res, c) => sendJson(res, 200, state(c.local)), 'remote'],
    ['GET', /^\/api\/events$/, (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(': hello\n\n');
        tvClients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
        req.on('close', () => {
            clearInterval(ping);
            tvClients.delete(res);
        });
    }, 'tv'],
    ['GET', /^\/api\/pair\/qr\.svg$/, (req, res) => {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
        res.end(qr.svg(`${remoteUrl()}#code=${remotes.currentCode()}`));
    }, 'tv'],
    ['GET', /^\/remote\/manifest\.webmanifest$/, (req, res, c) => {
        const t = c.url.searchParams.get('t') || '';
        const paired = /^[A-Za-z0-9_-]{20,100}$/.test(t) && remotes.verify(t);
        res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-store' });
        res.end(
            JSON.stringify({
                name: `${store.load().deviceName} Remote`,
                short_name: store.load().deviceName,
                description: 'The remote for SimpleTV',
                id: '/remote/',
                start_url: paired ? `/remote/#t=${t}` : '/remote/',
                scope: '/remote/',
                display: 'standalone',
                orientation: 'portrait',
                background_color: '#0a0c11',
                theme_color: '#0a0c11',
                icons: [
                    { src: '/remote/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
                    { src: '/remote/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
                    { src: '/remote/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
                ],
            }),
        );
    }, 'open'],
    ['POST', /^\/api\/pair$/, async (req, res) => {
        const body = await readBody(req);
        const out = remotes.pair(String(body.code || '').replace(/\D/g, ''), body.name);
        broadcast('remotes', { remotes: remotes.list(), pairCode: remotes.currentCode() });
        browser.toast(`${out.remote.name} is now a remote`).catch(() => {});
        sendJson(res, 200, { token: out.token, deviceName: store.load().deviceName });
    }, 'open'],
    ['POST', /^\/api\/remotes\/revoke$/, async (req, res) => {
        const { id } = await readBody(req);
        remotes.revoke(String(id));
        for (const s of remoteSockets) if (s.remoteId === id) s.close();
        broadcast('remotes', { remotes: remotes.list(), pairCode: remotes.currentCode() });
        sendJson(res, 200, { ok: true });
    }, 'tv'],
    ['POST', /^\/api\/action$/, async (req, res) => {
        await act(await readBody(req));
        sendJson(res, 200, { ok: true });
    }, 'remote'],
    ['POST', /^\/api\/launch$/, async (req, res) => {
        const { id, path: extra } = await readBody(req);
        const app = apps.find(String(id));
        if (!app) throw Object.assign(new Error('No such app.'), { status: 404 });
        // A deeper link into the app, such as a search: only ever within it.
        if (extra && app.url) {
            const target = new URL(String(extra), app.url);
            if (target.host !== new URL(app.url).host) throw Object.assign(new Error('That link is outside the app.'), { status: 400 });
            await browser.open(target.toString(), { ua: app.ua });
        } else await browser.launch(app);
        sendJson(res, 200, { ok: true });
    }, 'remote'],
    ['POST', /^\/api\/apps\/pin$/, async (req, res) => {
        const { id, pinned } = await readBody(req);
        apps.setPinned(String(id), Boolean(pinned));
        sendJson(res, 200, state(true));
    }, 'tv'],
    ['POST', /^\/api\/apps\/move$/, async (req, res) => {
        const { id, by } = await readBody(req);
        apps.move(String(id), Math.sign(Number(by)) || 0);
        sendJson(res, 200, state(true));
    }, 'tv'],
    ['POST', /^\/api\/apps\/custom$/, async (req, res) => {
        const body = await readBody(req);
        apps.addCustom(body);
        sendJson(res, 200, state(true));
    }, 'tv'],
    ['POST', /^\/api\/apps\/remove$/, async (req, res) => {
        const { id } = await readBody(req);
        apps.removeCustom(String(id));
        sendJson(res, 200, state(true));
    }, 'tv'],
    ['GET', /^\/api\/jellyfin\/home$/, async (req, res) => sendJson(res, 200, (await jellyfin.home()) || {}), 'tv'],
    ['GET', /^\/api\/jellyfin\/search$/, async (req, res, c) => sendJson(res, 200, { items: await jellyfin.search(c.url.searchParams.get('q') || '') }), 'tv'],
    ['GET', /^\/api\/jf\/views$/, async (req, res) => sendJson(res, 200, { views: await jellyfin.views() }), 'tv'],
    ['GET', /^\/api\/jf\/items$/, async (req, res, c) => {
        const q = c.url.searchParams;
        sendJson(res, 200, await jellyfin.items({ parentId: q.get('parentId'), type: q.get('type'), sort: q.get('sort'), start: q.get('start'), limit: q.get('limit') }));
    }, 'tv'],
    ['GET', /^\/api\/jf\/item$/, async (req, res, c) => sendJson(res, 200, await jellyfin.detail(c.url.searchParams.get('id'))), 'tv'],
    ['GET', /^\/api\/jf\/episodes$/, async (req, res, c) => {
        const q = c.url.searchParams;
        sendJson(res, 200, { episodes: await jellyfin.episodes({ seriesId: q.get('seriesId'), seasonId: q.get('seasonId') }) });
    }, 'tv'],
    ['POST', /^\/api\/jf\/play$/, async (req, res) => sendJson(res, 200, await jellyfin.play(await readBody(req))), 'tv'],
    ['GET', /^\/api\/jf\/sub$/, async (req, res, c) => {
        const text = await jellyfin.subtitle(c.url.searchParams.get('path'));
        res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(text);
    }, 'tv'],
    ['POST', /^\/api\/jf\/report$/, async (req, res) => {
        const b = await readBody(req);
        await jellyfin.report(String(b.event), b);
        sendJson(res, 200, { ok: true });
    }, 'tv'],
    ['GET', /^\/api\/jellyfin\/discover$/, async (req, res) => sendJson(res, 200, { servers: await jellyfin.discover() }), 'tv'],
    ['POST', /^\/api\/jellyfin\/signin$/, async (req, res) => sendJson(res, 200, await jellyfin.signIn(await readBody(req))), 'tv'],
    ['POST', /^\/api\/jellyfin\/signout$/, async (req, res) => {
        await jellyfin.signOut();
        sendJson(res, 200, jellyfin.status());
    }, 'tv'],
    ['POST', /^\/api\/jellyfin\/play$/, async (req, res) => {
        const { id } = await readBody(req);
        await browser.open(jellyfin.playUrl(String(id)));
        sendJson(res, 200, { ok: true });
    }, 'tv'],
    ['GET', /^\/api\/audio$/, async (req, res) => sendJson(res, 200, await audio.status()), 'tv'],
    ['POST', /^\/api\/audio$/, async (req, res) => {
        const b = await readBody(req);
        let s;
        if (b.output) s = await audio.setOutput(b.output);
        else if (b.volume != null) s = await audio.set(b.volume);
        else if (b.mute) s = await audio.toggleMute();
        else s = await audio.status();
        sendJson(res, 200, s);
    }, 'tv'],
    ['POST', /^\/api\/settings$/, async (req, res) => {
        const b = await readBody(req);
        if (typeof b.autostart === 'boolean') {
            if (MODE !== 'window') throw Object.assign(new Error('In TV mode SimpleTV already starts with the computer.'), { status: 400 });
            autostartOn = await autostart.set(b.autostart);
        }
        store.update((cfg) => {
            if (typeof b.deviceName === 'string' && b.deviceName.trim()) cfg.deviceName = b.deviceName.trim().slice(0, 40);
            if (typeof b.uiSounds === 'boolean') cfg.uiSounds = b.uiSounds;
            if (b.screensaverMinutes != null) cfg.screensaverMinutes = Math.max(0, Math.min(120, Number(b.screensaverMinutes) || 0));
        });
        sendJson(res, 200, state(true));
    }, 'tv'],
    // What is on the TV right now, for checking it from this machine.
    ['GET', /^\/api\/screenshot\.jpg$/, async (req, res) => {
        const img = await browser.screenshot();
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
        res.end(img);
    }, 'tv'],
    ['GET', /^\/api\/update$/, async (req, res) => {
        const r = await update.check();
        await update.poll();
        broadcast('update', update.lastCheck() || {});
        sendJson(res, 200, { ...r, progress: update.progress() });
    }, 'tv'],
    ['GET', /^\/api\/update\/progress$/, (req, res) => sendJson(res, 200, update.progress()), 'tv'],
    ['POST', /^\/api\/update$/, async (req, res) => sendJson(res, 200, await update.run()), 'tv'],
    ['POST', /^\/api\/power$/, async (req, res) => {
        const { action } = await readBody(req);
        if (!(await power.available()).ok) throw Object.assign(new Error('This computer cannot be turned off from SimpleTV.'), { status: 400 });
        if (action !== 'off' && action !== 'restart') throw Object.assign(new Error('Unknown power action.'), { status: 400 });
        log(action === 'off' ? 'turning the computer off' : 'restarting the computer');
        sendJson(res, 200, { ok: true });
        setTimeout(() => (action === 'off' ? power.powerOff() : power.restart()).catch((e) => log(`power ${action} failed: ${e.message}`)), 500);
    }, 'tv'],
    ['POST', /^\/api\/exit$/, async (req, res) => {
        if (MODE !== 'window') throw Object.assign(new Error('Only window mode can be closed; in TV mode SimpleTV is the screen.'), { status: 400 });
        sendJson(res, 200, { ok: true });
        setTimeout(() => update.closeWindow().catch((e) => log(`close failed: ${e.message}`)), 300);
    }, 'tv'],
];

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const local = isLocal(req);
    try {
        if (url.pathname === '/') {
            res.writeHead(302, { Location: local ? '/tv/' : '/remote/' });
            return res.end();
        }
        const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
        if (route) {
            const access = route[3];
            const remote = local ? null : remotes.verify(tokenOf(req, url));
            if (access === 'tv' && !local) return sendJson(res, 403, { error: 'Only the TV can do that.' });
            if (access === 'remote' && !local && !remote) return sendJson(res, 401, { error: 'Pair this phone first.' });
            return await route[2](req, res, { url, local, remote });
        }
        if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found.' });
        if (req.method === 'GET' && serveStatic(req, res, url.pathname)) return;
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
    } catch (err) {
        if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message });
        else res.end();
    }
});

// The phone remote's live connection.
server.on('upgrade', (req, sock) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/api/remote/ws') return sock.destroy();
    const remote = isLocal(req) ? { id: 'local', name: 'This machine' } : remotes.verify(url.searchParams.get('token'));
    if (!remote) {
        sock.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return;
    }
    const ws = acceptWs(req, sock);
    if (!ws) return;
    ws.remoteId = remote.id;
    remoteSockets.add(ws);
    ws.send({ t: 'hello', deviceName: store.load().deviceName, ...nowShowing() });
    audio.status().then((s) => ws.send({ t: 'volume', volume: s.volume, muted: s.muted })).catch(() => {});
    ws.on('message', (msg) => {
        if (!msg || typeof msg.action !== 'string') return;
        act(msg).catch((err) => ws.send({ t: 'error', message: err.message }));
    });
    ws.on('close', () => remoteSockets.delete(ws));
});

server.listen(PORT, '0.0.0.0', () => {
    log(`SimpleTV ${VERSION} (${MODE} mode) on port ${PORT}; phone remote at ${remoteUrl()}`);
    browser.start();
    pads.start();
    if (MODE === 'window') autostart.enabled().then((on) => (autostartOn = on));
    power.available().then((p) => {
        powerOk = p.ok;
        if (!p.ok) log(`power off and restart unavailable: ${p.why}`);
    });
    // Looks for a new version a minute after starting, then every six hours.
    const pollUpdates = async () => {
        const before = update.lastCheck()?.available;
        const now = await update.poll();
        if (now?.available && !before) {
            log(`an update is available: ${now.latestMessage}`);
            broadcast('update', now);
        }
    };
    setTimeout(pollUpdates, 60_000);
    setInterval(pollUpdates, 6 * 3_600_000);
});

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));
