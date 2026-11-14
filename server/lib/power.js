/*
 * Turning the computer off or restarting it, from the TV.
 *
 * Asked of systemd-logind over the host's system bus, the same way a
 * desktop's shut-down menu does it. The server runs as root, which logind
 * lets power off without a password prompt. Needs the bus socket mounted
 * (docker-compose.yml does that); without it, the buttons are not offered.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';

const BUS = '/run/dbus/system_bus_socket';

function logind(method, ...args) {
    return new Promise((resolve, reject) => {
        execFile(
            'dbus-send',
            ['--system', '--print-reply', '--dest=org.freedesktop.login1', '/org/freedesktop/login1', `org.freedesktop.login1.Manager.${method}`, ...args],
            { env: { ...process.env, DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${BUS}` }, timeout: 5000 },
            (err, stdout, stderr) => {
                if (err) reject(new Error((stderr || err.message).trim()));
                else resolve(stdout);
            },
        );
    });
}

let cached = null;

/** Whether this computer can be turned off from here: 'yes', or why not. */
export async function available() {
    // Only a yes is kept: a no may just be the system still starting.
    if (cached) return cached;
    try {
        if (!fs.statSync(BUS).isSocket()) throw new Error('no system bus');
        const out = await logind('CanPowerOff');
        if (/"yes"/.test(out)) return (cached = { ok: true });
        return { ok: false, why: out.match(/string "(.*)"/)?.[1] || 'not allowed' };
    } catch (err) {
        return { ok: false, why: err.message };
    }
}

export async function powerOff() {
    await logind('PowerOff', 'boolean:false');
}

export async function restart() {
    await logind('Reboot', 'boolean:false');
}
