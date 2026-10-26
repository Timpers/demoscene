"use strict";

// Browser audio for the YM player.
//
// The chip and player run inside an AudioWorklet. Its code is built from the classes' own source
// text (Class.toString()) and loaded from a data: URL (or a Blob URL if that is refused), so it works
// from a plain file:// page with no build step and no separate worklet file. If the worklet cannot be
// created, the same player runs on the main thread through a ScriptProcessorNode instead.
//
// Messages, page -> worklet:
//   { type: "load", song, loop, autoplay }   song is the object returned by parseYm()
//   { type: "play" } { type: "pause" } { type: "seek", frame } { type: "loop", value }
// Messages, worklet -> page:
//   { type: "loaded", frames }
//   { type: "position", frame, pos, samples, frames, playing, finished, loops, peak, time }
//        every 7 audio blocks, roughly 55 times a second. pos is the fractional frame position,
//        samples counts samples rendered since the last load or seek (loops included), and time is
//        the audio context's clock when the message was made.
//   { type: "ended" }                      the song finished (only when not looping)
//   { type: "error", message }

const _audioDeps = (typeof module !== "undefined" && module.exports && typeof require === "function")
  ? { YM2149: require("./ym2149.js").YM2149, YMPlayer: require("./ymplayer.js").YMPlayer }
  : { YM2149, YMPlayer };

// Everything that runs inside the AudioWorkletGlobalScope, as a string
function ymWorkletSource() {
  const processor = `
class YMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.player = null;
    this.loop = true;
    this.since = 0;           // samples since the last position message
    this.peak = 0;
    this.endedSent = false;
    this.port.onmessage = e => this.onMessage(e.data);
  }
  onMessage(m) {
    try {
      const p = this.player;
      switch (m.type) {
        case "load":
          this.loop = m.loop !== false;
          this.player = new YMPlayer(m.song, { sampleRate, loop: this.loop });
          this.player.playing = m.autoplay !== false;
          this.endedSent = false;
          this.port.postMessage({ type: "loaded", frames: m.song.frames });
          this.post();
          break;
        case "play": if (p) { p.play(); this.endedSent = false; } break;
        case "pause": if (p) p.pause(); break;
        case "seek": if (p) { p.seek(m.frame); this.endedSent = false; } this.post(); break;
        case "loop": this.loop = !!m.value; if (p) p.loop = this.loop; break;
      }
    } catch (err) {
      this.port.postMessage({ type: "error", message: String(err && err.message || err) });
    }
  }
  post() {
    const p = this.player;
    this.port.postMessage({
      type: "position", frame: p ? p.frame : 0, pos: p ? p.framePosition : 0, samples: p ? p.samplesPlayed : 0,
      frames: p ? p.song.frames : 0, playing: p ? p.playing && !p.finished : false, finished: p ? p.finished : false,
      loops: p ? p.loops : 0, peak: this.peak, time: currentTime,
    });
    this.since = 0; this.peak = 0;
  }
  process(inputs, outputs) {
    const out = outputs[0], left = out[0], right = out[1];
    const p = this.player;
    if (!p) { left.fill(0); if (right) right.fill(0); return true; }
    try {
      p.render(left, left.length);
    } catch (err) {
      left.fill(0);
      this.port.postMessage({ type: "error", message: String(err && err.message || err) });
      this.player = null;
    }
    if (right) right.set(left);
    for (let i = 0; i < left.length; i++) { const a = Math.abs(left[i]); if (a > this.peak) this.peak = a; }
    this.since += left.length;
    if (this.since >= sampleRate / 60) this.post();
    if (p.finished && !this.endedSent) { this.endedSent = true; this.post(); this.port.postMessage({ type: "ended" }); }
    return true;
  }
}
registerProcessor("ym-player", YMProcessor);
`;
  return [_audioDeps.YM2149.toString(), "const _YM2149 = YM2149;", _audioDeps.YMPlayer.toString(), processor].join("\n");
}

// The parts of a song the player needs, as a plain object that can be sent in a message
function ymSongForWorklet(song) {
  return {
    format: song.format, frames: song.frames, regs: song.regs, clock: song.clock, frameRate: song.frameRate,
    loopFrame: song.loopFrame, drums: song.drums, drum4bit: song.drum4bit, drumSigned: song.drumSigned,
    title: song.title, author: song.author, comment: song.comment,
  };
}

class YMAudio {
  // ctx: an existing AudioContext to use, or null to create one in init().
  // opts: volume (0..1, default 0.8: leaves headroom, see PRD R28), loop (default true),
  //       forceFallback (use the ScriptProcessor path even if AudioWorklet works)
  constructor(ctx = null, opts = {}) {
    this.ctx = ctx;
    this.forceFallback = !!opts.forceFallback;
    this.volume = opts.volume === undefined ? 0.8 : opts.volume;
    this.muted = false;
    this.loop = opts.loop !== false;
    this.mode = null;               // "worklet" or "script" once init() has finished
    this.workletLoader = "";        // how the worklet code was loaded: "data" or "blob"
    this.fallbackReason = "";
    this.ready = false;
    this.song = null;
    this.pending = null;            // a tune loaded before init() finished
    this.state = { frame: 0, frames: 0, playing: false, finished: false, loops: 0, peak: 0, time: 0 };
    this.onposition = null;
    this.positionListeners = [];    // extra callbacks, for things like the demo's music clock
    this.onended = null;
    this.onerror = null;
  }

  addPositionListener(fn) { this.positionListeners.push(fn); }

  // Must be called from a user gesture the first time. Resolves to "worklet" or "script".
  async init() {
    if (this.ready) return this.mode;
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this.muted ? 0 : this.volume;
    this.gain.connect(this.ctx.destination);
    if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});   // not awaited: can wait for a gesture
    if (!this.forceFallback && this.ctx.audioWorklet && typeof AudioWorkletNode !== "undefined") {
      try {
        await this.initWorklet();
        this.mode = "worklet";
      } catch (err) {
        this.fallbackReason = String(err && err.message || err);
        console.warn("AudioWorklet unavailable, using the ScriptProcessor fallback:", err);
      }
    } else {
      this.fallbackReason = this.forceFallback ? "forced" : "AudioWorklet not supported";
    }
    if (!this.mode) { this.initScript(); this.mode = "script"; }
    this.ready = true;
    if (this.pending) { const p = this.pending; this.pending = null; this.load(p.song, p.autoplay); }
    return this.mode;
  }

  // Loads the worklet code without a separate file. A page opened from file:// has an opaque origin,
  // which makes some browsers reject a Blob URL for the module, so a data: URL is tried first.
  async loadWorkletModule() {
    const source = ymWorkletSource();
    const attempts = [
      ["data", () => "data:text/javascript;base64," + btoa(source), () => {}],
      ["blob", () => URL.createObjectURL(new Blob([source], { type: "text/javascript" })), u => URL.revokeObjectURL(u)],
    ];
    const errors = [];
    for (const [name, make, cleanup] of attempts) {
      const url = make();
      try {
        await this.ctx.audioWorklet.addModule(url);
        this.workletLoader = name;
        return;
      } catch (err) {
        errors.push(`${name}: ${err && err.message || err}`);
      } finally { cleanup(url); }
    }
    throw new Error(errors.join("; "));
  }

  async initWorklet() {
    await this.loadWorkletModule();
    this.node = new AudioWorkletNode(this.ctx, "ym-player", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    this.node.port.onmessage = e => this.handle(e.data);
    this.node.onprocessorerror = () => this.fail("The audio processor stopped unexpectedly");
    this.node.connect(this.gain);
  }

  // Fallback: the same player on the main thread
  initScript() {
    const node = this.ctx.createScriptProcessor(2048, 0, 2);
    let lastPost = 0, peak = 0;
    node.onaudioprocess = e => {
      const left = e.outputBuffer.getChannelData(0), right = e.outputBuffer.getChannelData(1);
      const p = this.player;
      if (!p) { left.fill(0); right.fill(0); return; }
      try { p.render(left, left.length); } catch (err) { left.fill(0); this.player = null; this.fail(err.message); }
      right.set(left);
      for (let i = 0; i < left.length; i++) { const a = Math.abs(left[i]); if (a > peak) peak = a; }
      const now = this.ctx.currentTime;
      if (now - lastPost >= 1 / 60) {
        lastPost = now;
        this.handle(this.positionMessage(peak));
        peak = 0;
      }
      if (p.finished && !this.endedSent) { this.endedSent = true; this.handle({ type: "ended" }); }
    };
    node.connect(this.gain);
    this.node = node;
  }

  positionMessage(peak = 0) {
    const p = this.player;
    return {
      type: "position", frame: p ? p.frame : 0, pos: p ? p.framePosition : 0, samples: p ? p.samplesPlayed : 0,
      frames: p ? p.song.frames : 0, playing: p ? p.playing && !p.finished : false, finished: p ? p.finished : false,
      loops: p ? p.loops : 0, peak, time: this.ctx.currentTime,
    };
  }

  handle(m) {
    if (m.type === "position") {
      this.state = m;
      if (this.onposition) this.onposition(m);
      for (const fn of this.positionListeners) fn(m);
    }
    else if (m.type === "ended") { if (this.onended) this.onended(); }
    else if (m.type === "error") this.fail(m.message);
  }

  fail(message) {
    console.error("YM audio error:", message);
    if (this.onerror) this.onerror(message);
  }

  // Load a parsed song (from parseYm) and start playing it unless autoplay is false
  load(song, autoplay = true) {
    this.song = song;
    if (!this.ready) { this.pending = { song, autoplay }; return; }
    this.endedSent = false;
    if (this.mode === "worklet") {
      this.node.port.postMessage({ type: "load", song: ymSongForWorklet(song), loop: this.loop, autoplay });
    } else {
      this.player = new _audioDeps.YMPlayer(song, { sampleRate: this.ctx.sampleRate, loop: this.loop });
      this.player.playing = autoplay;
      this.handle(this.positionMessage());
    }
  }

  send(msg, direct) {
    if (!this.ready) return;
    if (this.mode === "worklet") this.node.port.postMessage(msg);
    else if (this.player) { direct(this.player); this.handle(this.positionMessage()); }
  }

  play() { this.endedSent = false; this.send({ type: "play" }, p => p.play()); }
  pause() { this.send({ type: "pause" }, p => p.pause()); }
  toggle() { if (this.state.playing) this.pause(); else this.play(); }
  seek(frame) { this.endedSent = false; this.send({ type: "seek", frame }, p => p.seek(frame)); }
  setLoop(value) { this.loop = !!value; this.send({ type: "loop", value: this.loop }, p => { p.loop = this.loop; }); }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    this.applyGain();
  }
  setMuted(m) { this.muted = !!m; this.applyGain(); }
  applyGain() {
    if (!this.gain) return;
    // A short ramp avoids clicks
    this.gain.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.02);
  }

  destroy() {
    if (this.node) { try { this.node.disconnect(); } catch (e) { /* already gone */ } }
    if (this.gain) this.gain.disconnect();
  }
}

YMAudio.workletSource = ymWorkletSource;
YMAudio.songForWorklet = ymSongForWorklet;

if (typeof module !== "undefined" && module.exports) module.exports = { YMAudio, ymWorkletSource, ymSongForWorklet };
