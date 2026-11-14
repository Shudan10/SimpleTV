/*
 * This machine's address on the home network, for the link the phone opens.
 * The server runs with the host's network, so these are the host's own
 * interfaces. The one carrying the default route is the answer; Docker
 * bridges, VPNs and the like are never it.
 */
import fs from 'node:fs';
import os from 'node:os';

const SKIP = /^(lo|docker|br-|veth|virbr|tailscale|wg|tun|tap|zt|cni|flannel|vxlan)/;

function defaultRouteInterface() {
    try {
        const lines = fs.readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1);
        const best = lines
            .map((l) => l.trim().split(/\s+/))
            .filter((f) => f[1] === '00000000')
            .sort((a, b) => Number(a[6]) - Number(b[6]))[0];
        return best?.[0] || null;
    } catch {
        return null;
    }
}

export function lanAddress() {
    const ifaces = os.networkInterfaces();
    const v4 = (name) => (ifaces[name] || []).find((a) => a.family === 'IPv4' && !a.internal)?.address;
    const preferred = defaultRouteInterface();
    if (preferred && v4(preferred)) return v4(preferred);
    for (const name of Object.keys(ifaces)) {
        if (SKIP.test(name)) continue;
        const a = v4(name);
        if (a) return a;
    }
    return '127.0.0.1';
}
