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
// The branch it was installed from; updates come from the same one.
const REF = /^[\w./-]{1,100}$/.test(process.env.SIMPLETV_REF || '') ? process.env.SIMPLETV_REF : 'main';
const SHA_RE = /^[0-9a-f]{40}$/;
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
    const res = await fetch(`https://api.github.com/repos/${REPO}/commits/${REF}`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'SimpleTV' },
        signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${REPO}.`);
    const c = await res.json();
    if (!SHA_RE.test(String(c.sha || ''))) throw new Error('GitHub gave an answer that is not a version.');
    const have = installed();
    last = {
        repo: REPO,
        installed: have,
        latest: c.sha,
        latestMessage: (c.commit?.message || '').split('\n')[0],
        latestDate: c.commit?.committer?.date || null,
        available: !have || have !== c.sha,
        checkedAt: new Date().toISOString(),
    };
    return last;
}


// The last answer from GitHub, so the TV can show that an update is waiting
// without asking GitHub every time a page loads. Only ever set by pressing
// Check for updates: SimpleTV never asks on its own.
let last = null;

export function lastCheck() {
    return last && { available: last.available, latestMessage: last.latestMessage, latestDate: last.latestDate, checkedAt: last.checkedAt };
}


const LOG = path.join(STACK, 'conf', 'update.log');

/** The update's log from a byte offset on, so the TV can follow it. */
export function log(from = 0) {
    let fd;
    try {
        fd = fs.openSync(LOG, 'r');
        const size = fs.fstatSync(fd).size;
        const start = Math.max(0, Math.min(Number(from) || 0, size));
        // Never more than 64 KB at once; the rest comes on the next ask.
        const len = Math.min(size - start, 64 * 1024);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, start);
        return { text: buf.toString('utf8'), next: start + len, size };
    } catch {
        return { text: '', next: 0, size: 0 };
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
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
    // An update cut off half way (the computer turned off during it) never
    // writes its result. After an hour it is over, whatever happened.
    if (out.running && Date.now() / 1000 - Number(out.started || 0) > 3600) {
        out.running = false;
        out.result = 'fail';
        out.error = out.error || 'The update was interrupted. Check for updates to try again.';
    }
    out.ok = out.result === 'ok';
    return out;
}

export async function run() {
    if (!STACK_HOST) throw new Error('This install does not know its own folder (STACK_HOST), so it cannot update itself.');
    // Pressing Update twice must not stop the first one half way through.
    const running = await docker(['inspect', '-f', '{{.State.Running}}', 'simpletv-update']).catch(() => 'false');
    if (running === 'true') throw Object.assign(new Error('An update is already running.'), { status: 409 });
    const { latest } = await check();
    const D = sq(STACK_HOST);
    const script = `
set -u
D=${D}
S="$D/conf/update.txt"
mkdir -p "$D/conf"
owner=$(stat -c %u:%g "$D")
: > "$S"; chown "$owner" "$S"
# Everything from here on also goes to a log the TV shows while it runs.
LOG="$D/conf/update.log"
: > "$LOG"; chown "$owner" "$LOG"
exec >>"$LOG" 2>&1
echo "started=$(date +%s)" >> "$S"
step() { echo "step=$1" >> "$S"; echo; echo "== $1"; }
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
# The old copies stay until every new one is in place, and come back if
# one cannot be.
undo() {
  for u in ${CODE_ITEMS.join(' ')}; do
    [ -e "$D/$u.old" ] || continue
    rm -rf "$D/$u"; mv "$D/$u.old" "$D/$u"
  done
}
for item in ${CODE_ITEMS.join(' ')}; do
  rm -rf "$D/$item.old"
done
for item in ${CODE_ITEMS.join(' ')}; do
  [ -e "$D/$item.new" ] || continue
  if [ -e "$D/$item" ]; then mv "$D/$item" "$D/$item.old" || { undo; fail "Could not replace $item. Nothing was changed."; }; fi
  mv "$D/$item.new" "$D/$item" || { undo; fail "Could not replace $item. Nothing was changed."; }
done
for item in ${CODE_ITEMS.join(' ')}; do
  rm -rf "$D/$item.old"
done
rm -rf "$tmp"
step "Rebuilding"
cd "$D"
docker compose --profile tv --profile window build --progress=plain || fail "The new version did not build. The old one is still running."
window=$(docker inspect -f '{{.State.Running}}' simpletv-window 2>/dev/null || echo false)
step "Restarting"
if [ "$window" = true ]; then
  docker compose --profile window up -d --force-recreate window || fail "The new version did not start. Restart SimpleTV to try again."
fi
docker compose up -d --force-recreate || fail "The new version did not start. Restart SimpleTV to try again."
# Only now is it really installed.
echo "${latest}" > "$D/conf/installed-sha"; chown "$owner" "$D/conf/installed-sha"
echo "finished=$(date +%s)" >> "$S"
echo "result=ok" >> "$S"
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
