/*
 * Phones paired as remotes. The TV shows a six-digit code (and a QR code
 * carrying it); a phone that sends it back gets a long random token it keeps,
 * and only a hash of that token is stored here. The code changes after every
 * pairing and every ten minutes, and wrong guesses are rate-limited, so
 * somebody else on the network cannot simply walk in.
 */
import crypto from 'node:crypto';
import * as store from './store.js';

let code = null;
let codeSetAt = 0;
let failures = [];

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

export function currentCode() {
    if (!code || Date.now() - codeSetAt > 10 * 60_000) rotate();
    return code;
}

export function rotate() {
    code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    codeSetAt = Date.now();
    return code;
}

export function pair(given, name) {
    const now = Date.now();
    failures = failures.filter((t) => now - t < 60_000);
    if (failures.length >= 8) throw Object.assign(new Error('Too many wrong codes. Wait a minute and try again.'), { status: 429 });
    const want = currentCode();
    const ok = typeof given === 'string' && given.length === want.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want));
    if (!ok) {
        failures.push(now);
        throw Object.assign(new Error('That code is not the one on the TV.'), { status: 403 });
    }
    rotate();
    const token = crypto.randomBytes(32).toString('base64url');
    const remote = {
        id: crypto.randomUUID(),
        name: String(name || 'Phone').trim().slice(0, 40) || 'Phone',
        tokenHash: hash(token),
        added: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
    };
    store.update((cfg) => {
        cfg.remotes.push(remote);
    });
    return { token, remote: publicView(remote) };
}

export function verify(token) {
    if (!token || typeof token !== 'string') return null;
    const h = hash(token);
    const r = store.load().remotes.find((x) => x.tokenHash === h);
    if (!r) return null;
    // Written at most once an hour, not on every button press.
    if (Date.now() - Date.parse(r.lastSeen) > 3_600_000) {
        store.update(() => {
            r.lastSeen = new Date().toISOString();
        });
    }
    return r;
}

const publicView = (r) => ({ id: r.id, name: r.name, added: r.added, lastSeen: r.lastSeen });

export function list() {
    return store.load().remotes.map(publicView);
}

export function revoke(id) {
    store.update((cfg) => {
        cfg.remotes = cfg.remotes.filter((r) => r.id !== id);
    });
}
