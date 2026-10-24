/* Minimal offline QR Code encoder for the phone-pairing URL.
   Byte mode, error correction level M, versions 1-10 (up to 213 bytes). No dependencies, no network.
   Algorithm follows ISO/IEC 18004 (Reed-Solomon over GF(256), 8 mask patterns, penalty scoring). */
(function (root) {
  'use strict';
  const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26]; // level M, index = version
  const NUM_BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  const MAX_VERSION = 10;

  const rawModules = ver => {
    let n = (16 * ver + 128) * ver + 64;
    if (ver >= 2) { const a = Math.floor(ver / 7) + 2; n -= (25 * a - 10) * a - 55; if (ver >= 7) n -= 36; }
    return n;
  };
  const dataCodewords = ver => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];

  function gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11d); z ^= ((y >>> i) & 1) * x; }
    return z;
  }
  function rsDivisor(degree) {
    const result = new Array(degree).fill(0); result[degree - 1] = 1;
    let r = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < degree; j++) { result[j] = gfMul(result[j], r); if (j + 1 < degree) result[j] ^= result[j + 1]; }
      r = gfMul(r, 2);
    }
    return result;
  }
  function rsRemainder(data, divisor) {
    const result = divisor.map(() => 0);
    for (const b of data) {
      const factor = b ^ result.shift(); result.push(0);
      divisor.forEach((c, i) => { result[i] ^= gfMul(c, factor); });
    }
    return result;
  }

  function utf8(text) { return Array.from(new TextEncoder().encode(text)); }

  function buildCodewords(bytes, ver) {
    const bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(0x4, 4); put(bytes.length, ver >= 10 ? 16 : 8);
    bytes.forEach(b => put(b, 8));
    const capacity = dataCodewords(ver) * 8;
    put(0, Math.min(4, capacity - bits.length));
    put(0, (8 - bits.length % 8) % 8);
    for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));

    const blocks = [], nb = NUM_BLOCKS[ver], eccLen = ECC_PER_BLOCK[ver];
    const rawCw = Math.floor(rawModules(ver) / 8), shortCount = nb - rawCw % nb, shortLen = Math.floor(rawCw / nb);
    const divisor = rsDivisor(eccLen);
    for (let i = 0, k = 0; i < nb; i++) {
      const dat = data.slice(k, k + shortLen - eccLen + (i < shortCount ? 0 : 1)); k += dat.length;
      const ecc = rsRemainder(dat, divisor);
      if (i < shortCount) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    const out = [];
    for (let i = 0; i < blocks[0].length; i++) {
      blocks.forEach((block, j) => { if (i !== shortLen - eccLen || j >= shortCount) out.push(block[i]); });
    }
    return out;
  }

  function encode(text) {
    const bytes = utf8(String(text));
    let ver = 1;
    for (; ver <= MAX_VERSION; ver++) {
      const lenBits = ver >= 10 ? 16 : 8;
      if (4 + lenBits + bytes.length * 8 <= dataCodewords(ver) * 8) break;
    }
    if (ver > MAX_VERSION) throw new RangeError('QR: text too long');
    const size = ver * 4 + 17;
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const isFn = Array.from({ length: size }, () => new Array(size).fill(false));
    const setFn = (x, y, dark) => { modules[y][x] = dark; isFn[y][x] = true; };

    for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
    [[3, 3], [size - 4, 3], [3, size - 4]].forEach(([cx, cy]) => {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy)), x = cx + dx, y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, d !== 2 && d !== 4);
      }
    });
    const pos = ALIGN[ver], n = pos.length;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    const drawFormat = mask => {
      const data = (0 << 3) | mask; // ECC level M = 0b00
      let rem = data;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const bits = ((data << 10) | rem) ^ 0x5412, bit = i => ((bits >>> i) & 1) !== 0;
      for (let i = 0; i <= 5; i++) setFn(8, i, bit(i));
      setFn(8, 7, bit(6)); setFn(8, 8, bit(7)); setFn(7, 8, bit(8));
      for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(i));
      setFn(8, size - 8, true);
    };
    drawFormat(0);
    if (ver >= 7) {
      let rem = ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = ((bits >>> i) & 1) !== 0, a = size - 11 + i % 3, b = Math.floor(i / 3);
        setFn(a, b, bit); setFn(b, a, bit);
      }
    }

    const codewords = buildCodewords(bytes, ver);
    for (let i = 0, right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert;
        if (!isFn[y][x] && i < codewords.length * 8) { modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0; i++; }
      }
    }

    const maskFn = [
      (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0,
      (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0
    ];
    const applyMask = m => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFn[y][x] && maskFn[m](x, y)) modules[y][x] = !modules[y][x]; };
    const penalty = () => {
      let score = 0;
      const line = get => {
        let run = 1, hist = [];
        for (let i = 1; i < size; i++) {
          if (get(i) === get(i - 1)) { run++; } else { if (run >= 5) score += run - 2; hist.push(run); run = 1; }
        }
        if (run >= 5) score += run - 2; hist.push(run);
        // finder-like 1:1:3:1:1 with 4 light modules on either side
        for (let i = 0; i + 4 < hist.length; i++) {
          const [a, b, c, d, e] = hist.slice(i, i + 5);
          if (b === a && c === 3 * a && d === a && e === a) score += 40;
        }
      };
      for (let y = 0; y < size; y++) line(i => modules[y][i]);
      for (let x = 0; x < size; x++) line(i => modules[i][x]);
      for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
        const c = modules[y][x]; if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
      }
      const dark = modules.reduce((s, row) => s + row.filter(Boolean).length, 0), total = size * size;
      score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
      return score;
    };
    let best = 0, bestScore = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m); drawFormat(m);
      const s = penalty(); if (s < bestScore) { best = m; bestScore = s; }
      applyMask(m);
    }
    applyMask(best); drawFormat(best);
    return { version: ver, size, modules };
  }

  /* SVG string: white quiet zone (4 modules) + dark modules. crispEdges keeps scanning reliable. */
  function toSvg(text, border = 4) {
    const { size, modules } = encode(text), dim = size + border * 2;
    let path = '';
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (modules[y][x]) path += 'M' + (x + border) + ' ' + (y + border) + 'h1v1h-1z';
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim + '" shape-rendering="crispEdges" role="img" aria-label="スマホ接続用QRコード">' +
      '<rect width="' + dim + '" height="' + dim + '" fill="#fff"/><path d="' + path + '" fill="#111"/></svg>';
  }

  root.ErgoQR = { encode, toSvg, MAX_VERSION };
})(globalThis);
