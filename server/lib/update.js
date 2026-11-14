/*
 * Updating SimpleTV from its own Settings page.
 *
 * The update replaces the server that would report on it, so it runs in a
 * container of its own, started from the server's image (which carries the
 * docker CLI), with the install folder mounted at the same path it has on the
 * host. It writes each step to a status file the TV page reads back.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const REPO = process.env.SIMPLETV_REPO || 'Shudan10/SimpleTV';
const STACK_HOST = process.env.STACK_HOST || '';
const STACK = '/stack';
const STATUS = path.join(STACK, 'conf', 'update.txt');
const SHA_FILE = path.join(STACK, 'conf', 'installed-sha');
const SERVER_IMAGE = 'simpletv/server:1';

// What an update replaces. Everything else in the folder (.env, conf/) stays.
const CODE_ITEMS = ['server', 'display', 'docker-compose.yml', 'install.sh', 'uninstall.sh', 'simpletv', 'README.md', 'LICENSE'];

const sq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

function docker(args) {
    return new Promise((resolve, reject) => {
        execFile('docker', args, { timeout: 60_000 }, (err, stdout, stderr) => {
            if (err) reject(new Error((stderr || err.message).trim()));
            else resolve(stdout.trim());
        });
    });
}

export function installed() {
    try {
        return fs.readFileSync(SHA_FILE, 'utf8').trim() || null;
    } catch {
        return null;
    }
}

export async function check() {
    const res = await fetch(`https://api.github.com/repos/${REPO}/commits/main`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'SimpleTV' },
        signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${REPO}.`);
    const c = await res.json();
    const have = installed();
    return {
        repo: REPO,
        installed: have,
        latest: c.sha,
        latestMessage: (c.commit?.message || '').split('\n')[0],
        latestDate: c.commit?.committer?.date || null,
        available: !have || have !== c.sha,
    };
}


// The last answer from GitHub, so the TV can show that an update is waiting
// without asking GitHub every time a page loads.
let last = null;

export function lastCheck() {
    return last && { available: last.available, latestMessage: last.latestMessage, latestDate: last.latestDate, checkedAt: last.checkedAt };
}

/** Checks now, quietly; for the background timer. */
export async function poll() {
    try {
        last = { ...(await check()), checkedAt: new Date().toISOString() };
    } catch {
        /* offline, or GitHub rate-limited: try again next time */
    }
    return lastCheck();
}

export function progress() {
    let raw;
    try {
        raw = fs.readFileSync(STATUS, 'utf8');
    } catch {
        return { running: false, steps: [] };
    }
    const out = { steps: [] };
    for (const line of raw.split('\n')) {
        const at = line.indexOf('=');
        if (at < 1) continue;
        const k = line.slice(0, at);
        const v = line.slice(at + 1);
        if (k === 'step') out.steps.push(v);
        else out[k] = v;
    }
    out.running = !out.result;
    out.ok = out.result === 'ok';
    return out;
}

export async function run() {
    if (!STACK_HOST) throw new Error('This install does not know its own folder (STACK_HOST), so it cannot update itself.');
    const { latest } = await check();
    const D = sq(STACK_HOST);
    const script = `
set -u
D=${D}
S="$D/conf/update.txt"
mkdir -p "$D/conf"
owner=$(stat -c %u:%g "$D")
: > "$S"; chown "$owner" "$S"
step() { echo "step=$1" >> "$S"; echo "$1"; }
fail() { echo "error=$1" >> "$S"; echo "result=fail" >> "$S"; exit 1; }
echo "sha=${latest}" >> "$S"
step "Downloading the latest version"
tmp=$(mktemp -d)
n=0
until curl -fsSL "https://codeload.github.com/${REPO}/tar.gz/${latest}" | tar -xz -C "$tmp" --strip-components=1; do
  n=$((n + 1)); [ "$n" -ge 4 ] && fail "Could not download the update from GitHub."
  sleep 5; rm -rf "$tmp"; tmp=$(mktemp -d)
done
[ -f "$tmp/docker-compose.yml" ] || fail "The download does not look like SimpleTV."
step "Replacing the files"
for item in ${CODE_ITEMS.join(' ')}; do
  [ -e "$tmp/$item" ] || continue
  rm -rf "$D/$item.new"
  cp -a "$tmp/$item" "$D/$item.new" && chown -R "$owner" "$D/$item.new" || fail "Could not write $item. Nothing was replaced."
done
for item in ${CODE_ITEMS.join(' ')}; do
  [ -e "$D/$item.new" ] || continue
  rm -rf "$D/$item.old"
  [ -e "$D/$item" ] && mv "$D/$item" "$D/$item.old"
  mv "$D/$item.new" "$D/$item"
  rm -rf "$D/$item.old"
done
rm -rf "$tmp"
echo "${latest}" > "$D/conf/installed-sha"; chown "$owner" "$D/conf/installed-sha"
step "Rebuilding"
cd "$D"
docker compose --profile tv --profile window build || fail "The new version did not build. The old one is still running."
window=$(docker inspect -f '{{.State.Running}}' simpletv-window 2>/dev/null || echo false)
step "Restarting"
echo "result=ok" >> "$S"
[ "$window" = true ] && docker compose --profile window up -d --force-recreate window
docker compose up -d --force-recreate
`;
    await docker(['rm', '-f', 'simpletv-update']).catch(() => {});
    await docker([
        'run', '--detach', '--rm', '--name', 'simpletv-update',
        '-v', '/var/run/docker.sock:/var/run/docker.sock',
        '-v', `${STACK_HOST}:${STACK_HOST}`,
        '--entrypoint', 'sh',
        SERVER_IMAGE, '-c', script,
    ]);
    return { started: true, latest };
}

/** Window mode: closes the TV screen, which hands the display back to the desktop. */
export async function closeWindow() {
    await docker(['stop', 'simpletv-window']);
}
