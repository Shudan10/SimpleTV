// Jellyfin, built in: the Library screens, a details page for every film and
// show, and SimpleTV's own player. Everything is driven by the same arrows,
// OK and Back as the rest of SimpleTV.

const TICKS = 10_000_000;

export function setupLibrary(ctx) {
    const { api, $, $$, esc, focusEl, showView, toast, sfx } = ctx;
    const S = () => ctx.state();

    // ============================================================ helpers ==

    const fmtTime = (s) => {
        s = Math.max(0, Math.floor(s || 0));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = String(s % 60).padStart(2, '0');
        return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
    };
    const fmtMinutes = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);

    // What this browser can play by itself, for Jellyfin to choose between
    // sending the file as it is and converting it on the fly.
    function deviceProfile({ directPlay = true } = {}) {
        const v = document.createElement('video');
        const can = (t) => v.canPlayType(t) !== '';
        const vcodecs = ['h264'];
        if (can('video/mp4; codecs="hvc1.1.6.L120.90"') || can('video/mp4; codecs="hev1.1.6.L120.90"')) vcodecs.push('hevc');
        if (can('video/mp4; codecs="av01.0.08M.08"')) vcodecs.push('av1');
        if (can('video/webm; codecs="vp9"')) vcodecs.push('vp9');
        const acodecs = ['aac', 'mp3', 'opus', 'flac'];
        if (can('audio/mp4; codecs="ac-3"')) acodecs.push('ac3');
        if (can('audio/mp4; codecs="ec-3"')) acodecs.push('eac3');
        const direct = [
            { Container: 'mp4,m4v,mov', Type: 'Video', VideoCodec: vcodecs.join(','), AudioCodec: acodecs.join(',') },
            { Container: 'webm', Type: 'Video', VideoCodec: 'vp8,vp9,av1', AudioCodec: 'vorbis,opus' },
        ];
        if (can('video/x-matroska; codecs="avc1.640029"')) direct.push({ Container: 'mkv', Type: 'Video', VideoCodec: vcodecs.join(','), AudioCodec: acodecs.join(',') });
        const hls = can('application/vnd.apple.mpegurl');
        return {
            MaxStreamingBitrate: 140_000_000,
            DirectPlayProfiles: directPlay ? direct : [],
            TranscodingProfiles: hls
                ? [{ Container: 'ts', Type: 'Video', Protocol: 'hls', VideoCodec: 'h264', AudioCodec: 'aac', Context: 'Streaming', MaxAudioChannels: '2', BreakOnNonKeyFrames: true }]
                : [{ Container: 'mp4', Type: 'Video', Protocol: 'http', VideoCodec: 'h264', AudioCodec: 'aac', Context: 'Streaming', MaxAudioChannels: '2' }],
            ContainerProfiles: [],
            CodecProfiles: [],
            SubtitleProfiles: [
                { Format: 'vtt', Method: 'External' },
                { Format: 'pgssub', Method: 'Encode' },
                { Format: 'dvdsub', Method: 'Encode' },
                { Format: 'dvbsub', Method: 'Encode' },
            ],
        };
    }

    // ============================================================ library ==

    const lib = { views: null, view: null, sort: 'name', items: [], total: 0, loading: false };

    async function renderLibrary() {
        const inner = $('#lib-inner');
        if (!S()?.jellyfin?.connected) {
            inner.innerHTML = `<h2 class="page-title">Library</h2><p class="page-hint">Sign in to Jellyfin under Settings → Jellyfin to see your films and shows here.</p>
                <button class="f btn primary" data-pane-go="jellyfin">Set up Jellyfin</button>`;
            return;
        }
        if (!lib.views) {
            inner.innerHTML = `<h2 class="page-title">Library</h2><p class="page-hint">Loading…</p>`;
            try {
                lib.views = await api('/api/jf/views').then((r) => r.views);
            } catch (err) {
                inner.innerHTML = `<h2 class="page-title">Library</h2><p class="err">Jellyfin did not answer: ${esc(err.message)}</p>`;
                return;
            }
            lib.view = lib.views[0] || null;
        }
        if (!lib.view) {
            inner.innerHTML = `<h2 class="page-title">Library</h2><p class="page-hint">Your Jellyfin has no film or TV libraries yet.</p>`;
            return;
        }
        drawLibraryFrame();
        await loadItems(true);
    }

    function drawLibraryFrame() {
        const inner = $('#lib-inner');
        inner._ty = 0;
        inner.style.transform = '';
        inner.innerHTML = `
            <div class="lib-head" data-row="lib-head">
              ${lib.views.map((v) => `<button class="f chip${v.id === lib.view.id ? ' on' : ''}" data-lib="${esc(v.id)}" data-key="lib:${esc(v.id)}">${esc(v.name)}</button>`).join('')}
              <span class="lib-gap"></span>
              ${[
                  ['name', 'A–Z'],
                  ['added', 'Recently added'],
                  ['year', 'Year'],
              ]
                  .map(([k, label]) => `<button class="f chip small${lib.sort === k ? ' on' : ''}" data-sort="${k}" data-key="sort:${k}">${label}</button>`)
                  .join('')}
            </div>
            <div class="poster-grid" id="lib-grid"></div>
            <p class="page-hint" id="lib-more"></p>`;
    }

    function posterHtml(it) {
        const badge = it.played ? '<span class="pbadge played">✓</span>' : it.unplayed ? `<span class="pbadge">${it.unplayed}</span>` : '';
        return `<button class="f poster" data-jf="${esc(it.id)}" data-key="p:${esc(it.id)}">
            <div class="pimg"${it.poster ? ` style="background-image:url('${esc(it.poster)}')"` : ''}>${it.poster ? '' : `<span>${esc(it.title)}</span>`}${badge}${
                it.progress ? `<div class="bar"><i style="width:${it.progress}%"></i></div>` : ''
            }</div>
            <div class="ct">${esc(it.title)}</div>${it.year ? `<div class="cs">${it.year}</div>` : ''}</button>`;
    }

    async function loadItems(fresh) {
        if (lib.loading) return;
        if (!fresh && lib.items.length >= lib.total) return;
        lib.loading = true;
        if (fresh) {
            lib.items = [];
            lib.total = 0;
        }
        const more = $('#lib-more');
        if (more) more.textContent = 'Loading…';
        try {
            const r = await api(`/api/jf/items?parentId=${encodeURIComponent(lib.view.id)}&type=${encodeURIComponent(lib.view.type)}&sort=${lib.sort}&start=${lib.items.length}&limit=60`);
            lib.total = r.total;
            lib.items.push(...r.items);
            $('#lib-grid')?.insertAdjacentHTML('beforeend', r.items.map(posterHtml).join(''));
            if (more) more.textContent = lib.items.length ? '' : 'Nothing here yet.';
        } catch (err) {
            if (more) more.textContent = `Jellyfin did not answer: ${err.message}`;
        } finally {
            lib.loading = false;
        }
    }

    // More posters as the selection nears the end of what is loaded.
    function onLibraryFocus(el) {
        if (!el.classList.contains('poster')) return;
        const all = $$('#lib-grid .poster');
        if (all.indexOf(el) > all.length - 14) loadItems(false);
    }

    // =========================================================== details ==

    const detailStack = []; // where Back goes from a details page
    let detailData = null;

    async function openDetail(id, { from } = {}) {
        if (ctx.view() !== 'detail') detailStack.push({ view: ctx.view(), focusKey: from?.dataset?.key || document.activeElement?.dataset?.key });
        else detailStack.push({ view: 'detail', id: detailData?.id, focusKey: document.activeElement?.dataset?.key });
        showView('detail', { focus: false });
        const box = $('#detail');
        box.innerHTML = '<p class="page-hint">Loading…</p>';
        $('#detail-bg').style.backgroundImage = '';
        try {
            detailData = await api(`/api/jf/item?id=${encodeURIComponent(id)}`);
        } catch (err) {
            box.innerHTML = `<p class="err">Jellyfin did not answer: ${esc(err.message)}</p>`;
            return;
        }
        drawDetail();
    }

    function drawDetail(focusKey) {
        const d = detailData;
        const box = $('#detail');
        $('#detail-bg').style.backgroundImage = d.backdrop ? `url("${d.backdrop}")` : '';
        const meta = [d.year, d.rating, d.minutes ? fmtMinutes(d.minutes) : null, d.score ? `★ ${d.score}` : null, ...(d.genres || [])].filter(Boolean);
        const buttons = [];
        if (d.type === 'Series') {
            if (d.next) buttons.push(`<button class="f btn primary" data-play="${esc(d.next.id)}" data-resume="1" data-key="d:next">▶ ${d.next.resumeTicks ? 'Resume' : 'Play'} ${esc(d.next.label)}</button>`);
        } else if (d.resumeTicks > 0) {
            buttons.push(`<button class="f btn primary" data-play="${esc(d.id)}" data-resume="1" data-key="d:resume">▶ Resume from ${fmtTime(d.resumeTicks / TICKS)}</button>`);
            buttons.push(`<button class="f btn" data-play="${esc(d.id)}" data-key="d:start">Play from the start</button>`);
        } else {
            buttons.push(`<button class="f btn primary" data-play="${esc(d.id)}" data-key="d:play">▶ Play</button>`);
        }
        if (d.type === 'Episode' && d.seriesId) buttons.push(`<button class="f btn" data-series="${esc(d.seriesId)}" data-key="d:series">All episodes</button>`);
        box.innerHTML = `
            <div class="d-inner" id="d-inner">
              <div class="d-head">
                ${d.logo ? `<img class="d-logo" src="${esc(d.logo)}" alt="${esc(d.name)}">` : `<h1 class="d-title">${esc(d.name)}</h1>`}
                ${d.episodeLabel ? `<div class="d-ep">${esc(d.episodeLabel)}</div>` : ''}
                <div class="d-meta">${meta.map((m) => `<span>${esc(m)}</span>`).join('')}${d.played ? '<span class="d-watched">✓ Watched</span>' : ''}</div>
                ${d.progress && d.type !== 'Series' ? `<div class="hero-progress"><i style="width:${d.progress}%"></i></div>` : ''}
                <p class="d-overview">${esc(d.overview)}</p>
                <div class="d-buttons" data-row="d-buttons">${buttons.join('')}</div>
              </div>
              ${d.seasons?.length ? `<div class="d-seasons" data-row="d-seasons">${d.seasons
                  .map((s) => `<button class="f chip${s.id === d.seasonId ? ' on' : ''}" data-season="${esc(s.id)}" data-key="s:${esc(s.id)}">${esc(s.name)}</button>`)
                  .join('')}</div><div class="row" data-row="d-eps"><div class="strip" id="d-eps"></div></div>` : ''}
            </div>`;
        if (d.seasons?.length) {
            const season = d.seasons.find((s) => s.id === d.seasonId) || d.seasons.find((s) => s.unplayed) || d.seasons[0];
            loadEpisodes(season.id);
        }
        focusEl((focusKey && $(`#detail [data-key="${CSS.escape(focusKey)}"]`)) || $('#detail .d-buttons .f') || $('#detail .f'));
    }

    async function loadEpisodes(seasonId) {
        detailData.seasonId = seasonId;
        $$('#detail [data-season]').forEach((c) => c.classList.toggle('on', c.dataset.season === seasonId));
        const strip = $('#d-eps');
        strip.innerHTML = '<p class="page-hint">Loading episodes…</p>';
        try {
            const { episodes } = await api(`/api/jf/episodes?seriesId=${encodeURIComponent(detailData.seriesId)}&seasonId=${encodeURIComponent(seasonId)}`);
            strip.innerHTML = episodes
                .map(
                    (e) => `<button class="f card ep" data-play="${esc(e.id)}" data-resume="1" data-key="e:${esc(e.id)}">
                        <div class="thumb"${e.image ? ` style="background-image:url('${esc(e.image)}')"` : ''}>${e.image ? '' : `<div class="noimg">${esc(e.name)}</div>`}${
                            e.played ? '<span class="pbadge played">✓</span>' : ''
                        }${e.progress ? `<div class="bar"><i style="width:${e.progress}%"></i></div>` : ''}</div>
                        <div class="ct">${e.index != null ? `${e.index}. ` : ''}${esc(e.name)}</div><div class="cs">${e.minutes ? fmtMinutes(e.minutes) : ''}</div></button>`,
                )
                .join('');
        } catch (err) {
            strip.innerHTML = `<p class="err">Jellyfin did not answer: ${esc(err.message)}</p>`;
        }
    }

    function backFromDetail() {
        const prev = detailStack.pop();
        if (!prev) return showView('home');
        if (prev.view === 'detail' && prev.id) return openDetailFromStack(prev);
        showView(prev.view, { focus: false });
        const again = prev.focusKey && $(`#view-${prev.view} [data-key="${CSS.escape(prev.focusKey)}"]`);
        focusEl(again || ctx.defaultFocus());
    }

    async function openDetailFromStack(prev) {
        showView('detail', { focus: false });
        try {
            detailData = await api(`/api/jf/item?id=${encodeURIComponent(prev.id)}`);
            drawDetail(prev.focusKey);
        } catch {
            showView('home');
        }
    }

    // ============================================================ player ==

    const P = {
        active: false,
        info: null,
        id: null,
        uiTimer: null,
        reportTimer: null,
        started: false,
        retried: false,
        nextTimer: null,
    };
    const video = () => $('#video');

    async function play(id, { resume = false, startSeconds = null, audioIndex, subtitleIndex, directPlay = true } = {}) {
        let info;
        try {
            info = await api('/api/jf/play', { id, profile: deviceProfile({ directPlay }), audioIndex, subtitleIndex });
        } catch (err) {
            toast(`Could not play: ${err.message}`);
            return;
        }
        if (P.active) await stopReporting('stop');
        P.active = true;
        P.info = info;
        P.id = id;
        P.started = false;
        if (directPlay) P.retried = false;
        clearTimeout(P.nextTimer);

        const v = video();
        const el = $('#player');
        el.hidden = false;
        document.body.classList.add('playing');
        $('#pl-title').textContent = info.title;
        $('#pl-sub').textContent = info.subtitle || '';
        $('#pl-next').hidden = true;
        spinner(true);

        clearSubtitles(v);
        for (const s of info.subs.filter((x) => x.url)) {
            const tr = document.createElement('track');
            tr.kind = 'subtitles';
            tr.label = s.label;
            tr.src = s.url;
            tr.dataset.index = s.index;
            v.appendChild(tr);
        }
        v.src = info.url;
        const startAt = startSeconds != null ? startSeconds : resume && info.resumeTicks ? info.resumeTicks / TICKS : 0;
        v.addEventListener(
            'loadedmetadata',
            () => {
                if (startAt > 1) v.currentTime = startAt;
                showSubtitle(info.subtitleIndex);
            },
            { once: true },
        );
        v.play().catch(() => {});
        drawButtons();
        showUi();
    }

    // Switched off before they go: a removed track can otherwise leave its
    // last line on screen over the next video.
    function clearSubtitles(v) {
        for (const t of v.textTracks) t.mode = 'disabled';
        v.querySelectorAll('track').forEach((t) => t.remove());
    }

    function spinner(on) {
        $('#pl-spin').hidden = !on;
    }

    function showSubtitle(index) {
        const v = video();
        for (const t of v.textTracks) t.mode = 'disabled';
        if (index == null) return;
        const i = [...v.querySelectorAll('track')].findIndex((t) => Number(t.dataset.index) === index);
        if (i >= 0) v.textTracks[i].mode = 'showing';
    }

    function drawButtons() {
        const i = P.info;
        const btn = (act, label, extra = '') => `<button class="f pl-btn" data-pl="${act}" ${extra}>${label}</button>`;
        let h = btn('toggle', video().paused ? '▶ Play' : '❚❚ Pause');
        h += btn('back10', '« 10 s') + btn('fwd10', '10 s »');
        if (i.subs.length) h += btn('subs', i.subtitleIndex != null ? 'Subtitles: on' : 'Subtitles');
        if (i.audio.length > 1) h += btn('audio', 'Audio');
        if (i.next) h += btn('next', 'Next episode');
        h += btn('stop', 'Stop');
        $('#pl-buttons').innerHTML = h;
    }

    function showUi(focusScrubber = true) {
        const ui = $('#pl-ui');
        ui.classList.add('on');
        if (focusScrubber && !ui.contains(document.activeElement)) focusEl($('#pl-scrub'));
        clearTimeout(P.uiTimer);
        P.uiTimer = setTimeout(hideUi, 4500);
    }

    function hideUi() {
        if (video().paused || !$('#pl-menu').hidden) return; // stays up while paused or a menu is open
        $('#pl-ui').classList.remove('on');
        $('#pl-scrub').focus({ preventScroll: true });
    }

    const uiOn = () => $('#pl-ui').classList.contains('on');

    function seek(by) {
        const v = video();
        const dur = Number.isFinite(v.duration) ? v.duration : P.info.durationTicks / TICKS;
        v.currentTime = Math.max(0, Math.min(dur - 1, v.currentTime + by));
        updateBar();
        showUi(false);
    }

    function toggle() {
        const v = video();
        if (v.paused) v.play().catch(() => {});
        else v.pause();
        showUi(false);
    }

    function updateBar() {
        const v = video();
        const dur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : P.info ? P.info.durationTicks / TICKS : 0;
        const pct = dur ? Math.min(100, (v.currentTime / dur) * 100) : 0;
        $('#pl-fill').style.width = `${pct}%`;
        $('#pl-knob').style.left = `${pct}%`;
        $('#pl-pos').textContent = fmtTime(v.currentTime);
        $('#pl-dur').textContent = `-${fmtTime(dur - v.currentTime)}`;
        try {
            const b = v.buffered;
            if (b.length && dur) $('#pl-buf').style.width = `${Math.min(100, (b.end(b.length - 1) / dur) * 100)}%`;
        } catch {
            /* nothing buffered yet */
        }
    }

    function menu(title, options, onPick) {
        const m = $('#pl-menu');
        m.innerHTML = `<h3>${esc(title)}</h3>${options.map((o, i) => `<button class="f option${o.on ? ' on' : ''}" data-pick="${i}"><span class="radio"></span>${esc(o.label)}</button>`).join('')}`;
        m.hidden = false;
        $$('[data-pick]', m).forEach((b) =>
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                m.hidden = true;
                onPick(options[Number(b.dataset.pick)]);
            }),
        );
        focusEl($('.option.on', m) || $('.f', m));
        clearTimeout(P.uiTimer);
    }

    function closeMenu() {
        $('#pl-menu').hidden = true;
        focusEl($('#pl-buttons .f'));
        showUi(false);
    }

    function restartAt(opts) {
        const pos = video().currentTime;
        play(P.id, { startSeconds: pos, audioIndex: P.info.audioIndex ?? undefined, subtitleIndex: P.info.subtitleIndex ?? undefined, ...opts });
    }

    function onButton(act) {
        const i = P.info;
        if (act === 'toggle') return toggle();
        if (act === 'back10') return seek(-10);
        if (act === 'fwd10') return seek(10);
        if (act === 'stop') return exit();
        if (act === 'next' && i.next) return playNext();
        if (act === 'subs') {
            const opts = [{ label: 'Off', index: null, on: i.subtitleIndex == null }, ...i.subs.map((s) => ({ ...s, on: s.index === i.subtitleIndex }))];
            return menu('Subtitles', opts, (o) => {
                if (o.index == null || o.url) {
                    i.subtitleIndex = o.index;
                    showSubtitle(o.index);
                    drawButtons();
                    focusEl($('#pl-buttons [data-pl="subs"]'));
                    return;
                }
                // Picture subtitles are burned in by Jellyfin, which means a new stream.
                restartAt({ subtitleIndex: o.index, directPlay: false });
            });
        }
        if (act === 'audio') {
            const opts = i.audio.map((a) => ({ ...a, on: a.index === i.audioIndex }));
            return menu('Audio', opts, (o) => restartAt({ audioIndex: o.index, directPlay: false }));
        }
    }

    // ------------------------------------------------- telling Jellyfin --

    function reportBody(event) {
        const v = video();
        return {
            event,
            id: P.id,
            mediaSourceId: P.info.mediaSourceId,
            playSessionId: P.info.playSessionId,
            positionTicks: Math.round((v.currentTime || 0) * TICKS),
            paused: v.paused,
            mode: P.info.mode,
            audioIndex: P.info.audioIndex,
            subtitleIndex: P.info.subtitleIndex,
        };
    }

    function report(event) {
        if (!P.info) return Promise.resolve();
        return api('/api/jf/report', reportBody(event)).catch(() => {});
    }

    async function stopReporting() {
        clearInterval(P.reportTimer);
        P.reportTimer = null;
        if (P.started) await report('stop');
        P.started = false;
    }

    // ------------------------------------------------------- the ending --

    function playNext() {
        const next = P.info.next;
        if (!next) return exit();
        play(next.id, { resume: false });
    }

    function onEnded() {
        const next = P.info.next;
        stopReporting();
        if (!next) return exit({ ended: true });
        let n = 10;
        const box = $('#pl-next');
        const draw = () => {
            box.innerHTML = `<div class="pn-label">Up next</div><div class="pn-title">${esc(next.label)}</div><div class="pn-count">Starting in ${n} s</div>
                <button class="f btn primary" data-pn="now">Play now</button><button class="f btn" data-pn="stop">Stop</button>`;
            $('[data-pn="now"]', box).addEventListener('click', (e) => {
                e.stopPropagation();
                playNext();
            });
            $('[data-pn="stop"]', box).addEventListener('click', (e) => {
                e.stopPropagation();
                exit({ ended: true });
            });
        };
        box.hidden = false;
        draw();
        focusEl($('[data-pn="now"]', box));
        const tick = () => {
            n--;
            if (n <= 0) return playNext();
            $('.pn-count', box).textContent = `Starting in ${n} s`;
            P.nextTimer = setTimeout(tick, 1000);
        };
        P.nextTimer = setTimeout(tick, 1000);
    }

    async function exit({ ended = false } = {}) {
        if (!P.active) return;
        clearTimeout(P.nextTimer);
        clearTimeout(P.uiTimer);
        await stopReporting();
        const v = video();
        v.pause();
        clearSubtitles(v);
        v.removeAttribute('src');
        v.load();
        P.active = false;
        $('#player').hidden = true;
        $('#pl-menu').hidden = true;
        $('#pl-next').hidden = true;
        document.body.classList.remove('playing');
        // Whatever was on screen before shows what was just watched.
        if (ctx.view() === 'detail' && detailData) {
            try {
                detailData = await api(`/api/jf/item?id=${encodeURIComponent(detailData.id)}`);
                drawDetail();
            } catch {
                /* keep what is there */
            }
        } else {
            ctx.refreshJellyfin();
            focusEl(ctx.defaultFocus());
        }
        if (ended) sfx.play('back');
    }

    // ------------------------------------------------ video's own events --

    function wireVideo() {
        const v = video();
        v.addEventListener('playing', () => {
            spinner(false);
            if (!P.started) {
                P.started = true;
                report('start');
                clearInterval(P.reportTimer);
                P.reportTimer = setInterval(() => report('progress'), 10_000);
            }
            drawButtonsKeepFocus();
        });
        v.addEventListener('pause', () => {
            if (P.started) report('progress');
            drawButtonsKeepFocus();
            showUi(false);
        });
        v.addEventListener('waiting', () => spinner(true));
        v.addEventListener('seeked', () => {
            if (P.started) report('progress');
        });
        v.addEventListener('timeupdate', updateBar);
        v.addEventListener('ended', onEnded);
        v.addEventListener('error', () => {
            if (!P.active) return;
            spinner(false);
            // A file the browser said it could play but cannot: once, ask
            // Jellyfin to convert it instead.
            if (P.info.mode === 'DirectPlay' && !P.retried) {
                P.retried = true;
                const pos = v.currentTime;
                return play(P.id, { startSeconds: pos, directPlay: false });
            }
            toast('This video would not play.');
            exit();
        });
        $('#player').addEventListener('click', (e) => {
            const b = e.target.closest('[data-pl]');
            if (b) {
                e.stopPropagation();
                onButton(b.dataset.pl);
            }
        });
    }

    function drawButtonsKeepFocus() {
        if (!P.active) return;
        const act = document.activeElement?.dataset?.pl;
        drawButtons();
        if (act) focusEl($(`#pl-buttons [data-pl="${act}"]`));
    }

    // ----------------------------------------------------------- keys --

    // The player takes every key while it is on screen. Returns true when
    // it handled one, so the rest of SimpleTV leaves it alone.
    function handleKey(e) {
        if (!P.active) return false;
        const k = e.key;
        e.preventDefault();
        const nextBox = $('#pl-next');
        if (!nextBox.hidden) {
            if (k === 'Escape' || k === 'Backspace') {
                exit({ ended: true });
                return true;
            }
            if (k === 'ArrowLeft' || k === 'ArrowRight') focusEl($(k === 'ArrowLeft' ? '[data-pn="now"]' : '[data-pn="stop"]', nextBox));
            if (k === 'Enter') document.activeElement?.click();
            return true;
        }
        const m = $('#pl-menu');
        if (!m.hidden) {
            if (k === 'Escape' || k === 'Backspace') closeMenu();
            else if (k === 'ArrowUp' || k === 'ArrowDown') {
                const opts = $$('.f', m);
                const i = opts.indexOf(document.activeElement);
                focusEl(opts[Math.max(0, Math.min(opts.length - 1, i + (k === 'ArrowDown' ? 1 : -1)))]);
            } else if (k === 'Enter') document.activeElement?.click();
            return true;
        }
        const onScrub = document.activeElement === $('#pl-scrub') || !$('#player').contains(document.activeElement);
        if (k === 'Escape' || k === 'Backspace' || k === 'BrowserBack') {
            if (uiOn() && !onScrub) focusEl($('#pl-scrub'));
            else if (uiOn() && !video().paused) $('#pl-ui').classList.remove('on');
            else exit();
            return true;
        }
        if (k === ' ' || k === 'MediaPlayPause') {
            toggle();
            return true;
        }
        if (onScrub) {
            if (k === 'ArrowLeft') seek(-10);
            else if (k === 'ArrowRight') seek(10);
            else if (k === 'Enter') toggle();
            else if (k === 'ArrowDown') {
                showUi(false);
                focusEl($('#pl-buttons .f'));
            } else if (k === 'ArrowUp') showUi();
            return true;
        }
        // On the buttons row.
        const btns = $$('#pl-buttons .f');
        const i = btns.indexOf(document.activeElement);
        if (k === 'ArrowLeft' || k === 'ArrowRight') focusEl(btns[Math.max(0, Math.min(btns.length - 1, i + (k === 'ArrowLeft' ? -1 : 1)))]);
        else if (k === 'ArrowUp') focusEl($('#pl-scrub'));
        else if (k === 'Enter') document.activeElement?.click();
        showUi(false);
        return true;
    }

    // ========================================================== clicks ==

    function handleClick(el) {
        if (el.dataset.lib) {
            lib.view = lib.views.find((v) => v.id === el.dataset.lib) || lib.view;
            drawLibraryFrame();
            loadItems(true).then(() => focusEl($(`#lib-inner [data-lib="${CSS.escape(lib.view.id)}"]`)));
            return true;
        }
        if (el.dataset.sort) {
            lib.sort = el.dataset.sort;
            drawLibraryFrame();
            loadItems(true).then(() => focusEl($(`#lib-inner [data-sort="${lib.sort}"]`)));
            return true;
        }
        if (el.dataset.season) {
            loadEpisodes(el.dataset.season);
            return true;
        }
        if (el.dataset.series) {
            openDetail(el.dataset.series);
            return true;
        }
        if (el.dataset.play) {
            const d = detailData;
            const fromStart = el.dataset.key === 'd:start';
            play(el.dataset.play, { resume: !fromStart && el.dataset.resume === '1' || (!fromStart && d?.id === el.dataset.play && d.resumeTicks > 0) });
            return true;
        }
        return false;
    }

    wireVideo();

    return {
        renderLibrary,
        openDetail,
        play,
        exit,
        handleKey,
        handleClick,
        backFromDetail,
        onLibraryFocus,
        playing: () => P.active,
        reset() {
            lib.views = null;
            lib.view = null;
        },
    };
}
