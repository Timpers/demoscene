"use strict";

// YM file parser: YM2!/YM3!/YM3b/YM5!/YM6! (raw or LHA-wrapped) into a frame-major register table.
// Format details and sources: docs/ym2149-notes.md section 9.

const _ym = (typeof module !== "undefined" && module.exports && typeof require === "function")
  ? require("./lha.js")
  : { lhaIsArchive, lhaDepack };

const YM_ATTR_INTERLEAVED = 1, YM_ATTR_DRUM_SIGNED = 2, YM_ATTR_DRUM_4BIT = 4;
const YM_ATARI_CLOCK = 2000000;

// Returns {
//   format ("YM2!" | "YM3!" | "YM3b" | "YM5!" | "YM6!"), packed (bool), crcOk (bool | null),
//   frames (count), regs (Uint8Array frames x 16, frame-major), clock, frameRate, loopFrame,
//   drums (array of { data: Uint8Array, ... }), drum4bit, drumSigned, title, author, comment
// }
// Throws an Error with a readable message on bad input.
function parseYm(input) {
  let bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let packed = false, crcOk = null;
  if (_ym.lhaIsArchive(bytes)) {
    const r = _ym.lhaDepack(bytes);
    bytes = r.data; packed = true; crcOk = r.crcOk;
  }
  if (bytes.length < 4) throw new Error("not a YM file (too short)");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const id = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const out = { format: id, packed, crcOk, clock: YM_ATARI_CLOCK, frameRate: 50, loopFrame: 0,
    drums: [], drum4bit: false, drumSigned: false, title: "", author: "", comment: "" };

  const deinterleave = (data, frames, width) => {
    const regs = new Uint8Array(frames * 16);
    for (let j = 0; j < frames; j++) for (let k = 0; k < width; k++) regs[j * 16 + k] = data[k * frames + j];
    return regs;
  };

  if (id === "YM2!" || id === "YM3!" || id === "YM3b") {
    // 14 registers per frame, always interleaved. YM3b keeps its loop frame in the last 4 bytes.
    const tail = id === "YM3b" ? 4 : 0;
    const frames = Math.floor((bytes.length - 4 - tail) / 14);
    if (frames < 1) throw new Error("YM file has no frames");
    out.frames = frames;
    out.regs = deinterleave(bytes.subarray(4, 4 + frames * 14), frames, 14);
    if (id === "YM3b") out.loopFrame = dv.getUint32(bytes.length - 4, true);
    out.title = "(untitled)";
    return out;
  }

  if (id === "YM4!") throw new Error("YM4! files are not supported");
  if (id !== "YM5!" && id !== "YM6!") {
    if (id === "MIX1" || id === "YMT1" || id === "YMT2") throw new Error(id + " files are not supported");
    throw new Error("not a YM file (unknown format " + JSON.stringify(id) + ")");
  }

  if (bytes.length < 34) throw new Error("YM file header is truncated");
  const sig = String.fromCharCode(...bytes.subarray(4, 12));
  if (sig !== "LeOnArD!") throw new Error("YM header signature is wrong");
  const frames = dv.getUint32(12, false), attr = dv.getUint32(16, false), nDrums = dv.getUint16(20, false);
  out.clock = dv.getUint32(22, false);
  out.frameRate = dv.getUint16(26, false);
  out.loopFrame = dv.getUint32(28, false);
  let p = 34 + dv.getUint16(32, false);
  out.drum4bit = !!(attr & YM_ATTR_DRUM_4BIT);
  out.drumSigned = !!(attr & YM_ATTR_DRUM_SIGNED);
  if (frames < 1) throw new Error("YM file has no frames");
  if (out.frameRate < 1 || out.frameRate > 1000) throw new Error("YM frame rate is implausible");
  if (out.clock < 100000) throw new Error("YM master clock is implausible");

  for (let i = 0; i < nDrums; i++) {
    if (p + 4 > bytes.length) throw new Error("YM digidrum table is truncated");
    const size = dv.getUint32(p, false); p += 4;
    if (p + size > bytes.length) throw new Error("YM digidrum sample is truncated");
    out.drums.push({ data: bytes.slice(p, p + size) });
    p += size;
  }
  const str = () => {
    let e = p;
    while (e < bytes.length && bytes[e] !== 0) e++;
    if (e >= bytes.length) throw new Error("YM text fields are truncated");
    const s = String.fromCharCode(...bytes.subarray(p, e));
    p = e + 1;
    return s;
  };
  out.title = str(); out.author = str(); out.comment = str();

  if (p + frames * 16 > bytes.length) throw new Error("YM frame data is truncated");
  out.frames = frames;
  const data = bytes.subarray(p, p + frames * 16);
  out.regs = (attr & YM_ATTR_INTERLEAVED) ? deinterleave(data, frames, 16) : Uint8Array.from(data);
  if (out.loopFrame >= frames) out.loopFrame = 0;
  return out;
}

if (typeof module !== "undefined" && module.exports) module.exports = { parseYm };
