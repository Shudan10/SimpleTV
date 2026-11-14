/*
 * Everything SimpleTV remembers, in one JSON file on the data volume. Written to
 * a temporary file and renamed into place, so a power cut mid-write leaves the
 * old settings rather than half of the new ones.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = process.env.DATA_DIR || '/data';
const FILE = path.join(DATA_DIR, 'config.json');

const DEFAULTS = {
    // Apps on the home screen, in order.
    pinned: ['youtube', 'netflix', 'prime', 'disney', 'jellyfin', 'spotify', 'twitch', 'plex'],
    // Websites added by hand: { id, name, url, color }.
    custom: [],
    jellyfin: null, // { url, serverId, userId, userName, token }
    remotes: [], // paired phones: { id, name, tokenHash, added, lastSeen }
    deviceId: null,
    deviceName: 'SimpleTV',
    screensaverMinutes: 10,
    uiSounds: true, // the clicks and chimes on the home screen
    siteScale: 1, // Website size: 0.85 smaller, 1 standard, 1.15 larger
};

let cache = null;

export function load() {
    if (cache) return cache;
    let saved = {};
    try {
        saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('not settings');
    } catch (err) {
        saved = {};
        // First run: nothing there. Anything else is a damaged file, kept
        // next to the new one so the paired phones and Jellyfin sign-in in
        // it are not lost for good.
        if (err.code !== 'ENOENT') {
            const aside = `${FILE}.bad-${Date.now()}`;
            try {
                fs.renameSync(FILE, aside);
                console.error(`config.json could not be read (${err.message}); kept it as ${path.basename(aside)}`);
            } catch {
                /* unreadable and unmovable: the defaults will do */
            }
        }
    }
    cache = { ...structuredClone(DEFAULTS), ...saved };
    // Each setting the shape the rest of SimpleTV expects, or its default.
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (Array.isArray(v) && !Array.isArray(cache[k])) cache[k] = structuredClone(v);
        else if (typeof v === 'number' && typeof cache[k] !== 'number') cache[k] = v;
        else if (typeof v === 'boolean' && typeof cache[k] !== 'boolean') cache[k] = v;
        else if (typeof v === 'string' && typeof cache[k] !== 'string') cache[k] = v;
    }
    if (cache.jellyfin !== null && typeof cache.jellyfin !== 'object') cache.jellyfin = null;
    if (!cache.deviceId) {
        cache.deviceId = crypto.randomUUID();
        save();
    }
    return cache;
}

export function save() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, FILE);
}

export function update(fn) {
    fn(load());
    save();
    return cache;
}

export const dataDir = DATA_DIR;
