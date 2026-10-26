"use strict";

// Generates small test .ym files that we own outright (T1.7).
// Usage: node tools/gen-test-ym.js [outDir]    (default: tests/data)

const fs = require("fs");
const path = require("path");

const CLOCK = 2000000;
const tp = hz => Math.round(CLOCK / (16 * hz));            // tone period for a frequency
const midi = n => 440 * 2 ** ((n - 69) / 12);

// Frames are 16-byte arrays of register values. R13 = 0xFF means "do not retrigger the envelope".
const newFrame = () => { const f = new Uint8Array(16); f[13] = 0xff; return f; };
function setTone(f, ch, period) { f[ch * 2] = period & 255; f[ch * 2 + 1] = (period >> 8) & 15; }

// Writes an interleaved (planar) YM5!/YM6! file
function writeYm(id, frames, { title, comment = "", loop = 0 }) {
  const strs = Buffer.from(title + "\0" + "Test generator\0" + comment + "\0", "latin1");
  const head = Buffer.alloc(34);
  head.write(id, 0, "latin1");
  head.write("LeOnArD!", 4, "latin1");
  head.writeUInt32BE(frames.length, 12);
  head.writeUInt32BE(1, 16);              // attributes: interleaved
  head.writeUInt16BE(0, 20);              // digidrums
  head.writeUInt32BE(CLOCK, 22);
  head.writeUInt16BE(50, 26);
  head.writeUInt32BE(loop, 28);
  head.writeUInt16BE(0, 32);              // extra data
  const data = Buffer.alloc(frames.length * 16);
  frames.forEach((f, j) => { for (let k = 0; k < 16; k++) data[k * frames.length + j] = f[k]; });
  return Buffer.concat([head, strs, data]);
}

// Held for n frames: calls fill(frame, i) for each
function hold(n, fill) {
  return Array.from({ length: n }, (_, i) => { const f = newFrame(); fill(f, i); return f; });
}

const files = {};

// A440 reference then a C major scale on channel A, then a C major triad
{
  const frames = [];
  frames.push(...hold(50, f => { setTone(f, 0, tp(440)); f[7] = 0x3e; f[8] = 12; }));
  for (const n of [60, 62, 64, 65, 67, 69, 71, 72]) {
    frames.push(...hold(25, f => { setTone(f, 0, tp(midi(n))); f[7] = 0x3e; f[8] = 12; }));
  }
  frames.push(...hold(75, f => {
    [60, 64, 67].forEach((n, c) => { setTone(f, c, tp(midi(n))); f[8 + c] = 10; });
    f[7] = 0x38;
  }));
  files["scale.ym"] = writeYm("YM5!", frames, { title: "Scale", comment: "A440, C major scale, C major triad" });
}

// Noise only on channel A, period 1 to 31 (10 frames each)
{
  const frames = [];
  for (let np = 1; np <= 31; np++) frames.push(...hold(10, f => { f[6] = np; f[7] = 0x37; f[8] = 12; }));
  files["noise-sweep.ym"] = writeYm("YM5!", frames, { title: "Noise sweep", comment: "Noise period 1..31" });
}

// Every envelope shape for one second each (envelope on channel A over a steady tone)
{
  const frames = [];
  for (let shape = 0; shape < 16; shape++) {
    frames.push(...hold(50, (f, i) => {
      setTone(f, 0, tp(220)); f[7] = 0x3e; f[8] = 16;
      f[11] = 0xe8; f[12] = 0x03;         // envelope period 1000 (about 4 ms per step)
      if (i === 0) f[13] = shape;
    }));
  }
  files["envelopes.ym"] = writeYm("YM5!", frames, { title: "Envelope shapes", comment: "Shapes 0..15, one second each" });
}

// SID voice on channel A (YM6 effect slot 1): prescale index 2 (/10) x count 100 -> 2457.6 Hz
{
  const frames = hold(100, f => {
    setTone(f, 0, tp(220)); f[7] = 0x3e; f[8] = 12;
    f[1] |= 0x10;                          // effect: SID on voice A
    f[6] = (2 << 5);                       // prescale index 2 (/10) in R6 bits 5-7
    f[14] = 100;                           // timer count
  });
  files["sid-voice.ym"] = writeYm("YM6!", frames, { title: "SID voice", comment: "YM6 SID effect on voice A, 2457.6 Hz" });
}

const outDir = path.resolve(process.argv[2] || path.join(__dirname, "..", "tests", "data"));
fs.mkdirSync(outDir, { recursive: true });
for (const [name, buf] of Object.entries(files)) {
  fs.writeFileSync(path.join(outDir, name), buf);
  console.log(name.padEnd(18), buf.length, "bytes");
}
