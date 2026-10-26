"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("node:vm");
const { ymPartAt, MusicClock, YMBeat } = require("../src/musicsync.js");
const { parseYm } = require("../src/ymfile.js");

const root = path.join(__dirname, "..");
const song = (frames, loopFrame = 0, extra = {}) => ({ frames, loopFrame, frameRate: 50, format: "YM5!", regs: new Uint8Array(frames * 16), ...extra });

// ---- part schedule ----

test("a 287 s tune is cut into 15 slices of about 19 s, cycling A B C", () => {
  const s = song(14350);
  const first = ymPartAt(s, 0, 0);
  assert.equal(first.slices, 15);
  assert.equal(first.slice, 0); assert.equal(first.part, 0); assert.equal(first.local, 0);
  assert.ok(Math.abs(first.length - 287 / 15) < 1e-9);
  const parts = [];
  for (let k = 0; k < 15; k++) parts.push(ymPartAt(s, k * 14350 / 15 + 1, 0).part);
  assert.deepEqual(parts, [0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2]);
  assert.equal(ymPartAt(s, 14349.9, 0).part, 2, "the last slice is part C, so the loop restarts at A");
});

test("part changes land exactly on the slice boundaries", () => {
  const s = song(3000);                                   // 60 s -> 3 slices of 20 s
  const b = 1000;
  assert.equal(ymPartAt(s, b - 0.001, 0).part, 0);
  assert.equal(ymPartAt(s, b, 0).part, 1);
  assert.ok(ymPartAt(s, b - 0.001, 0).local > 19.99, "end of a slice");
  assert.ok(ymPartAt(s, b, 0).local < 0.001, "start of the next");
  assert.ok(ymPartAt(s, b - 0.001, 0).length === 20);
});

test("slice counts for different tune lengths", () => {
  const slices = secs => ymPartAt(song(secs * 50), 0, 0).slices;
  assert.equal(slices(10), 3, "very short tunes still get one round");
  assert.equal(slices(60), 3);
  assert.equal(slices(100), 6);
  assert.equal(slices(287), 15);
  assert.equal(slices(600), 30);
  for (const secs of [40, 90, 150, 287, 392, 476]) {
    const r = ymPartAt(song(secs * 50), 0, 0);
    assert.equal(r.slices % 3, 0, "whole rounds");
    assert.ok(r.length > 11 && r.length < 31, `${secs} s tune: slices of ${r.length.toFixed(1)} s`);
  }
});

test("after the loop the schedule restarts at part A from the loop frame", () => {
  const s = song(5000, 800);
  const pass0 = ymPartAt(s, 0, 0), pass1 = ymPartAt(s, 800, 1);
  assert.equal(pass0.part, 0); assert.equal(pass1.part, 0); assert.equal(pass1.local, 0);
  assert.equal(pass0.slices, Math.round(100 / 60) * 3, "first pass covers the whole tune");
  assert.equal(pass1.slices, Math.round(84 / 60) * 3, "later passes cover from the loop frame");
  assert.equal(ymPartAt(s, 4999.9, 1).part, 2);
});

test("positions outside the tune are clamped", () => {
  const s = song(3000);
  assert.equal(ymPartAt(s, -5, 0).slice, 0);
  assert.equal(ymPartAt(s, 99999, 0).slice, 2);
  assert.ok(Number.isFinite(ymPartAt(s, NaN === NaN ? 0 : 0, 0).local));
});

// ---- the music clock, against a simulated audio thread ----

// Simulates the audio thread of a tune: blocks of 128 samples, a message every 7 blocks, delivered to
// the page with random delay. Returns helpers to run it.
function simulate({ frames = 1000, loopFrame = 100, sr = 48000, latency = 0.02, jitterMs = 6, seed = 5, drift = 0 } = {}) {
  let rnd = seed;
  const rand = () => (rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const ctx = { sampleRate: sr, currentTime: 0, outputLatency: latency };
  const s = song(frames, loopFrame);
  const clock = new MusicClock({ ctx, now: () => 0 });
  clock.setSong(s);
  const spf = sr / 50, span = frames - loopFrame;
  const msgs = [];
  const st = { samples: 0, playing: true, loops: 0, pos: 0, base: 0 };
  // Build every message for `seconds` of audio, with the tune running at ctx time == sample time
  const build = (seconds, from = 0) => {
    for (let blk = Math.round(from * sr / 128); blk * 128 < seconds * sr; blk += 7) {
      const time = blk * 128 / sr;
      msgs.push({ blk, time });
    }
  };
  // state of the audio thread at the end of block `blk` (rendered samples counted from `origin` block)
  const make = (blk, origin, playing = true, frozenAt = null) => {
    const rendered = ((frozenAt === null ? blk : frozenAt) - origin + 1) * 128;      // samples rendered, this block included
    const f = rendered / spf;
    let pos = f, loops = 0;
    if (f >= frames) { loops = 1 + Math.floor((f - frames) / span); pos = loopFrame + ((f - frames) % span); }
    return { type: "position", frame: Math.ceil(pos), pos, samples: rendered, frames, playing, finished: false, loops, peak: 0, time: blk * 128 / sr };
  };
  const truthFrames = (heardSeconds) => heardSeconds * 50;
  const cont = p => p.loops === 0 ? p.frame : frames + (p.loops - 1) * span + (p.frame - loopFrame);
  return { ctx, clock, msgs, build, make, rand, jitterMs, latency, truthFrames, cont, frames, span, loopFrame, spf, sr, drift };
}

function drive(sim, { seconds, origin = 0, setup = () => {}, onFrame }) {
  // Walk wall-clock time in 1 ms steps: deliver messages at their (jittered) delivery time, call onFrame every 16.7 ms
  sim.build(seconds * (1 + sim.drift), origin * 128 / sim.sr);
  const queue = sim.msgs.map(m => ({ ...m, at: m.time * 1000 / (1 + sim.drift) + 1 + sim.rand() * sim.jitterMs })).sort((a, b) => a.at - b.at);
  let qi = 0, nextFrame = 100;
  for (let ms = 0; ms < seconds * 1000; ms++) {
    sim.ctx.currentTime = Math.floor(ms / 1000 * (1 + sim.drift) * sim.sr / 128) * 128 / sim.sr;       // the browser's clock moves in blocks
    while (qi < queue.length && queue[qi].at <= ms) { const m = queue[qi++]; sim.clock.onPosition(sim.make(m.blk, origin), ms); }
    setup(ms, sim);
    if (ms >= nextFrame) { onFrame(ms); nextFrame += 1000 / 60; }
  }
}

test("MusicClock: the clock follows the audio within a few ms despite message jitter", () => {
  const sim = simulate();
  const errs = [];
  drive(sim, { seconds: 8, onFrame: ms => {
    if (ms < 1500) return;
    const t = sim.clock.time(ms), truth = ms / 1000 - sim.latency;
    errs.push(t - truth);
  } });
  const worst = Math.max(...errs.map(Math.abs));
  assert.ok(worst < 0.012, `worst error ${(worst * 1000).toFixed(1)} ms`);
});

test("MusicClock: it keeps in step with an audio clock that drifts against the wall clock", () => {
  for (const drift of [0.002, -0.002]) {
    const sim = simulate({ drift });
    const errs = [];
    drive(sim, { seconds: 20, onFrame: ms => {
      if (ms < 1500) return;
      // the audio has played ms/1000 * (1 + drift) seconds by now; the listener hears it a latency later
      errs.push(sim.clock.time(ms) - (ms / 1000 * (1 + drift) - sim.latency));
    } });
    assert.ok(Math.max(...errs.map(Math.abs)) < 0.015, `drift ${drift}: worst error ${(Math.max(...errs.map(Math.abs)) * 1000).toFixed(1)} ms`);
  }
});

test("MusicClock: the clock is smooth, with no steps from jittery or batched messages", () => {
  const sim = simulate({ jitterMs: 8 });
  const ts = [];
  drive(sim, { seconds: 6, onFrame: ms => { if (ms >= 1000) ts.push(sim.clock.time(ms)); } });
  const steps = ts.slice(1).map((t, i) => (t - ts[i]) * 1000);
  const min = Math.min(...steps), max = Math.max(...steps);
  assert.ok(min > 14 && max < 19.5, `frame steps ${min.toFixed(1)} to ${max.toFixed(1)} ms (ideal 16.7)`);
});

test("MusicClock: song position tracks the audio through loops", () => {
  const sim = simulate({ frames: 400, loopFrame: 100 });       // an 8 s tune with a 6 s loop, so it wraps several times
  const errs = [];
  drive(sim, { seconds: 30, onFrame: ms => {
    if (ms < 1500) return;
    const p = sim.clock.position(ms);
    const truth = (ms / 1000 - sim.latency) * 50;
    errs.push(Math.abs(sim.cont(p) - truth));
    // the position itself must stay inside the tune, and inside the loop after the first wrap
    assert.ok(p.frame >= 0 && p.frame < sim.frames, `frame ${p.frame} left the tune`);
    if (p.loops > 0) assert.ok(p.frame >= sim.loopFrame, `frame ${p.frame} is before the loop frame`);
  } });
  assert.ok(Math.max(...errs) < 0.9, `worst position error ${Math.max(...errs).toFixed(2)} frames`);
  const last = sim.clock.position(29000);
  assert.ok(last.loops >= 3, `loops ${last.loops}`);
});

test("MusicClock: wrap-around between messages is predicted, and parts restart at A", () => {
  const sim = simulate({ frames: 400, loopFrame: 0 });
  const s = song(400);
  let sawWrapToA = false, prevPart = -1;
  drive(sim, { seconds: 20, onFrame: ms => {
    if (ms < 1500) return;
    const p = sim.clock.position(ms), part = ymPartAt(s, p.frame, p.loops);
    if (prevPart === 2 && part.part === 0 && part.slice === 0) sawWrapToA = true;
    if (prevPart !== -1 && prevPart !== part.part) assert.equal(part.part, (prevPart + 1) % 3, "parts only advance A, B, C, A");
    prevPart = part.part;
  } });
  assert.ok(sawWrapToA, "C was followed by A at the loop");
});

test("MusicClock: a seek or tune change snaps the clock; a pause holds it and resume continues", () => {
  const sim = simulate({ frames: 2000, loopFrame: 0 });
  const clock = sim.clock, ctx = sim.ctx;
  // run 3 s, then seek back 2 s worth of samples
  let heardBefore = 0;
  drive(sim, { seconds: 3, onFrame: ms => { if (ms === 2999 || ms > 2980) heardBefore = clock.time(ms); } });
  assert.ok(Math.abs(heardBefore - (3 - sim.latency)) < 0.03);
  // after a seek the audio's sample counter restarts: send a message from a position 0.5 s into a fresh run
  const seek = (ms) => ({ type: "position", frame: 26, pos: 25.5, samples: 24000, frames: 2000, playing: true, finished: false, loops: 0, peak: 0, time: ctx.currentTime });
  ctx.currentTime = 3.2;
  clock.onPosition(seek(3200), 3200);
  const t = clock.time(3200);
  assert.ok(Math.abs(t - (24000 - 128) / 48000 + sim.latency) < 0.05 + 0.02, `snapped to ${t.toFixed(3)} s`);
  // pause: the clock holds
  const paused = { ...seek(), playing: false, time: 3.25 };
  ctx.currentTime = 3.25;
  clock.onPosition(paused, 3250);
  const held = clock.time(3250);
  assert.equal(clock.time(3500), held, "held while paused");
  assert.equal(clock.time(9000), held);
  assert.equal(clock.position(9000).frame, 25.5, "and so is the song position");
  // resume: continues from where it was held
  const resumed = { ...seek(), playing: true, samples: 24000, time: 9.0 };
  ctx.currentTime = 9.0;
  clock.onPosition(resumed, 9000);
  assert.ok(Math.abs(clock.time(9000) - held) < 0.05, `resumed at ${clock.time(9000).toFixed(3)} after holding ${held.toFixed(3)}`);
});

test("MusicClock: ready() needs a recent message", () => {
  const ctx = { sampleRate: 48000, currentTime: 0, outputLatency: 0 };
  const clock = new MusicClock({ ctx, now: () => 0 });
  clock.setSong(song(1000));
  assert.equal(clock.ready(0), false, "no message yet");
  assert.equal(clock.position(0), null);
  clock.onPosition({ type: "position", frame: 1, pos: 0.5, samples: 1000, frames: 1000, playing: true, loops: 0, time: 0 }, 100);
  assert.equal(clock.ready(150), true);
  assert.equal(clock.ready(800), false, "stale after 600 ms");
  clock.setSong(song(1000));
  assert.equal(clock.ready(150), false, "a new song waits for its own messages");
});

test("MusicClock: if messages stall across the loop point, the position still wraps", () => {
  const ctx = { sampleRate: 48000, currentTime: 10, outputLatency: 0 };
  const clock = new MusicClock({ ctx, now: () => 0 });
  clock.setSong(song(400, 100));
  // the last message before the stall: frame 398.0, 0 loops
  clock.onPosition({ type: "position", frame: 399, pos: 398, samples: 398 * 960, frames: 400, playing: true, loops: 0, time: 10 }, 1000);
  ctx.currentTime = 10.2;
  const p = clock.position(1200);                  // 0.2 s = 10 frames later: 2 frames to the end, then 8 into the loop
  assert.equal(p.loops, 1);
  assert.ok(Math.abs(p.frame - 108) < 0.2, `frame ${p.frame}`);
  const far = clock.position(1000 + 7 * 1000);     // 7 s later: wrapped more than once (300-frame loop = 6 s)
  assert.ok(far.loops >= 2, `loops ${far.loops}`);
  assert.ok(far.frame >= 100 && far.frame < 400);
});

test("MusicClock: with looping off the position stops at the end", () => {
  const ctx = { sampleRate: 48000, currentTime: 10, outputLatency: 0 };
  const clock = new MusicClock({ ctx, now: () => 0, isLooping: () => false });
  clock.setSong(song(100));
  clock.onPosition({ type: "position", frame: 99, pos: 98.9, samples: 98.9 * 960, frames: 100, playing: true, loops: 0, time: 10 }, 0);
  const p = clock.position(2000);
  assert.ok(p.frame < 100 && p.frame > 99.9 && p.loops === 0);
});

// ---- beat signal ----

function beatSong(fill, frames, format = "YM5!") {
  const regs = new Uint8Array(frames * 16);
  for (let f = 0; f < frames; f++) { regs[f * 16 + 13] = 0xff; regs[f * 16 + 7] = 0x3f; fill(f, k => regs[f * 16 + k], (k, v) => { regs[f * 16 + k] = v; }); }
  return { frames, loopFrame: 0, frameRate: 50, format, regs, drums: [] };
}

test("beat: a level jump is an onset, and the signal decays after it", () => {
  const s = beatSong((f, g, set) => { set(7, 0x3e); set(8, f >= 20 && f < 30 ? 15 : 0); }, 60);
  const on = YMBeat.analyse(s);
  assert.equal(on[20], 1, "the jump is the strongest hit");
  assert.ok(on.every((v, i) => i === 20 || v < 0.05), "nothing else");
  assert.ok(YMBeat.level(on, 19.5, 50) === 0, "nothing before the hit");
  assert.equal(YMBeat.level(on, 20, 50), 1);
  const later = YMBeat.level(on, 20 + 0.14 * 50, 50);
  assert.ok(Math.abs(later - Math.exp(-1)) < 0.02, `decays by 1/e after one time constant: ${later}`);
  assert.ok(YMBeat.level(on, 40, 50) < 0.02, "gone after a while");
});

test("beat: noise starting up, envelope retriggers and digidrum starts all count", () => {
  const noise = beatSong((f, g, set) => { set(7, f >= 10 ? 0x37 : 0x3f); set(8, 8); }, 30);   // noise on channel A from frame 10
  assert.ok(YMBeat.analyse(noise)[10] > 0.2);
  const env = beatSong((f, g, set) => { set(7, 0x3e); set(8, 16); if (f === 12) set(13, 10); }, 30);
  assert.ok(YMBeat.analyse(env)[12] > 0.3, "R13 written");
  const drum = beatSong((f, g, set) => { if (f === 5) { set(1, 0x50); set(6, 3 << 5); set(14, 20); } }, 20, "YM6!");
  const d = YMBeat.analyse(drum);
  assert.ok(d[5] > 0.9, "digidrum start");
  const none = beatSong((f, g, set) => { if (f === 5) { set(1, 0x50); set(6, 0); set(14, 20); } }, 20, "YM6!");
  assert.ok(YMBeat.analyse(none)[5] < 0.1, "prescale 0 means no effect, so no hit");
});

test("beat: steady sound and silence give no beat", () => {
  const flat = beatSong((f, g, set) => { set(7, 0x3e); set(8, 12); }, 100);
  assert.ok(YMBeat.analyse(flat).every(v => v < 0.05 || v === YMBeat.analyse(flat)[0]));
  const silent = beatSong(() => {}, 50);
  assert.ok(YMBeat.analyse(silent).every(v => v === 0));
  assert.equal(YMBeat.analyse(beatSong(() => {}, 1)).length, 1);
});

test("beat: real tunes give a plausible, finite signal", { skip: !fs.existsSync(path.join(root, "tunes", "stsound")) }, () => {
  for (const name of ["VirtualEscape2.ym", "jess2.ym", "ND-Toxygene.ym", "Scout.ym"]) {
    const s = parseYm(fs.readFileSync(path.join(root, "tunes", "stsound", name)));
    const on = YMBeat.analyse(s);
    assert.equal(on.length, s.frames);
    assert.ok(on.every(v => Number.isFinite(v) && v >= 0 && v <= 1), name);
    const strong = on.filter(v => v > 0.3).length / on.length;
    assert.ok(strong > 0.01 && strong < 0.7, `${name}: ${(strong * 100).toFixed(1)}% of frames are strong hits`);
  }
});

// ---- the baked default tune ----

test("tunes/default-tune.js holds a valid tune that matches the file it was baked from", () => {
  const src = fs.readFileSync(path.join(root, "tunes", "default-tune.js"), "utf8");
  const ctx = vm.createContext({});
  vm.runInContext(src + "; this.tune = YM_DEFAULT_TUNE;", ctx);
  const bytes = Buffer.from(ctx.tune.data, "base64");
  const original = fs.readFileSync(path.join(root, "tunes", "stsound", ctx.tune.name));
  assert.deepEqual(bytes, original, "run tools/ym2js.js again if the tune changed");
  const s = parseYm(bytes);
  assert.ok(s.frames > 1000);
  assert.ok(s.packed && s.crcOk);
});
