"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { parseYm } = require("../src/ymfile.js");
const { lhaCrc16, lhaDepack, lhaIsArchive } = require("../src/lha.js");

const dataDir = path.join(__dirname, "data");
const ymDir = path.join(__dirname, "..", "ym");     // git-ignored local tunes, may be absent
const haveYm = fs.existsSync(ymDir);
const readData = name => fs.readFileSync(path.join(dataDir, name));
const localFiles = (filter = () => true) => haveYm ? fs.readdirSync(ymDir).filter(n => /\.ym$/i.test(n) && filter(n)) : [];

// Builds a YM5! file in memory
function buildYm5({ frames, interleaved = true, drums = [], title = "T", author = "A", comment = "C", loop = 0, clock = 2000000, rate = 50 }) {
  const n = frames.length;
  const head = Buffer.alloc(34);
  head.write("YM5!LeOnArD!", 0, "latin1");
  head.writeUInt32BE(n, 12); head.writeUInt32BE(interleaved ? 1 : 0, 16); head.writeUInt16BE(drums.length, 20);
  head.writeUInt32BE(clock, 22); head.writeUInt16BE(rate, 26); head.writeUInt32BE(loop, 28);
  const parts = [head];
  for (const d of drums) { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); parts.push(l, Buffer.from(d)); }
  parts.push(Buffer.from(`${title}\0${author}\0${comment}\0`, "latin1"));
  const data = Buffer.alloc(n * 16);
  frames.forEach((f, j) => { for (let k = 0; k < 16; k++) data[interleaved ? k * n + j : j * 16 + k] = f[k]; });
  parts.push(data);
  return Buffer.concat(parts);
}
const frame = fill => { const f = new Uint8Array(16); fill.forEach((v, i) => { f[i] = v; }); return f; };

test("CRC-16 matches the standard check value", () => {
  assert.equal(lhaCrc16(Buffer.from("123456789")), 0xbb3d);
});

test("parses our generated YM5 and YM6 test files", () => {
  const scale = parseYm(readData("scale.ym"));
  assert.equal(scale.format, "YM5!");
  assert.equal(scale.frames, 325);
  assert.equal(scale.frameRate, 50);
  assert.equal(scale.clock, 2000000);
  assert.equal(scale.title, "Scale");
  assert.equal(scale.packed, false);
  assert.equal(scale.regs.length, 325 * 16);
  assert.equal(scale.regs[0], 284 & 255, "A440 period low byte");
  assert.equal(scale.regs[1], 284 >> 8, "A440 period high byte");
  assert.equal(scale.regs[13], 0xff, "envelope shape left alone");
  const sid = parseYm(readData("sid-voice.ym"));
  assert.equal(sid.format, "YM6!");
  assert.equal(sid.regs[1] & 0xf0, 0x10, "SID effect on voice A");
  assert.equal(sid.regs[14], 100, "timer count");
  const env = parseYm(readData("envelopes.ym"));
  assert.equal(env.regs[13], 0, "shape 0 written on the first frame");
  assert.equal(env.regs[50 * 16 + 13], 1, "shape 1 on frame 50");
});

test("de-interleaves YM5, and reads non-interleaved YM5 the same way", () => {
  const frames = [frame([1, 2, 3]), frame([4, 5, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 15]), frame([7, 8, 9])];
  const a = parseYm(buildYm5({ frames, interleaved: true }));
  const b = parseYm(buildYm5({ frames, interleaved: false }));
  assert.deepEqual(a.regs, b.regs);
  assert.deepEqual(Array.from(a.regs.subarray(16, 19)), [4, 5, 6]);
  assert.equal(a.regs[16 + 15], 15);
});

test("reads text fields, clock, rate, loop frame and digidrum samples", () => {
  const frames = Array.from({ length: 10 }, () => frame([]));
  const y = parseYm(buildYm5({ frames, title: "Song", author: "Someone", comment: "Hi", loop: 4, clock: 1773400, rate: 60, drums: [[1, 2, 3], [], [9, 9]] }));
  assert.equal(y.title, "Song"); assert.equal(y.author, "Someone"); assert.equal(y.comment, "Hi");
  assert.equal(y.loopFrame, 4); assert.equal(y.clock, 1773400); assert.equal(y.frameRate, 60);
  assert.equal(y.drums.length, 3);
  assert.deepEqual(Array.from(y.drums[0].data), [1, 2, 3]);
  assert.equal(y.drums[1].data.length, 0);
  assert.deepEqual(Array.from(y.drums[2].data), [9, 9]);
  assert.equal(y.frames, 10);
});

test("a loop frame outside the song falls back to 0", () => {
  const y = parseYm(buildYm5({ frames: [frame([]), frame([])], loop: 99 }));
  assert.equal(y.loopFrame, 0);
});

test("parses YM3 and YM3b (14-byte interleaved frames, loop frame at the end)", () => {
  const body = Buffer.alloc(14 * 3);
  for (let k = 0; k < 14; k++) for (let j = 0; j < 3; j++) body[k * 3 + j] = k * 10 + j;
  const ym3 = parseYm(Buffer.concat([Buffer.from("YM3!"), body]));
  assert.equal(ym3.format, "YM3!");
  assert.equal(ym3.frames, 3);
  assert.equal(ym3.frameRate, 50);
  assert.equal(ym3.regs[16 + 5], 5 * 10 + 1);
  assert.equal(ym3.regs[14], 0, "R14 filled with zero");
  const tail = Buffer.alloc(4); tail.writeUInt32LE(2);
  const ym3b = parseYm(Buffer.concat([Buffer.from("YM3b"), body, tail]));
  assert.equal(ym3b.frames, 3);
  assert.equal(ym3b.loopFrame, 2);
});

test("rejects bad input with a clear error", () => {
  const good = buildYm5({ frames: [frame([]), frame([])] });
  const cases = {
    "empty": Buffer.alloc(0),
    "tiny": Buffer.from("YM"),
    "unknown format": Buffer.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"),
    "YM4": Buffer.from("YM4!LeOnArD!" + "x".repeat(40)),
    "tracker format": Buffer.from("YMT1LeOnArD!" + "x".repeat(40)),
    "truncated header": good.subarray(0, 20),
    "truncated data": good.subarray(0, good.length - 5),
    "bad signature": Buffer.concat([good.subarray(0, 4), Buffer.from("XeOnArD!"), good.subarray(12)]),
    "no frames": buildYm5({ frames: [] }),
    "zero frame rate": buildYm5({ frames: [frame([])], rate: 0 }),
    "bad clock": buildYm5({ frames: [frame([])], clock: 5 }),
    "huge frame count": (() => { const b = Buffer.from(good); b.writeUInt32BE(0xffffffff, 12); return b; })(),
    "huge drum table": (() => { const b = Buffer.from(good); b.writeUInt16BE(500, 20); return b; })(),
    "unterminated text": Buffer.concat([good.subarray(0, 34), Buffer.from("abc")]),
  };
  for (const [name, bytes] of Object.entries(cases)) {
    assert.throws(() => parseYm(bytes), Error, name);
  }
});

test("mutated files either parse or throw an Error, never hang or crash", () => {
  const base = readData("envelopes.ym");
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 500; i++) {
    const b = Buffer.from(base);
    for (let k = 0; k < 1 + Math.floor(rnd() * 6); k++) b[Math.floor(rnd() * 80)] = Math.floor(rnd() * 256);
    const cut = rnd() < 0.2 ? b.subarray(0, Math.floor(rnd() * b.length)) : b;
    try { parseYm(cut); } catch (e) { assert.ok(e instanceof Error); }
  }
});

test("local tunes: every LHA file unpacks and passes its CRC check", { skip: !haveYm && "no ym/ folder" }, () => {
  let packed = 0;
  for (const name of localFiles()) {
    const bytes = fs.readFileSync(path.join(ymDir, name));
    if (!lhaIsArchive(bytes)) continue;
    const r = lhaDepack(bytes);
    assert.ok(r.crcOk, `${name}: CRC mismatch`);
    packed++;
  }
  console.log(`  ${packed} compressed local files passed their CRC`);
});

test("local tunes: every file parses", { skip: !haveYm && "no ym/ folder" }, () => {
  for (const name of localFiles()) {
    const y = parseYm(fs.readFileSync(path.join(ymDir, name)));
    assert.ok(y.frames > 0, name);
    assert.equal(y.regs.length, y.frames * 16, name);
    assert.ok(y.packed === false || y.crcOk, name);
  }
});

test("local tunes: the TCB tunes read back as expected", { skip: !haveYm && "no ym/ folder" }, () => {
  const want = { "so watt 1.ym": ["YM6!", 8450, "SoWatt Tune 1"], "so watt 3.ym": ["YM6!", 11600, "SoWatt Tune 3"],
    "m-demo 1 - anbass.ym": ["YM5!", 4999, "M-Demo 1 : ANbass"] };
  for (const [name, [format, frames, title]] of Object.entries(want)) {
    if (!fs.existsSync(path.join(ymDir, name))) continue;
    const y = parseYm(fs.readFileSync(path.join(ymDir, name)));
    assert.equal(y.format, format, name); assert.equal(y.frames, frames, name); assert.equal(y.title, title, name);
    assert.ok(y.packed && y.crcOk, name);
  }
});

test("corrupt LHA data throws or returns, and does not hang", { skip: !haveYm && "no ym/ folder" }, () => {
  const name = localFiles(n => /so watt 2/i.test(n))[0] || localFiles()[0];
  if (!name) return;
  const base = fs.readFileSync(path.join(ymDir, name));
  if (!lhaIsArchive(base)) return;
  let seed = 777;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 300; i++) {
    const b = Buffer.from(base);
    for (let k = 0; k < 1 + Math.floor(rnd() * 8); k++) b[30 + Math.floor(rnd() * (b.length - 30))] = Math.floor(rnd() * 256);
    try {
      const r = lhaDepack(rnd() < 0.2 ? b.subarray(0, Math.floor(rnd() * b.length)) : b);
      assert.ok(r.data instanceof Uint8Array);
    } catch (e) { assert.ok(e instanceof Error); }
  }
});
