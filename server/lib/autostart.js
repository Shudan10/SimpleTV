/*
 * Opening SimpleTV when the computer starts (window mode).
 *
 * Desktops on Linux start whatever has an entry in ~/.config/autostart when
 * someone signs in. The server cannot see the home folder, so the entry is
 * written by a moment-long container from the server's own image, with the
 * home folder mounted, and handed to its owner. In TV mode none of this is
 * needed: SimpleTV is the screen from boot.
 */
import path from 'node:path';
import { execFile } from 'node:child_process';

const STACK_HOST = process.env.STACK_HOST || '';
const HOST_HOME = process.env.HOST_HOME || (STACK_HOST ? path.dirname(STACK_HOST) : '');
const UID = process.env.HOST_UID || '1000';
const GID = process.env.HOST_GID || '1000';
const IMAGE = 'simpletv/server:1';

const sq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

function inHome(script) {
    return new Promise((resolve, reject) => {
        if (!path.isAbsolute(HOST_HOME) || HOST_HOME === '/') return reject(new Error('This install does not know its home folder.'));
        execFile(
            'docker',
            ['run', '--rm', '--network', 'none', '-v', `${HOST_HOME}:/h`, '--entrypoint', 'sh', IMAGE, '-c', `set -e\n${script}`],
            { timeout: 60_000 },
            (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout.trim())),
        );
    });
}

let cached = null;

export async function enabled() {
    if (cached !== null) return cached;
    try {
        cached = (await inHome('[ -f /h/.config/autostart/simpletv.desktop ] && echo yes || echo no')) === 'yes';
    } catch {
        cached = false;
    }
    return cached;
}

export async function set(on) {
    if (on) {
        const entry = [
            '[Desktop Entry]',
            'Type=Application',
            'Name=SimpleTV',
            'Comment=Open SimpleTV when you sign in',
            // Quoted as desktop files want, so a folder with spaces works.
            `Exec="${`${STACK_HOST}/simpletv`.replace(/[\\"`$]/g, '\\$&')}" open --wait`,
            `Icon=${STACK_HOST}/server/public/tv/icon.svg`,
            'Terminal=false',
            'X-GNOME-Autostart-enabled=true',
            '',
        ].join('\n');
        // Folders made here are given to the owner of the home folder, never
        // left to root; an existing ~/.config is used as it is.
        await inHome(
            [
                `for d in /h/.config /h/.config/autostart; do [ -d "$d" ] || { mkdir "$d"; chown ${UID}:${GID} "$d"; }; done`,
                `printf '%s' ${sq(entry)} > /h/.config/autostart/simpletv.desktop`,
                `chown ${UID}:${GID} /h/.config/autostart/simpletv.desktop`,
            ].join('\n'),
        );
    } else {
        await inHome('rm -f /h/.config/autostart/simpletv.desktop');
    }
    cached = on;
    return cached;
}
