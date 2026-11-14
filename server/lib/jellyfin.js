/*
 * Jellyfin, built into SimpleTV: the rows on the home screen, the library
 * screens, and the player. Signing in here is the only sign-in; everything is
 * asked of the Jellyfin server with that token.
 */
import dgram from 'node:dgram';
import * as store from './store.js';
import { lanAddress } from './net.js';

const VERSION = '0.1.0';

function authHeader(token) {
    const cfg = store.load();
    // Encoded as Jellyfin's own apps do: a header can only carry plain
    // letters, and a TV named in Cyrillic or with an emoji would otherwise
    // stop every request.
    const enc = (v) => encodeURIComponent(String(v ?? ''));
    const parts = [`Client="SimpleTV"`, `Device="${enc(cfg.deviceName)}"`, `DeviceId="${enc(cfg.deviceId)}"`, `Version="${VERSION}"`];
    if (token) parts.push(`Token="${enc(token)}"`);
    return `MediaBrowser ${parts.join(', ')}`;
}

async function call(base, path, { token, method = 'GET', body, timeoutMs = 8000 } = {}) {
    const res = await fetch(`${base}${path}`, {
        method,
        headers: { Authorization: authHeader(token), 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
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

// ------------------------------------------------------------ finding it --

let found = null;
let foundAt = 0;

/** Jellyfin's own discovery: a UDP broadcast that servers answer, when they are allowed to. */
function broadcast(ms) {
    return new Promise((resolve) => {
        const out = [];
        let sock;
        try {
            sock = dgram.createSocket('udp4');
        } catch {
            return resolve(out);
        }
        sock.on('error', () => {});
        sock.on('message', (msg) => {
            try {
                const j = JSON.parse(msg.toString());
                if (j.Address) out.push({ url: cleanUrl(j.Address), name: j.Name || '', id: j.Id || j.Address });
            } catch {
                /* not a Jellyfin answer */
            }
        });
        sock.bind(() => {
            try {
                sock.setBroadcast(true);
                sock.send('who is JellyfinServer?', 7359, '255.255.255.255');
            } catch {
                /* no broadcast here */
            }
        });
        setTimeout(() => {
            sock.close();
            resolve(out);
        }, ms);
    });
}

/**
 * Asks every address on this machine's /24 for Jellyfin's public info on its
 * usual port. Discovery alone misses servers in Docker (Quick Start Home
 * publishes only 8096), and this takes about a second.
 */
async function probe() {
    const me = lanAddress();
    const m = me.match(/^(\d+\.\d+\.\d+)\.\d+$/);
    if (!m) return [];
    const hosts = [];
    for (let i = 1; i < 255; i++) hosts.push(`${m[1]}.${i}`);
    const results = await Promise.all(
        hosts.map(async (h) => {
            const url = `http://${h}:8096`;
            try {
                const res = await fetch(`${url}/System/Info/Public`, { signal: AbortSignal.timeout(1200) });
                if (!res.ok) return null;
                const j = await res.json();
                return j?.ProductName?.includes('Jellyfin') || j?.Id ? { url, name: j.ServerName || '', id: j.Id || url } : null;
            } catch {
                return null;
            }
        }),
    );
    return results.filter(Boolean);
}

/** Jellyfin servers on the home network, remembered for a minute. */
export async function discover() {
    if (found && Date.now() - foundAt < 60_000) return found;
    const [a, b] = await Promise.all([broadcast(1500), probe()]);
    const seen = new Map();
    for (const s of [...a, ...b]) if (!seen.has(s.id)) seen.set(s.id, { url: s.url, name: s.name });
    found = [...seen.values()];
    foundAt = Date.now();
    return found;
}

export async function signIn({ url, username, password }) {
    const base = cleanUrl(url);
    let info;
    try {
        info = await call(base, '/System/Info/Public', { timeoutMs: 4000 });
    } catch (err) {
        throw new Error(`Could not reach Jellyfin at ${base}.${err.status ? '' : ' Check the address, and that Jellyfin is running.'}`);
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

// ------------------------------------------------- library and playback --
//
// SimpleTV's own Jellyfin screens: libraries, a details page, seasons and
// episodes, and its own player. The stream comes straight from Jellyfin to
// the TV's browser; this only asks Jellyfin for the right address and passes
// on where the viewer is, so Continue watching stays right everywhere.

function jfOrThrow() {
    const jf = store.load().jellyfin;
    if (!jf) throw Object.assign(new Error('Jellyfin is not set up. Sign in under Settings → Jellyfin.'), { status: 400 });
    return jf;
}

const ID_RE = /^[a-f0-9-]{32,36}$/i;
function checkId(id) {
    if (!ID_RE.test(String(id || ''))) throw Object.assign(new Error('That is not a Jellyfin item.'), { status: 400 });
    return String(id);
}

const TICKS = 10_000_000; // Jellyfin counts time in 100-nanosecond ticks

function poster(base, it) {
    if (it.ImageTags?.Primary) return img(base, it.Id, 'Primary', it.ImageTags.Primary, 400);
    if (it.SeriesId && it.SeriesPrimaryImageTag) return img(base, it.SeriesId, 'Primary', it.SeriesPrimaryImageTag, 400);
    return null;
}

function tile(base, it) {
    return {
        ...card(base, it),
        poster: poster(base, it),
        year: it.ProductionYear || null,
        played: Boolean(it.UserData?.Played),
        unplayed: it.UserData?.UnplayedItemCount ?? null,
        resumeTicks: it.UserData?.PlaybackPositionTicks || 0,
    };
}

const LIST_FIELDS = 'fields=Overview,PrimaryImageAspectRatio,ProductionYear&enableImageTypes=Primary,Backdrop,Thumb,Logo&imageTypeLimit=1&enableUserData=true';
const SHOWN_LIBRARIES = new Set(['movies', 'tvshows', 'homevideos', 'musicvideos', 'boxsets', 'mixed']);

/** The libraries worth showing on a TV: films, shows and home videos. */
export async function views() {
    const jf = jfOrThrow();
    const r = await either(jf, `/UserViews?userId=${jf.userId}`, `/Users/${jf.userId}/Views`);
    return (r.Items || [])
        .map((v) => ({ id: v.Id, name: v.Name, type: v.CollectionType || 'mixed' }))
        .filter((v) => SHOWN_LIBRARIES.has(v.type));
}

const TYPES_FOR = {
    movies: 'Movie',
    tvshows: 'Series',
    homevideos: 'Video,Movie',
    musicvideos: 'MusicVideo',
    boxsets: 'BoxSet',
    mixed: 'Movie,Series,Video',
};
const SORTS = {
    name: 'sortBy=SortName&sortOrder=Ascending',
    added: 'sortBy=DateCreated,SortName&sortOrder=Descending',
    year: 'sortBy=ProductionYear,SortName&sortOrder=Descending',
};

export async function items({ parentId, type = 'mixed', sort = 'name', start = 0, limit = 60 }) {
    const jf = jfOrThrow();
    const q = [
        `userId=${jf.userId}`,
        `parentId=${checkId(parentId)}`,
        'recursive=true',
        `includeItemTypes=${TYPES_FOR[type] || TYPES_FOR.mixed}`,
        SORTS[sort] || SORTS.name,
        `startIndex=${Math.max(0, Number(start) || 0)}`,
        `limit=${Math.min(120, Math.max(1, Number(limit) || 60))}`,
        LIST_FIELDS,
    ].join('&');
    const r = await call(jf.url, `/Items?${q}`, { token: jf.token });
    return { total: r.TotalRecordCount || 0, items: (r.Items || []).map((it) => tile(jf.url, it)) };
}

async function getItem(jf, id) {
    return either(jf, `/Items/${id}?userId=${jf.userId}`, `/Users/${jf.userId}/Items/${id}`);
}

function episodeLabel(it) {
    const se = it.ParentIndexNumber != null && it.IndexNumber != null ? `S${it.ParentIndexNumber}:E${it.IndexNumber}` : '';
    return [se, it.Name].filter(Boolean).join(' · ');
}

export async function detail(id) {
    const jf = jfOrThrow();
    const it = await getItem(jf, checkId(id));
    const base = jf.url;
    const out = {
        id: it.Id,
        type: it.Type,
        name: it.Type === 'Episode' ? it.SeriesName || it.Name : it.Name,
        episodeLabel: it.Type === 'Episode' ? episodeLabel(it) : '',
        overview: it.Overview || '',
        year: it.ProductionYear || null,
        rating: it.OfficialRating || '',
        score: it.CommunityRating ? Math.round(it.CommunityRating * 10) / 10 : null,
        minutes: it.RunTimeTicks ? Math.round(it.RunTimeTicks / TICKS / 60) : null,
        genres: (it.Genres || []).slice(0, 3),
        backdrop:
            (it.BackdropImageTags?.length && img(base, it.Id, 'Backdrop', it.BackdropImageTags[0], 1920, 0)) ||
            (it.ParentBackdropItemId && img(base, it.ParentBackdropItemId, 'Backdrop', it.ParentBackdropImageTags?.[0], 1920, 0)) ||
            null,
        logo:
            (it.ImageTags?.Logo && img(base, it.Id, 'Logo', it.ImageTags.Logo, 800)) ||
            (it.ParentLogoItemId && img(base, it.ParentLogoItemId, 'Logo', it.ParentLogoImageTag, 800)) ||
            null,
        poster: poster(base, it),
        played: Boolean(it.UserData?.Played),
        resumeTicks: it.UserData?.PlaybackPositionTicks || 0,
        progress: it.UserData?.PlayedPercentage ? Math.round(it.UserData.PlayedPercentage) : 0,
        seriesId: it.SeriesId || (it.Type === 'Series' ? it.Id : null),
        seasonId: it.SeasonId || null,
    };
    if (it.Type === 'Series' || it.Type === 'Season' || it.Type === 'Episode') {
        const seriesId = out.seriesId;
        const [seasons, next] = await Promise.all([
            call(base, `/Shows/${seriesId}/Seasons?userId=${jf.userId}&enableUserData=true`, { token: jf.token }),
            it.Type === 'Series'
                ? call(base, `/Shows/NextUp?userId=${jf.userId}&seriesId=${seriesId}&limit=1&enableUserData=true`, { token: jf.token }).catch(() => ({ Items: [] }))
                : { Items: [] },
        ]);
        out.seasons = (seasons.Items || []).map((s) => ({ id: s.Id, name: s.Name, index: s.IndexNumber ?? null, unplayed: s.UserData?.UnplayedItemCount ?? null }));
        const n = next.Items?.[0];
        if (n) out.next = { id: n.Id, label: episodeLabel(n), resumeTicks: n.UserData?.PlaybackPositionTicks || 0 };
        if (it.Type === 'Season') out.seasonId = it.Id;
    }
    return out;
}

export async function episodes({ seriesId, seasonId }) {
    const jf = jfOrThrow();
    const q = `userId=${jf.userId}&seasonId=${checkId(seasonId)}&fields=Overview,PrimaryImageAspectRatio&enableUserData=true&enableImageTypes=Primary,Thumb,Backdrop&imageTypeLimit=1`;
    const r = await call(jf.url, `/Shows/${checkId(seriesId)}/Episodes?${q}`, { token: jf.token });
    return (r.Items || []).map((it) => ({
        ...tile(jf.url, it),
        index: it.IndexNumber ?? null,
        name: it.Name,
        label: episodeLabel(it),
        minutes: it.RunTimeTicks ? Math.round(it.RunTimeTicks / TICKS / 60) : null,
    }));
}

function withKey(url, token) {
    return /[?&](api_key|ApiKey)=/i.test(url) ? url : `${url}${url.includes('?') ? '&' : '?'}api_key=${encodeURIComponent(token)}`;
}

/**
 * Asks Jellyfin how this TV should play an item. The page sends what its
 * browser can play (the device profile); Jellyfin answers with either the
 * file itself, or a stream it converts on the fly into something it can.
 */
export async function play({ id, profile, audioIndex, subtitleIndex, startTicks, resume }) {
    const jf = jfOrThrow();
    checkId(id);
    if (!profile || typeof profile !== 'object') throw Object.assign(new Error('No device profile.'), { status: 400 });
    const it = await getItem(jf, id);
    const body = {
        UserId: jf.userId,
        DeviceProfile: profile,
        MaxStreamingBitrate: 140_000_000,
        AutoOpenLiveStream: true,
        EnableDirectPlay: true,
        EnableDirectStream: true,
        EnableTranscoding: true,
        AllowVideoStreamCopy: true,
        AllowAudioStreamCopy: true,
    };
    if (Number.isInteger(audioIndex)) body.AudioStreamIndex = audioIndex;
    if (Number.isInteger(subtitleIndex)) body.SubtitleStreamIndex = subtitleIndex;
    const info = await call(jf.url, `/Items/${id}/PlaybackInfo?userId=${jf.userId}`, { token: jf.token, method: 'POST', body, timeoutMs: 20_000 });
    const ms = info.MediaSources?.[0];
    if (!ms) throw new Error('Jellyfin did not offer a way to play this.');

    let url;
    let mode;
    let offsetTicks = 0;
    if (ms.SupportsDirectPlay && !Number.isInteger(subtitleIndex) && !Number.isInteger(audioIndex)) {
        url = `${jf.url}/Videos/${id}/stream?static=true&mediaSourceId=${encodeURIComponent(ms.Id)}&playSessionId=${encodeURIComponent(info.PlaySessionId)}`;
        mode = 'DirectPlay';
    } else if (ms.TranscodingUrl) {
        url = `${jf.url}${ms.TranscodingUrl}`;
        mode = 'Transcode';
        // A film converted as one plain file cannot be skipped through: it
        // is converted from where it is to start, and the TV counts its
        // clock from there.
        const start = Math.max(0, Math.floor(Number(startTicks ?? (resume ? it.UserData?.PlaybackPositionTicks : 0)) || 0));
        if (start && !/\.m3u8(\?|$)/.test(url)) {
            const u = new URL(url);
            u.searchParams.set('StartTimeTicks', String(start));
            url = u.toString();
            offsetTicks = start;
        }
    } else if (ms.SupportsDirectPlay || ms.SupportsDirectStream) {
        url = `${jf.url}/Videos/${id}/stream?static=true&mediaSourceId=${encodeURIComponent(ms.Id)}&playSessionId=${encodeURIComponent(info.PlaySessionId)}`;
        mode = 'DirectPlay';
    } else {
        throw new Error('Jellyfin cannot convert this one for the TV.');
    }

    const streams = ms.MediaStreams || [];
    const audio = streams
        .filter((s) => s.Type === 'Audio')
        .map((s) => ({ index: s.Index, label: s.DisplayTitle || s.Language || `Track ${s.Index}` }));
    const subs = streams
        .filter((s) => s.Type === 'Subtitle')
        .map((s) => ({
            index: s.Index,
            label: s.DisplayTitle || s.Language || `Subtitles ${s.Index}`,
            // Text subtitles are fetched as WebVTT and drawn by the browser;
            // picture-based ones (Blu-ray PGS) have to be burned in.
            // Fetched through SimpleTV's own server: the TV's browser will not
            // load subtitles from another address unless Jellyfin allows it.
            url: s.DeliveryMethod === 'External' && s.DeliveryUrl ? `/api/jf/sub?path=${encodeURIComponent(s.DeliveryUrl.split('?')[0])}` : null,
        }));

    let next = null;
    if (it.Type === 'Episode' && it.SeriesId) {
        const r = await call(jf.url, `/Shows/${it.SeriesId}/Episodes?userId=${jf.userId}&startItemId=${id}&limit=2`, { token: jf.token }).catch(() => null);
        const n = r?.Items?.[1];
        if (n) next = { id: n.Id, label: episodeLabel(n) };
    }

    return {
        url: withKey(url, jf.token),
        mode,
        hls: /\.m3u8(\?|$)/.test(url),
        // Where the stream starts in the film, when it does not start at 0.
        offsetTicks,
        playSessionId: info.PlaySessionId,
        mediaSourceId: ms.Id,
        durationTicks: ms.RunTimeTicks || it.RunTimeTicks || 0,
        resumeTicks: it.UserData?.PlaybackPositionTicks || 0,
        audio,
        audioIndex: Number.isInteger(audioIndex) ? audioIndex : ms.DefaultAudioStreamIndex ?? null,
        subs,
        subtitleIndex: Number.isInteger(subtitleIndex) ? subtitleIndex : null,
        title: it.Type === 'Episode' ? it.SeriesName || it.Name : it.Name,
        subtitle: it.Type === 'Episode' ? episodeLabel(it) : it.ProductionYear ? String(it.ProductionYear) : '',
        type: it.Type,
        next,
    };
}

const SUB_PATH = /^\/Videos\/[A-Za-z0-9-]+\/[A-Za-z0-9-]+\/Subtitles\/\d+\/\d+\/Stream\.vtt$/;

/** A subtitle file, as WebVTT, from Jellyfin. */
export async function subtitle(path) {
    const jf = jfOrThrow();
    if (!SUB_PATH.test(String(path || ''))) throw Object.assign(new Error('Not a subtitle.'), { status: 400 });
    const res = await fetch(`${jf.url}${path}`, { headers: { Authorization: authHeader(jf.token) }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw Object.assign(new Error(`Jellyfin answered ${res.status}.`), { status: res.status });
    return res.text();
}

// ------------------------------------------------- subtitles from online --
// Jellyfin searches and downloads them itself, through a subtitle plugin
// installed on the Jellyfin server (OpenSubtitles, usually). Without one, a
// search simply finds nothing.

const LANG_RE = /^[a-z]{3}$/;

function subtitleError(err) {
    if (err.status === 403 || err.status === 401) {
        return Object.assign(new Error('Your Jellyfin user may not download subtitles. In Jellyfin: Dashboard, Users, your user, tick "Allow subtitle management".'), { status: 403 });
    }
    return err;
}

const subtitleStreams = (it) => (it.MediaStreams || it.MediaSources?.[0]?.MediaStreams || []).filter((s) => s.Type === 'Subtitle');

/** Subtitles Jellyfin can find online for an item, in a language (ISO 639-2, like "eng"). */
export async function findSubtitles(id, language) {
    const jf = jfOrThrow();
    const lang = LANG_RE.test(String(language || '')) ? String(language) : 'eng';
    let list;
    try {
        list = await call(jf.url, `/Items/${checkId(id)}/RemoteSearch/Subtitles/${lang}?isPerfectMatch=false`, { token: jf.token, timeoutMs: 30_000 });
    } catch (err) {
        throw subtitleError(err);
    }
    return (list || []).slice(0, 25).map((s) => ({
        id: String(s.Id || ''),
        name: String(s.Name || 'Subtitles').slice(0, 120),
        provider: s.ProviderName || '',
        downloads: Number(s.DownloadCount) || 0,
        exact: Boolean(s.IsHashMatch),
    }));
}

/** Downloads one of those into Jellyfin; answers the new subtitle track's index. */
export async function downloadSubtitle(id, subtitleId) {
    const jf = jfOrThrow();
    checkId(id);
    const sid = String(subtitleId || '');
    if (!sid || sid.length > 400) throw Object.assign(new Error('Pick subtitles from the list.'), { status: 400 });
    const before = new Set(subtitleStreams(await getItem(jf, id)).map((s) => s.Index));
    try {
        await call(jf.url, `/Items/${id}/RemoteSearch/Subtitles/${encodeURIComponent(sid)}`, { token: jf.token, method: 'POST', timeoutMs: 60_000 });
    } catch (err) {
        throw subtitleError(err);
    }
    // Jellyfin adds the file to the film a moment after saving it.
    for (let i = 0; i < 12; i++) {
        const added = subtitleStreams(await getItem(jf, id)).filter((s) => !before.has(s.Index));
        if (added.length) return { index: Math.max(...added.map((s) => s.Index)) };
        await new Promise((r) => setTimeout(r, 1000));
    }
    throw Object.assign(new Error('Jellyfin downloaded them but has not added them yet. Try Subtitles again in a moment.'), { status: 504 });
}

/** Where the viewer is, so Jellyfin's Continue watching and Played stay right. */
export async function report(event, r) {
    const jf = jfOrThrow();
    const body = {
        ItemId: checkId(r.id),
        MediaSourceId: r.mediaSourceId,
        PlaySessionId: r.playSessionId,
        PositionTicks: Math.max(0, Math.round(Number(r.positionTicks) || 0)),
        IsPaused: Boolean(r.paused),
        CanSeek: true,
        PlayMethod: r.mode === 'Transcode' ? 'Transcode' : 'DirectPlay',
    };
    if (Number.isInteger(r.audioIndex)) body.AudioStreamIndex = r.audioIndex;
    if (Number.isInteger(r.subtitleIndex)) body.SubtitleStreamIndex = r.subtitleIndex;
    const path = { start: '/Sessions/Playing', progress: '/Sessions/Playing/Progress', stop: '/Sessions/Playing/Stopped' }[event];
    if (!path) throw Object.assign(new Error('Unknown playback event.'), { status: 400 });
    await call(jf.url, path, { token: jf.token, method: 'POST', body });
    // A conversion Jellyfin was running for this playback stops with it.
    if (event === 'stop' && r.playSessionId) {
        const cfg = store.load();
        await call(jf.url, `/Videos/ActiveEncodings?deviceId=${encodeURIComponent(cfg.deviceId)}&playSessionId=${encodeURIComponent(r.playSessionId)}`, {
            token: jf.token,
            method: 'DELETE',
        }).catch(() => {});
    }
}
