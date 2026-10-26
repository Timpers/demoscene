"use strict";

// LHA "-lh5-" decompressor (LZ77 with an 8 KB window and dynamic Huffman blocks), written from the
// public description of the format. Handles the single-file, level-0 archives that .ym files use.
// Layout and sources: docs/ym2149-notes.md section 9.1.

const LHA_NC = 510;        // literal/length symbols: 256 literals + lengths 3..256 + 1
const LHA_NT = 19;         // symbols of the code-length code
const LHA_NP = 14;         // position slots (lh5: 13-bit window + 1)

// True if the bytes start with a level-0 "-lh5-" header
function lhaIsArchive(b) {
  return b.length > 22 && b[0] !== 0 &&
    String.fromCharCode(b[2], b[3], b[4], b[5], b[6]) === "-lh5-";
}

function lhaCrc16(data) {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let k = 0; k < 8; k++) crc = (crc & 1) ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
}

// Canonical Huffman code from code lengths: codes of equal length are consecutive in symbol order
function lhaHuffman(lens, n) {
  const count = new Uint16Array(17), start = new Uint16Array(18);
  for (let i = 0; i < n; i++) count[lens[i]]++;
  count[0] = 0;
  for (let l = 1; l <= 16; l++) start[l + 1] = start[l] + count[l];
  const sorted = new Uint16Array(n);
  const next = start.slice();
  for (let i = 0; i < n; i++) if (lens[i]) sorted[next[lens[i]]++] = i;
  return { count, sorted, constant: -1 };
}

// Returns { data, name, crcOk } for the first file in the archive
function lhaDepack(src) {
  if (!lhaIsArchive(src)) throw new Error("not an LHA -lh5- archive");
  const u32 = o => (src[o] | (src[o + 1] << 8) | (src[o + 2] << 16) | (src[o + 3] << 24)) >>> 0;
  const headerEnd = src[0] + 2;
  const packedSize = u32(7), origSize = u32(11), nameLen = src[21];
  if (src[20] !== 0) throw new Error("only level-0 LHA headers are supported");
  if (origSize > 64 * 1024 * 1024) throw new Error("unpacked size is implausibly large");
  const name = String.fromCharCode(...src.subarray(22, 22 + nameLen));
  const crcWanted = src[headerEnd - 2] | (src[headerEnd - 1] << 8);
  const end = Math.min(src.length, headerEnd + packedSize);

  // MSB-first bit reader
  let pos = headerEnd, acc = 0, nb = 0;
  const bits = n => {
    if (n === 0) return 0;
    while (nb < n) { acc = ((acc << 8) | (pos < end ? src[pos++] : 0)) >>> 0; nb += 8; }
    nb -= n;
    const v = (acc >>> nb) & ((1 << n) - 1);
    acc &= (1 << nb) - 1;
    return v;
  };
  const symbol = h => {
    if (h.constant >= 0) return h.constant;
    let code = 0, first = 0, index = 0;
    for (let len = 1; len <= 16; len++) {
      code |= bits(1);
      const cnt = h.count[len];
      if (code - cnt < first) return h.sorted[index + (code - first)];
      index += cnt; first += cnt; first <<= 1; code <<= 1;
    }
    throw new Error("bad Huffman code in LHA data");
  };
  const constant = c => ({ constant: c });

  // Length table for the code-length code (nn symbols, tbits bits for the count, special = index
  // after which a run of zeros is encoded, or -1)
  const readLens = (nn, tbits, special) => {
    const n = bits(tbits);
    if (n === 0) return constant(bits(tbits));
    const lens = new Uint8Array(nn);
    let i = 0;
    while (i < Math.min(n, nn)) {
      let c = bits(3);
      if (c === 7) while (bits(1)) c++;
      lens[i++] = c;
      if (i === special) { let z = bits(2); while (z-- > 0 && i < nn) lens[i++] = 0; }
    }
    return lhaHuffman(lens, nn);
  };

  const readCodeLens = ptH => {
    const n = bits(9);
    if (n === 0) return constant(bits(9));
    const lens = new Uint8Array(LHA_NC);
    let i = 0;
    while (i < Math.min(n, LHA_NC)) {
      let c = symbol(ptH);
      if (c <= 2) {
        c = c === 0 ? 1 : c === 1 ? bits(4) + 3 : bits(9) + 20;
        while (c-- > 0 && i < LHA_NC) lens[i++] = 0;
      } else {
        lens[i++] = c - 2;
      }
    }
    return lhaHuffman(lens, LHA_NC);
  };

  const out = new Uint8Array(origSize);
  let o = 0, blockLeft = 0, cH = null, pH = null;
  while (o < origSize) {
    if (blockLeft === 0) {
      blockLeft = bits(16);
      if (blockLeft === 0) throw new Error("empty LHA block");
      const ptH = readLens(LHA_NT, 5, 3);
      cH = readCodeLens(ptH);
      pH = readLens(LHA_NP, 4, -1);
    }
    blockLeft--;
    const c = symbol(cH);
    if (c < 256) {
      out[o++] = c;
    } else {
      const len = c - 256 + 3;
      let p = symbol(pH);
      if (p !== 0) p = (1 << (p - 1)) + bits(p - 1);
      if (p + 1 > o) throw new Error("LHA match points before the start of the data");
      for (let k = 0; k < len && o < origSize; k++, o++) out[o] = out[o - p - 1];
    }
  }
  return { data: out, name, crcOk: lhaCrc16(out) === crcWanted };
}

if (typeof module !== "undefined" && module.exports) module.exports = { lhaIsArchive, lhaDepack, lhaCrc16 };
