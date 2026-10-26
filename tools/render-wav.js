"use strict";

// Renders a .ym file to a 16-bit mono WAV so we can listen to it and analyse it.
// Usage: node tools/render-wav.js in.ym out.wav [--start S] [--seconds N] [--rate 48000] [--box]
//                                 [--lowpass Hz] [--gain G] [--loop]
// The level is normalised to a 0.9 peak unless --gain is given (a single quiet channel is only about 0.1).
//
// Reads raw or LHA-compressed YM2/3/3b/5/6 files and plays them with the real player, including the
// ST effects (SID voice, sync-buzzer, digidrums). Not played: sinus-SID and YM2 Mad Max digidrums;
// the tool warns if a tune uses them.

const fs = require("fs");
const { YMPlayer } = require("../src/ymplayer.js");
const { parseYm } = require("../src/ymfile.js");

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i < 0 ? def : args[i + 1]; };
const valueFlags = ["--start", "--seconds", "--rate", "--lowpass", "--gain"];
const positional = args.filter((a, i) => !a.startsWith("--") && !valueFlags.includes(args[i - 1]));
const [inFile, outFile] = positional;
if (!inFile || !outFile) {
  console.error("usage: render-wav.js in.ym out.wav [--start S] [--seconds N] [--rate N] [--box] [--lowpass Hz] [--gain G] [--loop]");
  process.exit(1);
}

const rate = +opt("--rate", 48000);
const startSec = +opt("--start", 0);
const song = parseYm(fs.readFileSync(inFile));
const songSec = song.frames / song.frameRate;
// Without --loop the render stops at the end of the song, even if --seconds asks for more
const left = Math.max(0, songSec - startSec);
const lenSec = args.includes("--loop") ? +opt("--seconds", left) : Math.min(+opt("--seconds", left), left);

// Frames that use effects, using the layout in docs/ym2149-notes.md section 9.4
function effectFrames(ym) {
  const MFP = YMPlayer.MFP_PRESCALE, R = ym.regs, n = { sid: 0, drum: 0, sync: 0, sinus: 0, madmax: 0 };
  const slot = (j, code, pre, cnt) => {
    const c = R[j * 16 + code] & 0xf0;
    if (!(c & 0x30) || !(MFP[(R[j * 16 + pre] >> 5) & 7] * R[j * 16 + cnt])) return;
    const t = c & 0xc0;
    if (t === 0x40 && (R[j * 16 + 8 + ((c & 0x30) >> 4) - 1] & 31) >= ym.drums.length) return;
    n[t === 0 ? "sid" : t === 0x40 ? "drum" : t === 0x80 ? "sinus" : "sync"]++;
  };
  for (let j = 0; j < ym.frames; j++) {
    if (ym.format === "YM6!") { slot(j, 1, 6, 14); slot(j, 3, 8, 15); }
    else if (ym.format === "YM5!") {
      if (((R[j * 16 + 1] >> 4) & 3) && MFP[(R[j * 16 + 6] >> 5) & 7] * R[j * 16 + 14]) n.sid++;
      const v = (R[j * 16 + 3] >> 4) & 3;
      if (v && MFP[(R[j * 16 + 8] >> 5) & 7] * R[j * 16 + 15] && (R[j * 16 + 7 + v] & 31) < ym.drums.length) n.drum++;
    } else if (ym.format === "YM2!" && (R[j * 16 + 10] & 0x80)) n.madmax++;
  }
  return n;
}

const fx = effectFrames(song);
const played = Object.entries(fx).filter(([k, v]) => v && k !== "sinus" && k !== "madmax").map(([k, v]) => `${k} ${v}`).join(", ");
console.log(`${song.format}${song.packed ? " (LHA" + (song.crcOk ? ", CRC ok)" : ", CRC MISMATCH)") : ""} "${song.title}"` +
  ` by "${song.author}", ${song.frames} frames at ${song.frameRate} Hz (${songSec.toFixed(1)} s)`);
if (played) console.log(`  effects played: ${played} frames` + (song.drums.length ? `, ${song.drums.length} digidrum samples` : ""));
if (fx.sinus) console.warn(`  warning: ${fx.sinus} frames use sinus-SID, which is not played`);
if (fx.madmax) console.warn(`  warning: ${fx.madmax} frames use Mad Max digidrums (YM2), which are not played`);

const player = new YMPlayer(song, {
  sampleRate: rate, loop: args.includes("--loop"), filter: args.includes("--box") ? "box" : "fir",
  lowpassHz: +opt("--lowpass", 0),
});
const skip = Math.round(startSec * rate), total = Math.round(lenSec * rate);
const out = new Float32Array(total);
const block = new Float32Array(4096);
let done = 0, peak = 0;
// Audio before --start is still played through the chip (and discarded) so its state is right
for (let at = 0; at < skip + total; ) {
  const n = Math.min(block.length, skip + total - at);
  player.render(block, n);
  for (let i = 0; i < n; i++, at++) {
    if (at >= skip) { out[done++] = block[i]; peak = Math.max(peak, Math.abs(block[i])); }
  }
}
const gain = args.includes("--gain") ? +opt("--gain", 1) : (peak > 0 ? 0.9 / peak : 1);
const pcm = new Int16Array(done);
for (let i = 0; i < done; i++) pcm[i] = Math.round(Math.max(-1, Math.min(1, out[i] * gain)) * 32767);

const wav = Buffer.alloc(44 + done * 2);
wav.write("RIFF", 0); wav.writeUInt32LE(36 + done * 2, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write("data", 36); wav.writeUInt32LE(done * 2, 40);
Buffer.from(pcm.buffer, 0, done * 2).copy(wav, 44);
fs.writeFileSync(outFile, wav);
console.log(`  -> ${outFile}: ${(done / rate).toFixed(1)} s from ${startSec} s, raw peak ${peak.toFixed(3)}, gain x${gain.toFixed(2)}`);
