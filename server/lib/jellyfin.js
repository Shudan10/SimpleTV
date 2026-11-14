/*
 * Jellyfin, for the rows on the home screen: what you were watching, what is
 * next in a show, and what was just added. Signing in here stores a token for
 * those rows only; playing opens Jellyfin's own web player, which keeps its
 * own sign-in.
 */
import * as store from './store.js';

const VERSION = '0.1.0';

function authHeader(token) {
    const cfg = store.load();
    const parts = [`Client="SimpleTV"`, `Device="${cfg.deviceName.replace(/"/g, '')}"`, `DeviceId="${cfg.deviceId}"`, `Version="${VERSION}"`];
    if (token) parts.push(`Token="${token}"`);
    return `MediaBrowser ${parts.join(', ')}`;
}

async function call(base, path, { token, method = 'GET', body } = {}) {
    const res = await fetch(`${base}${path}`, {
        method,
        headers: { Authorization: authHeader(token), 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401) throw Object.assign(new Error('Jellyfin did not accept that user name and password.'), { status: 401 });
    if (!res.ok) throw Object.assign(new Error(`Jellyfin answered ${res.status}.`), { status: res.status });
    return res.status === 204 ? null : res.json();
}

export function cleanUrl(input) {
    let s = String(input || '').trim().replace(/\/+$/, '');
    if (!s) throw new Error('Enter the address of your Jellyfin server.');
    if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
    const u = new URL(s);
    // People paste the address of the web app; the server is one level up.
    return `${u.origin}${u.pathname.replace(/\/web(\/.*)?$/, '').replace(/\/+$/, '')}`;
}

export async function signIn({ url, username, password }) {
    const base = cleanUrl(url);
    let info;
    try {
        info = await call(base, '/System/Info/Public');
    } catch (err) {
        throw new Error(`Could not reach Jellyfin at ${base}. ${err.status ? '' : 'Check the address and that it is running.'}`.trim());
    }
    const auth = await call(base, '/Users/AuthenticateByName', {
        method: 'POST',
        body: { Username: String(username || ''), Pw: String(password || '') },
    });
    store.update((cfg) => {
        cfg.jellyfin = {
            url: base,
            serverId: auth.ServerId || info.Id,
            serverName: info.ServerName,
            userId: auth.User.Id,
            userName: auth.User.Name,
            token: auth.AccessToken,
        };
        if (!cfg.pinned.includes('jellyfin')) cfg.pinned.push('jellyfin');
    });
    return status();
}

export async function signOut() {
    const jf = store.load().jellyfin;
    if (jf) await call(jf.url, '/Sessions/Logout', { method: 'POST', token: jf.token }).catch(() => {});
    store.update((cfg) => {
        cfg.jellyfin = null;
    });
}

export function status() {
    const jf = store.load().jellyfin;
    return jf ? { connected: true, url: jf.url, serverName: jf.serverName, userName: jf.userName } : { connected: false };
}

function img(base, id, type, tag, width, index = '') {
    if (!id) return null;
    const path = index !== '' ? `${type}/${index}` : type;
    return `${base}/Items/${id}/Images/${path}?maxWidth=${width}&quality=85${tag ? `&tag=${tag}` : ''}`;
}

function card(base, it) {
    const isEpisode = it.Type === 'Episode';
    const landscape =
        (isEpisode && it.ImageTags?.Primary && img(base, it.Id, 'Primary', it.ImageTags.Primary, 640)) ||
        (it.ImageTags?.Thumb && img(base, it.Id, 'Thumb', it.ImageTags.Thumb, 640)) ||
        (it.ParentThumbItemId && img(base, it.ParentThumbItemId, 'Thumb', it.ParentThumbImageTag, 640)) ||
        (it.BackdropImageTags?.length && img(base, it.Id, 'Backdrop', it.BackdropImageTags[0], 640, 0)) ||
        (it.ParentBackdropItemId && img(base, it.ParentBackdropItemId, 'Backdrop', it.ParentBackdropImageTags?.[0], 640, 0)) ||
        (it.ImageTags?.Primary && img(base, it.Id, 'Primary', it.ImageTags.Primary, 640)) ||
        null;
    const backdrop =
        (it.BackdropImageTags?.length && img(base, it.Id, 'Backdrop', it.BackdropImageTags[0], 1920, 0)) ||
        (it.ParentBackdropItemId && img(base, it.ParentBackdropItemId, 'Backdrop', it.ParentBackdropImageTags?.[0], 1920, 0)) ||
        null;
    let subtitle = '';
    if (isEpisode) {
        const se = it.ParentIndexNumber != null && it.IndexNumber != null ? `S${it.ParentIndexNumber}:E${it.IndexNumber} · ` : '';
        subtitle = `${se}${it.Name}`;
    } else if (it.ProductionYear) subtitle = String(it.ProductionYear);
    return {
        id: it.Id,
        title: isEpisode ? it.SeriesName || it.Name : it.Name,
        subtitle,
        type: it.Type,
        overview: it.Overview || '',
        progress: it.UserData?.PlayedPercentage ? Math.round(it.UserData.PlayedPercentage) : 0,
        image: landscape,
        backdrop,
    };
}

const FIELDS = 'fields=Overview,PrimaryImageAspectRatio&enableImageTypes=Primary,Backdrop,Thumb&imageTypeLimit=1';

/** Tries the current API path, then the one servers before 10.9 used. */
async function either(jf, current, older) {
    try {
        return await call(jf.url, current, { token: jf.token });
    } catch (err) {
        if (err.status !== 404) throw err;
        return call(jf.url, older, { token: jf.token });
    }
}

export async function home() {
    const jf = store.load().jellyfin;
    if (!jf) return null;
    const u = jf.userId;
    const [resume, nextUp, latest] = await Promise.all([
        either(jf, `/UserItems/Resume?userId=${u}&limit=12&mediaTypes=Video&${FIELDS}`, `/Users/${u}/Items/Resume?limit=12&mediaTypes=Video&${FIELDS}`),
        call(jf.url, `/Shows/NextUp?userId=${u}&limit=12&${FIELDS}`, { token: jf.token }).catch(() => ({ Items: [] })),
        either(jf, `/Items/Latest?userId=${u}&limit=16&includeItemTypes=Movie,Series&${FIELDS}`, `/Users/${u}/Items/Latest?limit=16&includeItemTypes=Movie,Series&${FIELDS}`),
    ]);
    const map = (list) => (list || []).map((it) => card(jf.url, it));
    // Next up repeats what is already in Continue watching for a show in progress.
    const resumeIds = new Set((resume.Items || []).map((i) => i.SeriesId || i.Id));
    return {
        resume: map(resume.Items),
        nextUp: map((nextUp.Items || []).filter((i) => !resumeIds.has(i.SeriesId))),
        latest: map(Array.isArray(latest) ? latest : latest.Items),
    };
}

export async function search(q) {
    const jf = store.load().jellyfin;
    if (!jf || !q) return [];
    const r = await call(
        jf.url,
        `/Items?userId=${jf.userId}&searchTerm=${encodeURIComponent(q)}&recursive=true&includeItemTypes=Movie,Series,Episode&limit=30&${FIELDS}`,
        { token: jf.token },
    );
    return (r.Items || []).map((it) => card(jf.url, it));
}

export function playUrl(id) {
    const jf = store.load().jellyfin;
    if (!jf) throw new Error('Jellyfin is not set up.');
    return `${jf.url}/web/#/details?id=${encodeURIComponent(id)}`;
}
