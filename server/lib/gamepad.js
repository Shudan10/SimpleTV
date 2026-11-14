/*
 * Game controllers, read straight from the kernel's input devices.
 *
 * Every /dev/input/eventN that reports gamepad buttons is opened and its raw
 * events turned into remote actions: the d-pad and left stick move the focus,
 * A selects, B goes back, the Xbox / PS button goes home, and the right stick
 * drives the pointer for sites made for a mouse. Works for Xbox, PlayStation,
 * 8BitDo and most other pads, wired or over Bluetooth -- whatever the kernel
 * already understands.
 *
 * Reading needs no ioctl, so this is plain Node: each event is 24 bytes,
 * a timestamp followed by type, code and value. Devices are looked for every
 * two seconds, which is how a controller switched on later is picked up.
 */
import fs from 'node:fs';
import { EventEmitter } from 'node:events';

const INPUT_DIR = process.env.INPUT_DIR || '/dev/input';
const SYS_DIR = '/sys/class/input';

const EV_KEY = 1;
const EV_ABS = 3;

const BTN = {
    SOUTH: 304, // A / Cross
    EAST: 305, // B / Circle
    NORTH: 307, // X / Triangle (labels differ by brand and driver)
    WEST: 308, // Y / Square
    TL: 310,
    TR: 311,
    TL2: 312,
    TR2: 313,
    SELECT: 314,
    START: 315,
    MODE: 316, // Xbox / PS / Home
    THUMBL: 317,
    THUMBR: 318,
    DPAD_UP: 544,
    DPAD_DOWN: 545,
    DPAD_LEFT: 546,
    DPAD_RIGHT: 547,
};
const ABS = { X: 0, Y: 1, Z: 2, RX: 3, RY: 4, RZ: 5, HAT0X: 16, HAT0Y: 17 };

// What each button does. Directions repeat while held.
const BUTTON_ACTIONS = {
    [BTN.SOUTH]: { action: 'key', key: 'enter' },
    [BTN.EAST]: { action: 'back' },
    [BTN.NORTH]: { action: 'playpause' },
    [BTN.WEST]: { action: 'search' },
    [BTN.TL]: { action: 'key', key: 'pageup' },
    [BTN.TR]: { action: 'key', key: 'pagedown' },
    [BTN.TR2]: { action: 'click' },
    [BTN.SELECT]: { action: 'key', key: 'menu' },
    [BTN.START]: { action: 'playpause' },
    [BTN.MODE]: { action: 'home' },
    [BTN.THUMBR]: { action: 'click' },
    [BTN.DPAD_UP]: { action: 'key', key: 'up', repeat: true },
    [BTN.DPAD_DOWN]: { action: 'key', key: 'down', repeat: true },
    [BTN.DPAD_LEFT]: { action: 'key', key: 'left', repeat: true },
    [BTN.DPAD_RIGHT]: { action: 'key', key: 'right', repeat: true },
};

const REPEAT_DELAY = 380;
const REPEAT_EVERY = 110;

/** The KEY capability bitmap from sysfs, as a set of button codes. */
function keyCaps(eventName) {
    let raw;
    try {
        raw = fs.readFileSync(`${SYS_DIR}/${eventName}/device/capabilities/key`, 'utf8').trim();
    } catch {
        return new Set();
    }
    // Space-separated words, most significant first, each unsigned long (64-bit here).
    const words = raw.split(/\s+/).reverse();
    const caps = new Set();
    words.forEach((hex, w) => {
        const v = BigInt(`0x${hex}`);
        for (let b = 0n; b < 64n; b++) if ((v >> b) & 1n) caps.add(w * 64 + Number(b));
    });
    return caps;
}

function deviceName(eventName) {
    try {
        return fs.readFileSync(`${SYS_DIR}/${eventName}/device/name`, 'utf8').trim();
    } catch {
        return eventName;
    }
}

class Pad {
    constructor(manager, eventName, name) {
        this.manager = manager;
        this.eventName = eventName;
        this.name = name;
        this.abs = {};
        this.range = {}; // per axis: 'u8' (0..255) or 's16' (-32768..32767)
        this.held = new Map(); // repeat key -> timer
        // Opened synchronously so a device this container may not read fails
        // here, once, rather than as a stream error on every scan.
        const fd = fs.openSync(`${INPUT_DIR}/${eventName}`, 'r');
        this.stream = fs.createReadStream(null, { fd, highWaterMark: 24 * 64 });
        this.leftover = Buffer.alloc(0);
        this.openedAt = Date.now();
        this.stream.on('data', (d) => this.onData(d));
        this.stream.on('error', (err) => this.close(err.code || err.message));
        this.stream.on('end', () => this.close('the device stopped sending'));
        this.stream.on('close', () => this.close('the device closed'));
        this.pointerTimer = setInterval(() => this.tickPointer(), 16);
    }

    close(reason = 'closed') {
        if (this.closed) return;
        this.closed = true;
        this.reason = reason;
        clearInterval(this.pointerTimer);
        for (const t of this.held.values()) clearTimeout(t);
        this.stream.destroy();
        this.manager.removed(this);
    }

    onData(chunk) {
        let buf = Buffer.concat([this.leftover, chunk]);
        while (buf.length >= 24) {
            const type = buf.readUInt16LE(16);
            const code = buf.readUInt16LE(18);
            const value = buf.readInt32LE(20);
            buf = buf.subarray(24);
            if (type === EV_KEY) this.onButton(code, value);
            else if (type === EV_ABS) this.onAxis(code, value);
        }
        this.leftover = buf;
    }

    emit(a) {
        this.manager.dispatch(a, this);
    }

    onButton(code, value) {
        const a = BUTTON_ACTIONS[code];
        if (!a) return;
        if (value === 2) return; // the kernel's own autorepeat; ours is steadier
        if (a.repeat) return this.hold(`btn${code}`, value === 1, a);
        if (value === 1) this.emit(a);
    }

    /** Presses a direction, then repeats it until released. */
    hold(id, down, a) {
        const t = this.held.get(id);
        if (!down) {
            if (t) clearTimeout(t);
            this.held.delete(id);
            return;
        }
        if (t) return;
        this.emit(a);
        const again = () => {
            this.emit(a);
            this.held.set(id, setTimeout(again, REPEAT_EVERY));
        };
        this.held.set(id, setTimeout(again, REPEAT_DELAY));
    }

    /** -1..1, with the stick's resting wobble taken out. */
    norm(code) {
        const v = this.abs[code] ?? 0;
        const r = this.range[code] || 's16';
        let n = r === 'u8' ? (v - 128) / 127 : v / 32767;
        n = Math.max(-1, Math.min(1, n));
        return Math.abs(n) < 0.22 ? 0 : n;
    }

    onAxis(code, value) {
        // Ranges are not known without an ioctl, so they are worked out from
        // what the stick sends: PlayStation pads report 0..255, Xbox ones are
        // signed 16-bit. A value outside 0..255 settles it for good.
        if (value < 0 || value > 255) this.range[code] = 's16';
        else if (!this.range[code]) this.range[code] = 'u8';
        this.abs[code] = value;

        if (code === ABS.HAT0X || code === ABS.HAT0Y) {
            const neg = code === ABS.HAT0X ? 'left' : 'up';
            const pos = code === ABS.HAT0X ? 'right' : 'down';
            this.hold(`hat${neg}`, value < 0, { action: 'key', key: neg, repeat: true });
            this.hold(`hat${pos}`, value > 0, { action: 'key', key: pos, repeat: true });
        } else if (code === ABS.X || code === ABS.Y) {
            const x = this.norm(ABS.X);
            const y = this.norm(ABS.Y);
            // The stronger axis wins, and only past half-way, so a push up
            // that drifts a little sideways does not also step sideways.
            const strong = (n) => Math.abs(n) > 0.55;
            const horiz = Math.abs(x) >= Math.abs(y);
            this.hold('stickleft', horiz && strong(x) && x < 0, { action: 'key', key: 'left' });
            this.hold('stickright', horiz && strong(x) && x > 0, { action: 'key', key: 'right' });
            this.hold('stickup', !horiz && strong(y) && y < 0, { action: 'key', key: 'up' });
            this.hold('stickdown', !horiz && strong(y) && y > 0, { action: 'key', key: 'down' });
        }
    }

    tickPointer() {
        const x = this.norm(ABS.RX);
        const y = this.norm(ABS.RY);
        if (!x && !y) return;
        // Squared, so small pushes are fine and full pushes cross the screen fast.
        const speed = 26;
        this.emit({ action: 'move', dx: Math.sign(x) * x * x * speed, dy: Math.sign(y) * y * y * speed });
    }
}

export class Gamepads extends EventEmitter {
    constructor({ log = () => {} } = {}) {
        super();
        this.log = log;
        this.pads = new Map();
        this.unreadable = new Set();
        // Devices that drop again right after opening: eventN -> { drops, until }.
        this.flaky = new Map();
        this.passthrough = false; // the app reads the controller itself
    }

    start() {
        this.scan();
        setInterval(() => this.scan(), 2000);
    }

    scan() {
        let names;
        try {
            names = fs.readdirSync(INPUT_DIR).filter((n) => /^event\d+$/.test(n));
        } catch {
            return;
        }
        for (const n of this.unreadable) if (!names.includes(n)) this.unreadable.delete(n);
        for (const n of names) {
            if (this.pads.has(n) || this.unreadable.has(n)) continue;
            const f = this.flaky.get(n);
            if (f && Date.now() < f.until) continue;
            // Motion sensors and touchpads of a PlayStation pad show up as
            // devices of their own with a few buttons; the pad is the one with A.
            if (!keyCaps(n).has(BTN.SOUTH)) continue;
            const name = deviceName(n);
            try {
                this.pads.set(n, new Pad(this, n, name));
            } catch (err) {
                this.unreadable.add(n);
                this.log(`cannot read controller ${name}: ${err.code || err.message}`);
                continue;
            }
            this.log(`controller connected: ${name}`);
            this.emit('change', this.list());
        }
    }

    removed(pad) {
        if (this.pads.get(pad.eventName) !== pad) return;
        this.pads.delete(pad.eventName);
        const lived = Date.now() - pad.openedAt;
        this.log(`controller disconnected: ${pad.name} after ${Math.round(lived / 1000)}s (${pad.reason})`);
        // Dropping within seconds of opening, again and again, is a device
        // (or its Bluetooth link) that cannot hold on. Rather than reopening
        // it every two seconds, wait longer each time, up to a minute.
        const f = this.flaky.get(pad.eventName) || { drops: 0, until: 0 };
        f.drops = lived < 5000 ? f.drops + 1 : 0;
        if (f.drops >= 3) {
            f.until = Date.now() + Math.min(60_000, 10_000 * (f.drops - 2));
            if (f.drops === 3) this.log(`${pad.name} keeps dropping straight after connecting; trying it less often`);
        }
        this.flaky.set(pad.eventName, f);
        this.emit('change', this.list());
    }

    list() {
        return [...this.pads.values()].map((p) => p.name);
    }

    dispatch(a, pad) {
        // Home always works, so a cloud game can still be left.
        if (this.passthrough && a.action !== 'home') return;
        this.emit('action', a, pad.name);
    }
}
