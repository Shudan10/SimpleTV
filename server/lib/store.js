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
};

let cache = null;

export function load() {
    if (cache) return cache;
    let saved = {};
    try {
        saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch {
        /* first run, or unreadable: start from the defaults */
    }
    cache = { ...structuredClone(DEFAULTS), ...saved };
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
