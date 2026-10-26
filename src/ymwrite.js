"use strict";

// Writes a song object (the shape parseYm returns) as a raw, interleaved YM5! file. Digidrums and
// effects are not written: this is for tunes made in code, such as the built-in one.

function ymWriteYm5(song) {
  const n = song.frames;
  const enc = s => Array.from(String(s), ch => ch.charCodeAt(0) & 255);
  const text = [...enc(song.title || ""), 0, ...enc(song.author || ""), 0, ...enc(song.comment || ""), 0];
  const head = new Uint8Array(34);
  const dv = new DataView(head.buffer);
  head.set(enc("YM5!LeOnArD!"), 0);
  dv.setUint32(12, n, false);
  dv.setUint32(16, 1, false);                    // attributes: interleaved
  dv.setUint16(20, 0, false);                    // no digidrums
  dv.setUint32(22, song.clock || 2000000, false);
  dv.setUint16(26, song.frameRate || 50, false);
  dv.setUint32(28, song.loopFrame || 0, false);
  dv.setUint16(32, 0, false);                    // no extra data
  const out = new Uint8Array(34 + text.length + n * 16);
  out.set(head, 0);
  out.set(text, 34);
  const base = 34 + text.length;
  for (let j = 0; j < n; j++) for (let k = 0; k < 16; k++) out[base + k * n + j] = song.regs[j * 16 + k];
  return out;
}

if (typeof module !== "undefined" && module.exports) module.exports = { ymWriteYm5 };
