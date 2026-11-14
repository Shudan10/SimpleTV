/*
 * Drives the TV's browser over the Chrome DevTools Protocol.
 *
 * The home screen and every app are pages in one full-screen browser (Brave, which is Chromium), started
 * with --remote-debugging-port on 127.0.0.1. Everything the remote and the
 * controller do arrives here and is played into the page that is showing:
 * keys, typed text, pointer moves and clicks. Going through the browser rather than
 * through a virtual keyboard on the host means it does not matter which window
 * the desktop thinks has focus, and nothing needs access to /dev/uinput.
 *
 * Chrome can come and go (in window mode it only runs while SimpleTV is open),
 * so the connection is retried quietly until it is there.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import * as apps from './apps.js';

const CDP_PORT = Number(process.env.CDP_PORT || 9222);
// Window mode: the TV window reads pointer moves from here and plays them on
// the desktop's real pointer (see display/entrypoint.sh).
const POINTER_PIPE = process.env.POINTER_PIPE || '/run/simpletv-input/pointer';

class NativePointer {
    constructor() {
        this.fd = null;
    }

    /** Writes one line, or says it could not (no window listening). */
    send(line) {
        try {
            if (this.fd === null) this.fd = fs.openSync(POINTER_PIPE, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
            fs.writeSync(this.fd, `${line}\n`);
            return true;
        } catch {
            if (this.fd !== null) {
                try {
                    fs.closeSync(this.fd);
                } catch {
                    /* already gone */
                }
            }
            this.fd = null;
            return false;
        }
    }
}

const KEYS = {
    up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
    escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
    pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
    pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
    menu: { key: 'ContextMenu', code: 'ContextMenu', keyCode: 93 },
    search: { key: 'BrowserSearch', code: 'BrowserSearch', keyCode: 170 },
};

// Drawn into every page: the pointer, and a small message box for volume and
// the like. In a shadow root so the site's own CSS cannot reach it.
const OVERLAY = `(() => {
  if (window.__simpletv) return;
  let host, cursor, toast, ring, hideCursorTimer, hideToastTimer;
  const ensure = () => {
    if (host && host.isConnected) return;
    host = document.createElement('simpletv-overlay');
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:block';
    const root = host.attachShadow({ mode: 'closed' });
    // Built element by element: sites with Trusted Types (YouTube, Google)
    // refuse innerHTML from anything but their own code.
    const style = document.createElement('style');
    style.textContent =
      '.c{position:fixed;left:0;top:0;width:40px;height:40px;margin:-5px 0 0 -6px;opacity:0;transition:opacity .2s;filter:drop-shadow(0 2px 4px rgba(0,0,0,.6))}' +
      '.t{position:fixed;left:50%;bottom:7vh;transform:translateX(-50%);background:rgba(18,20,28,.92);color:#fff;' +
      'font:600 22px/1.3 system-ui,sans-serif;padding:14px 26px;border-radius:14px;opacity:0;transition:opacity .2s;white-space:nowrap}' +
      '.t b{display:block;height:6px;margin-top:10px;border-radius:3px;background:rgba(255,255,255,.2);overflow:hidden}' +
      '.t b i{display:block;height:100%;background:#fff}';
    const NS = 'http://www.w3.org/2000/svg';
    cursor = document.createElementNS(NS, 'svg');
    cursor.setAttribute('class', 'c');
    cursor.setAttribute('viewBox', '0 0 24 24');
    const arrow = document.createElementNS(NS, 'path');
    arrow.setAttribute('d', 'M3 2l17 9.5-7.2 1.6L9.6 21z');
    arrow.setAttribute('fill', '#fff');
    arrow.setAttribute('stroke', '#111');
    arrow.setAttribute('stroke-width', '1.4');
    arrow.setAttribute('stroke-linejoin', 'round');
    cursor.appendChild(arrow);
    toast = document.createElement('div');
    toast.className = 't';
    ring = document.createElement('div');
    ring.className = 'r';
    style.textContent += '.r{position:fixed;left:0;top:0;width:0;height:0;border:3px solid #fff;border-radius:12px;' +
      'box-shadow:0 0 0 3px rgba(91,140,255,.85),0 0 28px rgba(91,140,255,.55);opacity:0;transition:opacity .15s;pointer-events:none}';
    root.append(style, cursor, toast, ring);
    (document.body || document.documentElement).appendChild(host);
  };
  // A sign-in sheet or dialog in the page's top layer covers everything,
  // whatever its z-index; showing the overlay as a popover puts it in the
  // top layer too, above them.
  const lift = () => {
    ensure();
    try {
      if (!host.popover) host.popover = 'manual';
      if (document.querySelector(':modal, :popover-open:not(simpletv-overlay)') || !host.matches(':popover-open')) {
        if (host.matches(':popover-open')) host.hidePopover();
        host.showPopover();
      }
    } catch (e) {}
  };
  window.__simpletv = {
    cursor(x, y) {
      window.__stvSynthAt = Date.now();
      lift();
      cursor.style.transform = 'translate(' + x + 'px,' + y + 'px)';
      cursor.style.opacity = '1';
      clearTimeout(hideCursorTimer);
      hideCursorTimer = setTimeout(() => { cursor.style.opacity = '0'; }, 4000);
    },
    toast(text, level) {
      ensure();
      toast.textContent = text;
      if (typeof level === 'number') {
        const bar = document.createElement('b');
        const fill = document.createElement('i');
        fill.style.width = Math.max(0, Math.min(100, level)) + '%';
        bar.appendChild(fill);
        toast.appendChild(bar);
      }
      toast.style.opacity = '1';
      clearTimeout(hideToastTimer);
      hideToastTimer = setTimeout(() => { toast.style.opacity = '0'; }, 1800);
    },
    playPause() {
      const v = [...document.querySelectorAll('video,audio')].find((m) => !m.paused) || document.querySelector('video,audio');
      if (!v) return false;
      if (v.paused) v.play(); else v.pause();
      return true;
    },
  };
  // ------------------------------------------------------------- zoom --
  // Only used without a desktop to press Ctrl + and Ctrl - on (TV mode).
  const ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
  const applyZoom = (z) => { document.documentElement.style.zoom = z === 1 ? '' : String(z); };
  try { const z = Number(localStorage.getItem('simpletv-zoom')); if (z && z !== 1) applyZoom(z); } catch (e) {}
  window.__simpletv.zoom = (dir) => {
    let z = 1;
    try { z = Number(localStorage.getItem('simpletv-zoom')) || 1; } catch (e) {}
    let i = ZOOMS.findIndex((v) => v >= z - 0.001);
    if (i < 0) i = ZOOMS.length - 1;
    if (dir === 'in') z = ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS[i] > z + 0.001 ? i : i + 1)];
    else if (dir === 'out') z = ZOOMS[Math.max(0, i - 1)];
    else z = 1;
    applyZoom(z);
    try { localStorage.setItem('simpletv-zoom', String(z)); } catch (e) {}
    window.__simpletv.toast('Zoom ' + Math.round(z * 100) + '%');
  };

  // -------------------------------------------------- arrows on websites --
  // Sites made for a mouse (Disney+, Netflix, ...) do nothing useful with the
  // arrow keys. The remote's arrows move a highlight from one link, button
  // or tile to the nearest in that direction instead, scrolling it into view;
  // OK clicks it. Nothing in that direction: the arrow scrolls as before.
  const PICKABLE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],' +
    '[role=menuitem],[role=option],[role=checkbox],[role=switch],[tabindex]:not([tabindex="-1"]),[onclick]';
  let picked = null, ringTimer = null;
  const usable = (el) => {
    if (el.closest('simpletv-overlay,simpletv-saver') || el.disabled) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 14 || r.height < 14) return false;
    const vw = innerWidth, vh = innerHeight;
    if (r.bottom < -vh || r.top > 3 * vh || r.right < -vw || r.left > 2 * vw) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
    // On screen, it has to be what is actually there (not under a dialog).
    if (r.top >= 0 && r.left >= 0 && r.bottom <= vh && r.right <= vw) {
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (at && at !== el && !el.contains(at) && !at.contains(el)) return false;
    }
    return true;
  };
  const pickables = () => {
    const all = [...document.querySelectorAll(PICKABLE)].filter(usable);
    // A link wrapping a button the same size counts once.
    return all.filter((el) => !all.some((o) => o !== el && el.contains(o) && Math.abs(o.getBoundingClientRect().width - el.getBoundingClientRect().width) < 4));
  };
  const nearest = (from, dir, list) => {
    const r = from.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const across = dir === 'left' || dir === 'right';
    const c = [];
    for (const el of list) {
      if (el === from || el.contains(from) || from.contains(el)) continue;
      const o = el.getBoundingClientRect();
      const ox = o.left + o.width / 2, oy = o.top + o.height / 2;
      let gap;
      if (dir === 'right') { if (ox <= cx + 2) continue; gap = o.left - r.right; }
      else if (dir === 'left') { if (ox >= cx - 2) continue; gap = r.left - o.right; }
      else if (dir === 'down') { if (oy <= cy + 2) continue; gap = o.top - r.bottom; }
      else { if (oy >= cy - 2) continue; gap = r.top - o.bottom; }
      const overlap = across ? Math.min(r.bottom, o.bottom) - Math.max(r.top, o.top) : Math.min(r.right, o.right) - Math.max(r.left, o.left);
      const off = across ? Math.abs(oy - cy) : Math.abs(ox - cx);
      c.push({ el, gap: Math.max(0, gap), overlap, off });
    }
    if (!c.length) return null;
    if (across) {
      const line = c.filter((x) => x.overlap > 0);
      if (!line.length) return null;
      line.sort((a, b) => a.gap - b.gap || a.off - b.off);
      return line[0].el;
    }
    const min = Math.min(...c.map((x) => x.gap));
    const row = c.filter((x) => x.gap <= min + 24).sort((a, b) => a.off - b.off);
    return row[0].el;
  };
  const drawRing = () => {
    if (!picked || !picked.isConnected) { if (ring) ring.style.opacity = '0'; return; }
    ensure();
    const r = picked.getBoundingClientRect();
    ring.style.transform = 'translate(' + (r.left - 6) + 'px,' + (r.top - 6) + 'px)';
    ring.style.width = r.width + 12 + 'px';
    ring.style.height = r.height + 12 + 'px';
    ring.style.opacity = '1';
  };
  const follow = () => { // keep the ring on it while a smooth scroll runs
    clearInterval(ringTimer);
    let n = 0;
    ringTimer = setInterval(() => { drawRing(); if (++n > 40) clearInterval(ringTimer); }, 16);
  };
  const choose = (el) => {
    picked = el;
    lift();
    // Brought well onto the screen (clear of a site's fixed header at the
    // top), straight away: a smooth scroll can be cut short by the next press.
    const r = el.getBoundingClientRect();
    const inV = r.top >= innerHeight * 0.14 && r.bottom <= innerHeight * 0.92;
    const inH = r.left >= 0 && r.right <= innerWidth;
    if (!inV || !inH) el.scrollIntoView({ block: inV ? 'nearest' : 'center', inline: inH ? 'nearest' : 'center', behavior: 'instant' });
    try { el.focus({ preventScroll: true }); } catch (e) {}
    follow();
    return true;
  };
  window.addEventListener('scroll', () => { if (picked) drawRing(); }, true);
  window.addEventListener('resize', () => { if (picked) drawRing(); }); // zoomed
  window.addEventListener('mousedown', () => { picked = null; drawRing(); }, true);
  window.__simpletv.spatial = (dir) => {
    const list = pickables();
    if (!list.length) return false;
    if (!picked || !picked.isConnected || !list.includes(picked)) {
      // The first press picks something near the top left of what is showing.
      const shown = list.filter((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth; });
      const pool = shown.length ? shown : list;
      pool.sort((a, b) => { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return ra.top + ra.left * 0.35 - (rb.top + rb.left * 0.35); });
      return choose(pool[0]);
    }
    const next = nearest(picked, dir, list);
    return next ? choose(next) : false;
  };
  window.__simpletv.picked = () => {
    if (!picked || !picked.isConnected) return null;
    const r = picked.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) return null;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(picked.tagName)) return { x: r.left + r.width / 2, y: r.top + r.height / 2, field: true };
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };

  // ------------------------------------------------------- screensaver --
  // Photos of the world over whatever page is up, started by the server when
  // nothing has been pressed for a while. The first key, click or touch after
  // it only wakes the screen; the page underneath is exactly as it was.
  let saver = null, saverTimers = [], slides = [], slide = 0;
  const saverUp = () => Boolean(saver && saver.isConnected && saver.style.display !== 'none');
  const tell = (what) => { try { if (typeof window.__simpletvKey === 'function') window.__simpletvKey(what); } catch (e) {} };
  let lastTold = 0;
  const activity = (e) => {
    if (saverUp()) {
      e.preventDefault();
      e.stopImmediatePropagation();
      window.__simpletv.saver(false);
      tell('woke');
      return;
    }
    const now = Date.now();
    if (now - lastTold > 5000) { lastTold = now; tell('active'); }
  };
  for (const type of ['keydown', 'mousedown', 'wheel', 'touchstart']) window.addEventListener(type, activity, true);
  let lastMove = null;
  window.addEventListener('mousemove', (e) => {
    // A pointer that really moves, not one jiggling in place.
    if (lastMove && Math.abs(e.screenX - lastMove[0]) + Math.abs(e.screenY - lastMove[1]) < 8) return;
    lastMove = [e.screenX, e.screenY];
    activity(e);
  }, true);

  const buildSaver = () => {
    saver = document.createElement('simpletv-saver');
    saver.style.cssText = 'position:fixed;inset:0;z-index:2147483646;display:none;background:#000';
    const root = saver.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent =
      '.p{position:absolute;inset:0;background:#000 center/cover no-repeat;opacity:0;transition:opacity 2.5s ease}' +
      '.p.on{opacity:1;animation:drift 22s ease-in-out forwards}' +
      '@keyframes drift{from{transform:scale(1.04) translate(-0.6%,-0.4%)}to{transform:scale(1.14) translate(0.8%,0.6%)}}' +
      '.shade{position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,.55),transparent 35%,transparent 75%,rgba(0,0,0,.35))}' +
      // The time sits still in the bottom right, on a see-through dark panel
      // so it reads on any picture.
      '.clock{position:absolute;right:40px;bottom:34px;padding:18px 28px 20px;border-radius:22px;text-align:right;' +
      'background:rgba(0,0,0,.42);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);' +
      'font:300 64px/1 system-ui,sans-serif;color:#fff;font-variant-numeric:tabular-nums}' +
      '.clock small{display:block;font:500 20px/1.4 system-ui,sans-serif;color:rgba(255,255,255,.8);margin-top:6px}' +
      '.credit{position:absolute;left:44px;bottom:34px;max-width:calc(100vw - 520px);font:500 18px/1.4 system-ui,sans-serif;color:rgba(255,255,255,.85);text-shadow:0 1px 10px rgba(0,0,0,.8)}' +
      '.credit span{display:block;font-size:14px;color:rgba(255,255,255,.6)}';
    const a = document.createElement('div'); a.className = 'p';
    const b = document.createElement('div'); b.className = 'p';
    const shade = document.createElement('div'); shade.className = 'shade';
    const clock = document.createElement('div'); clock.className = 'clock';
    const credit = document.createElement('div'); credit.className = 'credit';
    root.append(style, a, b, shade, clock, credit);
    saver._parts = { layers: [a, b], clock, credit, front: 0 };
    (document.body || document.documentElement).appendChild(saver);
  };

  const showSlide = () => {
    const parts = saver._parts;
    if (!slides.length) {
      parts.layers.forEach((l) => { l.style.backgroundImage = 'radial-gradient(ellipse at 30% 30%, #1d2a4a, #000 70%)'; l.classList.add('on'); });
      parts.credit.textContent = '';
      return;
    }
    const s = slides[slide++ % slides.length];
    const img = new Image();
    img.onload = () => {
      if (!saverUp()) return;
      const next = parts.layers[1 - parts.front];
      const prev = parts.layers[parts.front];
      next.style.backgroundImage = 'url("' + s.url.replace(/"/g, '%22') + '")';
      next.classList.remove('on'); void next.offsetWidth; next.classList.add('on');
      prev.classList.remove('on');
      parts.front = 1 - parts.front;
      parts.credit.textContent = s.title || '';
      const by = document.createElement('span');
      by.textContent = [s.artist ? 'Photo: ' + s.artist : '', s.license, 'Wikimedia Commons'].filter(Boolean).join(' · ');
      parts.credit.appendChild(by);
    };
    img.onerror = () => { if (saverUp()) showSlide(); };
    img.src = s.url;
  };

  const tick = () => {
    const now = new Date();
    const c = saver._parts.clock;
    c.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const d = document.createElement('small');
    d.textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    c.appendChild(d);
  };
  window.__simpletv.saver = (on, list) => {
    if (!saver || !saver.isConnected) buildSaver();
    saverTimers.forEach(clearInterval);
    saverTimers = [];
    if (!on) { saver.style.display = 'none'; return false; }
    if (Array.isArray(list)) { slides = list; slide = 0; }
    saver.style.display = 'block';
    tick(); showSlide();
    saverTimers = [setInterval(showSlide, 15000), setInterval(tick, 10000)];
    return true;
  };
  window.__simpletv.saverUp = saverUp;
  window.__simpletv.mediaPlaying = () =>
    [...document.querySelectorAll('video,audio')].some((m) => !m.paused && !m.ended && m.readyState > 2);

  // While SimpleTV is open the computer stays awake: no screen lock, no
  // blanking. The screensaver above is what shows instead.
  const keepAwake = () => {
    if (document.visibilityState !== 'visible' || !navigator.wakeLock) return;
    navigator.wakeLock.request('screen').catch(() => {});
  };
  document.addEventListener('visibilitychange', keepAwake);
  keepAwake();

  // A keyboard plugged into the TV: Home (outside a text box) or Ctrl+H goes
  // back to SimpleTV from any site. Caught before the site sees it, and
  // handed to the server through a DevTools binding.
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    const home = (e.key === 'Home' && !typing && !e.ctrlKey && !e.altKey && !e.metaKey) ||
      (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'h' || e.key === 'H'));
    if (!home || typeof window.__simpletvKey !== 'function') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    window.__simpletvKey('home');
  }, true);
})();`;

export class Browser extends EventEmitter {
    constructor({ homeUrl, log = () => {} }) {
        super();
        this.homeUrl = homeUrl;
        this.log = log;
        this.ws = null;
        this.nextId = 1;
        this.pending = new Map();
        this.pages = new Map(); // targetId -> { url, created }
        this.session = null; // { targetId, sessionId }
        this.defaultUA = null;
        this.viewport = { w: 1920, h: 1080 };
        this.pointer = { x: 960, y: 540 };
        this.url = '';
        this.app = null;
        this.connected = false;
        this.native = new NativePointer();
    }

    start() {
        const tick = async () => {
            if (!this.ws) await this.connect().catch(() => {});
            setTimeout(tick, this.ws ? 5000 : 2000);
        };
        tick();
    }

    async connect() {
        const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`, { signal: AbortSignal.timeout(1500) });
        const info = await res.json();
        this.defaultUA = info['User-Agent'] || null;
        await new Promise((resolve, reject) => {
            const ws = new WebSocket(info.webSocketDebuggerUrl);
            ws.onopen = () => {
                this.ws = ws;
                resolve();
            };
            ws.onerror = () => reject(new Error('could not connect to the browser'));
            ws.onclose = () => this.disconnected(ws);
            ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data));
        });
        this.log('connected to the TV browser');
        await this.send('Target.setDiscoverTargets', { discover: true });
        const { targetInfos } = await this.send('Target.getTargets');
        // More than one copy of the home screen means a browser that brought
        // back an old session next to the new one. Each copy holds a
        // connection to the server, and enough of them leave the one on
        // screen unable to load anything, so all but one are closed.
        const pages = targetInfos.filter((t) => t.type === 'page');
        const homes = pages.filter((t) => this.isHome(t.url));
        for (const extra of homes.slice(1)) {
            await this.send('Target.closeTarget', { targetId: extra.targetId }).catch(() => {});
            this.log('closed a duplicate copy of the home screen');
        }
        const closed = new Set(homes.slice(1).map((t) => t.targetId));
        for (const t of pages) if (!closed.has(t.targetId)) this.pages.set(t.targetId, { url: t.url, created: 0 });
        await this.attachBest();
        this.connected = true;
        this.emit('status', true);
    }

    disconnected(ws) {
        if (this.ws !== ws) return;
        this.ws = null;
        this.session = null;
        this.pages.clear();
        for (const { reject } of this.pending.values()) reject(new Error('browser went away'));
        this.pending.clear();
        if (this.connected) {
            this.connected = false;
            this.log('the TV browser closed');
            this.emit('status', false);
        }
    }

    send(method, params = {}, sessionId) {
        if (!this.ws) return Promise.reject(new Error('The TV screen is not open.'));
        const id = this.nextId++;
        const msg = { id, method, params };
        if (sessionId) msg.sessionId = sessionId;
        this.ws.send(JSON.stringify(msg));
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            setTimeout(() => {
                if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
            }, 10_000);
        });
    }

    /** A command for the page that is showing. */
    async page(method, params = {}) {
        if (!this.session) await this.attachBest();
        if (!this.session) throw new Error('The TV screen is not open.');
        return this.send(method, params, this.session.sessionId);
    }

    onMessage(msg) {
        if (msg.id) {
            const p = this.pending.get(msg.id);
            if (!p) return;
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message));
            else p.resolve(msg.result);
            return;
        }
        const { method, params } = msg;
        if (method === 'Target.targetCreated' && params.targetInfo.type === 'page') {
            this.pages.set(params.targetInfo.targetId, { url: params.targetInfo.url, created: Date.now() });
            // A site opened a new window: that is what is on screen now.
            if (this.session) this.attach(params.targetInfo.targetId).catch(() => {});
        } else if (method === 'Target.targetInfoChanged' && params.targetInfo.type === 'page') {
            const p = this.pages.get(params.targetInfo.targetId);
            if (p) p.url = params.targetInfo.url;
        } else if (method === 'Target.targetDestroyed') {
            this.pages.delete(params.targetId);
            if (this.session?.targetId === params.targetId) {
                this.session = null;
                this.attachBest().catch(() => {});
            }
        } else if (method === 'Target.detachedFromTarget') {
            if (this.session?.sessionId === params.sessionId) this.session = null;
        } else if (method === 'Runtime.bindingCalled' && params.name === '__simpletvKey') {
            if (msg.sessionId !== this.session?.sessionId) return;
            if (params.payload === 'home') this.home().catch(() => {});
            else if (params.payload === 'active' || params.payload === 'woke') this.emit('activity', params.payload);
        } else if (method === 'Page.frameNavigated' && !params.frame.parentId) {
            if (msg.sessionId === this.session?.sessionId) this.navigated(params.frame.url);
        }
    }

    async attachBest() {
        if (!this.ws) return;
        // The newest page is the one on top.
        const newest = [...this.pages.entries()].sort((a, b) => b[1].created - a[1].created)[0];
        if (newest) await this.attach(newest[0]);
    }

    async attach(targetId) {
        if (this.session?.targetId === targetId) return;
        const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
        this.session = { targetId, sessionId };
        await this.send('Target.activateTarget', { targetId }).catch(() => {});
        await this.send('Page.enable', {}, sessionId);
        await this.send('Runtime.enable', {}, sessionId);
        await this.send('Runtime.addBinding', { name: '__simpletvKey' }, sessionId);
        await this.send('Page.addScriptToEvaluateOnNewDocument', { source: OVERLAY }, sessionId);
        await this.send('Runtime.evaluate', { expression: OVERLAY }, sessionId).catch(() => {});
        await this.measure();
        const { entries, currentIndex } = await this.send('Page.getNavigationHistory', {}, sessionId);
        this.navigated(entries[currentIndex]?.url || '');
    }

    async measure() {
        const m = await this.page('Page.getLayoutMetrics').catch(() => null);
        const vp = m?.cssLayoutViewport;
        if (vp?.clientWidth) this.viewport = { w: vp.clientWidth, h: vp.clientHeight };
    }

    navigated(url) {
        this.url = url;
        const onHome = this.isHome(url);
        const app = onHome ? null : apps.forUrl(url);
        const changed = (app?.id || null) !== (this.app?.id || null) || onHome !== this.onHome;
        this.app = app;
        this.onHome = onHome;
        if (changed) this.emit('app', { onHome, app });
        this.measure().catch(() => {});
    }

    isHome(url) {
        return url.startsWith(this.homeUrl);
    }

    // ------------------------------------------------------------- actions --

    async open(url, { ua = null, hints = false } = {}) {
        if (ua === 'tv') {
            await this.page('Emulation.setUserAgentOverride', { userAgent: apps.TV_UA });
            this.uaOverridden = true;
        } else if (this.uaOverridden) {
            // Overriding the user agent, even with the browser's own string,
            // empties navigator.userAgentData's brands while the string still
            // says Chrome. Amazon reads that mismatch as a bot and serves
            // "Website Temporarily Unavailable". An override only lasts as
            // long as the session that set it, so leaving a TV-mode app
            // reattaches, which gives the page its own identity back.
            const { targetId, sessionId } = this.session || {};
            this.uaOverridden = false;
            if (targetId) {
                await this.send('Target.detachFromTarget', { sessionId }).catch(() => {});
                this.session = null;
                await this.attach(targetId);
            }
        }
        await this.sendHints(hints);
        await this.page('Page.navigate', { url });
    }

    /*
     * The new Xbox Cloud Gaming site (play.xbox.com) lists viewport size and
     * colour preferences as critical client hints. Chrome reloads with them;
     * Brave holds them back for privacy and is left with the bare
     * "<!doctype html>" Xbox sends first: a white screen. For apps that need
     * them, they are added to the page's requests, and taken off again after.
     */
    async sendHints(on) {
        if (!on && !this.hintsOn) return;
        await this.page('Network.enable');
        const headers = on
            ? {
                  'Sec-CH-Viewport-Width': String(Math.round(this.viewport.w)),
                  'Sec-CH-Viewport-Height': String(Math.round(this.viewport.h)),
                  'Sec-CH-Prefers-Color-Scheme': 'dark',
                  'Sec-CH-Prefers-Reduced-Motion': 'no-preference',
                  'Sec-CH-Prefers-Reduced-Transparency': 'no-preference',
                  'Sec-CH-Prefers-Contrast': 'no-preference',
                  'Sec-CH-Forced-Colors': 'none',
              }
            : {};
        await this.page('Network.setExtraHTTPHeaders', { headers });
        this.hintsOn = on;
    }

    async launch(app) {
        if (!app.url) throw new Error(`${app.name} is not set up yet.`);
        await this.open(app.url, { ua: app.ua, hints: app.hints });
    }

    async home() {
        if (this.onHome) {
            this.emit('home-pressed');
            return;
        }
        await this.open(this.homeUrl);
    }

    async back() {
        if (this.onHome || this.app?.back === 'escape') return this.key('escape');
        const { entries, currentIndex } = await this.page('Page.getNavigationHistory');
        const prev = entries[currentIndex - 1];
        if (!prev || this.isHome(prev.url)) return this.home();
        await this.page('Page.navigateToHistoryEntry', { entryId: prev.id });
    }

    async key(name) {
        const k = KEYS[name];
        if (!k) throw new Error(`Unknown key ${name}`);
        const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
        await this.page('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, text: k.text, unmodifiedText: k.text });
        await this.page('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    }

    async text(s) {
        if (s) await this.page('Input.insertText', { text: String(s).slice(0, 500) });
    }

    async move(dx, dy) {
        if (this.native.send(`move ${Math.round(dx)} ${Math.round(dy)}`)) return;
        const p = this.pointer;
        p.x = Math.max(0, Math.min(this.viewport.w - 1, p.x + dx));
        p.y = Math.max(0, Math.min(this.viewport.h - 1, p.y + dy));
        await this.page('Runtime.evaluate', { expression: `window.__simpletv&&__simpletv.cursor(${p.x},${p.y})` });
        await this.page('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    }

    async click() {
        if (this.native.send('click')) return;
        const { x, y } = this.pointer;
        await this.page('Runtime.evaluate', { expression: `window.__simpletv&&__simpletv.cursor(${x},${y})` });
        await this.page('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await this.page('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    }

    async scroll(dx, dy) {
        // A wheel notch is about 100 pixels; the real pointer scrolls in notches.
        this.wheel = this.wheel || { x: 0, y: 0 };
        this.wheel.x += dx;
        this.wheel.y += dy;
        const steps = [];
        while (Math.abs(this.wheel.y) >= 60) {
            steps.push(this.wheel.y > 0 ? 'down' : 'up');
            this.wheel.y -= Math.sign(this.wheel.y) * 60;
        }
        while (Math.abs(this.wheel.x) >= 60) {
            steps.push(this.wheel.x > 0 ? 'right' : 'left');
            this.wheel.x -= Math.sign(this.wheel.x) * 60;
        }
        if (this.native.send(steps.length ? steps.join('\n') : '')) return;
        this.wheel = { x: 0, y: 0 };
        const { x, y } = this.pointer;
        await this.page('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy });
    }

    async playPause() {
        const r = await this.page('Runtime.evaluate', { expression: 'window.__simpletv ? __simpletv.playPause() : false', returnByValue: true });
        if (!r?.result?.value) await this.key('space');
    }

    async toast(text, level) {
        const args = [JSON.stringify(String(text))];
        if (typeof level === 'number') args.push(Math.round(level));
        await this.page('Runtime.evaluate', { expression: `window.__simpletv&&__simpletv.toast(${args.join(',')})` }).catch(() => {});
    }

    /**
     * Zooms what is showing in or out, like Ctrl + and Ctrl - on a keyboard.
     * On a desktop the browser's own zoom does it, which the browser keeps
     * for each website; without one (TV mode) the page is zoomed instead,
     * and that page remembers it.
     */
    async zoom(dir) {
        if (this.native.send(`zoom${dir}`)) return;
        await this.page('Runtime.evaluate', { expression: `window.__simpletv && __simpletv.zoom && __simpletv.zoom(${JSON.stringify(dir)})` });
    }

    /** Moves the arrows' highlight on a website; false when there is nowhere to go. */
    async spatial(dir) {
        const r = await this.page('Runtime.evaluate', { expression: `window.__simpletv && __simpletv.spatial ? __simpletv.spatial(${JSON.stringify(dir)}) : false`, returnByValue: true });
        return Boolean(r?.result?.value);
    }

    /** OK on a website: clicks what the arrows picked, with a real click. */
    async pressPicked() {
        const r = await this.page('Runtime.evaluate', { expression: 'window.__simpletv && __simpletv.picked ? __simpletv.picked() : null', returnByValue: true });
        const at = r?.result?.value;
        if (!at) return false;
        await this.page('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', clickCount: 1 });
        await this.page('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', clickCount: 1 });
        return true;
    }

    /** Whether the arrows should pick links on this page (not on TV-made apps, not at home). */
    get arrowsPick() {
        return !this.onHome && this.app?.nav !== 'keys' && this.url && !this.url.startsWith('about:');
    }

    async showSaver(slides) {
        const r = await this.page('Runtime.evaluate', { expression: `window.__simpletv ? __simpletv.saver(true, ${JSON.stringify(slides)}) : false`, returnByValue: true });
        return Boolean(r?.result?.value);
    }

    async hideSaver() {
        await this.page('Runtime.evaluate', { expression: 'window.__simpletv && __simpletv.saver(false)' }).catch(() => {});
    }

    /** Whether anything on screen is playing, which keeps the screensaver away. */
    async mediaPlaying() {
        const r = await this.page('Runtime.evaluate', { expression: 'window.__simpletv ? __simpletv.mediaPlaying() : false', returnByValue: true }).catch(() => null);
        return Boolean(r?.result?.value);
    }

    async screenshot() {
        const { data } = await this.page('Page.captureScreenshot', { format: 'jpeg', quality: 70 });
        return Buffer.from(data, 'base64');
    }
}
