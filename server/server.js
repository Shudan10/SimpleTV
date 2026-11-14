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
import net from 'node:net';
import os from 'node:os';
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
import * as wallpapers from './lib/wallpapers.js';
import * as logos from './lib/logos.js';
import { execFile } from 'node:child_process';

// The TV screen reads the Website size from here when it starts (see
// display/entrypoint.sh), and is restarted when it changes.
const SCALE_FILE = process.env.SCALE_FILE || '/run/simpletv-input/site-scale';
function writeSiteScale() {
    try {
        fs.writeFileSync(SCALE_FILE, `${store.load().siteScale || 1}\n`);
    } catch {
        /* no shared folder (an old compose file): Standard it is */
    }
}
function restartScreen() {
    const name = MODE === 'tv' ? 'simpletv-tv' : 'simpletv-window';
    execFile('docker', ['inspect', '-f', '{{.State.Running}}', name], (err, out) => {
        if (!err && out.trim() === 'true') execFile('docker', ['restart', '-t', '5', name], () => {});
    });
}
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

// --------------------------------------------------------- screensaver --
//
// After the chosen minutes with nothing pressed, photos of the world go over
// whatever is on screen, unless something is playing. Presses from the phone
// or a controller count, and so do keys, clicks and touches on the TV itself
// (the page reports those). The first press afterwards only wakes it.
let lastActivity = Date.now();
let saverOn = false;
const touch = () => {
    lastActivity = Date.now();
};
async function wakeSaver() {
    saverOn = false;
    touch();
    await browser.hideSaver();
}
browser.on('activity', (what) => {
    touch();
    if (what === 'woke') saverOn = false;
});
setInterval(async () => {
    const mins = store.load().screensaverMinutes;
    if (!mins || saverOn || !browser.connected) return;
    if (update.progress().running) return touch();
    if (Date.now() - lastActivity < mins * 60_000) return;
    if (await browser.mediaPlaying()) return touch();
    try {
        saverOn = await browser.showSaver(await wallpapers.pick(30));
    } catch {
        saverOn = false;
    }
}, 15_000);

browser.on('app', () => {
    // A new page has no screensaver on it.
    saverOn = false;
    touch();
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

// A swipe's distance in pixels, kept to what a finger can do: a made-up
// huge number would otherwise keep the server pressing keys forever.
const amount = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(-2000, Math.min(2000, n)) : 0;
};

/** Every button press, from the phone, a controller or the API, ends here. */
async function act(a) {
    // With the screensaver up, a press wakes the screen and does nothing else.
    if (saverOn) return wakeSaver();
    touch();
    switch (a.action) {
        case 'key': {
            const key = String(a.key);
            if (browser.arrowsPick && ['up', 'down', 'left', 'right'].includes(key)) {
                if (await browser.spatial(key)) return;
            } else if (browser.arrowsPick && key === 'enter') {
                if (await browser.pressPicked()) return;
            }
            return browser.key(key);
        }
        case 'text':
            // The home screen has its own keyboard and decides which box the
            // text belongs in; anywhere else it is typed into the page.
            if (browser.onHome) return broadcast('text', { text: String(a.text || '').slice(0, 500) });
            return browser.text(String(a.text || ''));
        case 'move':
            return browser.move(amount(a.dx), amount(a.dy));
        case 'click':
            return browser.click();
        case 'scroll':
            if (browser.onHome) return scrollAsKeys(amount(a.dx), amount(a.dy));
            return browser.scroll(amount(a.dx), amount(a.dy));
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
        case 'zoom':
            if (!['in', 'out', 'reset'].includes(a.dir)) throw new Error('zoom is in, out or reset');
            return browser.zoom(a.dir);
        default:
            throw new Error(`Unknown action ${a.action}`);
    }
}

// ---------------------------------------------------------------- http ----

const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

// Being reached from this machine is what makes a request "the TV". Web
// pages open on this machine (in SimpleTV's browser or any other) reach it
// from here too, so two more things are asked of every request:
//
// - It is addressed to this machine by a name of its own: an IP address,
//   localhost, the computer's name, or a Tailscale name. A website that
//   points its own name at 127.0.0.1 (DNS rebinding) and then reads what
//   comes back -- the pairing code, the Jellyfin key -- is turned away.
// - A web page sending it is one of SimpleTV's own (the Origin a browser
//   puts on such requests names the same address). Requests that are not
//   from a web page at all, such as the simpletv command's, carry none.
//
// SIMPLETV_HOSTS adds more names, comma-separated, for an unusual setup.
const EXTRA_HOSTS = (process.env.SIMPLETV_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

function hostName(hostHeader) {
    const h = String(hostHeader || '').trim().toLowerCase();
    if (h.startsWith('[')) return h.slice(1, h.indexOf(']')); // [::1]:8480
    return h.replace(/:\d+$/, '');
}

function hostAllowed(req) {
    const h = hostName(req.headers.host);
    if (!h) return false;
    if (net.isIP(h)) return true;
    const me = os.hostname().toLowerCase();
    return (
        h === 'localhost' ||
        h.endsWith('.localhost') ||
        h === me ||
        h === `${me}.local` ||
        h.endsWith('.ts.net') ||
        EXTRA_HOSTS.includes(h)
    );
}

function originAllowed(req) {
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    try {
        const u = new URL(origin);
        return /^https?:$/.test(u.protocol) && u.host.toLowerCase() === String(req.headers.host || '').trim().toLowerCase();
    } catch {
        return false; // "null", from a sandboxed frame or a file
    }
}

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
        siteScale: cfg.siteScale || 1,
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
        remotes.reopen();
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
            // Same scheme and site as the app itself: a javascript: link
            // would otherwise run whatever it says inside the TV's browser.
            let target;
            try {
                target = new URL(String(extra), app.url);
            } catch {
                target = null;
            }
            const base = new URL(app.url);
            if (!target || !/^https?:$/.test(target.protocol) || target.origin !== base.origin) {
                throw Object.assign(new Error('That link is outside the app.'), { status: 400 });
            }
            await browser.open(target.toString(), { ua: app.ua, hints: app.hints });
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
    ['GET', /^\/api\/logo\/([a-z0-9-]+)$/, async (req, res, c) => {
        const png = await logos.get(apps.find(c.url.pathname.split('/').pop()));
        if (!png) return sendJson(res, 404, { error: 'No logo.' });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=604800', 'Content-Length': png.length });
        res.end(png);
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
    ['GET', /^\/api\/jf\/subs\/search$/, async (req, res, c) => {
        sendJson(res, 200, { results: await jellyfin.findSubtitles(c.url.searchParams.get('id'), c.url.searchParams.get('lang')) });
    }, 'tv'],
    ['POST', /^\/api\/jf\/subs\/download$/, async (req, res) => {
        const { id, subtitleId } = await readBody(req);
        sendJson(res, 200, await jellyfin.downloadSubtitle(id, subtitleId));
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
            if ([0.85, 1, 1.15].includes(Number(b.siteScale))) cfg.siteScale = Number(b.siteScale);
            if (b.screensaverMinutes != null) cfg.screensaverMinutes = Math.max(0, Math.min(120, Number(b.screensaverMinutes) || 0));
        });
        if (b.siteScale != null) {
            writeSiteScale();
            setTimeout(restartScreen, 600); // after the answer reaches the page
        }
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
        broadcast('update', update.lastCheck() || {});
        sendJson(res, 200, { ...r, progress: update.progress() });
    }, 'tv'],
    ['GET', /^\/api\/update\/log$/, (req, res, c) => sendJson(res, 200, update.log(c.url.searchParams.get('from'))), 'tv'],
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

// A page on some website asking the server for something leaves this
// header behind; SimpleTV's own pages, the phone remote and the simpletv
// command never do. Even an image on a website pointed at this server is
// turned away, so a site cannot make the TV do anything just by being open.
const fromOtherSite = (req) => /^(cross-site|same-site)$/.test(String(req.headers['sec-fetch-site'] || ''));

function parseUrl(req) {
    try {
        return new URL(req.url, 'http://localhost');
    } catch {
        return null;
    }
}

const server = http.createServer(async (req, res) => {
    const url = parseUrl(req);
    if (!url) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        return res.end('Bad request');
    }
    const local = isLocal(req);
    if (!hostAllowed(req) || !originAllowed(req) || fromOtherSite(req)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        return res.end('Forbidden');
    }
    // Commands come as JSON, which a page on another site cannot send here
    // without the browser asking first (and that is never answered).
    if (req.method !== 'GET' && req.method !== 'HEAD' && !/^application\/json\b/i.test(req.headers['content-type'] || '')) {
        return sendJson(res, 415, { error: 'Send JSON.' });
    }
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
    // A phone that drops off mid-answer must not take the server with it.
    sock.on('error', () => sock.destroy());
    try {
        upgrade(req, sock);
    } catch (err) {
        log(`remote connection failed: ${err.message}`);
        sock.destroy();
    }
});

function upgrade(req, sock) {
    const url = parseUrl(req);
    if (!url || url.pathname !== '/api/remote/ws') return sock.destroy();
    // A web page can open a connection like this to any address, whatever
    // site it is on: only SimpleTV's own remote page is let in.
    if (!hostAllowed(req) || !originAllowed(req) || fromOtherSite(req)) {
        sock.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
    }
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
}

server.listen(PORT, '0.0.0.0', () => {
    log(`SimpleTV ${VERSION} (${MODE} mode) on port ${PORT}; phone remote at ${remoteUrl()}`);
    writeSiteScale();
    browser.start();
    pads.start();
    wallpapers.warm();
    if (MODE === 'window') autostart.enabled().then((on) => (autostartOn = on));
    const checkPower = (tries) =>
        power.available().then((p) => {
            powerOk = p.ok;
            if (p.ok) return;
            if (tries > 0) return setTimeout(() => checkPower(tries - 1), 30_000);
            log(`power off and restart unavailable: ${p.why}`);
        });
    checkPower(10);
    // New versions are only looked for when Settings, Updates, Check for
    // updates is pressed: never on its own.
});

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));
