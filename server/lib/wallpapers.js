/*
 * Photos of the world for the screensaver: Wikimedia Commons' featured
 * pictures of landscapes, mountains, lakes and coasts. They are freely
 * licensed, and each is shown with its title, photographer and licence.
 * The list is fetched once a week and kept on the data volume; the photos
 * themselves load straight from Wikimedia when they are shown.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './store.js';

const FILE = path.join(dataDir, 'wallpapers.json');
const CATEGORIES = ['Featured_pictures_of_landscapes', 'Featured_pictures_of_mountains', 'Featured_pictures_of_lakes', 'Featured_pictures_of_coasts'];
const PER_CATEGORY = 150;
const WEEK = 7 * 24 * 3_600_000;
// Wikimedia asks automated clients to say who they are.
const UA = 'SimpleTV/0.1 (https://github.com/Shudan10/SimpleTV)';

const strip = (html) =>
    String(html || '')
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();

// Credits are sometimes sentences ("This photo was taken by X. Feel free..."):
// the name is what goes on screen.
function credit(a) {
    let c = a.replace(/^.*?(photo|picture|image) (was )?(taken|made) by\s+/i, '').replace(/^Original:\s*/i, '');
    c = c.split(/\.\s|\s+Derivative work:/i)[0];
    return c.slice(0, 60).trim();
}

// Filenames carry dates and camera codes; the place is what is worth showing.
function tidy(t) {
    return t
        .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '')
        .replace(/\b\d{2}-\d{4}\b/g, '')
        .replace(/\b\d{8}\b/g, '')
        .replace(/\b(DD|IMG|DSC|DSCF|DJI|P|_MG)[ _-]?\d+\b/gi, '')
        .replace(/\bimg\d+\b/gi, '')
        .replace(/\((\d+|edit|edited|cropped|)\)/gi, '')
        .replace(/^(19|20)\d{2}\s+/, '')
        .replace(/\s*,\s*(,\s*)+/g, ', ')
        .replace(/\s+/g, ' ')
        .replace(/^[\s,.-]+|[\s,.-]+$/g, '')
        .trim();
}

function niceTitle(file, meta) {
    const named = strip(meta.ObjectName?.value);
    if (named && !/^File:/i.test(named)) return tidy(named);
    return tidy(file.replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' '));
}

async function fetchCategory(cat) {
    const out = [];
    let cont = {};
    while (out.length < PER_CATEGORY) {
        const params = new URLSearchParams({
            action: 'query',
            format: 'json',
            generator: 'categorymembers',
            gcmtitle: `Category:${cat}`,
            gcmtype: 'file',
            gcmlimit: '50',
            prop: 'imageinfo',
            iiprop: 'url|size|mime|extmetadata',
            iiurlwidth: '1920',
            iiextmetadatafilter: 'ObjectName|Artist|LicenseShortName',
            ...cont,
        });
        const res = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) });
        if (!res.ok) break;
        const j = await res.json();
        for (const p of Object.values(j.query?.pages || {})) {
            const ii = p.imageinfo?.[0];
            if (!ii?.thumburl || ii.mime !== 'image/jpeg') continue;
            // Wide pictures only: a TV is wide.
            if (!(ii.width > ii.height * 1.3)) continue;
            const meta = ii.extmetadata || {};
            out.push({
                url: ii.thumburl,
                title: niceTitle(p.title, meta),
                artist: credit(strip(meta.Artist?.value)),
                license: strip(meta.LicenseShortName?.value),
            });
        }
        if (!j.continue) break;
        cont = j.continue;
    }
    return out;
}

let cache = null;

async function list() {
    if (!cache) {
        try {
            cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        } catch {
            cache = { fetchedAt: 0, items: [] };
        }
    }
    if (cache.items.length && Date.now() - cache.fetchedAt < WEEK) return cache.items;
    try {
        const all = (await Promise.all(CATEGORIES.map((c) => fetchCategory(c).catch(() => [])))).flat();
        const seen = new Set();
        const items = all.filter((x) => !seen.has(x.url) && seen.add(x.url));
        if (items.length) {
            cache = { fetchedAt: Date.now(), items };
            fs.writeFileSync(FILE, JSON.stringify(cache));
        }
    } catch {
        /* offline: whatever was kept before will do */
    }
    return cache.items;
}

/** A shuffled handful, for one round of the screensaver. */
export async function pick(n = 30) {
    const items = [...(await list())];
    for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
    }
    return items.slice(0, n);
}

/** Fetches the list in the background, so the first screensaver has it. */
export function warm() {
    list().catch(() => {});
}
