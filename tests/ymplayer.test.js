"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { YM2149 } = require("../src/ym2149.js");
const { YMPlayer } = require("../src/ymplayer.js");
const { parseYm } = require("../src/ymfile.js");

const ymDir = path.join(__dirname, "..", "ym");

// Builds an in-memory song object (what parseYm returns) from per-frame register arrays
function song(frames, extra = {}) {
  const regs = new Uint8Array(frames.length * 16);
  frames.forEach((f, j) => { for (let k = 0; k < 16; k++) regs[j * 16 + k] = f[k] === undefined ? (k === 13 ? 0xff : 0) : f[k]; });
  return { format: "YM6!", frames: frames.length, regs, clock: 2000000, frameRate: 50, loopFrame: 0,
    drums: [], drum4bit: false, drumSigned: false, title: "", author: "", comment: "", ...extra };
}
const fr = (obj) => { const f = new Array(16).fill(undefined); for (const [k, v] of Object.entries(obj)) f[+k] = v; return f; };
const same = (n, obj) => Array.from({ length: n }, () => fr(obj));

function render(p, seconds) {
  const n = Math.round(seconds * p.sampleRate), b = new Float32Array(n);
  p.render(b, n);
  return b;
}
// Frequency from rising edges, with hysteresis so that filter ringing near an edge counts only once
function measureHz(buf, rate) {
  let lo = Infinity, hi = -Infinity;
  for (const v of buf) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const low = lo + 0.25 * (hi - lo), high = lo + 0.75 * (hi - lo);
  let state = buf[0] > high, edges = 0, first = -1, last = -1;
  for (let i = 1; i < buf.length; i++) {
    if (!state && buf[i] > high) { state = true; edges++; if (first < 0) first = i; last = i; }
    else if (state && buf[i] < low) state = false;
  }
  return (edges - 1) * rate / (last - first);
}
const rawOpts = { sampleRate: 48000, dcBlock: false };

test("timer frequency: 2457600 / (prescale x count), and zero means no effect", () => {
  assert.equal(YMPlayer.timerHz(2, 100), 2457.6);
  assert.equal(YMPlayer.timerHz(7, 1), 12288);
  assert.equal(YMPlayer.timerHz(0, 100), 0);
  assert.equal(YMPlayer.timerHz(3, 0), 0);
  assert.equal(YMPlayer.timerHz(10, 4), YMPlayer.timerHz(2, 4), "index uses 3 bits");
});

test("frames advance sample-accurately, with no drift when frames are not a whole number of samples", () => {
  for (const [rate, fps] of [[48000, 50], [44100, 50], [8000, 49], [22050, 60]]) {
    const p = new YMPlayer(song(same(4000, { 7: 0x3f }), { frameRate: fps }), { sampleRate: rate, loop: false });
    const seen = [];
    p.onFrame = j => seen.push([j, p.samplesPlayed]);
    const total = Math.round(rate * 60);
    p.render(new Float32Array(total), total);
    for (const [j, at] of seen) {
      const ideal = j * rate / fps;
      assert.ok(Math.abs(at - ideal) <= 1 + 1e-9, `rate ${rate} fps ${fps} frame ${j}: started at sample ${at}, ideal ${ideal.toFixed(2)}`);
    }
    assert.ok(Math.abs(seen.length - 60 * fps) <= 1);
  }
});

test("loops back to the loop frame, or stops and goes silent without looping", () => {
  const s = song(same(10, { 0: 50, 7: 0x3e, 8: 15 }), { loopFrame: 4, frameRate: 50 });
  const p = new YMPlayer(s, { sampleRate: 8000 });
  const seen = [];
  p.onFrame = j => seen.push(j);
  p.render(new Float32Array(8000 * 0.2 * 2.5), 8000 * 0.5);
  assert.deepEqual(seen.slice(0, 16), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 4, 5, 6, 7, 8, 9]);
  const q = new YMPlayer(s, { sampleRate: 8000, loop: false });
  const buf = new Float32Array(8000);
  q.render(buf, 8000);
  assert.ok(q.finished);
  let tail = 0; for (let i = 8000 * 0.2 + 100; i < 8000; i++) tail = Math.max(tail, Math.abs(buf[i]));
  assert.equal(tail, 0, "silent after the end");
});

test("pause holds the position and renders silence; seek jumps", () => {
  const p = new YMPlayer(song(same(100, { 0: 50, 7: 0x3e, 8: 15 })), { sampleRate: 8000 });
  const seen = []; p.onFrame = j => seen.push(j);
  p.render(new Float32Array(800), 800);
  const f = p.frame;
  p.pause();
  const b = new Float32Array(800).fill(1);
  p.render(b, 800);
  assert.equal(p.frame, f);
  assert.ok(b.every(v => v === 0));
  p.play(); p.seek(50);
  seen.length = 0;
  p.render(new Float32Array(200), 200);
  assert.equal(seen[0], 50);
});

test("R13 = 0xFF leaves the envelope alone; any other value restarts it", () => {
  const frames = [fr({ 11: 1, 13: 0x0c }), fr({ 13: 0xff }), fr({ 13: 0x0c })];
  const p = new YMPlayer(song(frames), { sampleRate: 8000, loop: false });
  const pos = [];
  p.onFrame = j => pos.push(p.chip.envPos);
  p.render(new Float32Array(8000 / 50 * 3), 8000 / 50 * 3);
  assert.equal(pos[0], 0, "restarted by the first write");
  assert.ok(pos[1] > 0, "kept running through the 0xFF frame");
  assert.equal(pos[2], 0, "restarted again by the third frame");
});

test("YM6 effect decoding: SID, sync-buzzer, digidrum and the no-effect cases", () => {
  const mk = (r) => { const p = new YMPlayer(song([fr(r), fr({})], { drums: [{ data: new Uint8Array([200, 100]) }] }), { sampleRate: 48000 }); p.chip.reset(); p.startFrame(); return p; };
  // SID on voice B (code 0x20 in R1), prescale index 2, count 100, volume 9
  let p = mk({ 1: 0x20, 6: 2 << 5, 14: 100, 9: 9 });
  assert.deepEqual(Array.from(p.chip.sidOn), [0, 1, 0]);
  assert.equal(p.chip.sidVol[1], 9);
  assert.ok(Math.abs(p.chip.sidHalf[1] - 250000 / 2457.6) < 1e-6);
  // sync-buzzer (code 0xC0 | voice), shape taken from the low nibble of that voice's level register
  p = mk({ 3: 0xe0, 8: 0x1b, 6: 0, 9: 0x1d, 15: 10 });          // slot 2: prescale from R8 bits 5-7
  assert.equal(p.chip.syncOn, false, "prescale index 0 in R8 means off");
  p = mk({ 3: 0xe0, 8: (4 << 5) | 0x1b, 9: 0x1d, 15: 10 });
  assert.equal(p.chip.syncOn, true);
  assert.equal(p.chip.syncShape, 0x0d, "shape from R9 low nibble (voice B)");
  // digidrum on voice A, sample 0
  p = mk({ 1: 0x50, 6: 3 << 5, 14: 20, 8: 0 });
  assert.equal(p.chip.drumOn[0], 1);
  // digidrum sample number outside the table is ignored
  p = mk({ 1: 0x50, 6: 3 << 5, 14: 20, 8: 5 });
  assert.equal(p.chip.drumOn[0], 0);
  // zero count or zero prescale: no effect
  p = mk({ 1: 0x10, 6: 2 << 5, 14: 0 });
  assert.equal(p.chip.sidOn[0], 0);
  p = mk({ 1: 0x10, 6: 0, 14: 50 });
  assert.equal(p.chip.sidOn[0], 0);
  // effect code with no voice bits (the "extended" codes) and sinus-SID: ignored
  p = mk({ 1: 0x40, 6: 2 << 5, 14: 50 });
  assert.equal(p.chip.fxActive, false);
  p = mk({ 1: 0x90, 6: 2 << 5, 14: 50 });
  assert.equal(p.chip.fxActive, false);
});

test("YM5 decodes SID from R1/R6/R14 and digidrum from R3/R8/R15", () => {
  const s = song([fr({ 1: 0x10, 6: 2 << 5, 14: 50, 3: 0x20, 8: (4 << 5) | 1, 9: 0, 15: 10 }), fr({})],
    { format: "YM5!", drums: [{ data: new Uint8Array([10, 20]) }, { data: new Uint8Array([30, 40]) }] });
  const p = new YMPlayer(s, { sampleRate: 48000 });
  p.startFrame();
  assert.equal(p.chip.sidOn[0], 1);
  assert.equal(p.chip.drumOn[1], 1, "digidrum on voice B");
  assert.equal(p.chip.drumData[1][0], 10, "sample number comes from R9 (voice B level), here 0, the first drum");
});

test("effects last one frame: SID and sync stop when the next frame does not ask for them", () => {
  const s = song([fr({ 1: 0x10, 6: 2 << 5, 14: 50, 8: 9 }), fr({ 8: 9 })]);
  const p = new YMPlayer(s, { sampleRate: 48000, loop: false });
  const seen = [];
  p.onFrame = j => seen.push([j, p.chip.sidOn[0]]);
  p.render(new Float32Array(960 * 2), 960 * 2);
  assert.deepEqual(seen, [[0, 1], [1, 0]]);
});

test("a digidrum keeps playing across frames until its sample ends", () => {
  const data = new Uint8Array(2000).fill(255);          // at 2457600/(50*10) = 4915 Hz: about 0.41 s, 20 frames
  const s = song([fr({ 1: 0x50, 6: 4 << 5, 14: 10, 8: 0, 7: 0x3f }), ...same(40, { 7: 0x3f })], { drums: [{ data }] });
  const p = new YMPlayer(s, { sampleRate: 48000, loop: false });
  const state = [];
  p.onFrame = j => state.push(p.chip.drumOn[0]);
  p.render(new Float32Array(960 * 41), 960 * 41);
  const ends = state.indexOf(0);
  assert.ok(ends >= 19 && ends <= 22, `drum ended at frame ${ends}`);
});

// ---- the effects, measured ----

test("SID voice: the level gate runs at the timer frequency / 2", () => {
  // tone and noise off, so the channel is steady unless the SID gate moves it
  const hz = YMPlayer.timerHz(3, 20);                    // 7680 Hz timer
  const frames = same(150, { 1: 0x10, 6: 3 << 5, 14: 20, 7: 0x3f, 8: 15 });
  const p = new YMPlayer(song(frames), { ...rawOpts, loop: false });
  render(p, 0.1);
  const got = measureHz(render(p, 1.0), 48000);
  assert.ok(Math.abs(got / (hz / 2) - 1) < 0.01, `${got.toFixed(1)} Hz vs ${hz / 2} Hz`);
});

test("SID voice: gating is between the written volume and silence", () => {
  const frames = same(50, { 1: 0x10, 6: 3 << 5, 14: 20, 7: 0x3f, 8: 10 });
  const p = new YMPlayer(song(frames), { ...rawOpts, loop: false });
  const buf = render(p, 0.5).subarray(2000);
  let lo = Infinity, hi = -Infinity;
  for (const v of buf) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const unit = YM2149.levelToAmp(10) / 3;
  // a low-passed square wave overshoots by up to about 10%, so allow for that
  assert.ok(hi > unit * 0.95 && hi < unit * 1.15, `high ${hi} vs ${unit}`);
  assert.ok(lo < unit * 0.1 && lo > -unit * 0.15, `low ${lo}`);
});

test("sync-buzzer: the envelope restarts at the timer frequency", () => {
  // shape 13 (attack once, then hold at the top), fast envelope: a pulse that restarts at the timer rate
  const hz = YMPlayer.timerHz(4, 49);                    // about 1003 Hz
  const frames = same(150, { 3: 0xd0, 8: (4 << 5) | 0x1d, 15: 49, 7: 0x3f, 11: 1, 12: 0 });
  // slot 2 on voice A: R8 bits 5-7 give the prescale, R15 the count, and R8 low 5 bits are the envelope bit plus shape 13
  const p = new YMPlayer(song(frames), { ...rawOpts, loop: false });
  render(p, 0.1);
  const got = measureHz(render(p, 1.0), 48000);
  assert.ok(Math.abs(got / hz - 1) < 0.01, `${got.toFixed(1)} Hz vs ${hz.toFixed(1)} Hz`);
});

test("digidrum: plays its samples at the requested rate, as linear amplitude", () => {
  // alternating 255 and 0 at 4915.2 Hz is a square wave at half that rate
  const data = new Uint8Array(4000); for (let i = 0; i < data.length; i += 2) data[i] = 255;
  const rate = YMPlayer.timerHz(4, 10);
  const frames = [fr({ 1: 0x50, 6: 4 << 5, 14: 10, 8: 0, 7: 0x3f }), ...same(60, { 7: 0x3f })];
  const p = new YMPlayer(song(frames, { drums: [{ data }] }), { ...rawOpts, loop: false });
  const buf = render(p, 0.5);
  const got = measureHz(buf.subarray(500, 12000), 48000);
  assert.ok(Math.abs(got / (rate / 2) - 1) < 0.01, `${got.toFixed(1)} Hz vs ${rate / 2} Hz`);
  let hi = -Infinity; for (let i = 500; i < 12000; i++) hi = Math.max(hi, buf[i]);
  assert.ok(Math.abs(hi - 1 / 3) < 0.05, `peak ${hi}: full-scale sample is a full-level channel (1/3 of the mix)`);
});

test("digidrum: 4-bit samples go through the chip's level table", () => {
  const out = YMPlayer.drumAmplitudes(new Uint8Array([0, 8, 15, 0xf5]), true);
  assert.deepEqual(Array.from(out), [YM2149.LEVELS_4BIT[0] >> 7, YM2149.LEVELS_4BIT[8] >> 7, 255, YM2149.LEVELS_4BIT[5] >> 7]);
  const raw = new Uint8Array([1, 2, 3]);
  assert.equal(YMPlayer.drumAmplitudes(raw, false), raw, "8-bit samples are used as they are");
});

test("a digidrum overrides its channel and then hands it back", () => {
  const data = new Uint8Array(40).fill(255);
  const frames = [fr({ 1: 0x50, 6: 4 << 5, 14: 10, 8: 0, 7: 0x3f }), ...same(3, { 7: 0x3f })];
  const p = new YMPlayer(song(frames, { drums: [{ data }] }), { ...rawOpts, loop: false });
  p.startFrame();
  assert.equal(p.chip.override[0], 1);
  p.render(new Float32Array(48000 * 0.05), 48000 * 0.05);
  assert.equal(p.chip.override[0], -1, "released after the sample");
});

// ---- real tunes, if present locally ----

function playReal(name, seconds, check, needAudible = true) {
  const file = path.join(ymDir, name);
  if (!fs.existsSync(file)) return;
  const s = parseYm(fs.readFileSync(file));
  const p = new YMPlayer(s, { sampleRate: 48000, loop: false });
  const buf = render(p, seconds);
  let peak = 0;
  for (const v of buf) { assert.ok(Number.isFinite(v), name); peak = Math.max(peak, Math.abs(v)); }
  if (needAudible) assert.ok(peak > 0.05, `${name}: audible`);
  assert.ok(peak < 1.3, `${name}: peak ${peak}`);
  if (check) check(p, s);
}

test("real tunes with effects play without problems", { skip: !fs.existsSync(ymDir) && "no ym/ folder" }, () => {
  for (const n of ["VirtualEscape1.YM", "VirtualEscape2.ym", "ND-Loader.ym", "ND-Toxygene.ym"]) playReal(n, 16);
  let sidSeen = 0;
  const file = path.join(ymDir, "VirtualEscape1.YM");
  if (fs.existsSync(file)) {
    const p = new YMPlayer(parseYm(fs.readFileSync(file)), { sampleRate: 48000, loop: false });
    p.onFrame = () => { if (p.chip.sidOn.some(Boolean)) sidSeen++; };
    render(p, 10);
    assert.ok(sidSeen > 50, `SID voice started on ${sidSeen} frames`);
  }
  playReal("jess2.ym", 25);
  const jess = path.join(ymDir, "jess2.ym");
  if (fs.existsSync(jess)) {
    const p = new YMPlayer(parseYm(fs.readFileSync(jess)), { sampleRate: 48000, loop: false });
    let drums = 0; p.onFrame = () => { if (p.chip.drumOn.some(Boolean)) drums++; };
    render(p, 25);
    assert.ok(drums > 20, `digidrums playing on ${drums} frames`);
  }
});

test("every local tune plays for a few seconds without errors", { skip: !fs.existsSync(ymDir) && "no ym/ folder" }, () => {
  for (const name of fs.readdirSync(ymDir).filter(n => /\.ym$/i.test(n))) playReal(name, 3, null, false);
});
