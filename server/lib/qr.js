/*
 * A small QR code encoder: byte mode, error correction level M, versions 1-10,
 * which holds up to 213 bytes -- far more than the pairing link the TV shows.
 * Written here rather than pulled in, because the server has no dependencies.
 *
 * The structure follows the QR Code Model 2 specification (ISO/IEC 18004) as
 * laid out in Project Nayuki's reference implementation.
 */

// Indexed by version; entry 0 unused.
const ECC_PER_BLOCK_M = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS_M = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const ECL_FORMAT_BITS_M = 0;

function gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11d);
        z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
}

function rsDivisor(degree) {
    const result = new Array(degree - 1).fill(0);
    result.push(1);
    let root = 1;
    for (let i = 0; i < degree; i++) {
        for (let j = 0; j < result.length; j++) {
            result[j] = gfMul(result[j], root);
            if (j + 1 < result.length) result[j] ^= result[j + 1];
        }
        root = gfMul(root, 0x02);
    }
    return result;
}

function rsRemainder(data, divisor) {
    const result = new Array(divisor.length).fill(0);
    for (const b of data) {
        const factor = b ^ result.shift();
        result.push(0);
        divisor.forEach((coef, i) => {
            result[i] ^= gfMul(coef, factor);
        });
    }
    return result;
}

function rawDataModules(ver) {
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
        const numAlign = Math.floor(ver / 7) + 2;
        result -= (25 * numAlign - 10) * numAlign - 55;
        if (ver >= 7) result -= 36;
    }
    return result;
}

const dataCodewords = (ver) => Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK_M[ver] * BLOCKS_M[ver];

function alignmentPositions(ver, size) {
    if (ver === 1) return [];
    const numAlign = Math.floor(ver / 7) + 2;
    const step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const result = [6];
    for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
}

const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/** Returns a square array of booleans, true for dark modules. */
export function encode(text) {
    const bytes = [...Buffer.from(String(text), 'utf8')];

    let ver = 1;
    for (; ver <= 10; ver++) {
        const ccBits = ver <= 9 ? 8 : 16;
        if (4 + ccBits + bytes.length * 8 <= dataCodewords(ver) * 8) break;
    }
    if (ver > 10) throw new Error('Text too long for a QR code here.');
    const size = ver * 4 + 17;
    const capacityBits = dataCodewords(ver) * 8;

    // Data bits: mode, length, payload, terminator, padding.
    const bits = [];
    const push = (val, len) => {
        for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    };
    push(0b0100, 4);
    push(bytes.length, ver <= 9 ? 8 : 16);
    for (const b of bytes) push(b, 8);
    push(0, Math.min(4, capacityBits - bits.length));
    push(0, (8 - (bits.length % 8)) % 8);
    for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) push(pad, 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

    // Split into blocks, add error correction, interleave.
    const numBlocks = BLOCKS_M[ver];
    const eccLen = ECC_PER_BLOCK_M[ver];
    const rawCodewords = Math.floor(rawDataModules(ver) / 8);
    const numShort = numBlocks - (rawCodewords % numBlocks);
    const shortLen = Math.floor(rawCodewords / numBlocks);
    const divisor = rsDivisor(eccLen);
    const blocks = [];
    for (let i = 0, k = 0; i < numBlocks; i++) {
        const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
        k += dat.length;
        const ecc = rsRemainder(dat, divisor);
        if (i < numShort) dat.push(0);
        blocks.push(dat.concat(ecc));
    }
    const codewords = [];
    for (let i = 0; i < blocks[0].length; i++) {
        blocks.forEach((block, j) => {
            if (i !== shortLen - eccLen || j >= numShort) codewords.push(block[i]);
        });
    }

    // Function patterns.
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
    const setFn = (x, y, dark) => {
        modules[y][x] = dark;
        isFunction[y][x] = true;
    };
    for (let i = 0; i < size; i++) {
        setFn(6, i, i % 2 === 0);
        setFn(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
        for (let dy = -4; dy <= 4; dy++) {
            for (let dx = -4; dx <= 4; dx++) {
                const x = cx + dx;
                const y = cy + dy;
                if (x < 0 || x >= size || y < 0 || y >= size) continue;
                const dist = Math.max(Math.abs(dx), Math.abs(dy));
                setFn(x, y, dist !== 2 && dist !== 4);
            }
        }
    }
    const align = alignmentPositions(ver, size);
    const last = align.length - 1;
    align.forEach((ax, i) => {
        align.forEach((ay, j) => {
            if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
            for (let dy = -2; dy <= 2; dy++) {
                for (let dx = -2; dx <= 2; dx++) setFn(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
            }
        });
    });
    const drawFormat = (mask) => {
        const fmt = (ECL_FORMAT_BITS_M << 3) | mask;
        let rem = fmt;
        for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
        const fbits = ((fmt << 10) | rem) ^ 0x5412;
        const bit = (i) => ((fbits >>> i) & 1) !== 0;
        for (let i = 0; i <= 5; i++) setFn(8, i, bit(i));
        setFn(8, 7, bit(6));
        setFn(8, 8, bit(7));
        setFn(7, 8, bit(8));
        for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(i));
        for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(i));
        for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(i));
        setFn(8, size - 8, true);
    };
    drawFormat(0); // reserves the area; redrawn once the mask is chosen
    if (ver >= 7) {
        let rem = ver;
        for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
        const vbits = (ver << 12) | rem;
        for (let i = 0; i < 18; i++) {
            const dark = ((vbits >>> i) & 1) !== 0;
            const a = size - 11 + (i % 3);
            const b = Math.floor(i / 3);
            setFn(a, b, dark);
            setFn(b, a, dark);
        }
    }

    // Codewords, zig-zagging up and down in two-module columns.
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < size; vert++) {
            for (let j = 0; j < 2; j++) {
                const x = right - j;
                const upward = ((right + 1) & 2) === 0;
                const y = upward ? size - 1 - vert : vert;
                if (!isFunction[y][x] && i < codewords.length * 8) {
                    modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
                    i++;
                }
            }
        }
    }

    // Try every mask and keep the one with the lowest penalty.
    const applyMask = (mask) => {
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) if (!isFunction[y][x] && MASKS[mask](x, y)) modules[y][x] = !modules[y][x];
        }
    };
    let best = 0;
    let bestPenalty = Infinity;
    for (let mask = 0; mask < 8; mask++) {
        applyMask(mask);
        drawFormat(mask);
        const p = penalty(modules, size);
        if (p < bestPenalty) {
            best = mask;
            bestPenalty = p;
        }
        applyMask(mask); // undo
    }
    applyMask(best);
    drawFormat(best);
    return modules;
}

function penalty(m, size) {
    let result = 0;
    // Runs of five or more in a row or column, and finder-like patterns.
    const finderLike = [true, false, true, true, true, false, true];
    for (const horizontal of [true, false]) {
        for (let a = 0; a < size; a++) {
            let run = 1;
            const line = [];
            for (let b = 0; b < size; b++) line.push(horizontal ? m[a][b] : m[b][a]);
            for (let b = 1; b < size; b++) {
                if (line[b] === line[b - 1]) {
                    run++;
                    if (run === 5) result += 3;
                    else if (run > 5) result++;
                } else run = 1;
            }
            for (let b = 0; b + 7 <= size; b++) {
                if (!finderLike.every((v, k) => line[b + k] === v)) continue;
                const before = b >= 4 && !line[b - 1] && !line[b - 2] && !line[b - 3] && !line[b - 4];
                const after = b + 11 <= size && !line[b + 7] && !line[b + 8] && !line[b + 9] && !line[b + 10];
                if (before || after) result += 40;
            }
        }
    }
    // 2x2 blocks of one colour.
    for (let y = 0; y < size - 1; y++) {
        for (let x = 0; x < size - 1; x++) {
            const c = m[y][x];
            if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) result += 3;
        }
    }
    // Balance of dark and light.
    let dark = 0;
    for (const row of m) for (const v of row) if (v) dark++;
    const total = size * size;
    result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return result;
}

/** An SVG drawing of the code, with the four-module quiet zone around it. */
export function svg(text, { dark = '#000', light = '#fff' } = {}) {
    const m = encode(text);
    const n = m.length + 8;
    let path = '';
    m.forEach((row, y) => {
        row.forEach((on, x) => {
            if (on) path += `M${x + 4},${y + 4}h1v1h-1z`;
        });
    });
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges">` +
        `<rect width="${n}" height="${n}" fill="${light}"/><path d="${path}" fill="${dark}"/></svg>`
    );
}
