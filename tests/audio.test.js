"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("fs");
const path = require("path");
const { YMAudio, ymWorkletSource, ymSongForWorklet } = require("../src/audio.js");
const { YMPlayer } = require("../src/ymplayer.js");
const { parseYm } = require("../src/ymfile.js");

const RATE = 48000;
const dataDir = path.join(__dirname, "data");
const scale = () => parseYm(fs.readFileSync(path.join(dataDir, "scale.ym")));
const sid = () => parseYm(fs.readFileSync(path.join(dataDir, "sid-voice.ym")));

// Runs the worklet source in an empty context with stand-ins for the AudioWorklet globals
function makeWorklet(sampleRate = RATE) {
  const posted = [], registered = {};
  const ctx = vm.createContext({
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: m => posted.push(m), onmessage: null }; } },
    registerProcessor: (name, cls) => { registered[name] = cls; },
    sampleRate, currentTime: 0, console,
  });
  vm.runInContext(ymWorkletSource(), ctx);
  const proc = new registered["ym-player"]();
  const send = m => proc.port.onmessage({ data: m });
  const run = (quanta) => {
    const out = [];
    for (let q = 0; q < quanta; q++) {
      const L = new Float32Array(128), R = new Float32Array(128);
      ctx.currentTime = q * 128 / sampleRate;
      proc.process([], [[L, R]]);
      out.push([L, R]);
    }
    return out;
  };
  return { posted, registered, proc, send, run };
}
const flat = quanta => { const a = new Float32Array(quanta.length * 128); quanta.forEach(([L], i) => a.set(L, i * 128)); return a; };

test("the worklet source is self-contained and registers the processor", () => {
  const w = makeWorklet();
  assert.ok(w.registered["ym-player"], "registered as ym-player");
  const src = ymWorkletSource();
  assert.ok(src.includes("class YM2149") && src.includes("class YMPlayer"));
});

test("the worklet renders exactly what the player renders, on both channels", () => {
  const w = makeWorklet();
  w.send({ type: "load", song: ymSongForWorklet(scale()), loop: true, autoplay: true });
  const got = flat(w.run(400));
  const ref = new YMPlayer(scale(), { sampleRate: RATE, loop: true });
  const want = new Float32Array(400 * 128);
  ref.render(want, want.length);
  assert.deepEqual(got, want);
  assert.ok(got.some(v => Math.abs(v) > 0.01), "not silent");
  const q = w.run(1)[0];
  assert.deepEqual(q[0], q[1], "right channel copies left");
});

test("effects play through the worklet too", () => {
  const w = makeWorklet();
  w.send({ type: "load", song: ymSongForWorklet(sid()), loop: true, autoplay: true });
  const got = flat(w.run(200));
  const ref = new YMPlayer(sid(), { sampleRate: RATE, loop: true });
  const want = new Float32Array(200 * 128);
  ref.render(want, want.length);
  assert.deepEqual(got, want);
});

test("silence before a tune is loaded, and while paused", () => {
  const w = makeWorklet();
  assert.ok(flat(w.run(10)).every(v => v === 0));
  w.send({ type: "load", song: ymSongForWorklet(scale()), autoplay: false });
  assert.ok(flat(w.run(10)).every(v => v === 0), "loaded but not playing");
  w.send({ type: "play" });
  assert.ok(flat(w.run(50)).some(v => v !== 0));
  w.send({ type: "pause" });
  const frame = w.proc.player.frame;
  assert.ok(flat(w.run(10)).every(v => v === 0));
  assert.equal(w.proc.player.frame, frame, "position held while paused");
});

test("position messages arrive 50 to 60 times a second with sensible values", () => {
  const w = makeWorklet();
  w.send({ type: "load", song: ymSongForWorklet(scale()), autoplay: true });
  w.posted.length = 0;
  w.run(Math.round(RATE / 128));                        // one second
  const pos = w.posted.filter(m => m.type === "position");
  // one message per 7 audio blocks of 128 samples (about 54 a second at 48 kHz)
  assert.ok(pos.length >= 50 && pos.length <= 64, `${pos.length} messages`);
  const last = pos[pos.length - 1];
  assert.ok(last.frame >= 49 && last.frame <= 51, `frame ${last.frame}`);
  assert.equal(last.frames, 325);
  assert.equal(last.playing, true);
  assert.ok(last.peak >= 0 && last.peak <= 1.1);
  assert.ok(pos.some(m => m.peak > 0.01), "a peak level is reported");
  assert.ok(pos.every((m, i) => i === 0 || m.frame >= pos[i - 1].frame), "frame never goes backwards without a loop");
});

test("seek, loop and the end of a song", () => {
  const w = makeWorklet();
  w.send({ type: "load", song: ymSongForWorklet(scale()), loop: false, autoplay: true });
  w.send({ type: "seek", frame: 320 });
  w.run(Math.round(RATE * 0.3 / 128));                   // more than the five frames left
  const ended = w.posted.filter(m => m.type === "ended");
  assert.equal(ended.length, 1, "exactly one ended message");
  assert.ok(flat(w.run(20)).every(v => v === 0), "silent after the end");
  assert.equal(w.posted.filter(m => m.type === "ended").length, 1, "and not repeated");
  // looping: the same seek wraps round instead
  const l = makeWorklet();
  l.send({ type: "load", song: ymSongForWorklet(scale()), loop: true, autoplay: true });
  l.send({ type: "seek", frame: 320 });
  l.run(Math.round(RATE * 0.3 / 128));
  assert.equal(l.posted.filter(m => m.type === "ended").length, 0);
  assert.ok(l.posted.filter(m => m.type === "position").pop().loops >= 1);
  l.send({ type: "loop", value: false });
  assert.equal(l.proc.player.loop, false);
});

test("a bad message produces an error message, not an exception", () => {
  const w = makeWorklet();
  assert.doesNotThrow(() => w.send({ type: "load", song: null }));
  assert.ok(w.posted.some(m => m.type === "error" && m.message));
  assert.doesNotThrow(() => w.run(5));
  assert.doesNotThrow(() => w.send({ type: "seek", frame: 5 }));
});

test("the song object sent to the worklet survives structured cloning", () => {
  const s = scale();
  const copy = structuredClone(ymSongForWorklet(s));
  assert.equal(copy.frames, s.frames);
  assert.deepEqual(copy.regs, s.regs);
  const p = new YMPlayer(copy, { sampleRate: RATE });
  const b = new Float32Array(2000);
  assert.doesNotThrow(() => p.render(b, b.length));
});

// ---- YMAudio with a fake AudioContext ----

function fakeContext({ worklet = null, state = "running", sampleRate = RATE } = {}) {
  const ctx = {
    sampleRate, currentTime: 0, state, destination: { name: "destination" },
    gains: [], processors: [],
    resumed: 0,
    resume() { this.resumed++; return Promise.resolve(); },
    createGain() {
      const g = { gain: { value: 1, targets: [], setTargetAtTime(v, t, c) { this.targets.push(v); } }, connected: null,
        connect(n) { this.connected = n; }, disconnect() { this.connected = null; } };
      ctx.gains.push(g); return g;
    },
    createScriptProcessor(size, i, o) {
      const p = { size, onaudioprocess: null, connected: null, connect(n) { this.connected = n; }, disconnect() {} };
      ctx.processors.push(p); return p;
    },
  };
  if (worklet) ctx.audioWorklet = worklet;
  return ctx;
}
const fakeBuffer = n => { const ch = [new Float32Array(n), new Float32Array(n)]; return { getChannelData: i => ch[i], ch }; };

test("without AudioWorklet, YMAudio falls back to a ScriptProcessor and plays", async () => {
  const ctx = fakeContext();
  const a = new YMAudio(ctx);
  const positions = [];
  a.onposition = m => positions.push(m);
  assert.equal(await a.init(), "script");
  assert.match(a.fallbackReason, /not supported/);
  a.load(scale());
  const proc = ctx.processors[0];
  assert.equal(proc.size, 2048);
  assert.equal(proc.connected, ctx.gains[0], "processor goes through the gain node");
  assert.equal(ctx.gains[0].connected, ctx.destination);
  const ref = new YMPlayer(scale(), { sampleRate: RATE });
  for (let i = 0; i < 20; i++) {
    const out = fakeBuffer(2048), want = new Float32Array(2048);
    ctx.currentTime += 2048 / RATE;
    proc.onaudioprocess({ outputBuffer: out });
    ref.render(want, 2048);
    assert.deepEqual(out.ch[0], want);
    assert.deepEqual(out.ch[1], want);
  }
  assert.ok(positions.length > 5, "position updates delivered");
  assert.ok(positions[positions.length - 1].frame > 20);
});

test("YMAudio: play, pause, seek, loop and volume reach the player", async () => {
  const ctx = fakeContext();
  const a = new YMAudio(ctx, { volume: 0.5 });
  await a.init();
  assert.equal(ctx.gains[0].gain.value, 0.5);
  a.load(scale(), false);
  assert.equal(a.state.playing, false);
  a.play();
  assert.equal(a.state.playing, true);
  a.toggle();
  assert.equal(a.state.playing, false);
  a.seek(100);
  assert.equal(a.player.frame, 100);
  a.setLoop(false);
  assert.equal(a.player.loop, false);
  a.setVolume(2);
  assert.equal(a.volume, 1, "volume is clamped");
  assert.equal(ctx.gains[0].gain.targets.pop(), 1);
  a.setMuted(true);
  assert.equal(ctx.gains[0].gain.targets.pop(), 0);
  a.setMuted(false);
  assert.equal(ctx.gains[0].gain.targets.pop(), 1);
});

test("a tune loaded before init() is played once the audio is ready", async () => {
  const ctx = fakeContext();
  const a = new YMAudio(ctx);
  a.load(scale());
  assert.equal(a.pending.song.frames, 325);
  await a.init();
  assert.equal(a.pending, null);
  assert.ok(a.player, "loaded after init");
});

test("an initial suspended context is resumed without waiting for it", async () => {
  const ctx = fakeContext({ state: "suspended" });
  ctx.resume = function () { this.resumed++; return new Promise(() => {}); };   // never resolves, like a blocked autoplay
  const a = new YMAudio(ctx);
  assert.equal(await a.init(), "script");
  assert.equal(ctx.resumed, 1);
});

test("with a working AudioWorklet, YMAudio uses it and sends messages", async () => {
  const added = [];
  const posted = [];
  global.AudioWorkletNode = class {
    constructor(ctx, name, opts) { this.name = name; this.opts = opts; this.port = { postMessage: m => posted.push(m), onmessage: null }; }
    connect(n) { this.connected = n; }
    disconnect() {}
  };
  try {
    const ctx = fakeContext({ worklet: { addModule: async url => { added.push(url); } } });
    const a = new YMAudio(ctx);
    assert.equal(await a.init(), "worklet");
    assert.equal(added.length, 1);
    assert.match(added[0], /^data:text\/javascript;base64,/);
    assert.equal(a.workletLoader, "data");
    // the data URL carries the worklet source
    assert.equal(Buffer.from(added[0].split(",")[1], "base64").toString(), ymWorkletSource());
    assert.equal(a.node.name, "ym-player");
    assert.deepEqual(a.node.opts.outputChannelCount, [2]);
    assert.equal(a.node.opts.numberOfInputs, 0);
    assert.equal(a.node.connected, ctx.gains[0]);
    a.load(scale());
    a.pause(); a.play(); a.seek(7); a.setLoop(false);
    assert.deepEqual(posted.map(m => m.type), ["load", "pause", "play", "seek", "loop"]);
    assert.equal(posted[0].song.frames, 325);
    assert.equal(posted[3].frame, 7);
    assert.equal(posted[4].value, false);
    // messages coming back
    const seen = [];
    a.onposition = m => seen.push(m.frame);
    a.node.port.onmessage({ data: { type: "position", frame: 12, frames: 325, playing: true, finished: false, loops: 0, peak: 0.2, time: 1 } });
    assert.deepEqual(seen, [12]);
    assert.equal(a.state.frame, 12);
    let ended = 0, err = null;
    a.onended = () => ended++; a.onerror = m => { err = m; };
    a.node.port.onmessage({ data: { type: "ended" } });
    a.node.port.onmessage({ data: { type: "error", message: "boom" } });
    assert.equal(ended, 1); assert.equal(err, "boom");
  } finally { delete global.AudioWorkletNode; }
});

test("if the data: URL is refused, YMAudio tries a Blob URL before giving up on the worklet", async () => {
  global.AudioWorkletNode = class { constructor() { this.port = { postMessage() {}, onmessage: null }; } connect() {} disconnect() {} };
  try {
    const tried = [];
    const ctx = fakeContext({ worklet: { addModule: async url => { tried.push(url.split(":")[0]); if (url.startsWith("data:")) throw new Error("data URLs not allowed"); } } });
    const a = new YMAudio(ctx);
    assert.equal(await a.init(), "worklet");
    assert.deepEqual(tried, ["data", "blob"]);
    assert.equal(a.workletLoader, "blob");
  } finally { delete global.AudioWorkletNode; }
});

test("if the worklet module fails to load, YMAudio falls back to the ScriptProcessor", async () => {
  global.AudioWorkletNode = class {};
  const origWarn = console.warn; console.warn = () => {};
  try {
    const ctx = fakeContext({ worklet: { addModule: async () => { throw new Error("blocked by file:// policy"); } } });
    const a = new YMAudio(ctx);
    assert.equal(await a.init(), "script");
    assert.match(a.fallbackReason, /data: blocked by file.*blob: blocked by file/, "both attempts are reported");
    assert.equal(ctx.processors.length, 1);
  } finally { console.warn = origWarn; delete global.AudioWorkletNode; }
});

test("forceFallback skips the worklet even when it is available", async () => {
  global.AudioWorkletNode = class {};
  try {
    let called = 0;
    const ctx = fakeContext({ worklet: { addModule: async () => { called++; } } });
    const a = new YMAudio(ctx, { forceFallback: true });
    assert.equal(await a.init(), "script");
    assert.equal(called, 0);
    assert.equal(a.fallbackReason, "forced");
  } finally { delete global.AudioWorkletNode; }
});
