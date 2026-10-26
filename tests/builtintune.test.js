"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { ymBuiltinTune } = require("../src/builtintune.js");
const { ymWriteYm5 } = require("../src/ymwrite.js");
const { parseYm } = require("../src/ymfile.js");
const { YMPlayer } = require("../src/ymplayer.js");
const { ymPartAt, YMBeat } = require("../src/musicsync.js");

const RATE = 48000, BAR = 96, STEP = 6;
const hz = n => 440 * 2 ** ((n - 69) / 12);
const tp = n => Math.round(2000000 / (16 * hz(n)));
const song = ymBuiltinTune();
const reg = (f, k) => song.regs[f * 16 + k];
const tone = (f, ch) => reg(f, ch * 2) | (reg(f, ch * 2 + 1) << 8);
const frameAt = (bar, step, fr = 0) => bar * BAR + step * STEP + fr;
const toneOn = (f, ch) => !((reg(f, 7) >> ch) & 1);
const noiseOn = (f, ch) => !((reg(f, 7) >> (3 + ch)) & 1);

// Strongest frequency between lo and hi Hz, by Goertzel
function peakHz(buf, lo, hi) {
  let best = 0, bestP = -1;
  for (let f = lo; f <= hi; f += 1) {
    const w = 2 * Math.PI * f / RATE, c = 2 * Math.cos(w);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < buf.length; i++) { const s0 = buf[i] + c * s1 - s2; s2 = s1; s1 = s0; }
    const p = s1 * s1 + s2 * s2 - c * s1 * s2;
    if (p > bestP) { bestP = p; best = f; }
  }
  return best;
}

let rendered = null;                     // two passes of the tune, rendered once and shared
function renderTwoPasses() {
  if (rendered) return rendered;
  const p = new YMPlayer(song, { sampleRate: RATE, loop: true });
  const spf = RATE / 50, n = Math.round(2 * song.frames * spf);
  const buf = new Float32Array(n);
  p.render(buf, n);
  return (rendered = { buf, spf, p });
}
const slice = (r, f0, f1) => r.buf.subarray(Math.round(f0 * r.spf), Math.round(f1 * r.spf));

test("the built-in tune is 61.4 s, 50 Hz, looping from the start", () => {
  assert.equal(song.frames, 32 * BAR);
  assert.equal(song.frameRate, 50);
  assert.equal(song.clock, 2000000);
  assert.equal(song.loopFrame, 0);
  assert.equal(song.regs.length, song.frames * 16);
  assert.equal(song.title, "Pixel Riot Theme");
});

test("every register value is legal for the chip, and no effect bits are set", () => {
  for (let f = 0; f < song.frames; f++) {
    for (const k of [1, 3, 5]) assert.ok(reg(f, k) <= 15, `frame ${f} R${k}`);
    assert.ok(reg(f, 6) <= 31, `frame ${f} R6`);
    for (const k of [8, 9, 10]) assert.ok(reg(f, k) <= 31, `frame ${f} R${k}`);
    assert.ok(reg(f, 13) === 0xff || reg(f, 13) <= 15, `frame ${f} R13`);
    assert.equal(reg(f, 7) & 0xc0, 0, `frame ${f} mixer I/O bits`);
    assert.equal(reg(f, 14) | reg(f, 15), 0, `frame ${f} effect counts`);
  }
});

test("it is deterministic", () => {
  assert.deepEqual(ymBuiltinTune().regs, song.regs);
});

test("the notes are the ones from the original tune", () => {
  // bar 0 is Am: after the kick, the bass sounds A2 (110 Hz); channel C arpeggiates A, C, E, C from A3
  assert.equal(tone(frameAt(0, 0, 4), 1), tp(45), "bass A2");
  assert.deepEqual([4, 5, 6, 7].map(f => tone(f, 2)), [tp(57), tp(60), tp(64), tp(60)], "arpeggio A3 C4 E4 C4");
  // bar 1 is F, bar 2 is C, bar 3 is G
  assert.equal(tone(frameAt(1, 0, 4), 1), tp(41), "bass F2");
  assert.equal(tone(frameAt(2, 0, 4), 1), tp(36), "bass C2");
  assert.equal(tone(frameAt(3, 0, 4), 1), tp(43), "bass G2");
  // the lead enters at bar 4 with A5 on the first step, then G5 on the fourth
  assert.equal(tone(frameAt(4, 0, 1), 0), tp(81), "lead A5");
  assert.ok(reg(frameAt(4, 0, 1), 8) >= 10, "lead is loud");
  assert.equal(tone(frameAt(4, 3, 1), 0), tp(79), "lead G5");
  assert.equal(reg(frameAt(0, 4), 8), 0, "no lead in the intro");
  // second half of a bar goes up an octave from bar 8
  assert.equal(tone(frameAt(8, 8, 0), 2), tp(57 + 12), "arpeggio an octave up");
  assert.equal(tone(frameAt(8, 0, 0), 2), tp(57), "and the first half stays low");
});

test("the kick sweeps down and clicks, and the snare is noise on channel C", () => {
  const f0 = frameAt(2, 0);
  assert.deepEqual([0, 1, 2, 3].map(i => tone(f0 + i, 1)), [833, 1400, 2000, 2778], "pitch falls");
  assert.deepEqual([0, 1, 2, 3].map(i => noiseOn(f0 + i, 1)), [true, false, false, false], "a click of noise on the first frame");
  assert.ok(reg(f0, 9) === 15 && reg(f0 + 3, 9) < reg(f0, 9));
  const s = frameAt(2, 4);
  for (let i = 0; i < 5; i++) { assert.ok(noiseOn(s + i, 2) && !toneOn(s + i, 2), `snare frame ${i}`); }
  assert.ok(toneOn(s + 5, 2) && !noiseOn(s + 5, 2), "back to the arpeggio");
  assert.ok(!noiseOn(frameAt(2, 8, 1), 2), "no snare on step 8");
  assert.equal(frameAt(1, 4) >= 0 && noiseOn(frameAt(1, 4), 2), false, "no snare yet in bar 1");
  const hat = frameAt(5, 1);
  assert.ok(noiseOn(hat, 2) && reg(hat, 6) === 2 && !noiseOn(hat + 1, 2), "hi-hat is one frame of high noise");
});

test("the breakdown (bars 16 to 23) has an envelope buzz bass and no kick", () => {
  for (let bar = 16; bar < 24; bar++) {
    for (let st = 0; st < 16; st += 4) assert.ok(!(tone(frameAt(bar, st), 1) === 833 && noiseOn(frameAt(bar, st), 1)), `kick at bar ${bar} step ${st}`);
  }
  const f = frameAt(16, 0);
  assert.equal(reg(f, 9), 0x10, "channel B uses the envelope");
  assert.ok(!toneOn(f, 1), "with its tone off");
  assert.equal(reg(f, 11) | (reg(f, 12) << 8), Math.round(2000000 / (256 * hz(45))), "envelope period matches the note's pitch");
  assert.equal(reg(f, 13), 8, "the envelope restarts on each note");
  assert.equal(reg(f + 1, 13), 0xff, "and is left alone in between");
  for (let g = 0; g < song.frames; g++) {
    if (reg(g, 13) !== 0xff) { const bar = Math.floor(g / BAR); assert.ok(bar >= 16 && bar < 24, `envelope write in bar ${bar}`); }
  }
});

test("the loop point: the last bar is a fill and the tune comes back in on the first beat", () => {
  const snares = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].filter(st => noiseOn(frameAt(31, st), 2) && reg(frameAt(31, st), 6) === 6);
  assert.deepEqual(snares, [4, 8, 12, 13, 14, 15], "snare fill");
  assert.equal(tone(frameAt(0, 0, 4), 1), tp(45));
});

test("rendered: the bass sits at the right pitch, both as a square wave and as a buzz bass", () => {
  const r = renderTwoPasses();
  // bar 0, frames 4 to 10: kick finished, the bass is A2 = 110 Hz
  assert.ok(Math.abs(peakHz(slice(r, frameAt(0, 0, 4), frameAt(0, 0, 11)), 60, 160) - 110) <= 3);
  // bar 17 (buzz bass over F): F2 = 87.3 Hz sawtooth from the envelope, note frames 1 to 10
  const buzz = peakHz(slice(r, frameAt(17, 0, 1), frameAt(17, 0, 11)), 60, 160);
  assert.ok(Math.abs(buzz - hz(41)) <= 4, `buzz bass at ${buzz} Hz, expected ${hz(41).toFixed(1)}`);
});

test("rendered: clean output, sensible level, no DC, no click at the loop point", () => {
  const r = renderTwoPasses();
  let peak = 0, sum = 0, sq = 0;
  for (const v of r.buf) { assert.ok(Number.isFinite(v)); peak = Math.max(peak, Math.abs(v)); sum += v; sq += v * v; }
  const rms = Math.sqrt(sq / r.buf.length), mean = sum / r.buf.length;
  assert.ok(peak < 1.0, `peak ${peak}`);
  assert.ok(rms > 0.04 && rms < 0.4, `rms ${rms}`);
  assert.ok(Math.abs(mean) < 0.005, `dc ${mean}`);
  // the biggest sample-to-sample step near the loop point is no bigger than elsewhere
  const jump = (a, b) => { let m = 0; for (let i = a + 1; i < b; i++) m = Math.max(m, Math.abs(r.buf[i] - r.buf[i - 1])); return m; };
  const at = Math.round(song.frames * r.spf);
  const seam = jump(at - 2000, at + 2000);
  let typical = 0;
  for (let k = 1; k < 8; k++) typical = Math.max(typical, jump(Math.round(k * 7 * BAR * r.spf), Math.round(k * 7 * BAR * r.spf) + 4000));
  assert.ok(seam <= typical * 1.5, `loop seam step ${seam.toFixed(3)} vs typical ${typical.toFixed(3)}`);
  assert.equal(r.p.loops, 1, "the player looped once");
});

test("the demo's part schedule gives three parts of about 20 s, and the beat follows the kick", () => {
  const first = ymPartAt(song, 0, 0), last = ymPartAt(song, song.frames - 1, 0);
  assert.equal(first.slices, 3);
  assert.ok(Math.abs(first.length - 20.48) < 0.01);
  assert.equal(first.part, 0); assert.equal(last.part, 2);
  const on = YMBeat.analyse(song);
  const kickFrames = [], other = [];
  for (let st = 0; st < 16; st++) for (let fr = 0; fr < STEP; fr++) (st % 4 === 0 && fr === 0 ? kickFrames : other).push(on[frameAt(10, st, fr)]);
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  assert.ok(mean(kickFrames) > 3 * mean(other), `beat strength on kicks ${mean(kickFrames).toFixed(2)} vs elsewhere ${mean(other).toFixed(2)}`);
  const strong = Array.from(on).filter(v => v > 0.3).length / on.length;
  assert.ok(strong > 0.03 && strong < 0.5, `${(strong * 100).toFixed(1)}% strong hits`);
});

test("writing the tune as a .ym file and reading it back gives the same song", () => {
  const back = parseYm(ymWriteYm5(song));
  assert.equal(back.format, "YM5!");
  assert.equal(back.frames, song.frames);
  assert.deepEqual(back.regs, song.regs);
  assert.equal(back.title, song.title); assert.equal(back.author, song.author);
  assert.equal(back.clock, 2000000); assert.equal(back.frameRate, 50); assert.equal(back.loopFrame, 0);
});

test("tunes/pixel-riot-theme.ym matches what the generator makes now", () => {
  const file = fs.readFileSync(path.join(__dirname, "..", "tunes", "pixel-riot-theme.ym"));
  assert.deepEqual(new Uint8Array(file), ymWriteYm5(song), "run: node tools/export-builtin.js");
});
