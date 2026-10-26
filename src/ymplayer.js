"use strict";

// YM song player: steps through the register frames of a parsed YM file at sample-accurate timing,
// writes them to a YM2149 and starts the ST timer effects each frame asks for.
// Frame layout and effect encoding: docs/ym2149-notes.md sections 9.3 to 9.6.
//
// Pure JS like the chip core. Uses the global/required YM2149 class, so in an AudioWorklet both
// classes must be defined (via toString()) before this one is constructed.

const _YM2149 = (typeof module !== "undefined" && module.exports && typeof require === "function")
  ? require("./ym2149.js").YM2149
  : YM2149;

class YMPlayer {
  static MFP_CLOCK = 2457600;                          // ST timer clock, Hz
  static MFP_PRESCALE = [0, 4, 10, 16, 50, 64, 100, 200];   // index 0 = effect off

  // song: result of parseYm(). opts: sampleRate, loop (default true), plus any YM2149 option.
  constructor(song, opts = {}) {
    this.song = song;
    this.loop = opts.loop !== false;
    this.chip = new _YM2149({ ...opts, clock: song.clock });
    this.sampleRate = this.chip.sampleRate;
    this.samplesPerFrame = this.sampleRate / song.frameRate;
    this.drums = song.drums.map(d => YMPlayer.drumAmplitudes(d.data, song.drum4bit));
    this.onFrame = null;                                // optional callback(frameIndex), for tests and sync
    this.playing = true;
    this.seek(0);
  }

  // Digidrum samples as linear amplitudes 0..255, as the reference player does: 4-bit samples are
  // mapped through the chip's level table, 8-bit samples are used as they are.
  static drumAmplitudes(data, fourBit) {
    if (!fourBit) return data;
    const out = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = _YM2149.LEVELS_4BIT[data[i] & 15] >> 7;
    return out;
  }

  // Jump to a frame. The chip is reset, so the sound restarts cleanly from the new position.
  seek(frame) {
    this.chip.reset();
    this.frame = Math.max(0, Math.min(this.song.frames, Math.floor(frame)));
    this.frameLeft = 0;                                 // samples left in the current frame
    this.carry = 0;                                     // fractional samples carried between frames
    this.finished = this.frame >= this.song.frames;
    this.samplesPlayed = 0;
    this.loops = 0;                                     // times the song has wrapped round to the loop frame
  }

  play() { this.playing = true; }
  pause() { this.playing = false; }

  // Seconds of the song played so far in this pass (not counting loops)
  get position() { return this.frame * this.samplesPerFrame / this.sampleRate; }

  // Fractional frame position of the audio rendered so far. `frame` is the next frame to start, so
  // the part of the current frame still to render is taken off.
  get framePosition() { return this.frame - this.frameLeft / this.samplesPerFrame; }

  // Fill out[0..n) with mono samples
  render(out, n) { this.run(out, null, n); }
  renderStereo(left, right, n) { this.run(left, right, n); }

  run(outL, outR, n) {
    let done = 0;
    while (done < n) {
      if (!this.playing || this.finished) {
        outL.fill(0, done, n);
        if (outR) outR.fill(0, done, n);
        return;
      }
      if (this.frameLeft === 0) {
        if (!this.startFrame()) continue;               // end of song handled
      }
      const take = Math.min(n - done, this.frameLeft);
      const l = outL.subarray(done, done + take);
      if (outR) this.chip.renderStereo(l, outR.subarray(done, done + take), take);
      else this.chip.render(l, take);
      this.frameLeft -= take; done += take;
      this.samplesPlayed += take;
    }
  }

  // Begin the next frame; returns false if the song ended and there is nothing to play yet
  startFrame() {
    const song = this.song;
    if (this.frame >= song.frames) {
      if (this.loop) { this.frame = song.loopFrame < song.frames ? song.loopFrame : 0; this.loops++; }
      else { this.finished = true; this.chip.reset(); return false; }
    }
    const j = this.frame++;
    this.carry += this.samplesPerFrame;
    this.frameLeft = Math.floor(this.carry);
    this.carry -= this.frameLeft;
    this.applyRegisters(song.regs.subarray(j * 16, j * 16 + 16));
    if (this.onFrame) this.onFrame(j);
    return this.frameLeft > 0;
  }

  applyRegisters(r) {
    const chip = this.chip;
    // Effects last one frame: stop them, write the registers, start the ones this frame asks for.
    // Digidrums are not stopped, they play on until their sample ends.
    for (let c = 0; c < 3; c++) chip.sidStop(c);
    chip.syncBuzzerStop();
    for (let k = 0; k < 13; k++) chip.write(k, r[k]);
    if (r[13] !== 0xff) chip.write(13, r[13]);          // 0xFF = leave the envelope alone
    const format = this.song.format;
    if (format === "YM6!") {
      this.effectSlot(r, 1, 6, 14);
      this.effectSlot(r, 3, 8, 15);
    } else if (format === "YM5!") {
      this.ym5Effects(r);
    }
  }

  // Timer frequency for an effect, or 0 if the prescale index or count is zero (= no effect)
  static timerHz(prescaleIndex, count) {
    const divisor = YMPlayer.MFP_PRESCALE[prescaleIndex & 7] * count;
    return divisor ? YMPlayer.MFP_CLOCK / divisor : 0;
  }

  // YM6 effect slot: code nibble in r[codeReg], prescale in the top 3 bits of r[preReg], count in r[cntReg]
  effectSlot(r, codeReg, preReg, cntReg) {
    const code = r[codeReg] & 0xf0;
    if (!(code & 0x30)) return;                         // no effect
    const voice = ((code & 0x30) >> 4) - 1;
    const hz = YMPlayer.timerHz(r[preReg] >> 5, r[cntReg]);
    if (!hz) return;
    switch (code & 0xc0) {
      case 0x00: this.chip.sidStart(voice, hz, r[8 + voice] & 15); break;
      case 0x40: this.startDrum(voice, r[8 + voice] & 31, hz); break;
      case 0xc0: this.chip.syncBuzzerStart(hz, r[8 + voice] & 15); break;
      // 0x80 is the sinus-SID: the reference player never implemented it, and neither do we yet
    }
  }

  // YM5 has two fixed effects: SID voice and digidrum
  ym5Effects(r) {
    const sidVoice = (r[1] >> 4) & 3;
    if (sidVoice) {
      const hz = YMPlayer.timerHz(r[6] >> 5, r[14]);
      if (hz) this.chip.sidStart(sidVoice - 1, hz, r[8 + sidVoice - 1] & 15);
    }
    const drumVoice = (r[3] >> 4) & 3;
    if (drumVoice) {
      const hz = YMPlayer.timerHz(r[8] >> 5, r[15]);
      if (hz) this.startDrum(drumVoice - 1, r[8 + drumVoice - 1] & 31, hz);
    }
  }

  startDrum(voice, index, hz) {
    if (index < this.drums.length) this.chip.drumStart(voice, this.drums[index], hz);
  }
}

if (typeof module !== "undefined" && module.exports) module.exports = { YMPlayer };
