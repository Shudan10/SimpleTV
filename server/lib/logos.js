/**
 * The apps' own logos for their tiles, as on a smart TV.
 *
 * None are shipped with SimpleTV: each is fetched once, the first time a tile
 * needs it, from Wikimedia Commons (a picture of the file named in the app
 * list), and kept in the data folder from then on. Without the internet, or
 * if Commons has no such file, the tile shows the app's name as before.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from './store.js';

const DIR = path.join(dataDir, 'logos');
const UA = 'SimpleTV/0.1 (https://github.com/Shudan10/SimpleTV)';
const MAX_BYTES = 2 * 1024 * 1024;
const RETRY_AFTER = 60 * 60 * 1000; // a failed fetch is tried again an hour later

const pending = new Map();
const failedAt = new Map();

const fileFor = (id, commonsFile) =>
    path.join(DIR, `${id}-${crypto.createHash('sha1').update(commonsFile).digest('hex').slice(0, 10)}.png`);

/** The logo's picture for an app, fetched if need be; null if there is none. */
export async function get(app) {
    if (!app?.logo) return null;
    const file = fileFor(app.id, app.logo);
    try {
        return fs.readFileSync(file);
    } catch {
        /* not fetched yet */
    }
    if (Date.now() - (failedAt.get(file) || 0) < RETRY_AFTER) return null;
    if (!pending.has(file)) {
        pending.set(
            file,
            fetchLogo(app.logo, file)
                .catch(() => {
                    failedAt.set(file, Date.now());
                    return null;
                })
                .finally(() => pending.delete(file)),
        );
    }
    return pending.get(file);
}

async function fetchLogo(commonsFile, file) {
    const name = encodeURIComponent(commonsFile.replace(/ /g, '_'));
    const res = await fetch(`https://commons.wikimedia.org/wiki/Special:FilePath/${name}?width=480`, {
        headers: { 'User-Agent': UA },
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok || !/^image\/png/.test(res.headers.get('content-type') || '')) throw new Error(`logo: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) throw new Error('logo: bad size');
    fs.mkdirSync(DIR, { recursive: true });
    // Logos fetched for an older pick of file are no longer needed.
    const id = path.basename(file).replace(/-[0-9a-f]{10}\.png$/, '');
    const mine = new RegExp(`^${id.replace(/[^a-z0-9]/gi, '')}-[0-9a-f]{10}\\.png$`);
    for (const old of fs.readdirSync(DIR)) {
        if (old !== path.basename(file) && mine.test(old)) fs.rmSync(path.join(DIR, old), { force: true });
    }
    fs.writeFileSync(`${file}.part`, buf);
    fs.renameSync(`${file}.part`, file);
    return buf;
}
