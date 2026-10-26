"use strict";

// YM2149F sound chip core.
// Pure JS with no DOM or Web Audio use, so it runs on the main thread, in an AudioWorklet
// (via YM2149.toString(), so everything it needs lives inside the class) and in Node.
// Register map, timings and sources: docs/ym2149-notes.md
//
// Output: the chip changes state on a fixed step (8 master clocks, 250 kHz on an ST). Each step's
// mixed level is held for exactly one step, so the chip's output is a piecewise-constant signal.
// To get audio at the output rate we low-pass that signal and sample it at the exact output times:
// y(t) = sum over steps of level x (integral of the filter kernel over that step). The integral
// comes from a table of kernel step responses ("polyphase" over the fractional output position),
// so there is no oversampling grid and no timing jitter.

class YM2149 {
  // 4-bit fixed-level amplitudes measured on the ST (values from ST-Sound, Arnaud Carre, MIT)
  static LEVELS_4BIT = [62, 161, 265, 377, 580, 774, 1155, 1575, 2260, 3088, 4570, 6233, 9330, 13187, 21220, 32767];

  // 32-step amplitude scale shared by the envelope and fixed levels (level n sits on step 2n+1).
  // The even steps are geometric means of their neighbours: provisional, see notes section 5.
  static buildDac32() {
    const t = YM2149.LEVELS_4BIT, d = new Float64Array(32);
    for (let n = 0; n < 16; n++) d[2 * n + 1] = t[n] / 32767;
    for (let i = 2; i < 31; i += 2) d[i] = Math.sqrt(d[i - 1] * d[i + 1]);
    return d;
  }

  // Polyphase table for the filter. For a fractional output position ph/phases (in chip steps) it
  // holds one coefficient per chip step in the window: the integral of the kernel over that step.
  // kind "fir": windowed-sinc low-pass (Blackman-Harris), half-width `half` steps, cutoff in
  //             cycles per chip step. kind "box": plain average over one output sample.
  static buildKernel(kind, half, cutoff, ticksPerOut, phases) {
    const sub = 8;                                  // integration sub-steps per table cell
    const H = kind === "box" ? Math.ceil(ticksPerOut / 2) + 1 : half;
    const cells = 2 * H * phases + phases + 1;
    const h = u => {
      if (kind === "box") return Math.abs(u) <= ticksPerOut / 2 ? 1 / ticksPerOut : 0;
      if (Math.abs(u) >= H) return 0;
      const a = Math.PI * (u / H + 1);
      const win = 0.35875 - 0.48829 * Math.cos(a) + 0.14128 * Math.cos(2 * a) - 0.01168 * Math.cos(3 * a);
      return (u === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * u) / (Math.PI * u)) * win;
    };
    // S[i] = integral of h from -H to -H + i/phases (midpoint rule), normalised to 1 at the end
    const S = new Float64Array(cells);
    const du = 1 / (phases * sub);
    for (let i = 1; i < cells; i++) {
      let acc = 0;
      for (let s = 0; s < sub; s++) acc += h(-H + (i - 1) / phases + (s + 0.5) * du) * du;
      S[i] = S[i - 1] + acc;
    }
    const total = S[2 * H * phases];
    for (let i = 0; i < cells; i++) S[i] /= total;      // no clamp: the step response overshoots 1 by design
    const taps = 2 * H, table = new Float64Array((phases + 1) * taps);
    for (let ph = 0; ph <= phases; ph++) {
      for (let q = 1; q <= taps; q++) table[ph * taps + q - 1] = S[q * phases + ph] - S[(q - 1) * phases + ph];
    }
    return { half: H, taps, table, phases };
  }

  // opts: clock (Hz), sampleRate (Hz), filter ("fir" | "box"), kernelHalfWidth (chip steps),
  //       phases (table resolution), cutoffHz, dcBlock (bool), lowpassHz (0 = off)
  constructor(opts = {}) {
    this.dac = YM2149.buildDac32();
    this.regs = new Uint8Array(16);
    this.tonePer = new Int32Array(3);
    this.toneCnt = new Int32Array(3);
    this.toneOut = new Uint8Array(3);
    this.override = new Float64Array(3).fill(-1);
    // ST timer effects (see docs/ym2149-notes.md section 9.5), driven per chip step
    this.sidOn = new Uint8Array(3);
    this.sidState = new Uint8Array(3);
    this.sidVol = new Uint8Array(3);
    this.sidAcc = new Float64Array(3);
    this.sidHalf = new Float64Array(3);
    this.drumOn = new Uint8Array(3);
    this.drumData = [null, null, null];
    this.drumPos = new Float64Array(3);
    this.drumInc = new Float64Array(3);
    this.drumIdx = new Int32Array(3);
    this.setPan(0.5, 0.5, 0.5);
    this.dcBlock = opts.dcBlock !== false;
    this.lowpassHz = opts.lowpassHz || 0;
    this.filter = opts.filter || "fir";
    this.kernelHalfWidth = opts.kernelHalfWidth || 128;
    this.phases = opts.phases || 128;
    this.cutoffHz = opts.cutoffHz || 0;
    this.configure({ clock: opts.clock || 2000000, sampleRate: opts.sampleRate || 48000 });
    this.reset();
  }

  // (Re)derive everything that depends on the master clock or output rate
  configure({ clock, sampleRate }) {
    this.clock = clock;
    this.sampleRate = sampleRate;
    const stepRate = clock / 8;                       // chip steps per second
    this.stepRate = stepRate;
    this.ticksPerOut = stepRate / sampleRate;
    const hz = this.cutoffHz || Math.min(0.42 * sampleRate, 20000);
    this.kernel = YM2149.buildKernel(this.filter, this.kernelHalfWidth, hz / stepRate, this.ticksPerOut, this.phases);
    let m = 1;
    while (m < 4 * this.kernel.half + Math.ceil(this.ticksPerOut)) m <<= 1;
    this.ringMask = m - 1;
    this.vals = new Float64Array(m);
    this.valsL = new Float64Array(m);
    this.valsR = new Float64Array(m);
    this.lpCoef = this.lowpassHz ? 1 - Math.exp(-2 * Math.PI * this.lowpassHz / sampleRate) : 1;
    this.dirty = true;
    this.resetStream();
  }

  // Restart the output stream (not the chip registers)
  resetStream() {
    this.vals.fill(0); this.valsL.fill(0); this.valsR.fill(0);
    this.stepsDone = 0;           // chip steps generated so far
    this.outStep = 0;             // integer part of the next output sample's position, in chip steps
    this.outFrac = 0;             // fractional part
    this.dcX = this.dcY = this.lpY = 0;
    this.dcXR = this.dcYR = this.lpYR = 0;
  }

  reset() {
    this.regs.fill(0);
    this.tonePer.fill(1);
    this.toneCnt.fill(0);
    this.toneOut.fill(0);
    this.override.fill(-1);
    this.noise = 1;           // 17-bit LFSR, must never be 0
    this.noiseCnt = 0;
    this.noisePer = 2;
    this.envPer = 1;
    this.envCnt = 0;
    this.envRestart();
    this.sidOn.fill(0); this.sidState.fill(0); this.sidAcc.fill(0);
    this.drumOn.fill(0); this.drumData = [null, null, null];
    this.syncOn = false; this.syncAcc = 0; this.syncHalf = 1; this.syncShape = 0;
    this.fxActive = false;
    this.resetStream();
    this.dirty = true;
  }

  // ---- ST timer effects. Timer frequencies are in Hz of the MFP timer. ----

  fxRefresh() {
    this.fxActive = this.syncOn || this.sidOn.some(Boolean) || this.drumOn.some(Boolean);
  }

  // SID voice: the channel's level is toggled between `vol` (0..15) and 0 on every timer tick,
  // so the gate square wave runs at timerHz / 2. The channel's tone and noise still apply.
  sidStart(ch, timerHz, vol) {
    this.sidOn[ch] = 1; this.sidState[ch] = 0; this.sidAcc[ch] = 0;
    this.sidVol[ch] = vol & 15;
    this.sidHalf[ch] = this.stepRate / timerHz;
    this.fxRefresh(); this.dirty = true;
  }
  sidStop(ch) { this.sidOn[ch] = 0; this.fxRefresh(); this.dirty = true; }

  // Sync-buzzer: the envelope is restarted with `shape` on every timer tick
  syncBuzzerStart(timerHz, shape) {
    this.syncOn = true; this.syncAcc = 0; this.syncShape = shape & 15;
    this.syncHalf = this.stepRate / timerHz;
    this.write(13, this.syncShape);
    this.fxRefresh();
  }
  syncBuzzerStop() { this.syncOn = false; this.fxRefresh(); }

  // Digidrum: `data` holds linear amplitudes 0..255, played at `sampleHz` samples per second.
  // While it runs it replaces the channel's output completely.
  drumStart(ch, data, sampleHz) {
    if (!data || data.length === 0 || sampleHz <= 0) return;
    this.drumOn[ch] = 1; this.drumData[ch] = data; this.drumPos[ch] = 0; this.drumIdx[ch] = 0;
    this.drumInc[ch] = sampleHz / this.stepRate;
    this.override[ch] = data[0] / 255;
    this.fxRefresh(); this.dirty = true;
  }
  drumStop(ch) {
    if (this.drumOn[ch]) { this.drumOn[ch] = 0; this.override[ch] = -1; }
    this.fxRefresh(); this.dirty = true;
  }

  // Advance the effects by one chip step; true if the output may have changed
  fxStep() {
    let changed = false;
    for (let c = 0; c < 3; c++) {
      if (this.sidOn[c] && ++this.sidAcc[c] >= this.sidHalf[c]) {
        this.sidAcc[c] -= this.sidHalf[c]; this.sidState[c] ^= 1; changed = true;
      }
      if (this.drumOn[c]) {
        const pos = this.drumPos[c] += this.drumInc[c], idx = Math.floor(pos), d = this.drumData[c];
        if (idx >= d.length) {
          this.drumOn[c] = 0; this.override[c] = -1; this.fxRefresh(); changed = true;
        } else if (idx !== this.drumIdx[c]) {
          this.drumIdx[c] = idx; this.override[c] = d[idx] / 255; changed = true;
        }
      }
    }
    if (this.syncOn && ++this.syncAcc >= this.syncHalf) {
      this.syncAcc -= this.syncHalf; this.write(13, this.syncShape); changed = true;
    }
    return changed;
  }

  write(reg, value) {
    reg &= 15;
    const r = this.regs;
    switch (reg) {
      case 1: case 3: case 5: value &= 15; break;
      case 6: case 8: case 9: case 10: value &= 31; break;
      case 13: value &= 15; break;
      default: value &= 255;
    }
    r[reg] = value;
    if (reg < 6) {
      const c = reg >> 1;
      this.tonePer[c] = Math.max(1, r[c * 2] | (r[c * 2 + 1] << 8));
    } else if (reg === 6) {
      this.noisePer = Math.max(1, value) * 2;
    } else if (reg === 11 || reg === 12) {
      this.envPer = Math.max(1, r[11] | (r[12] << 8));
    } else if (reg === 13) {
      this.envRestart();   // writing the shape register restarts the envelope [datasheet]
    }
    this.dirty = true;
  }

  read(reg) { return this.regs[reg & 15]; }

  // Force a channel to a constant linear amplitude (0..1, 1 = loudest DAC level), ignoring the
  // mixer and level registers. Used for digidrums and SID effects. Pass a negative value to clear.
  setOverride(ch, amp) { this.override[ch] = amp; this.dirty = true; }

  // Amplitude (0..1) of a 4-bit level, for callers that map samples to the chip's curve
  static levelToAmp(n) { return YM2149.LEVELS_4BIT[n & 15] / 32767; }

  // Pan per channel, 0 = left, 1 = right (equal power). Only used by renderStereo().
  setPan(a, b, c) {
    this.panL = new Float64Array([a, b, c].map(p => Math.cos(p * Math.PI / 2)));
    this.panR = new Float64Array([a, b, c].map(p => Math.sin(p * Math.PI / 2)));
    this.dirty = true;
  }

  envRestart() {
    const att = (this.regs[13] >> 2) & 1;
    this.envDir = att ? 1 : -1;
    this.envPos = att ? 0 : 31;
    this.envHold = false;
    this.envCnt = 0;
  }

  envStep() {
    if (this.envHold) return;
    const shape = this.regs[13], cont = shape & 8, alt = shape & 2, hold = shape & 1;
    let pos = this.envPos + this.envDir;
    if (pos >= 0 && pos <= 31) { this.envPos = pos; return; }
    // A 32-step ramp has just finished
    if (!cont) {
      this.envPos = 0; this.envHold = true;
    } else if (hold) {
      // ALT inverts the final level of a held ramp
      this.envPos = (this.envDir > 0) !== !!alt ? 31 : 0;
      this.envHold = true;
    } else {
      if (alt) this.envDir = -this.envDir;
      this.envPos = this.envDir > 0 ? 0 : 31;
    }
  }

  // One chip step (8 master clocks). Returns true if anything that can affect the output changed.
  tick() {
    const tp = this.tonePer, tc = this.toneCnt, to = this.toneOut;
    let changed = false;
    for (let c = 0; c < 3; c++) {
      if (++tc[c] >= tp[c]) { tc[c] = 0; to[c] ^= 1; changed = true; }
    }
    if (++this.noiseCnt >= this.noisePer) {
      this.noiseCnt = 0;
      const n = this.noise, next = (n >> 1) | (((n ^ (n >> 3)) & 1) << 16);
      if ((n ^ next) & 1) changed = true;
      this.noise = next;
    }
    if (++this.envCnt >= this.envPer) {
      this.envCnt = 0;
      const was = this.envPos;
      this.envStep();
      if (this.envPos !== was) changed = true;
    }
    if (this.fxActive && this.fxStep()) changed = true;
    return changed;
  }

  // Combine the three channels into mixMono / mixL / mixR (each 0..1)
  mixOutputs() {
    const r = this.regs, mix = r[7], dac = this.dac, nz = this.noise & 1;
    let sum = 0, left = 0, right = 0;
    for (let c = 0; c < 3; c++) {
      let a;
      if (this.override[c] >= 0) {
        a = this.override[c];
      } else {
        // A disabled source reads as 1, so with both disabled the channel outputs its level steadily
        const on = (this.toneOut[c] | ((mix >> c) & 1)) & (nz | ((mix >> (3 + c)) & 1));
        // A SID voice replaces the level register with vol or 0 (and never uses the envelope)
        const lv = this.sidOn[c] ? (this.sidState[c] ? this.sidVol[c] : 0) : r[8 + c];
        a = on ? ((lv & 16) ? dac[this.envPos] : dac[2 * (lv & 15) + 1]) : 0;
      }
      sum += a;
      left += a * this.panL[c]; right += a * this.panR[c];
    }
    this.mixMono = sum / 3;
    this.mixL = left / 3;
    this.mixR = right / 3;
    this.dirty = false;
  }

  // Fill out[0..n) with mono samples
  render(out, n) { this.run(out, null, n); }

  // Fill left/right with pan-weighted samples
  renderStereo(left, right, n) { this.run(left, right, n); }

  // The output runs `half` chip steps behind the chip (the filter needs future steps),
  // about 0.5 ms with the default kernel.
  run(outL, outR, n) {
    const stereo = outR !== null, K = this.kernel, half = K.half, taps = K.taps, table = K.table, phases = K.phases;
    const vals = this.vals, valsL = this.valsL, valsR = this.valsR, mask = this.ringMask;
    const dcR = 0.995, lpC = this.lpCoef, dcOn = this.dcBlock;
    if (this.dirty) this.mixOutputs();
    for (let i = 0; i < n; i++) {
      // Make sure every chip step the window needs exists
      const need = this.outStep + half;
      while (this.stepsDone <= need) {
        if (this.tick() || this.dirty) this.mixOutputs();
        const j = this.stepsDone & mask;
        if (stereo) { valsL[j] = this.mixL; valsR[j] = this.mixR; } else vals[j] = this.mixMono;
        this.stepsDone++;
      }
      // Window covers steps outStep+half-1 down to outStep-half; coefficient q pairs with step outStep+half-q
      const pos = this.outFrac * phases, ph = Math.floor(pos), w = pos - ph, w0 = 1 - w;
      const b0 = ph * taps, b1 = b0 + taps, top = this.outStep + half;
      let y = 0, yr = 0;
      if (stereo) {
        for (let q = 1; q <= taps; q++) {
          const c = table[b0 + q - 1] * w0 + table[b1 + q - 1] * w, j = (top - q) & mask;
          y += valsL[j] * c; yr += valsR[j] * c;
        }
      } else {
        for (let q = 1; q <= taps; q++) {
          y += vals[(top - q) & mask] * (table[b0 + q - 1] * w0 + table[b1 + q - 1] * w);
        }
      }
      // Advance to the next output sample
      this.outFrac += this.ticksPerOut;
      const adv = Math.floor(this.outFrac);
      this.outStep += adv; this.outFrac -= adv;
      // Optional ST-style output low-pass, then DC blocker
      if (lpC < 1) {
        this.lpY += lpC * (y - this.lpY); y = this.lpY;
        if (stereo) { this.lpYR += lpC * (yr - this.lpYR); yr = this.lpYR; }
      }
      if (dcOn) {
        const o = y - this.dcX + dcR * this.dcY;
        this.dcX = y; this.dcY = o; y = o;
        if (stereo) {
          const oR = yr - this.dcXR + dcR * this.dcYR;
          this.dcXR = yr; this.dcYR = oR; yr = oR;
        }
      }
      outL[i] = y;
      if (stereo) outR[i] = yr;
    }
  }
}

if (typeof module !== "undefined" && module.exports) module.exports = { YM2149 };
