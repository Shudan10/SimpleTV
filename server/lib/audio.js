/*
 * Volume and sound output, through the PulseAudio protocol -- which PipeWire
 * speaks too. In TV mode the socket is the display container's own PipeWire;
 * in window mode it is the desktop's, so the volume here is the desktop's.
 */
import { execFile } from 'node:child_process';

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
    return status();
}
