// SimpleTV home screen. Everything is driven by arrow keys, Enter, Escape and
// the menu key: the phone remote and the controller both arrive as those.

import { setupLibrary } from './library.js';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path, body) {
    // Nothing on the TV may wait forever: a request that has not been
    // answered in 20 seconds is an error the page can show.
    const opts = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    let res;
    try {
        res = await fetch(path, { ...opts, signal: AbortSignal.timeout(20_000) });
    } catch (err) {
        throw new Error(err.name === 'TimeoutError' ? 'SimpleTV did not answer in time. Try again in a moment.' : 'SimpleTV is not answering.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
}

let S = null; // server state
let jf = null; // Jellyfin rows
let view = 'home';
let pane = 'remote';
let moving = null; // app id being moved on the home row
const heroFor = new WeakMap();
const rowMemory = new Map();

function toast(text) {
    let t = $('.ui-toast');
    if (!t) {
        t = document.createElement('div');
        t.className = 'ui-toast';
        document.body.appendChild(t);
    }
    t.textContent = text;
    t.style.opacity = '1';
    clearTimeout(t._h);
    t._h = setTimeout(() => (t.style.opacity = '0'), 2200);
}

// ================================================================ sound ==

// The home screen's clicks and chimes, made on the spot with Web Audio, so
// there are no sound files. Short and quiet: a TV is heard across a room.
const sfx = {
    ctx: null,
    last: 0,
    on() {
        return S?.uiSounds !== false;
    },
    audio() {
        if (!this.ctx) {
            try {
                this.ctx = new AudioContext();
            } catch {
                return null;
            }
        }
        if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
        return this.ctx;
    },
    // One note: a pitch that slides from f1 to f2, eased in and faded out.
    tone({ f1, f2 = f1, dur = 0.12, gain = 0.07, type = 'sine', at = 0 }) {
        const ctx = this.audio();
        if (!ctx) return;
        const t = ctx.currentTime + at;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        // A gentle low-pass takes the edge off, so even the brighter notes
        // stay soft.
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 1400;
        osc.type = type;
        osc.frequency.setValueAtTime(f1, t);
        osc.frequency.exponentialRampToValueAtTime(f2, t + dur);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(gain, t + 0.018);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        osc.connect(lp).connect(g).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + dur + 0.03);
    },
    play(name) {
        if (!this.on()) return;
        // Holding a direction repeats it; keep the notes from piling up.
        const now = performance.now();
        if (name === 'move' && now - this.last < 70) return;
        this.last = now;
        switch (name) {
            case 'move':
                return this.tone({ f1: 330, f2: 311, dur: 0.11, gain: 0.08 });
            case 'tab':
                return this.tone({ f1: 262, f2: 247, dur: 0.13, gain: 0.08 });
            case 'edge':
                return this.tone({ f1: 131, f2: 117, dur: 0.16, gain: 0.09 });
            case 'select':
                this.tone({ f1: 294, dur: 0.14, gain: 0.07 });
                return this.tone({ f1: 392, dur: 0.22, gain: 0.07, at: 0.09 });
            case 'back':
                this.tone({ f1: 392, dur: 0.13, gain: 0.07 });
                return this.tone({ f1: 294, dur: 0.2, gain: 0.07, at: 0.08 });
            case 'key':
                return this.tone({ f1: 440, f2: 415, dur: 0.07, gain: 0.05 });
            case 'open':
                this.tone({ f1: 262, dur: 0.18, gain: 0.07 });
                this.tone({ f1: 330, dur: 0.18, gain: 0.07, at: 0.1 });
                return this.tone({ f1: 392, dur: 0.32, gain: 0.07, at: 0.2 });
        }
    },
};

// ================================================================ focus ==

function scopeEls() {
    if (!$('#modal').hidden) return $$('.f', $('#modal'));
    return [...$$('.f', $('#tabs')), ...$$('.f', $(`#view-${view}`))];
}

const visible = (el) => el.offsetParent !== null && !el.disabled;

function rectOf(el) {
    return el.getBoundingClientRect();
}

function nextInDirection(from, dir, list) {
    const r = rectOf(from);
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const horizontal = dir === 'left' || dir === 'right';
    const cands = [];
    for (const el of list) {
        if (el === from || !visible(el)) continue;
        const c = rectOf(el);
        const ccx = c.left + c.width / 2;
        const ccy = c.top + c.height / 2;
        let primary;
        let secondary;
        let overlap;
        if (dir === 'right') {
            if (ccx <= cx + 1) continue;
            primary = c.left - r.right;
        } else if (dir === 'left') {
            if (ccx >= cx - 1) continue;
            primary = r.left - c.right;
        } else if (dir === 'down') {
            if (ccy <= cy + 1) continue;
            primary = c.top - r.bottom;
        } else {
            if (ccy >= cy - 1) continue;
            primary = r.top - c.bottom;
        }
        if (horizontal) {
            overlap = Math.min(r.bottom, c.bottom) - Math.max(r.top, c.top);
            secondary = Math.abs(ccy - cy);
        } else {
            overlap = Math.min(r.right, c.right) - Math.max(r.left, c.left);
            secondary = Math.abs(ccx - cx);
        }
        cands.push({ el, primary: Math.max(0, primary), secondary, overlap });
    }
    if (!cands.length) return null;
    if (horizontal) {
        const inLine = cands.filter((c) => c.overlap > 0);
        // Past the end of a row there is nothing: not a jump to whatever is
        // nearest above or below (the top bar, a Remove button). The one
        // exception is Search, where the results sit beside the keyboard
        // rather than level with every row of it.
        if (!inLine.length && !from.closest('#search-osk')) return null;
        const pool = inLine.length ? inLine : cands;
        pool.sort((a, b) => a.primary + (inLine.length ? 0 : a.secondary * 2) - (b.primary + (inLine.length ? 0 : b.secondary * 2)) || a.secondary - b.secondary);
        return pool[0].el;
    }
    // Vertically: the nearest line first, then whatever on it is closest.
    // Something in the same column wins over something a little nearer in
    // another one -- otherwise Up in a form jumps to the menu beside it --
    // but not over a whole row that is clearly nearer.
    let pool = cands;
    const minAll = Math.min(...cands.map((c) => c.primary));
    const sameColumn = cands.filter((c) => c.overlap > 0);
    if (sameColumn.length && Math.min(...sameColumn.map((c) => c.primary)) <= minAll + window.innerHeight * 0.12) pool = sameColumn;
    const minP = Math.min(...pool.map((c) => c.primary));
    const slack = window.innerWidth / 80;
    const line = pool.filter((c) => c.primary <= minP + slack).sort((a, b) => a.secondary - b.secondary);
    let pick = line[0].el;
    // Coming back to a row lands where you left it.
    const row = pick.closest('[data-row]');
    if (row && row !== from.closest('[data-row]')) {
        const mem = rowMemory.get(row.dataset.row);
        if (mem && mem.isConnected && row.contains(mem) && visible(mem)) pick = mem;
    }
    return pick;
}

function focusEl(el) {
    if (!el) return;
    el.focus({ preventScroll: true });
}

function onFocus(el) {
    if (!el.closest('#tabs') && $('#modal').hidden && $(`#view-${view}`)?.contains(el)) lastFocus.set(view, el);
    const row = el.closest('[data-row]');
    if (row) rowMemory.set(row.dataset.row, el);
    // Horizontal strips scroll to keep the focused item on screen.
    const strip = el.closest('.strip');
    if (strip) {
        const pad = parseFloat(getComputedStyle(strip).paddingLeft);
        const left = el.offsetLeft;
        if (left - strip.scrollLeft < pad) strip.scrollLeft = left - pad;
        else if (left + el.offsetWidth - strip.scrollLeft > strip.clientWidth - pad) strip.scrollLeft = left + el.offsetWidth - strip.clientWidth + pad;
    }
    if (el.classList.contains('tab')) showView(el.dataset.view, { focus: false });
    if (view === 'home') {
        const inner = $('#rows .rows-inner');
        const rowEl = el.closest('.row');
        if (inner && rowEl) inner.style.transform = `translateY(${-rowEl.offsetTop}px)`;
        else if (inner && el.classList.contains('tab')) inner.style.transform = '';
        const h = heroFor.get(el);
        if (h) setHero(h);
    }
    if (view === 'apps') keepInView($('#view-apps .page'), $('#view-apps .page-inner'), el);
    if (view === 'settings') {
        if (el.classList.contains('sitem')) showPane(el.dataset.pane);
        else keepInView($('#settings-pane'), $('#settings-pane .pane-inner'), el);
    }
    if (view === 'search') keepInView($('.search-right'), $('#search-results'), el);
    if (view === 'library') {
        keepInView($('#view-library .page'), $('#lib-inner'), el);
        library.onLibraryFocus(el);
    }
    if (view === 'detail') keepInView($('#detail'), $('#d-inner'), el);
}

function keepInView(container, inner, el) {
    if (!container || !inner || !inner.contains(el)) return;
    const cr = container.getBoundingClientRect();
    const ir = inner.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    const margin = cr.height * 0.12;
    const off = er.top - ir.top;
    let t = inner._ty || 0;
    if (off + t + er.height > cr.height - margin) t = cr.height - margin - er.height - off;
    if (off + t < margin) t = margin - off;
    t = Math.min(0, t);
    inner._ty = t;
    inner.style.transform = `translateY(${t}px)`;
}

document.addEventListener('focusin', (e) => {
    if (e.target.classList?.contains('f')) onFocus(e.target);
});
// A real mouse or touchpad works like on any desktop app: the normal pointer
// shows while it moves, things under it light up, and a click opens them.
// It does not drag the selection around with it. The phone's touchpad draws
// its own pointer and is left out (its moves are marked as they arrive).
let pointerTimer = null;
const fromPhone = () => Date.now() - (window.__stvSynthAt || 0) < 250;
document.addEventListener('mousemove', () => {
    if (fromPhone()) return;
    document.body.classList.add('pointer');
    clearTimeout(pointerTimer);
    pointerTimer = setTimeout(() => document.body.classList.remove('pointer'), 3000);
});

// The wheel, or two fingers on a touchpad, steps through rows and lists.
let wheelAcc = 0;
let wheelAt = 0;
document.addEventListener(
    'wheel',
    (e) => {
        if (library.playing() || screensaver.on) return;
        e.preventDefault();
        const now = Date.now();
        if (now - wheelAt > 300) wheelAcc = 0;
        wheelAt = now;
        wheelAcc += Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : 0;
        while (Math.abs(wheelAcc) >= 80) {
            const down = wheelAcc > 0;
            wheelAcc -= down ? 80 : -80;
            moveFocus(down ? 'down' : 'up');
        }
    },
    { passive: false },
);

function moveFocus(dir) {
    const a = document.activeElement;
    const from = scopeEls().includes(a) ? a : null;
    if (!from) return focusEl(defaultFocus());
    let candidates = scopeEls();
    // In Settings, Up and Down stay in the column they started in: on the
    // page, or in the menu. How far the menu items sit from the options
    // depends on the screen's shape, so going by distance alone once sent a
    // Down on the Display page to Updates on some screens.
    if (view === 'settings' && $('#modal').hidden && (dir === 'up' || dir === 'down')) {
        const onPage = $('#settings-pane').contains(from);
        candidates = candidates.filter((el) => (onPage ? !el.classList.contains('sitem') : !$('#settings-pane').contains(el)));
    }
    let next = nextInDirection(from, dir, candidates);
    if (view === 'settings' && $('#modal').hidden) {
        if (dir === 'right' && from.classList.contains('sitem')) next = $('#settings-pane .f') || next;
        else if (dir === 'left' && next?.classList.contains('sitem') && $('#settings-pane').contains(from)) next = $(`.sitem[data-pane="${pane}"]`) || next;
    }
    // Up out of a page lands on that page's own tab, not whichever tab is
    // nearest above (the Settings menu sits under Home on the screen).
    if (next && dir === 'up' && next.closest('#tabs') && !from.closest('#tabs')) next = $('.tab.current') || next;
    // Down from the tabs goes back to where you were on that page.
    if (dir === 'down' && from.closest('#tabs')) {
        const back = remembered();
        if (back) next = back;
    }
    if (!next) return sfx.play('edge');
    sfx.play(next.classList.contains('tab') ? 'tab' : 'move');
    focusEl(next);
}

// Where the selection last was on each page, for coming back to it.
const lastFocus = new Map();

function remembered() {
    const page = $(`#view-${view}`);
    let el = lastFocus.get(view);
    // Pages are drawn again when you come back to them: find the same item
    // in the new drawing by what it is.
    if (el && !el.isConnected) {
        const same = ['id', 'data-key', 'data-pane', 'data-app', 'data-jf', 'data-act'].find((a) => el.hasAttribute(a));
        el = same ? page?.querySelector(`[${same}="${CSS.escape(el.getAttribute(same))}"]`) : null;
    }
    if (el && el.isConnected && visible(el) && page.contains(el)) return el;
    // Otherwise, in Settings, the section you were in.
    if (view === 'settings') return $(`.sitem[data-pane="${pane}"]`);
    return null;
}

// ================================================================= keys ==

function textTarget() {
    if (!$('#modal').hidden) return $('#modal input');
    const a = document.activeElement;
    if (a && a.tagName === 'INPUT') return a;
    if (view === 'search') return $('#search-input');
    return null;
}

function typeInto(input, text) {
    if (!input) return;
    input.value += text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

function backspaceIn(input) {
    if (!input || !input.value) return;
    input.value = input.value.slice(0, -1);
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

const DIRS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

document.addEventListener('keydown', (e) => {
    idle.reset();
    if (screensaver.on) {
        e.preventDefault();
        screensaver.stop();
        return;
    }
    document.body.classList.remove('pointer');
    if (updating.on) {
        // Only the Close button of a failed update can be pressed.
        e.preventDefault();
        if (e.key === 'Enter' && !$('#us-actions').hidden) $('#us-close').click();
        return;
    }
    if (library.handleKey(e)) return;
    const a = document.activeElement;
    const inText = a && a.tagName === 'INPUT';
    const dir = DIRS[e.key];

    if (moving && (dir === 'left' || dir === 'right')) {
        e.preventDefault();
        return moveApp(dir === 'left' ? -1 : 1);
    }
    if (moving && (e.key === 'Enter' || e.key === 'Escape' || e.key === 'Backspace')) {
        e.preventDefault();
        return stopMoving();
    }
    if (dir) {
        e.preventDefault();
        return moveFocus(dir);
    }
    if (e.key === 'Enter') {
        if (!a || a === document.body) return;
        e.preventDefault();
        if (inText) {
            sfx.play('select');
            return openKeyboardFor(a);
        }
        sfx.play(a.dataset.app || a.dataset.jf ? 'open' : a.dataset.k ? 'key' : 'select');
        a.click();
        return;
    }
    if (e.key === 'Escape' || e.key === 'BrowserBack') {
        e.preventDefault();
        return goBack();
    }
    if (e.key === 'Backspace') {
        if (inText) return; // a real keyboard editing a field
        e.preventDefault();
        const t = textTarget();
        if (t) return backspaceIn(t);
        return goBack();
    }
    if (e.key === 'ContextMenu') {
        e.preventDefault();
        return openOptions(a);
    }
    if (e.key === 'PageUp' || e.key === 'PageDown') {
        e.preventDefault();
        const order = ['home', ...(S?.jellyfin?.connected ? ['library'] : []), 'apps', 'search', 'settings'];
        const i = order.indexOf(view) + (e.key === 'PageDown' ? 1 : -1);
        if (i >= 0 && i < order.length) {
            sfx.play('tab');
            showView(order[i]);
        } else sfx.play('edge');
        return;
    }
    if (e.key === 'BrowserSearch') {
        e.preventDefault();
        return showView('search');
    }
    // A keyboard plugged into the TV: typing anywhere on Search searches.
    if (!inText && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const t = textTarget();
        if (t) {
            e.preventDefault();
            typeInto(t, e.key);
        }
    }
});

function goBack() {
    sfx.play('back');
    if (!$('#modal').hidden) return closeModal();
    if (view === 'detail') return library.backFromDetail();
    if (view !== 'home') return showView('home');
    const first = $('#rows .f');
    if (first && document.activeElement !== first) {
        $$('#rows .strip').forEach((s) => (s.scrollLeft = 0));
        focusEl(first);
    }
}

function defaultFocus() {
    if (!$('#modal').hidden) return $('#modal .f');
    const back = remembered();
    if (back) return back;
    if (view === 'home') return $('#rows .f') || $('.tab.current');
    if (view === 'settings') return $(`.sitem[data-pane="${pane}"]`);
    if (view === 'search') return $('#search-osk .f');
    return $(`#view-${view} .f`) || $('.tab.current');
}

// ================================================================ views ==

function showView(name, { focus = true } = {}) {
    if (view !== name) {
        view = name;
        $$('.view').forEach((v) => (v.hidden = v.id !== `view-${name}`));
        if (name === 'apps') renderApps();
        if (name === 'settings') showPane(pane, true);
        if (name === 'search') renderSearch();
        if (name === 'library') library.renderLibrary();
    }
    $$('.tab').forEach((t) => t.classList.toggle('current', t.dataset.view === (name === 'detail' ? 'library' : name)));
    if (focus) focusEl(defaultFocus());
}

// ----------------------------------------------------------------- hero --

function greeting() {
    const h = new Date().getHours();
    return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

let heroWant = null;
let heroTimer = null;
let heroLoad = 0;

function setHero(h) {
    $('#hero-kicker').textContent = h.kicker || '';
    $('#hero-title').textContent = h.title || '';
    $('#hero-sub').textContent = h.sub || '';
    $('#hero-desc').textContent = h.desc || '';
    const p = $('#hero-progress');
    p.hidden = !h.progress;
    if (h.progress) p.firstElementChild.style.width = `${h.progress}%`;
    const want = h.image ? `url("${h.image}")` : h.color || 'radial-gradient(ellipse at 70% 20%, #1d2a4a 0%, transparent 60%)';
    if (want === heroWant) return;
    heroWant = want;
    // Moving quickly along a row, the picture waits for a pause rather
    // than starting a fade for every tile passed.
    clearTimeout(heroTimer);
    heroTimer = setTimeout(() => showHeroPicture(want, Boolean(h.image), h.image), 140);
}

function showHeroPicture(want, isPhoto, url) {
    const seq = ++heroLoad;
    const swap = () => {
        if (seq !== heroLoad) return; // something newer was asked for meanwhile
        const layers = $$('#hero-bg .hero-layer');
        const front = layers.find((l) => l.classList.contains('on')) || layers[1];
        const back = layers.find((l) => l !== front);
        back.style.backgroundImage = want;
        back.classList.toggle('photo', isPhoto);
        back.classList.add('on');
        front.classList.toggle('on', false);
    };
    if (!isPhoto) return swap();
    // Only fade in a picture that has fully arrived.
    const img = new Image();
    img.onload = swap;
    img.onerror = swap;
    img.src = url;
}

const welcomeHero = () => ({
    kicker: greeting(),
    title: S?.deviceName && S.deviceName !== 'SimpleTV' ? S.deviceName : 'Welcome to SimpleTV',
    sub: 'Pick something to watch.',
});

function appHero(app) {
    const how = app.needsSetup
        ? 'Set up in Settings first.'
        : app.nav === 'keys'
          ? 'Made for the TV: use the arrows and OK.'
          : 'Arrows move between items, OK opens. The touchpad points too.';
    return {
        kicker: app.group || 'App',
        title: app.name,
        sub: how,
        color: `radial-gradient(ellipse at 75% 30%, color-mix(in srgb, ${app.bg.startsWith('linear') ? '#5b6cd8' : app.bg} 45%, transparent) 0%, transparent 65%)`,
    };
}

// ----------------------------------------------------------------- home --

function tileHtml(app, { pinnedBadge = false } = {}) {
    const style = `background:${app.bg};color:${app.fg}`;
    return `<button class="f tile" data-app="${esc(app.id)}" data-key="app:${esc(app.id)}" style="${esc(style)}">${esc(app.name)}${
        app.needsSetup ? '<span class="needs">Set up</span>' : ''
    }${pinnedBadge ? '<svg class="pin"><use href="#i-pin"/></svg>' : ''}</button>`;
}

function cardHtml(item, rowKey) {
    const img = item.image ? ` style="background-image:url('${esc(item.image)}')"` : '';
    return `<button class="f card" data-jf="${esc(item.id)}" data-key="${rowKey}:${esc(item.id)}">
        <div class="thumb"${img}>${item.image ? '' : `<div class="noimg">${esc(item.title)}</div>`}${
            item.progress ? `<div class="bar"><i style="width:${item.progress}%"></i></div>` : ''
        }</div>
        <div class="ct">${esc(item.title)}</div><div class="cs">${esc(item.subtitle)}</div></button>`;
}

function renderHome() {
    const keep = document.activeElement?.dataset?.key;
    const byId = new Map(S.apps.map((a) => [a.id, a]));
    const pinned = S.pinned.map((id) => byId.get(id)).filter(Boolean);
    let html = '';
    html += `<div class="row" data-row="apps"><h3>Your apps</h3><div class="strip">${pinned.map((a) => tileHtml(a)).join('')}
        <button class="f tile add" data-go="apps" data-key="add-apps"><svg><use href="#i-plus"/></svg>More apps</button></div></div>`;

    const rows = [];
    if (jf?.resume?.length) rows.push(['resume', 'Continue watching', jf.resume]);
    if (jf?.nextUp?.length) rows.push(['nextup', 'Next up', jf.nextUp]);
    if (jf?.latest?.length) rows.push(['latest', 'Recently added', jf.latest]);
    for (const [key, title, items] of rows) {
        html += `<div class="row" data-row="${key}"><h3>${title}</h3><div class="strip">${items.map((i) => cardHtml(i, key)).join('')}</div></div>`;
    }

    const todo = [];
    if (!S.remotes?.length) todo.push(['remote', 'Use your phone as the remote', 'i-phone']);
    if (!S.jellyfin.connected) todo.push(['jellyfin', 'Show your Jellyfin movies and shows here', 'i-film']);
    if (todo.length) {
        html += `<div class="row" data-row="start"><h3>Get started</h3><div class="strip">${todo
            .map(([p, label, icon]) => `<button class="f action-tile" data-pane-go="${p}" data-key="todo:${p}"><svg><use href="#${icon}"/></svg>${esc(label)}</button>`)
            .join('')}</div></div>`;
    }
    $('#rows').innerHTML = `<div class="rows-inner">${html}</div>`;

    // What the hero shows for each.
    $$('#rows [data-app]').forEach((el) => heroFor.set(el, appHero(byId.get(el.dataset.app))));
    for (const [key, label, items] of rows) {
        const byItem = new Map(items.map((i) => [i.id, i]));
        $$(`#rows [data-row="${key}"] [data-jf]`).forEach((el) => {
            const it = byItem.get(el.dataset.jf);
            heroFor.set(el, { kicker: label, title: it.title, sub: it.subtitle, desc: it.overview, image: it.backdrop || it.image, progress: it.progress });
        });
    }
    $$('#rows [data-go], #rows [data-pane-go]').forEach((el) => heroFor.set(el, welcomeHero()));

    if (view === 'home') {
        const again = keep && $(`#rows [data-key="${CSS.escape(keep)}"]`);
        if (again) focusEl(again);
        else if (!document.activeElement || document.activeElement === document.body || !document.activeElement.isConnected) {
            setHero(welcomeHero());
            focusEl($('#rows .f'));
        }
    }
}

document.addEventListener('click', (e) => {
    const el = e.target.closest('.f');
    if (!el) return;
    if (el.dataset.app) return launch(el.dataset.app);
    if (library.handleClick(el)) return;
    if (el.dataset.jf) {
        if (el.dataset.key?.startsWith('resume:')) return library.play(el.dataset.jf, { resume: true });
        return library.openDetail(el.dataset.jf, { from: el });
    }
    if (el.dataset.go) return showView(el.dataset.go);
    if (el.dataset.paneGo) {
        pane = el.dataset.paneGo;
        showView('settings', { focus: false });
        return focusEl($(`.sitem[data-pane="${pane}"]`));
    }
    if (el.classList.contains('tab')) return showView(el.dataset.view);
    if (el.id === 'close-btn') return confirmClose();
    if (el.id === 'power-btn') return confirmPower();
});

function confirmPower() {
    openModal(`<h2>Turn off this computer?</h2><p class="sub">SimpleTV and everything else on this computer shuts down.</p>
        <div class="menu"><button class="f" data-power="off">Turn off</button><button class="f" data-power="restart">Restart</button><button class="f" data-power="no">Cancel</button></div>`);
    $$('#modal [data-power]').forEach((b) =>
        b.addEventListener('click', async (e) => {
            e.stopPropagation();
            const action = b.dataset.power;
            if (action === 'no') return closeModal();
            $('#modal-card').innerHTML = `<h2>${action === 'off' ? 'Turning off…' : 'Restarting…'}</h2><p class="sub">${
                action === 'off' ? 'Goodnight.' : 'SimpleTV will be back in a minute.'
            }</p>`;
            try {
                await api('/api/power', { action });
            } catch (err) {
                closeModal();
                toast(err.message);
            }
        }),
    );
}

function confirmClose() {
    openModal(`<h2>Close SimpleTV?</h2><p class="sub">The TV screen closes and your desktop comes back. Open it again from the SimpleTV icon in your apps menu.</p>
        <div class="menu"><button class="f" data-close="yes">Close SimpleTV</button><button class="f" data-close="no">Cancel</button></div>`);
    $$('#modal [data-close]').forEach((b) =>
        b.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (b.dataset.close === 'no') return closeModal();
            $('#modal-card').innerHTML = '<h2>Closing…</h2>';
            try {
                await api('/api/exit', {});
            } catch (err) {
                closeModal();
                toast(err.message);
                return;
            }
            // Closing takes this very page away. Still here after 15 seconds
            // means it did not work, and saying so beats a frozen "Closing…".
            setTimeout(() => {
                if ($('#modal').hidden) return;
                $('#modal-card').innerHTML = `<h2>SimpleTV did not close</h2><p class="sub">Close it from a terminal with <b>simpletv close</b>, and if that fails too, <b>simpletv restart</b>.</p>
                    <div class="menu"><button class="f" data-close-ok>OK</button></div>`;
                $('#modal [data-close-ok]').addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    closeModal();
                });
                focusEl($('#modal .f'));
            }, 15_000);
        }),
    );
}

async function launch(id) {
    const app = S.apps.find((a) => a.id === id);
    if (!app) return;
    if (app.id === 'jellyfin' && S.jellyfin.connected) return showView('library');
    if (app.needsSetup) {
        pane = 'jellyfin';
        showView('settings', { focus: false });
        return focusEl($('.sitem[data-pane="jellyfin"]'));
    }
    toast(`Opening ${app.name}…`);
    try {
        await api('/api/launch', { id });
    } catch (err) {
        toast(err.message);
    }
}

// ------------------------------------------------------- moving tiles --

function startMoving(id) {
    if (view !== 'home') {
        showView('home', { focus: false });
    }
    moving = id;
    const el = $(`#rows [data-app="${CSS.escape(id)}"]`);
    if (el) {
        focusEl(el);
        el.classList.add('moving');
        el.style.outline = '0.25rem dashed #fff';
        el.style.outlineOffset = '0.35rem';
    }
    toast('Move with left and right, then press OK');
}

async function moveApp(by) {
    S = await api('/api/apps/move', { id: moving, by });
    renderHome();
    startMovingQuiet();
}

function startMovingQuiet() {
    const el = $(`#rows [data-app="${CSS.escape(moving)}"]`);
    if (!el) return;
    focusEl(el);
    el.style.outline = '0.25rem dashed #fff';
    el.style.outlineOffset = '0.35rem';
}

function stopMoving() {
    const el = $(`#rows [data-app="${CSS.escape(moving)}"]`);
    if (el) el.style.outline = '';
    moving = null;
}

// ================================================================ modal ==

let modalReturn = null;

function openModal(html, { onClose } = {}) {
    modalReturn = document.activeElement;
    $('#modal-card').innerHTML = html;
    $('#modal').hidden = false;
    $('#modal')._onClose = onClose;
    focusEl($('#modal .f'));
}

function closeModal() {
    $('#modal').hidden = true;
    const cb = $('#modal')._onClose;
    $('#modal')._onClose = null;
    if (cb) cb();
    if (modalReturn?.isConnected) focusEl(modalReturn);
    else focusEl(defaultFocus());
}

function openOptions(el) {
    const id = el?.dataset?.app;
    if (!id) return;
    const app = S.apps.find((a) => a.id === id);
    const pinned = S.pinned.includes(id);
    const items = [['open', 'Open']];
    if (pinned) items.push(['move', 'Move on the home screen'], ['unpin', 'Remove from the home screen']);
    else items.push(['pin', 'Add to the home screen']);
    if (app.custom) items.push(['delete', 'Delete this website']);
    openModal(
        `<h2>${esc(app.name)}</h2><p class="sub">${esc(app.url || 'Not set up yet')}</p><div class="menu">${items
            .map(([k, label]) => `<button class="f" data-opt="${k}">${esc(label)}</button>`)
            .join('')}</div>`,
    );
    $$('#modal [data-opt]').forEach((b) =>
        b.addEventListener('click', async (e) => {
            e.stopPropagation();
            const k = b.dataset.opt;
            closeModal();
            try {
                if (k === 'open') return launch(id);
                if (k === 'move') return startMoving(id);
                if (k === 'pin' || k === 'unpin') S = await api('/api/apps/pin', { id, pinned: k === 'pin' });
                if (k === 'delete') S = await api('/api/apps/remove', { id });
                renderHome();
                if (view === 'apps') renderApps(`app:${id}`);
                toast(k === 'pin' ? `${app.name} is on the home screen` : k === 'unpin' ? `${app.name} was taken off the home screen` : `${app.name} was deleted`);
            } catch (err) {
                toast(err.message);
            }
        }),
    );
}

// ---------------------------------------------------- on-screen keyboard --

const LOWER = 'abcdefghijklmnopqrstuvwxyz1234567890'.split('');
const SYMBOLS = ['.', '-', '_', '@', '/', ':', '?', '&', '=', '+', '!', '#', '%', '~', "'", ',', '(', ')', '*', '$'];

function oskHtml({ caps = false, symbols = false, done = true, cols = 10 } = {}) {
    const keys = symbols ? [...SYMBOLS, ...'1234567890'.split('')] : LOWER.map((k) => (caps ? k.toUpperCase() : k));
    let h = keys.map((k) => `<button class="f" data-k="${esc(k)}">${esc(k)}</button>`).join('');
    h += `<button class="f wide" data-k="#caps">${caps ? 'abc' : 'ABC'}</button>`;
    h += `<button class="f wide" data-k="#sym">${symbols ? 'abc' : '#+='}</button>`;
    if (cols >= 10) h += `<button class="f wide" data-k=".com">.com</button>`;
    h += `<button class="f wider" data-k=" ">Space</button>`;
    h += `<button class="f wide" data-k="#del">Delete</button>`;
    if (done) h += `<button class="f wide" data-k="#done">Done</button>`;
    else h += `<button class="f wide" data-k="#clear">Clear</button>`;
    return h;
}

function wireOsk(container, getInput, opts, onDone) {
    let caps = false;
    let symbols = false;
    const draw = (keepKey) => {
        container.innerHTML = oskHtml({ ...opts, caps, symbols });
        if (keepKey) focusEl($(`[data-k="${CSS.escape(keepKey)}"]`, container) || $('.f', container));
    };
    draw();
    container.addEventListener('click', (e) => {
        const b = e.target.closest('[data-k]');
        if (!b) return;
        e.stopPropagation();
        const k = b.dataset.k;
        const input = getInput();
        if (k === '#caps') {
            caps = !caps;
            symbols = false;
            return draw('#caps');
        }
        if (k === '#sym') {
            symbols = !symbols;
            return draw('#sym');
        }
        if (k === '#del') return backspaceIn(input);
        if (k === '#clear') {
            input.value = '';
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return;
        }
        if (k === '#done') return onDone?.();
        typeInto(input, k);
    });
}

function eyeButton(forId) {
    return `<button class="f eye" data-eye="${forId}" aria-label="Show password"><svg><use href="#i-eye"/></svg><span>Show</span></button>`;
}

function setEye(btn, shown) {
    btn.querySelector('use').setAttribute('href', shown ? '#i-eye-off' : '#i-eye');
    btn.querySelector('span').textContent = shown ? 'Hide' : 'Show';
    btn.setAttribute('aria-label', shown ? 'Hide password' : 'Show password');
}

document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-eye]');
    if (!btn) return;
    const input = document.getElementById(btn.dataset.eye);
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    setEye(btn, show);
    // The box being typed into from the keyboard follows suit.
    const field = document.querySelector(`[data-eye-mirror="${btn.dataset.eye}"]`);
    if (field) field.type = input.type;
}, true);

function openKeyboardFor(input) {
    const label = input.closest('.field')?.querySelector('span')?.textContent || input.placeholder || 'Type';
    const isPw = input.dataset.secret !== undefined;
    openModal(
        `<h2>${esc(label)}</h2><p class="sub">Or type on your phone's keyboard.</p>
         <div class="field" style="max-width:none">${
             isPw
                 ? `<div class="pw-row"><input id="osk-mirror" type="${input.type}" class="text-target" tabindex="-1" readonly>${eyeButton('osk-mirror')}</div>`
                 : `<input id="osk-mirror" type="text" class="text-target" tabindex="-1" readonly>`
         }</div>
         <div class="osk" id="modal-osk"></div>`,
    );
    // Showing it here shows it on the page behind too, and the other way round.
    if (isPw) {
        const eye = $('#modal [data-eye]');
        setEye(eye, input.type === 'text');
        if (input.id) $('#osk-mirror').dataset.eyeMirror = input.id;
        eye.addEventListener('click', () => {
            input.type = $('#osk-mirror').type;
            const pageEye = document.querySelector(`[data-eye="${input.id}"]`);
            if (pageEye) setEye(pageEye, input.type === 'text');
        });
    }
    const mirror = $('#osk-mirror');
    mirror.value = input.value;
    mirror.addEventListener('input', () => {
        input.value = mirror.value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    wireOsk($('#modal-osk'), () => mirror, { done: true, cols: 10 }, () => closeModal());
    focusEl($('#modal-osk .f'));
}

// ================================================================= apps ==

function renderApps(keepKey) {
    const keep = keepKey || document.activeElement?.dataset?.key;
    const groups = new Map();
    for (const a of S.apps) {
        if (!groups.has(a.group)) groups.set(a.group, []);
        groups.get(a.group).push(a);
    }
    if (!groups.has('Websites')) groups.set('Websites', []);
    let html = '';
    for (const [name, list] of groups) {
        html += `<div class="group" data-row="g-${esc(name)}"><h3>${esc(name)}</h3><div class="grid">${list
            .map((a) => tileHtml(a, { pinnedBadge: S.pinned.includes(a.id) }))
            .join('')}${
            name === 'Websites' ? `<button class="f tile add" data-add-site data-key="add-site"><svg><use href="#i-plus"/></svg>Add a website</button>` : ''
        }</div></div>`;
    }
    const pg = $('#view-apps .page');
    pg.innerHTML = `<div class="page-inner"><h2 class="page-title">Apps</h2><p class="page-hint">Select to open. Press <kbd>Menu</kbd> on a tile (the ☰ button on the phone, View on a controller) to put it on the home screen or move it.</p>${html}</div>`;
    $('[data-add-site]', pg)?.addEventListener('click', (e) => {
        e.stopPropagation();
        addSiteForm();
    });
    if (view === 'apps') {
        const again = keep && $(`#view-apps [data-key="${CSS.escape(keep)}"]`);
        if (again) focusEl(again);
    }
}

function addSiteForm() {
    openModal(`<h2>Add a website</h2><p class="sub">It gets a tile of its own, on the home screen and here.</p>
        <label class="field"><span>Web address</span><input class="f" id="site-url" placeholder="example.com" autocomplete="off"></label>
        <label class="field"><span>Name (optional)</span><input class="f" id="site-name" autocomplete="off"></label>
        <div id="site-err" class="err" hidden></div>
        <button class="f btn primary" id="site-add">Add</button><button class="f btn" id="site-cancel">Cancel</button>`);
    $('#site-cancel').addEventListener('click', (e) => {
        e.stopPropagation();
        closeModal();
    });
    $('#site-add').addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
            S = await api('/api/apps/custom', { url: $('#site-url').value, name: $('#site-name').value });
            closeModal();
            renderApps();
            renderHome();
            toast('Added');
        } catch (err) {
            $('#site-err').hidden = false;
            $('#site-err').textContent = err.message;
        }
    });
}

// =============================================================== search ==

let searchTimer = null;
let searchSeq = 0;

function renderSearch() {
    const osk = $('#search-osk');
    if (!osk.dataset.wired) {
        osk.dataset.wired = '1';
        wireOsk(osk, () => $('#search-input'), { done: false, cols: 7 });
        $('#search-input').addEventListener('input', () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(runSearch, 350);
        });
    }
    runSearch();
}

async function runSearch() {
    const q = $('#search-input').value.trim();
    const out = $('#search-results');
    const seq = ++searchSeq;
    if (!q) {
        out.innerHTML = `<p class="search-msg">Type with the keyboard here, or on your phone.${
            S.jellyfin.connected ? ' Search covers your Jellyfin library, your apps and YouTube.' : ' Connect Jellyfin in Settings to search your own library too.'
        }</p>`;
        return;
    }
    const ql = q.toLowerCase();
    const appHits = S.apps.filter((a) => a.name.toLowerCase().includes(ql));
    let html = `<div class="row" data-row="s-actions"><div class="grid">
        <button class="f action-tile" data-yt="${esc(q)}" data-key="s-yt"><span class="dot" style="background:#ff0033"></span>Search YouTube for “${esc(q)}”</button>
    </div></div>`;
    if (appHits.length) html += `<div class="row" data-row="s-apps"><h3>Apps</h3><div class="grid">${appHits.map((a) => tileHtml(a)).join('')}</div></div>`;
    out.innerHTML = html + (S.jellyfin.connected ? `<p class="search-msg">Searching your library…</p>` : '');
    wireSearchActions(out);
    if (!S.jellyfin.connected) return;
    try {
        const { items } = await api(`/api/jellyfin/search?q=${encodeURIComponent(q)}`);
        if (seq !== searchSeq) return;
        $('.search-msg', out)?.remove();
        if (items.length) {
            out.insertAdjacentHTML('beforeend', `<div class="row" data-row="s-jf"><h3>In your library</h3><div class="grid">${items.map((i) => cardHtml(i, 's-jf')).join('')}</div></div>`);
        } else out.insertAdjacentHTML('beforeend', `<p class="search-msg">Nothing in your library matches “${esc(q)}”.</p>`);
    } catch (err) {
        if (seq === searchSeq) $('.search-msg', out).textContent = `Jellyfin search failed: ${err.message}`;
    }
}

function wireSearchActions(out) {
    $$('[data-yt]', out).forEach((b) =>
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            api('/api/launch', { id: 'youtube', path: `#/search?q=${encodeURIComponent(b.dataset.yt)}` }).catch((err) => toast(err.message));
        }),
    );
}

// ============================================================= settings ==

function showPane(name, force) {
    if (pane === name && !force && $('#settings-pane .pane')) return;
    pane = name;
    $$('.sitem').forEach((s) => s.classList.toggle('current', s.dataset.pane === name));
    const render = PANES[name];
    $('#settings-pane').innerHTML = `<div class="pane-inner"><div class="pane">${render()}</div></div>`;
    WIRES[name]?.($('#settings-pane'));
}

function rerenderPane(name) {
    if (view !== 'settings' || pane !== name) return;
    const keep = document.activeElement?.id || document.activeElement?.dataset?.key;
    showPane(name, true);
    const again = keep && ($(`#settings-pane #${CSS.escape(keep)}`) || $(`#settings-pane [data-key="${CSS.escape(keep)}"]`));
    if (again) focusEl(again);
}

const lanHost = () => {
    try {
        return new URL(S.remoteUrl).hostname;
    } catch {
        return 'localhost';
    }
};

const PANES = {
    remote: () => `
        <h2>Phone remote</h2>
        <p class="lead">Point your phone's camera at the code. It opens a remote in the browser, over your Wi-Fi: no app to install.</p>
        <div class="box pair">
          <img src="/api/pair/qr.svg?c=${esc(S.pairCode)}" alt="QR code for the phone remote">
          <div>
            <div class="note">Or open this address on your phone</div>
            <div class="url">${esc(S.remoteUrl)}</div>
            <div class="note" style="margin-top:1.1rem">and enter this code</div>
            <div class="code">${esc(S.pairCode)}</div>
          </div>
        </div>
        <div class="box"><h4>Paired phones</h4>${
            S.remotes.length
                ? S.remotes
                      .map(
                          (r) => `<div class="list-item"><div class="grow">${esc(r.name)}<small>Paired ${new Date(r.added).toLocaleDateString()}</small></div>
                    <button class="f btn danger" data-revoke="${esc(r.id)}" data-key="rv:${esc(r.id)}">Remove</button></div>`,
                      )
                      .join('')
                : '<p class="note" style="margin:0">None yet.</p>'
        }</div>
        <p class="note">On the phone, use “Add to Home Screen” so the remote opens like an app.</p>`,

    controllers: () => `
        <h2>Controllers</h2>
        <p class="lead">Xbox, PlayStation, 8BitDo and most other controllers work, plugged in by USB or paired over Bluetooth with this computer.</p>
        <div class="box"><h4>Connected</h4>${
            S.controllers.length ? S.controllers.map((c) => `<div class="list-item"><svg><use href="#i-pad"/></svg><div class="grow">${esc(c)}</div></div>`).join('') : '<p class="note" style="margin:0">No controller connected right now.</p>'
        }</div>
        <div class="box"><h4>Buttons</h4><dl class="map">
          <dt>D-pad or left stick</dt><dd>Move around</dd>
          <dt>A / Cross</dt><dd>Select</dd>
          <dt>B / Circle</dt><dd>Back</dd>
          <dt>Xbox / PS button</dt><dd>Home</dd>
          <dt>Right stick</dt><dd>Move the pointer, for web apps made for a mouse</dd>
          <dt>RT / R2 or click R3</dt><dd>Click where the pointer is</dd>
          <dt>Menu / Start, X</dt><dd>Play / pause</dd>
          <dt>Y / Square</dt><dd>Search</dd>
          <dt>View / Share</dt><dd>Options for the selected tile</dd>
          <dt>LB / RB</dt><dd>Previous / next tab</dd>
        </dl></div>
        <p class="note">A keyboard works too: arrows and Enter to move and select, Esc to go back, and Home (or Ctrl+H) to come back here from any app.</p>
        <p class="note">In cloud gaming apps (Xbox Cloud Gaming, GeForce NOW) the controller goes straight to the game, and only the Xbox / PS button comes back to SimpleTV.</p>`,

    sound: () => `<h2>Sound</h2><p class="lead">Loading…</p>`,

    jellyfin: () => {
        const j = S.jellyfin;
        if (j.connected) {
            return `<h2>Jellyfin</h2><p class="lead">Your library shows on the home screen: what you were watching, what is next, and what was just added.</p>
            <div class="box"><div class="kv"><span>Server</span><b>${esc(j.serverName || '')} · ${esc(j.url)}</b><span>Signed in as</span><b>${esc(j.userName)}</b></div></div>
            <p class="note">Your films and shows are under Library, and play in SimpleTV's own player. Where you stop is saved back to Jellyfin, so Continue watching matches on every device.</p>
            <button class="f btn" id="jf-out">Sign out</button>`;
        }
        return `<h2>Jellyfin</h2><p class="lead">Sign in to show your movies and shows on the home screen.</p>
            <label class="field"><span>Server address</span><input class="f" id="jf-url" value="" placeholder="http://192.168.1.10:8096" autocomplete="off" spellcheck="false"></label>
            <div id="jf-found" class="note" style="margin:-.4rem 0 1rem">Looking for Jellyfin on your network…</div>
            <label class="field"><span>User name</span><input class="f" id="jf-user" autocomplete="off" spellcheck="false"></label>
            <div class="field"><span>Password</span><div class="pw-row"><input class="f" id="jf-pass" type="password" data-secret autocomplete="off">${eyeButton('jf-pass')}</div></div>
            <div id="jf-err" class="err" hidden></div>
            <button class="f btn primary" id="jf-in">Sign in</button>
            <p class="note">Select a box and press OK to type, or type on your phone's keyboard while a box is selected.</p>`;
    },

    display: () => `
        <h2>Display</h2>
        <p class="lead">${
            S.mode === 'tv'
                ? 'This computer is a TV box: SimpleTV starts with it and is all the TV shows.'
                : 'SimpleTV is a full-screen window on this desktop. Close it to get the desktop back.'
        }</p>
        <label class="field"><span>Name of this TV (shown on the phone)</span><input class="f" id="dev-name" value="${esc(S.deviceName)}" autocomplete="off"></label>
        <button class="f btn" id="dev-save">Save name</button>
        <div class="box" style="margin-top:1.4rem"><h4>Start with this computer</h4>${
            S.mode === 'window'
                ? `<p class="note" style="margin:0 0 .7rem">Open SimpleTV full-screen as soon as you sign in. For it to come up without anyone touching the computer, turn on automatic sign-in in the computer's own settings too.</p>
                   ${[true, false]
                       .map((v) => `<button class="f option${Boolean(S.autostart) === v ? ' on' : ''}" data-auto="${v}" data-key="auto:${v}"><span class="radio"></span>${v ? 'On' : 'Off'}</button>`)
                       .join('')}<p class="err" id="auto-err" hidden></p>`
                : '<p class="note" style="margin:0">SimpleTV is a TV box here: it already starts with the computer.</p>'
        }</div>
        <div class="box"><h4>Website size</h4>
          <p class="note" style="margin:0 0 .7rem">How large apps and websites draw on the TV. Standard lays them out like a 1080p TV, whatever this computer's display scaling.</p>
          ${[
              [0.85, 'Smaller (fits more)'],
              [1, 'Standard'],
              [1.15, 'Larger'],
          ]
              .map(([v, label]) => `<button class="f option${Number(S.siteScale || 1) === v ? ' on' : ''}" data-scale="${v}" data-key="scale:${v}"><span class="radio"></span>${label}</button>`)
              .join('')}
        </div>
        <div class="box"><h4>Screensaver</h4>
          <p class="note" style="margin:0 0 .7rem">Photos of the world from Wikimedia Commons, over whatever is on screen, when nothing has been pressed for a while. Never while something is playing. The first press only wakes the screen, and everything is where you left it. While SimpleTV is open the computer itself does not lock or go to sleep.</p>
          ${[0, 5, 10, 30]
              .map(
                  (m) => `<button class="f option${S.screensaverMinutes === m ? ' on' : ''}" data-ss="${m}" data-key="ss:${m}"><span class="radio"></span>${
                      m ? `After ${m} minutes` : 'Off'
                  }</button>`,
              )
              .join('')}
        </div>
        ${S.mode === 'window' ? '<button class="f btn danger" id="exit-btn">Close SimpleTV</button><p class="note">Open it again from the SimpleTV icon in your apps menu.</p>' : ''}`,

    about: () => `
        <h2>Updates</h2>
        <p class="lead">SimpleTV checks GitHub for a new version on its own every few hours. Updating keeps your apps, paired phones and every sign-in.</p>
        <div class="box"><div id="upd"></div></div>
        <div class="box"><div class="kv">
          <span>Version</span><b>${esc(S.version)}</b>
          <span>Mode</span><b>${S.mode === 'tv' ? 'TV box' : 'Window on a desktop'}</b>
          <span>Phone remote</span><b>${esc(S.remoteUrl)}</b>
        </div></div>
        <p class="note">SimpleTV is open source. Ads and trackers are blocked by Brave. Streaming services show at up to 720p in a Linux browser, which is their rule, not this computer's limit. Your own Jellyfin and YouTube play at full quality.</p>`,
};

const WIRES = {
    remote: (root) => {
        // The code is an image from the server. If the server was busy (an
        // update restarting it, say) the image fails and leaves a white box,
        // so it is asked for again, and explained if it never comes.
        const img = $('.pair img', root);
        if (img) {
            let tries = 0;
            img.addEventListener('error', () => {
                if (!img.isConnected) return;
                if (++tries <= 5) return setTimeout(() => (img.src = `/api/pair/qr.svg?c=${encodeURIComponent(S.pairCode)}&r=${tries}`), 2000);
                img.replaceWith(Object.assign(document.createElement('p'), { className: 'note', textContent: 'The code did not load. Use the address on the right instead.' }));
            });
        }
        $$('[data-revoke]', root).forEach((b) =>
            b.addEventListener('click', async (e) => {
                e.stopPropagation();
                await api('/api/remotes/revoke', { id: b.dataset.revoke });
                S = await api('/api/state');
                rerenderPane('remote');
                renderHome();
            }),
        );
    },
    sound: async (root) => {
        // The volume arrives a moment later. If the person has moved on to
        // another page by then, this one is gone and must not be drawn over it.
        const paneEl = $('.pane', root);
        const effectsBox = () => `<div class="box"><h4>Sound effects</h4>
              <p class="note" style="margin:0 0 .7rem">A soft click as you move around the home screen, and a chime when you open something.</p>
              ${[true, false]
                  .map((v) => `<button class="f option${(S.uiSounds !== false) === v ? ' on' : ''}" data-sfx="${v}" data-key="sfx:${v}"><span class="radio"></span>${v ? 'On' : 'Off'}</button>`)
                  .join('')}</div>`;
        const wireEffects = () =>
            $$('[data-sfx]', root).forEach((b) =>
                b.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const want = b.dataset.sfx === 'true';
                    S = await api('/api/settings', { uiSounds: want });
                    $$('[data-sfx]', root).forEach((x) => x.classList.toggle('on', (x.dataset.sfx === 'true') === want));
                    if (want) sfx.play('select');
                }),
            );
        let s;
        try {
            s = await api('/api/audio');
        } catch (err) {
            if (!paneEl.isConnected) return;
            paneEl.innerHTML = `<h2>Sound</h2><p class="lead">Volume control is not available: ${esc(err.message)}</p>${effectsBox()}`;
            wireEffects();
            return;
        }
        const draw = () => {
            if (!paneEl.isConnected) return;
            paneEl.innerHTML = `<h2>Sound</h2><p class="lead">The phone remote's volume buttons change this too.</p>
              <div class="box"><h4>Volume</h4><div class="vol">
                <button class="f btn" id="vol-down">−</button>
                <div class="meter"><i style="width:${s.muted ? 0 : s.volume}%"></i></div>
                <span class="num">${s.muted ? 'Muted' : `${s.volume}%`}</span>
                <button class="f btn" id="vol-up">+</button>
                <button class="f btn" id="vol-mute">${s.muted ? 'Unmute' : 'Mute'}</button>
              </div></div>
              <div class="box"><h4>Play sound through</h4>${s.outputs
                  .map((o) => `<button class="f option${o.name === s.output ? ' on' : ''}" data-out="${esc(o.name)}" data-key="out:${esc(o.name)}"><span class="radio"></span>${esc(o.description)}</button>`)
                  .join('')}</div>${effectsBox()}`;
            wireEffects();
            const keepFocus = (id) => focusEl($(`#${id}`, root));
            $('#vol-down', root).addEventListener('click', async (e) => {
                e.stopPropagation();
                s = await api('/api/audio', { volume: Math.max(0, s.volume - 5) });
                draw();
                keepFocus('vol-down');
            });
            $('#vol-up', root).addEventListener('click', async (e) => {
                e.stopPropagation();
                s = await api('/api/audio', { volume: Math.min(100, s.volume + 5) });
                draw();
                keepFocus('vol-up');
            });
            $('#vol-mute', root).addEventListener('click', async (e) => {
                e.stopPropagation();
                s = await api('/api/audio', { mute: true });
                draw();
                keepFocus('vol-mute');
            });
            $$('[data-out]', root).forEach((b) =>
                b.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const key = b.dataset.key;
                    s = await api('/api/audio', { output: b.dataset.out });
                    draw();
                    focusEl($(`[data-key="${CSS.escape(key)}"]`, root));
                }),
            );
        };
        draw();
    },
    jellyfin: (root) => {
        $('#jf-out', root)?.addEventListener('click', async (e) => {
            e.stopPropagation();
            await api('/api/jellyfin/signout', {});
            S = await api('/api/state');
            jf = null;
            library.reset();
            showLibraryTab();
            rerenderPane('jellyfin');
            renderHome();
            focusEl($('#jf-url'));
        });
        // Fill in the address of whatever Jellyfin is on the network.
        const foundBox = $('#jf-found', root);
        if (foundBox) {
            api('/api/jellyfin/discover')
                .then(({ servers }) => {
                    if (!foundBox.isConnected) return;
                    const input = $('#jf-url', root);
                    if (!servers.length) {
                        foundBox.textContent = 'No Jellyfin found on your network. Type its address, usually http://<its IP>:8096.';
                        if (!input.value) input.value = `http://${lanHost()}:8096`;
                        return;
                    }
                    if (!input.value) input.value = servers[0].url;
                    foundBox.innerHTML =
                        servers.length === 1
                            ? `Found ${esc(servers[0].name || 'Jellyfin')} at ${esc(servers[0].url)}.`
                            : `Found ${servers.length} Jellyfin servers: ${servers
                                  .map((sv) => `<button class="f btn" data-jf-use="${esc(sv.url)}">${esc(sv.name || sv.url)}</button>`)
                                  .join('')}`;
                    $$('[data-jf-use]', foundBox).forEach((b) =>
                        b.addEventListener('click', (e) => {
                            e.stopPropagation();
                            input.value = b.dataset.jfUse;
                            focusEl($('#jf-user', root));
                        }),
                    );
                })
                .catch(() => {
                    if (foundBox.isConnected) foundBox.textContent = '';
                });
        }
        let signingIn = false;
        $('#jf-in', root)?.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (signingIn) return;
            const err = $('#jf-err', root);
            const btn = $('#jf-in', root);
            err.hidden = true;
            signingIn = true;
            btn.textContent = 'Signing in…';
            try {
                await api('/api/jellyfin/signin', { url: $('#jf-url').value, username: $('#jf-user').value, password: $('#jf-pass').value });
                S = await api('/api/state');
                rerenderPane('jellyfin');
                focusEl($('#jf-out'));
                library.reset();
                showLibraryTab();
                toast('Signed in to Jellyfin');
                loadJellyfin();
            } catch (ex) {
                err.hidden = false;
                err.textContent = ex.message;
                sfx.play('edge');
            } finally {
                signingIn = false;
                if (btn.isConnected) btn.textContent = 'Sign in';
            }
        });
    },
    display: (root) => {
        $('#dev-save', root).addEventListener('click', async (e) => {
            e.stopPropagation();
            S = await api('/api/settings', { deviceName: $('#dev-name').value });
            toast('Saved');
        });
        $$('[data-auto]', root).forEach((b) =>
            b.addEventListener('click', async (e) => {
                e.stopPropagation();
                const want = b.dataset.auto === 'true';
                const err = $('#auto-err', root);
                err.hidden = true;
                try {
                    S = await api('/api/settings', { autostart: want });
                    $$('[data-auto]', root).forEach((x) => x.classList.toggle('on', (x.dataset.auto === 'true') === Boolean(S.autostart)));
                    toast(S.autostart ? 'SimpleTV will open when you sign in' : 'SimpleTV will not open by itself');
                } catch (ex) {
                    err.hidden = false;
                    err.textContent = `Could not change that: ${ex.message}`;
                }
            }),
        );
        $$('[data-scale]', root).forEach((b) =>
            b.addEventListener('click', async (e) => {
                e.stopPropagation();
                S = await api('/api/settings', { siteScale: Number(b.dataset.scale) });
                $$('[data-scale]', root).forEach((x) => x.classList.toggle('on', Number(x.dataset.scale) === Number(S.siteScale)));
                toast('Applying… the screen restarts for a moment');
            }),
        );
        $$('[data-ss]', root).forEach((b) =>
            b.addEventListener('click', async (e) => {
                e.stopPropagation();
                S = await api('/api/settings', { screensaverMinutes: Number(b.dataset.ss) });
                rerenderPane('display');
                focusEl($(`[data-key="ss:${b.dataset.ss}"]`));
            }),
        );
        $('#exit-btn', root)?.addEventListener('click', (e) => {
            e.stopPropagation();
            confirmClose();
        });
    },
    about: async (root) => {
        const box = $('#upd', root);
        const wire = (id, fn) => $(`#${id}`, box)?.addEventListener('click', (e) => {
            e.stopPropagation();
            fn();
        });
        const draw = (html, focusId) => {
            const hadFocus = box.contains(document.activeElement);
            box.innerHTML = html;
            wire('upd-check', check);
            wire('upd-run', run);
            // Only while the selection was in here: a check finishing must not
            // pull it back from wherever it has gone meanwhile.
            if (hadFocus) focusEl($(`#${focusId || 'upd-check'}`, box) || $('.f', box));
        };
        const check = async () => {
            draw('<p class="note" style="margin:0">Checking GitHub for a new version…</p>');
            let u;
            try {
                u = await api('/api/update');
            } catch (err) {
                return draw(`<p class="err" style="margin:0 0 .8rem">Could not check for updates: ${esc(err.message)}</p><button class="f btn" id="upd-check">Try again</button>`);
            }
            S.update = { available: u.available, latestMessage: u.latestMessage, latestDate: u.latestDate };
            showUpdateBadge();
            if (u.progress?.running && u.progress.steps.length) return openUpdateScreen();
            if (!u.available) {
                return draw(`<p class="okmsg" style="margin:0 0 .8rem">SimpleTV is up to date.</p><button class="f btn" id="upd-check">Check for updates</button>`);
            }
            draw(
                `<p style="margin:0 0 .3rem;font-weight:700">A new version is ready.</p>
                 <p class="note" style="margin:0 0 .9rem">${esc(u.latestMessage)}${u.latestDate ? ` · ${new Date(u.latestDate).toLocaleDateString()}` : ''}</p>
                 <button class="f btn primary" id="upd-run">Update now</button><button class="f btn" id="upd-check">Check again</button>
                 <p class="note" style="margin:.8rem 0 0">It takes a few minutes. The screen goes blank for a moment at the end and comes back on the new version.</p>`,
                'upd-run',
            );
        };
        const run = async () => {
            try {
                await api('/api/update', {});
                openUpdateScreen();
            } catch (err) {
                toast(err.message);
            }
        };
        const follow = () => {
            const tick = async () => {
                let p;
                try {
                    p = await api('/api/update/progress');
                } catch {
                    box.innerHTML = '<p class="note" style="margin:0">Restarting on the new version…</p>';
                    return setTimeout(tick, 1500);
                }
                const steps = `<ol class="steps">${p.steps.map((st) => `<li>${esc(st)}</li>`).join('')}</ol>`;
                if (p.running) {
                    box.innerHTML = `<p style="margin:0;font-weight:700">Updating…</p>${steps}`;
                    return setTimeout(tick, 1500);
                }
                if (p.ok) {
                    box.innerHTML = `<p class="okmsg" style="margin:0">Updated. Restarting on the new version…</p>${steps}`;
                    return setTimeout(tick, 3000);
                }
                draw(`<p class="err" style="margin:0">The update did not finish: ${esc(p.error || 'unknown error')}</p>${steps}<button class="f btn" id="upd-check">Check again</button>`);
            };
            tick();
        };
        check();
    },
};

// ========================================================= update screen ==

// Pressing Update now covers everything with this until the update is done:
// a progress bar, the four steps, and the update's own log, live. Nothing
// else can be reached meanwhile. At the end SimpleTV restarts and the page
// comes back on the new version.
const UPDATE_STEPS = ['Downloading the latest version', 'Replacing the files', 'Rebuilding', 'Restarting'];
const updating = { on: false, from: 0, lines: [], timer: null, wasDown: false };

function openUpdateScreen() {
    if (updating.on) return;
    updating.on = true;
    updating.from = 0;
    updating.lines = [];
    updating.wasDown = false;
    closeIfModal();
    $('#update-screen').hidden = false;
    $('#us-actions').hidden = true;
    $('#us-title').textContent = 'Updating SimpleTV';
    $('#us-sub').textContent = 'Please wait. The screen restarts by itself at the end.';
    document.activeElement?.blur?.();
    drawUpdate({ steps: [], running: true });
    pollUpdate();
}

function updatePercent(p) {
    if (p.result === 'ok') return 100;
    const at = UPDATE_STEPS.indexOf(p.steps[p.steps.length - 1]);
    if (at < 0) return 2;
    if (at === 0) return 8;
    if (at === 1) return 22;
    if (at === 3) return 94;
    // Rebuilding is most of the wait: creep on with each build step done.
    const done = updating.lines.filter((l) => /^#\d+ DONE/.test(l)).length;
    return Math.round(30 + 60 * (1 - Math.exp(-done / 14)));
}

function drawUpdate(p) {
    const at = p.steps.length - 1;
    $('#us-steps').innerHTML = UPDATE_STEPS.map((label, i) => {
        let cls = '';
        if (p.result === 'fail' && i === at) cls = 'failed';
        else if (i < at || p.result === 'ok') cls = 'done';
        else if (i === at) cls = 'now';
        return `<li class="${cls}">${esc(label.replace(' the latest version', '').replace(' the files', ' files'))}</li>`;
    }).join('');
    const pct = updatePercent(p);
    $('#us-fill').style.width = `${pct}%`;
    $('#us-pct').textContent = `${pct}%`;
    const box = $('#us-log');
    box.textContent = updating.lines.slice(-400).join('\n');
    box.scrollTop = box.scrollHeight;
}

async function pollUpdate() {
    clearTimeout(updating.timer);
    let p;
    try {
        p = await api('/api/update/progress');
        const log = await api(`/api/update/log?from=${updating.from}`);
        if (log.next < updating.from) updating.from = 0; // a new run started the log again
        if (log.text) {
            const parts = log.text.split('\n');
            if (updating.lines.length && updating.partial) parts[0] = updating.lines.pop() + parts[0];
            updating.partial = !log.text.endsWith('\n');
            updating.lines.push(...parts.filter((l, i) => l || i < parts.length - 1));
        }
        updating.from = log.next;
    } catch {
        // The server is restarting onto the new version.
        updating.wasDown = true;
        $('#us-sub').textContent = 'Restarting on the new version…';
        updating.timer = setTimeout(pollUpdate, 1500);
        return;
    }
    drawUpdate(p);
    if (p.result === 'fail') {
        $('#us-title').textContent = 'The update did not finish';
        $('#us-sub').textContent = p.error || 'Something went wrong. The old version is still running.';
        $('#us-actions').hidden = false;
        focusEl($('#us-close'));
        return;
    }
    if (p.result === 'ok' && updating.wasDown) {
        $('#us-title').textContent = 'Updated';
        $('#us-sub').textContent = 'Loading the new version…';
        setTimeout(() => location.reload(), 1200);
        return;
    }
    if (p.result === 'ok') $('#us-sub').textContent = 'Restarting on the new version…';
    updating.timer = setTimeout(pollUpdate, 1000);
}

$('#us-close').addEventListener('click', (e) => {
    e.stopPropagation();
    updating.on = false;
    $('#update-screen').hidden = true;
    focusEl(defaultFocus());
});

// ============================================================= live data ==

async function loadJellyfin() {
    if (!S.jellyfin.connected) {
        jf = null;
        return renderHome();
    }
    try {
        jf = await api('/api/jellyfin/home');
    } catch {
        jf = null;
    }
    renderHome();
}

function connectEvents() {
    const es = new EventSource('/api/events');
    let wasDown = false;
    es.onopen = () => {
        if (wasDown && sessionStorage.getItem('simpletv-updating')) {
            sessionStorage.removeItem('simpletv-updating');
            location.reload();
        }
    };
    es.onerror = () => {
        wasDown = true;
    };
    es.addEventListener('home', async () => {
        if (updating.on) return;
        await library.exit();
        closeIfModal();
        showView('home', { focus: false });
        goBack();
        if (document.activeElement === document.body) focusEl($('#rows .f'));
    });
    es.addEventListener('search', () => {
        if (updating.on) return;
        closeIfModal();
        showView('search');
    });
    es.addEventListener('text', (e) => {
        idle.reset();
        const { text } = JSON.parse(e.data);
        const t = textTarget();
        if (t) typeInto(t, text);
    });
    es.addEventListener('remotes', async (e) => {
        const d = JSON.parse(e.data);
        S.remotes = d.remotes;
        S.pairCode = d.pairCode;
        rerenderPane('remote');
        renderHome();
    });
    es.addEventListener('update', (e) => {
        S.update = JSON.parse(e.data);
        showUpdateBadge();
        announceUpdate();
    });
    es.addEventListener('controllers', (e) => {
        S.controllers = JSON.parse(e.data).list;
        $('#st-pads').hidden = !S.controllers.length;
        rerenderPane('controllers');
    });
}

function showUpdateBadge() {
    const on = Boolean(S?.update?.available);
    $$('.upd-dot').forEach((d) => (d.hidden = !on));
}

function announceUpdate() {
    if (!S?.update?.available) return;
    const key = `simpletv-update-seen:${S.update.latestDate || S.update.latestMessage}`;
    try {
        if (sessionStorage.getItem(key)) return;
        sessionStorage.setItem(key, '1');
    } catch {
        /* no storage: show it anyway */
    }
    toast('A SimpleTV update is ready: Settings → Updates');
}

function closeIfModal() {
    if (!$('#modal').hidden) closeModal();
    if (moving) stopMoving();
}

// ========================================================== clock, idle ==

function tickClock() {
    const now = new Date();
    $('#clock').textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (screensaver.on) {
        $('#ss-clock').innerHTML = `${esc(now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}<small>${esc(
            now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }),
        )}</small>`;
    }
}

const screensaver = {
    on: false,
    timers: [],
    start() {
        if (this.on) return;
        this.on = true;
        $('#screensaver').hidden = false;
        const pics = [...(jf?.latest || []), ...(jf?.resume || [])].map((i) => i.backdrop).filter(Boolean);
        let i = 0;
        const nextPic = () => {
            const bg = $('#ss-bg');
            bg.style.backgroundImage = pics.length ? `url("${pics[i++ % pics.length]}")` : 'radial-gradient(ellipse at 30% 30%, #1d2a4a, #000 70%)';
        };
        const moveClock = () => {
            const c = $('#ss-clock');
            c.style.left = `${8 + Math.random() * 62}vw`;
            c.style.top = `${10 + Math.random() * 60}vh`;
        };
        nextPic();
        moveClock();
        tickClock();
        this.timers = [setInterval(nextPic, 15000), setInterval(moveClock, 20000)];
    },
    stop() {
        this.on = false;
        $('#screensaver').hidden = true;
        this.timers.forEach(clearInterval);
        idle.reset();
    },
};

const idle = {
    last: Date.now(),
    reset() {
        this.last = Date.now();
    },
    check() {
        const mins = S?.screensaverMinutes || 0;
        if (library.playing()) return this.reset();
        if (mins && !screensaver.on && Date.now() - this.last > mins * 60_000) screensaver.start();
    },
};
document.addEventListener('mousemove', () => {
    idle.reset();
    if (screensaver.on) screensaver.stop();
});

// =========================================================== library ==

const library = setupLibrary({
    api,
    $,
    $$,
    esc,
    focusEl,
    toast,
    sfx,
    showView: (name, opts) => showView(name, opts),
    state: () => S,
    view: () => view,
    defaultFocus: () => defaultFocus(),
    refreshJellyfin: () => loadJellyfin(),
});

function showLibraryTab() {
    $('#tab-library').hidden = !S?.jellyfin?.connected;
}

// ================================================================ start ==

async function start() {
    S = await api('/api/state');
    api('/api/update/progress')
        .then((p) => {
            if (p.running && p.steps.length) return openUpdateScreen();
            if (p.result === 'ok' && p.finished && Date.now() / 1000 - Number(p.finished) < 300) {
                const key = `simpletv-updated:${p.sha}`;
                if (sessionStorage.getItem(key)) return;
                sessionStorage.setItem(key, '1');
                setTimeout(() => toast(`SimpleTV is updated: ${String(p.sha || '').slice(0, 7)}`), 1200);
            }
        })
        .catch(() => {});
    $('#st-pads').hidden = !S.controllers.length;
    $('#close-btn').hidden = S.mode !== 'window';
    showLibraryTab();
    $('#power-btn').hidden = !S.canPower;
    showUpdateBadge();
    setTimeout(announceUpdate, 1500);
    setHero(welcomeHero());
    renderHome();
    showView('home');
    connectEvents();
    loadJellyfin();
    tickClock();
    setInterval(tickClock, 10_000);
    // The screensaver is the server's now: it covers apps too, not only these screens.
    setInterval(() => {
        if (view === 'home' && !screensaver.on) loadJellyfin();
    }, 5 * 60_000);
}

start().catch((err) => {
    document.body.innerHTML = `<p style="padding:4rem;color:#ff8080">SimpleTV could not start: ${esc(err.message)}</p>`;
});
