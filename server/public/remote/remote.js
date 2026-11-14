// SimpleTV phone remote. Pairs once with the six-digit code on the TV, then
// sends every press over a WebSocket.

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const TOKEN_KEY = 'simpletv-remote-token';

// A Home Screen icon opens with the pairing in its address (#t=...), because
// on an iPhone it does not share Safari's storage.
const fromLink = new URLSearchParams(location.hash.slice(1)).get('t');
if (fromLink && /^[A-Za-z0-9_-]{20,100}$/.test(fromLink)) localStorage.setItem(TOKEN_KEY, fromLink);
let token = localStorage.getItem(TOKEN_KEY);
let ws = null;
let retry = 0;
let showing = null;

const buzz = () => navigator.vibrate?.(8);

function guessName() {
    const ua = navigator.userAgent;
    if (/iPad/.test(ua)) return 'iPad';
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/Android/.test(ua)) return 'Android phone';
    return 'Phone';
}

// ============================================================== pairing ==

function showPair(prefill) {
    $('#remote').hidden = true;
    $('#pair').hidden = false;
    $('#pair-name').value ||= guessName();
    if (prefill) $('#pair-code').value = prefill;
    if (prefill && prefill.length === 6) pair();
}

async function pair() {
    const err = $('#pair-err');
    err.hidden = true;
    $('#pair-go').disabled = true;
    try {
        const res = await fetch('/api/pair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: $('#pair-code').value.trim(), name: $('#pair-name').value.trim() }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Pairing failed.');
        token = data.token;
        localStorage.setItem(TOKEN_KEY, token);
        history.replaceState(null, '', location.pathname);
        showRemote();
    } catch (e) {
        err.hidden = false;
        err.textContent = e.message;
    } finally {
        $('#pair-go').disabled = false;
    }
}

$('#pair-go').addEventListener('click', pair);
$('#pair-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
});

// ============================================================ connection ==

function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/api/remote/ws?token=${encodeURIComponent(token)}`);
    ws.onopen = () => {
        retry = 0;
        $('#dot').classList.add('on');
    };
    ws.onclose = async () => {
        $('#dot').classList.remove('on');
        ws = null;
        // Is the token still good? A removed phone has to pair again.
        try {
            const r = await fetch('/api/state', { headers: { Authorization: `Bearer ${token}` } });
            if (r.status === 401) {
                localStorage.removeItem(TOKEN_KEY);
                token = null;
                history.replaceState(null, '', location.pathname);
                $('#manifest').href = 'manifest.webmanifest';
                return showPair();
            }
        } catch {
            /* the TV is off or out of reach; keep trying */
        }
        setTimeout(connect, Math.min(8000, 500 * 2 ** retry++));
    };
    ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.t === 'hello') $('#tv-name').textContent = m.deviceName;
        if (m.t === 'hello' || m.t === 'showing') setShowing(m);
        if (m.t === 'volume') $('#vol-fill').style.width = `${m.muted ? 0 : m.volume}%`;
    };
}

function send(msg) {
    if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
}

function setShowing(m) {
    showing = m;
    const text = !m.screen ? 'TV screen is closed' : m.onHome ? 'Home' : m.app?.name || 'Web';
    $('#showing').textContent = text;
    const pointer = m.app?.nav === 'pointer';
    $('#touch-hint').hidden = !pointer;
}

// =============================================================== presses ==

function press(el, fn) {
    el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        el.classList.add('pressed');
        buzz();
        fn(e);
    });
    const up = () => el.classList.remove('pressed');
    el.addEventListener('pointerup', up);
    el.addEventListener('pointerleave', up);
    el.addEventListener('pointercancel', up);
}

// Directions repeat while held, like a real remote.
$$('.dir').forEach((b) => {
    let t1;
    let t2;
    const stop = () => {
        clearTimeout(t1);
        clearInterval(t2);
    };
    b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        b.classList.add('pressed');
        buzz();
        send({ action: 'key', key: b.dataset.key });
        t1 = setTimeout(() => {
            t2 = setInterval(() => send({ action: 'key', key: b.dataset.key }), 110);
        }, 420);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) {
        b.addEventListener(ev, () => {
            b.classList.remove('pressed');
            stop();
        });
    }
});

// OK: a tap selects, a hold opens the options for what is selected.
{
    const ok = $('#ok');
    let holdTimer;
    let held = false;
    ok.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        ok.classList.add('pressed');
        buzz();
        held = false;
        holdTimer = setTimeout(() => {
            held = true;
            navigator.vibrate?.([10, 40, 10]);
            send({ action: 'key', key: 'menu' });
        }, 550);
    });
    const release = (fire) => {
        ok.classList.remove('pressed');
        clearTimeout(holdTimer);
        if (fire && !held) send({ action: 'key', key: 'enter' });
        held = true;
    };
    ok.addEventListener('pointerup', () => release(true));
    ok.addEventListener('pointerleave', () => release(false));
    ok.addEventListener('pointercancel', () => release(false));
}

$$('.buttons [data-act], .buttons [data-key], .kb-row [data-key]').forEach((b) =>
    press(b, () => {
        if (b.dataset.key) send({ action: 'key', key: b.dataset.key });
        else if (b.dataset.act === 'volume') send({ action: 'volume', step: Number(b.dataset.step) });
        else if (b.dataset.act === 'zoom') send({ action: 'zoom', dir: b.dataset.dir });
        else send({ action: b.dataset.act });
    }),
);

// ================================================================= modes ==

function setMode(mode) {
    $$('#seg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
    $('#mode-buttons').hidden = mode !== 'buttons';
    $('#mode-touch').hidden = mode !== 'touch';
    $('#mode-keys').hidden = mode !== 'keys';
    if (mode === 'keys') {
        const kb = $('#kb');
        kb.value = '';
        last = '';
        kb.focus();
    }
}
$$('#seg button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

// ------------------------------------------------------------- keyboard --

let last = '';
$('#kb').addEventListener('input', (e) => {
    const now = e.target.value;
    // Send only what changed: added letters as text, removed ones as deletes.
    let common = 0;
    while (common < last.length && common < now.length && last[common] === now[common]) common++;
    for (let i = 0; i < last.length - common; i++) send({ action: 'key', key: 'backspace' });
    const added = now.slice(common);
    if (added) send({ action: 'text', text: added });
    last = now;
});
$('#kb').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        send({ action: 'key', key: 'enter' });
        $('#kb').value = '';
        last = '';
    } else if (e.key === 'Backspace' && !$('#kb').value) {
        send({ action: 'key', key: 'backspace' });
    }
});

// ------------------------------------------------------------- touchpad --

// One finger moves the pointer and a tap clicks. Scrolling is one finger on
// the strip down the right edge, like a laptop's touchpad, or two fingers
// anywhere. A gesture keeps the mode it started in until every finger is up,
// so lifting one finger of two never turns the last one into a pointer jump.
{
    const pad = $('#pad');
    const touches = new Map();
    let mode = null; // 'move' | 'scroll' for the gesture under way
    let moved = 0;
    let downAt = 0;
    let pending = { dx: 0, dy: 0, sx: 0, sy: 0 };
    let raf = 0;

    const flush = () => {
        raf = 0;
        if (pending.dx || pending.dy) send({ action: 'move', dx: Math.round(pending.dx), dy: Math.round(pending.dy) });
        if (Math.round(pending.sx) || Math.round(pending.sy)) send({ action: 'scroll', dx: Math.round(pending.sx), dy: Math.round(pending.sy) });
        pending = { dx: 0, dy: 0, sx: 0, sy: 0 };
    };
    const queue = () => {
        if (!raf) raf = requestAnimationFrame(flush);
    };
    const inStrip = (e) => {
        const r = pad.getBoundingClientRect();
        return e.clientX > r.right - r.width * 0.2;
    };

    pad.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        pad.setPointerCapture(e.pointerId);
        touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (touches.size === 1) {
            moved = 0;
            downAt = Date.now();
            mode = inStrip(e) ? 'scroll' : 'move';
        } else {
            mode = 'scroll';
        }
        pad.classList.add('active');
        pad.classList.toggle('scrolling', mode === 'scroll');
    });
    pad.addEventListener('pointermove', (e) => {
        const t = touches.get(e.pointerId);
        if (!t) return;
        const dx = e.clientX - t.x;
        const dy = e.clientY - t.y;
        t.x = e.clientX;
        t.y = e.clientY;
        moved += Math.abs(dx) + Math.abs(dy);
        if (mode === 'scroll') {
            // Every finger reports its own movement; share it out so two
            // fingers scroll as far as one.
            const share = 1 / touches.size;
            // Finger down, page down: like dragging a scroll bar.
            pending.sx += dx * 3 * share;
            pending.sy += dy * 3 * share;
        } else {
            // Faster swipes travel further, so the whole screen is reachable.
            const speed = Math.hypot(dx, dy);
            const gain = 1.6 + Math.min(2.4, speed / 10);
            pending.dx += dx * gain;
            pending.dy += dy * gain;
        }
        queue();
    });
    const end = (e) => {
        if (!touches.delete(e.pointerId)) return;
        if (touches.size) return;
        pad.classList.remove('active', 'scrolling');
        if (mode === 'move' && moved < 10 && Date.now() - downAt < 300) {
            buzz();
            send({ action: 'click' });
        }
        mode = null;
    };
    pad.addEventListener('pointerup', end);
    pad.addEventListener('pointercancel', end);
}

// ================================================================= start ==

function showRemote() {
    $('#pair').hidden = true;
    $('#remote').hidden = false;
    // Whatever gets saved to the Home Screen from here carries the pairing.
    history.replaceState(null, '', `${location.pathname}#t=${token}`);
    $('#manifest').href = `manifest.webmanifest?t=${encodeURIComponent(token)}`;
    homeScreenTip();
    if (!ws) connect();
}

const standalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

function homeScreenTip() {
    if (standalone() || localStorage.getItem('simpletv-a2hs-dismissed')) return;
    const ua = navigator.userAgent;
    let how = '';
    if (/iPhone|iPad|iPod/.test(ua)) how = 'In Safari, tap Share, then “Add to Home Screen”. It opens full-screen, like an app.';
    else if (/Android/.test(ua)) how = 'In Chrome, tap ⋮, then “Add to Home screen”.';
    else return;
    $('#a2hs-how').textContent = how;
    $('#a2hs').hidden = false;
}

$('#a2hs-x').addEventListener('click', () => {
    localStorage.setItem('simpletv-a2hs-dismissed', '1');
    $('#a2hs').hidden = true;
});

const hashCode = new URLSearchParams(location.hash.slice(1)).get('code');
if (hashCode && !token) showPair(hashCode.replace(/\D/g, ''));
else if (token) showRemote();
else showPair();

// Phones suspend pages in the background; reconnect when it comes back.
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && token && !ws) connect();
});
