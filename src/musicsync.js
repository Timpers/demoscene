"use strict";

// Ties the demo to its music: which part to show, a clock that follows the audio, and a beat signal.
// No DOM use, so it can be tested in Node.

const _syncDeps = (typeof module !== "undefined" && module.exports && typeof require === "function")
  ? { YM2149: require("./ym2149.js").YM2149, YMPlayer: require("./ymplayer.js").YMPlayer }
  : { YM2149, YMPlayer };

// Which demo part is on screen, given where the music is.
//
// One pass through the tune is cut into equal slices, and the parts cycle A, B, C, A, B, C ... through
// them, so the demo restarts at part A exactly when the music loops. The number of slices is a whole
// number of rounds of `parts`, chosen so each slice is close to `partLen` seconds.
//   song: { frames, loopFrame, frameRate }   pos: fractional frame   loops: how many times it has wrapped
// Returns { slice, slices, part, local, length }: local and length are seconds within the slice.
function ymPartAt(song, pos, loops, opts = {}) {
  const parts = opts.parts || 3, target = opts.partLen || 20, fps = song.frameRate;
  // The first pass runs from the start of the song; later passes from the loop frame
  const start = loops === 0 ? 0 : Math.min(song.loopFrame, song.frames - 1);
  const span = Math.max(1, song.frames - start);
  const rounds = Math.max(1, Math.round(span / fps / (parts * target)));
  const slices = parts * rounds, sliceLen = span / slices;
  const rel = Math.max(0, Math.min(span - 1e-6, pos - start));
  const slice = Math.floor(rel / sliceLen);
  return { slice, slices, part: slice % parts, local: (rel - slice * sliceLen) / fps, length: sliceLen / fps };
}

// A clock that follows the audio. The audio thread reports its position about 55 times a second;
// this turns that into a smooth time and a song position at any moment in between.
//
// opts: ctx (the AudioContext), isLooping() (whether the song wraps at its end),
//       now() (ms, default performance.now), alpha (smoothing, 0..1), snap (seconds of jump that is
//       taken as a seek rather than drift), staleMs (how long without a message counts as lost)
class MusicClock {
  constructor(opts) {
    this.ctx = opts.ctx;
    this.isLooping = opts.isLooping || (() => true);
    this.now = opts.now || (() => performance.now());
    this.alpha = opts.alpha === undefined ? 0.05 : opts.alpha;
    this.snap = opts.snap === undefined ? 0.15 : opts.snap;
    this.staleMs = opts.staleMs === undefined ? 600 : opts.staleMs;
    this.song = null;
    this.reset();
  }

  setSong(song) { this.song = song; this.reset(); }

  reset() {
    this.msg = null;
    this.msgAt = -Infinity;
    this.off = 0;                // song seconds minus wall-clock seconds, smoothed
    this.haveOffset = false;
    this.playing = false;
    this.frozenT = 0;
  }

  // Call with each position message from the audio engine
  onPosition(m, nowMs = this.now()) {
    const ctx = this.ctx, sr = ctx.sampleRate;
    if (m.playing) {
      // Audio the listener hears now: what has been rendered, less one block still in flight and the
      // output latency, plus the time that has passed since the message was made
      const latency = ctx.outputLatency || ctx.baseLatency || 0;
      const heard = (m.samples - 128) / sr + (ctx.currentTime - m.time) - latency;
      const raw = heard - nowMs / 1000;
      if (!this.haveOffset || Math.abs(raw - this.off) > this.snap) { this.off = raw; this.haveOffset = true; }
      else this.off += (raw - this.off) * this.alpha;
      this.playing = true;
    } else if (this.playing) {
      this.frozenT = nowMs / 1000 + this.off;     // hold the clock while paused
      this.playing = false;
    }
    this.msg = m;
    this.msgAt = nowMs;
  }

  // True once the audio is reporting and the last message is recent
  ready(nowMs = this.now()) {
    return !!this.msg && this.haveOffset && nowMs - this.msgAt < this.staleMs;
  }

  // Seconds of audio heard so far, smooth, and held while paused
  time(nowMs = this.now()) {
    return this.playing ? nowMs / 1000 + this.off : this.frozenT;
  }

  // { frame, loops }: the song position (fractional frames) of what is being heard now
  position(nowMs = this.now()) {
    const m = this.msg, song = this.song;
    if (!m || !song) return null;
    let frame = m.pos, loops = m.loops;
    if (this.playing) {
      frame += (this.time(nowMs) - m.samples / this.ctx.sampleRate) * song.frameRate;
      // The audio thread wraps at the end of the song; so do we, until its next message says so
      if (frame >= song.frames) {
        if (this.isLooping()) {
          const loopLen = Math.max(1, song.frames - Math.min(song.loopFrame, song.frames - 1));
          const over = frame - song.frames;
          const wraps = 1 + Math.floor(over / loopLen);
          loops += wraps;
          frame = Math.min(song.loopFrame, song.frames - 1) + (over - (wraps - 1) * loopLen);
        } else frame = song.frames - 1e-6;
      }
      // Just after the audio thread has wrapped, what is heard still lags the rendered position by the
      // output latency, so it is really still in the end of the previous pass
      const loopStart = Math.min(song.loopFrame, song.frames - 1);
      if (loops > 0 && frame < loopStart) {
        const loopLen = Math.max(1, song.frames - loopStart);
        const back = Math.ceil((loopStart - frame) / loopLen);
        loops -= back; frame += back * loopLen;
      }
      if (frame < 0) frame = 0;
    }
    return { frame, loops };
  }
}

// A beat signal read straight from the tune's register data, so it is exactly in step with the sound.
const YMBeat = {
  // Per-frame onset strengths (0..1): rises in total channel level, noise starting up, envelope
  // retriggers and digidrum starts. Normalised so the 90th percentile of the hits is 1.
  analyse(song) {
    const n = song.frames, R = song.regs, LV = _syncDeps.YM2149.LEVELS_4BIT;
    const MFP = _syncDeps.YMPlayer.MFP_PRESCALE;
    const onset = new Float32Array(n);
    let prevAmp = 0, prevNoise = false;
    for (let f = 0; f < n; f++) {
      const r = k => R[f * 16 + k];
      const mix = r(7);
      let amp = 0, noise = false;
      for (let c = 0; c < 3; c++) {
        const toneOn = !((mix >> c) & 1), noiseOn = !((mix >> (3 + c)) & 1), lv = r(8 + c);
        if (!toneOn && !noiseOn) continue;               // steady level: not an audible hit
        const a = (lv & 16) ? 0.7 : LV[lv & 15] / 32767;
        amp += a;
        if (noiseOn && a > 0.02) noise = true;
      }
      let v = Math.max(0, amp - prevAmp);
      if (noise && !prevNoise) v += 0.25;
      if (r(13) !== 0xff && f > 0) v += 0.35;
      // digidrum start (YM5: R3 voice bits; YM6: either slot's code nibble 0100 | voice)
      const slot = (code, pre, cnt) => {
        const c = r(code) & 0xf0;
        return (c & 0x30) && (c & 0xc0) === 0x40 && MFP[(r(pre) >> 5) & 7] * r(cnt) > 0;
      };
      if (song.format === "YM6!" ? (slot(1, 6, 14) || slot(3, 8, 15))
        : song.format === "YM5!" && ((r(3) >> 4) & 3) && MFP[(r(8) >> 5) & 7] * r(15) > 0) v += 1;
      onset[f] = v;
      prevAmp = amp; prevNoise = noise;
    }
    const hits = Array.from(onset).filter(v => v > 0.02).sort((a, b) => a - b);
    const scale = hits.length ? 1 / hits[Math.floor(hits.length * 0.9)] : 1;
    for (let f = 0; f < n; f++) onset[f] = Math.min(1, onset[f] * scale);
    return onset;
  },

  // Beat level (0..1) at a fractional frame position: the strongest recent hit, decaying with time
  level(onset, pos, frameRate, tau = 0.14) {
    const f = Math.floor(pos);
    let best = 0;
    for (let k = 0; k <= 12; k++) {
      const i = f - k;
      if (i < 0 || i >= onset.length) continue;
      const o = onset[i];
      if (o <= 0) continue;
      const v = o * Math.exp(-(pos - i) / frameRate / tau);
      if (v > best) best = v;
    }
    return best;
  },
};

if (typeof module !== "undefined" && module.exports) module.exports = { ymPartAt, MusicClock, YMBeat };
