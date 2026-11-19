/*
 * Volume and sound output, through the PulseAudio protocol -- which PipeWire
 * speaks too. In TV mode the socket is the display container's own PipeWire;
 * in window mode it is the desktop's, so the volume here is the desktop's.
 */
import { execFile } from 'node:child_process';
import * as store from './store.js';

const SERVER = process.env.PULSE_SERVER || 'unix:/run/simpletv-audio/native';

function pactl(...args) {
    return new Promise((resolve, reject) => {
        execFile('pactl', args, { env: { ...process.env, PULSE_SERVER: SERVER }, timeout: 4000 }, (err, stdout, stderr) => {
            if (err) reject(new Error((stderr || err.message).trim() || 'Sound is not available.'));
            else resolve(stdout);
        });
    });
}

export async function status() {
    const [vol, mute, sinksJson, def] = await Promise.all([
        pactl('get-sink-volume', '@DEFAULT_SINK@'),
        pactl('get-sink-mute', '@DEFAULT_SINK@'),
        pactl('-f', 'json', 'list', 'sinks'),
        pactl('get-default-sink'),
    ]);
    const m = vol.match(/(\d+)%/);
    let sinks = [];
    try {
        sinks = JSON.parse(sinksJson).map((s) => ({ name: s.name, description: s.description || s.name }));
    } catch {
        /* older pactl without JSON: the list stays empty */
    }
    return {
        volume: m ? Number(m[1]) : null,
        muted: /yes/i.test(mute),
        output: def.trim(),
        outputs: sinks,
    };
}

export async function change(step) {
    const sign = step > 0 ? '+' : '-';
    if (step > 0) await pactl('set-sink-mute', '@DEFAULT_SINK@', '0');
    // Not past 100%: past that is distortion, not loudness.
    const now = await status();
    if (step > 0 && now.volume >= 100) return now;
    await pactl('set-sink-volume', '@DEFAULT_SINK@', `${sign}${Math.abs(step)}%`);
    const after = await status();
    if (after.volume > 100) await pactl('set-sink-volume', '@DEFAULT_SINK@', '100%');
    return status();
}

export async function set(percent) {
    const p = Math.max(0, Math.min(100, Math.round(Number(percent))));
    await pactl('set-sink-volume', '@DEFAULT_SINK@', `${p}%`);
    return status();
}

export async function toggleMute() {
    await pactl('set-sink-mute', '@DEFAULT_SINK@', 'toggle');
    return status();
}

export async function setOutput(name) {
    await pactl('set-default-sink', String(name));
    await moveAllTo(String(name));
    // Remembered, so the TV's sound turning up does not override it.
    store.update((cfg) => {
        cfg.soundOutput = String(name);
    });
    return status();
}

async function moveAllTo(sink) {
    const list = await pactl('list', 'short', 'sink-inputs');
    for (const line of list.split('\n')) {
        const id = line.split('\t')[0];
        if (/^\d+$/.test(id)) await pactl('move-sink-input', id, sink).catch(() => {});
    }
}

// --------------------------------------------------------- the TV's sound --
// When the computer starts, the TV is often slow to answer: the picture
// comes up, but sound stays on the computer's own speakers (or an HDMI port
// with nothing on it), and the desktop never looks again -- only pulling
// the cable out and back in made it. So every few seconds SimpleTV looks:
// whenever sound through a TV or monitor becomes possible, it is switched
// to, and whatever is playing moves with it. Only when that changes, so an
// output picked by hand afterwards is left alone; one picked in Settings is
// remembered and kept.

const isTvPort = (name, p) => /hdmi|displayport/i.test(`${name} ${p?.type || ''} ${p?.description || ''}`);
const live = (p) => p?.availability !== 'not available';

let lastPorts = null;
let lastSinks = null;
let busy = false;

async function keepTvSound() {
    const cards = JSON.parse(await pactl('-f', 'json', 'list', 'cards'));
    const tvPorts = cards.map((card) => ({
        card,
        ports: Object.entries(card.ports || {}).filter(([n, p]) => isTvPort(n, p) && p.availability === 'available'),
    }));
    const portsKey = JSON.stringify(tvPorts.map(({ card, ports }) => [card.name, ports.map(([n]) => n)]));
    if (portsKey !== lastPorts) {
        lastPorts = portsKey;
        for (const { card, ports } of tvPorts) {
            if (!ports.length) continue;
            // The card set to a way of playing (a profile) that leaves the
            // TV's port out, such as "Off" or another HDMI port: use the
            // best one that has it.
            const usable = new Set(ports.flatMap(([, p]) => p.profiles || []));
            if (usable.has(card.active_profile)) continue;
            const best = Object.entries(card.profiles || {})
                .filter(([n, pr]) => usable.has(n) && pr.available && pr.sinks > 0)
                .sort((x, y) => y[1].priority - x[1].priority)[0];
            if (best) await pactl('set-card-profile', card.name, best[0]).catch(() => {});
        }
    }

    const sinks = JSON.parse(await pactl('-f', 'json', 'list', 'sinks'));
    const tvSinks = sinks
        .map((s) => ({ s, port: (s.ports || []).find((p) => p.name === s.active_port) }))
        .filter(({ s, port }) => (port ? isTvPort(port.name, port) && live(port) : isTvPort(s.name, s)))
        .sort((x, y) => (y.port?.priority || 0) - (x.port?.priority || 0))
        .map(({ s }) => s.name);
    const sinksKey = JSON.stringify(tvSinks);
    if (sinksKey === lastSinks) return;
    lastSinks = sinksKey;
    if (!tvSinks.length) return;

    const chosen = store.load().soundOutput;
    if (chosen && sinks.some((s) => s.name === chosen) && !tvSinks.includes(chosen)) return;
    const target = tvSinks.includes(chosen) ? chosen : tvSinks[0];
    if ((await pactl('get-default-sink')).trim() === target) return;
    await pactl('set-default-sink', target);
    await moveAllTo(target);
    console.log(`simpletv: sound now plays through ${target}`);
}

/** Starts looking after the TV's sound; quietly does nothing without a sound server. */
export function watchTvSound() {
    const tick = () => {
        if (busy) return;
        busy = true;
        keepTvSound()
            .catch(() => {})
            .finally(() => (busy = false));
    };
    tick();
    setInterval(tick, 5000).unref();
}
