/*
 * Just enough of a WebSocket server (RFC 6455) for the phone remote: text
 * frames in both directions, ping/pong, close. No extensions, no binary
 * messages, and messages capped at 64 KB, since a remote sends key presses.
 */
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 64 * 1024;

export class Socket extends EventEmitter {
    constructor(sock) {
        super();
        this.sock = sock;
        this.buf = Buffer.alloc(0);
        this.fragments = [];
        this.open = true;
        sock.setNoDelay(true);
        sock.on('data', (d) => this.onData(d));
        sock.on('close', () => this.closed());
        sock.on('error', () => this.closed());
        // Phones drop off Wi-Fi without saying so; a ping every 20s finds out.
        this.alive = true;
        this.pinger = setInterval(() => {
            if (!this.alive) return this.sock.destroy();
            this.alive = false;
            this.frame(0x9, Buffer.alloc(0));
        }, 20_000);
    }

    closed() {
        if (!this.open) return;
        this.open = false;
        clearInterval(this.pinger);
        this.emit('close');
    }

    onData(chunk) {
        this.buf = Buffer.concat([this.buf, chunk]);
        for (;;) {
            if (this.buf.length < 2) return;
            const b0 = this.buf[0];
            const b1 = this.buf[1];
            const fin = (b0 & 0x80) !== 0;
            const opcode = b0 & 0x0f;
            const masked = (b1 & 0x80) !== 0;
            let len = b1 & 0x7f;
            let off = 2;
            if (len === 126) {
                if (this.buf.length < 4) return;
                len = this.buf.readUInt16BE(2);
                off = 4;
            } else if (len === 127) {
                if (this.buf.length < 10) return;
                const big = this.buf.readBigUInt64BE(2);
                if (big > BigInt(MAX_MESSAGE)) return this.sock.destroy();
                len = Number(big);
                off = 10;
            }
            // Clients must mask; an unmasked frame is not from a browser.
            if (!masked || len > MAX_MESSAGE) return this.sock.destroy();
            if (this.buf.length < off + 4 + len) return;
            const mask = this.buf.subarray(off, off + 4);
            const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
            for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
            this.buf = this.buf.subarray(off + 4 + len);
            this.handle(fin, opcode, payload);
        }
    }

    handle(fin, opcode, payload) {
        this.alive = true;
        if (opcode === 0x8) {
            this.frame(0x8, Buffer.alloc(0));
            this.sock.end();
            return this.closed();
        }
        if (opcode === 0x9) return this.frame(0xa, payload);
        if (opcode === 0xa) return;
        if (opcode === 0x1 || opcode === 0x0) {
            this.fragments.push(payload);
            const total = this.fragments.reduce((n, f) => n + f.length, 0);
            if (total > MAX_MESSAGE) return this.sock.destroy();
            if (!fin) return;
            const text = Buffer.concat(this.fragments).toString('utf8');
            this.fragments = [];
            let msg;
            try {
                msg = JSON.parse(text);
            } catch {
                return;
            }
            this.emit('message', msg);
        }
    }

    frame(opcode, payload) {
        if (!this.open) return;
        const len = payload.length;
        let head;
        if (len < 126) head = Buffer.from([0x80 | opcode, len]);
        else if (len < 65536) {
            head = Buffer.alloc(4);
            head[0] = 0x80 | opcode;
            head[1] = 126;
            head.writeUInt16BE(len, 2);
        } else {
            head = Buffer.alloc(10);
            head[0] = 0x80 | opcode;
            head[1] = 127;
            head.writeBigUInt64BE(BigInt(len), 2);
        }
        this.sock.write(Buffer.concat([head, payload]));
    }

    send(obj) {
        this.frame(0x1, Buffer.from(JSON.stringify(obj)));
    }

    close() {
        this.frame(0x8, Buffer.alloc(0));
        this.sock.end();
        this.closed();
    }
}

/** Completes the handshake for an 'upgrade' request and returns the socket. */
export function accept(req, sock) {
    const key = req.headers['sec-websocket-key'];
    if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
        sock.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return null;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    sock.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    return new Socket(sock);
}
