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
import * as apps from './apps.js';

const CDP_PORT = Number(process.env.CDP_PORT || 9222);

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
  let host, cursor, toast, hideCursorTimer, hideToastTimer;
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
    root.append(style, cursor, toast);
    (document.body || document.documentElement).appendChild(host);
  };
  window.__simpletv = {
    cursor(x, y) {
      window.__stvSynthAt = Date.now();
      ensure();
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
      '.clock{position:absolute;font:300 64px/1 system-ui,sans-serif;color:rgba(255,255,255,.92);text-shadow:0 2px 24px rgba(0,0,0,.7);transition:left 4s ease,top 4s ease;font-variant-numeric:tabular-nums}' +
      '.clock small{display:block;font:500 20px/1.4 system-ui,sans-serif;color:rgba(255,255,255,.7);margin-top:6px}' +
      '.credit{position:absolute;left:44px;bottom:34px;right:44px;font:500 18px/1.4 system-ui,sans-serif;color:rgba(255,255,255,.85);text-shadow:0 1px 10px rgba(0,0,0,.8)}' +
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
  const moveClock = () => {
    const c = saver._parts.clock;
    c.style.left = (6 + Math.random() * 64) + 'vw';
    c.style.top = (8 + Math.random() * 50) + 'vh';
  };

  window.__simpletv.saver = (on, list) => {
    if (!saver || !saver.isConnected) buildSaver();
    saverTimers.forEach(clearInterval);
    saverTimers = [];
    if (!on) { saver.style.display = 'none'; return false; }
    if (Array.isArray(list)) { slides = list; slide = 0; }
    saver.style.display = 'block';
    tick(); moveClock(); showSlide();
    saverTimers = [setInterval(showSlide, 15000), setInterval(tick, 10000), setInterval(moveClock, 30000)];
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
        const p = this.pointer;
        p.x = Math.max(0, Math.min(this.viewport.w - 1, p.x + dx));
        p.y = Math.max(0, Math.min(this.viewport.h - 1, p.y + dy));
        await this.page('Runtime.evaluate', { expression: `window.__simpletv&&__simpletv.cursor(${p.x},${p.y})` });
        await this.page('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
    }

    async click() {
        const { x, y } = this.pointer;
        await this.page('Runtime.evaluate', { expression: `window.__simpletv&&__simpletv.cursor(${x},${y})` });
        await this.page('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await this.page('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    }

    async scroll(dx, dy) {
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
