/*
 * The apps SimpleTV knows about. Each is a website opened full-screen in the
 * TV's browser; what makes it feel like an app is how it is driven:
 *
 *   nav    'keys'    the site works with arrow keys and Enter (made for TVs)
 *          'pointer' the site is a desktop site: the remote's touchpad or the
 *                    controller's right stick moves a pointer over it
 *   back   'escape'  the site handles Escape as its own back button
 *          'browser' Back goes back a page, and home from the first one
 *   ua     'tv'      the site is opened as a smart TV would open it, which is
 *                    what gets YouTube's big-screen layout
 *   gamepad          the site reads the controller itself (cloud gaming), so
 *                    SimpleTV stops turning stick and buttons into keys there
 *   hints            the site will not draw without the display client hints
 *                    (viewport size, colour scheme) that Brave holds back, so
 *                    they are sent for it
 *
 * Tiles are drawn from the colours and the name; no logos are shipped.
 */
import * as store from './store.js';

export const TV_UA =
    'Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) 76.0.3809.146/6.0 TV Safari/537.36';

export const CATALOG = [
    { id: 'youtube', name: 'YouTube', url: 'https://www.youtube.com/tv', bg: '#ff0033', fg: '#fff', nav: 'keys', back: 'escape', ua: 'tv', group: 'Video' },
    { id: 'netflix', name: 'Netflix', url: 'https://www.netflix.com/browse', bg: '#000', fg: '#e50914', nav: 'pointer', group: 'Video' },
    { id: 'prime', name: 'Prime Video', url: 'https://www.primevideo.com', bg: '#00a8e1', fg: '#fff', nav: 'pointer', group: 'Video' },
    { id: 'disney', name: 'Disney+', url: 'https://www.disneyplus.com', bg: '#0b1a5c', fg: '#fff', nav: 'pointer', group: 'Video' },
    { id: 'max', name: 'Max', url: 'https://play.max.com', bg: '#002be7', fg: '#fff', nav: 'pointer', group: 'Video' },
    { id: 'hulu', name: 'Hulu', url: 'https://www.hulu.com', bg: '#1ce783', fg: '#0b0c0f', nav: 'pointer', group: 'Video' },
    { id: 'appletv', name: 'Apple TV', url: 'https://tv.apple.com', bg: '#111', fg: '#fff', nav: 'pointer', group: 'Video' },
    { id: 'paramount', name: 'Paramount+', url: 'https://www.paramountplus.com', bg: '#0064ff', fg: '#fff', nav: 'pointer', group: 'Video' },
    { id: 'peacock', name: 'Peacock', url: 'https://www.peacocktv.com', bg: '#000', fg: '#fff', nav: 'pointer', group: 'Video' },
    { id: 'crunchyroll', name: 'Crunchyroll', url: 'https://www.crunchyroll.com', bg: '#f47521', fg: '#fff', nav: 'pointer', group: 'Video' },
    { id: 'tubi', name: 'Tubi', url: 'https://tubitv.com', bg: '#7408ff', fg: '#ffff13', nav: 'pointer', group: 'Free TV' },
    { id: 'pluto', name: 'Pluto TV', url: 'https://pluto.tv/live-tv', bg: '#000', fg: '#fff200', nav: 'pointer', group: 'Free TV' },
    { id: 'twitch', name: 'Twitch', url: 'https://www.twitch.tv', bg: '#9146ff', fg: '#fff', nav: 'pointer', group: 'Video' },
    { id: 'jellyfin', name: 'Jellyfin', url: null, bg: 'linear-gradient(135deg,#aa5cc3,#00a4dc)', fg: '#fff', nav: 'pointer', group: 'Your media' },
    { id: 'plex', name: 'Plex', url: 'https://app.plex.tv/desktop', bg: '#1f1f1f', fg: '#e5a00d', nav: 'pointer', group: 'Your media' },
    { id: 'spotify', name: 'Spotify', url: 'https://open.spotify.com', bg: '#1db954', fg: '#000', nav: 'pointer', group: 'Music' },
    { id: 'ytmusic', name: 'YouTube Music', url: 'https://music.youtube.com', bg: '#000', fg: '#ff0033', nav: 'pointer', group: 'Music' },
    { id: 'xcloud', name: 'Xbox Cloud Gaming', url: 'https://www.xbox.com/play', bg: '#107c10', fg: '#fff', nav: 'pointer', gamepad: true, hints: true, group: 'Games' },
    { id: 'geforcenow', name: 'GeForce NOW', url: 'https://play.geforcenow.com', bg: '#000', fg: '#76b900', nav: 'pointer', gamepad: true, group: 'Games' },
];

const DEFAULTS = { nav: 'pointer', back: 'browser', ua: null, gamepad: false, hints: false };

/** Every app, the hand-added websites included, with Jellyfin's address filled in. */
export function all() {
    const cfg = store.load();
    const builtIn = CATALOG.map((a) => {
        if (a.id !== 'jellyfin') return { ...DEFAULTS, ...a };
        const url = cfg.jellyfin?.url ? `${cfg.jellyfin.url}/web/` : null;
        return { ...DEFAULTS, ...a, url, needsSetup: !url };
    });
    const custom = cfg.custom.map((c) => ({ ...DEFAULTS, ...c, custom: true, group: 'Websites' }));
    return [...builtIn, ...custom];
}

export function find(id) {
    return all().find((a) => a.id === id) || null;
}

/** The app a page belongs to, by its address. */
export function forUrl(url) {
    let host;
    try {
        host = new URL(url).host;
    } catch {
        return null;
    }
    return (
        all().find((a) => {
            if (!a.url) return false;
            try {
                const appHost = new URL(a.url).host;
                return host === appHost || host.endsWith(`.${appHost.replace(/^www\./, '')}`);
            } catch {
                return false;
            }
        }) || null
    );
}

export function normaliseUrl(input) {
    let s = String(input || '').trim();
    if (!s) throw new Error('Enter a web address.');
    if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol)) throw new Error('Only web addresses (http or https) can be added.');
    return u.toString();
}

const PALETTE = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#059669', '#0891b2', '#4f46e5', '#b45309'];

export function addCustom({ name, url }) {
    const clean = normaliseUrl(url);
    const label = String(name || '').trim() || new URL(clean).hostname.replace(/^www\./, '');
    const id = `site-${Date.now().toString(36)}`;
    store.update((cfg) => {
        cfg.custom.push({ id, name: label.slice(0, 40), url: clean, bg: PALETTE[cfg.custom.length % PALETTE.length], fg: '#fff' });
        cfg.pinned.push(id);
    });
    return id;
}

export function removeCustom(id) {
    store.update((cfg) => {
        cfg.custom = cfg.custom.filter((c) => c.id !== id);
        cfg.pinned = cfg.pinned.filter((p) => p !== id);
    });
}

export function setPinned(id, pinned) {
    if (!find(id)) throw new Error('No such app.');
    store.update((cfg) => {
        cfg.pinned = cfg.pinned.filter((p) => p !== id);
        if (pinned) cfg.pinned.push(id);
    });
}

export function move(id, by) {
    store.update((cfg) => {
        const i = cfg.pinned.indexOf(id);
        if (i < 0) return;
        const j = Math.max(0, Math.min(cfg.pinned.length - 1, i + by));
        cfg.pinned.splice(i, 1);
        cfg.pinned.splice(j, 0, id);
    });
}
