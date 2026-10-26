"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { YM2149 } = require("../src/ym2149.js");

const CLOCK = 2000000, RATE = 48000;
const rawChip = (o = {}) => new YM2149({ clock: CLOCK, sampleRate: RATE, dcBlock: false, ...o });

function renderSeconds(chip, seconds, skip = 0) {
  const n = Math.round(seconds * RATE) + skip, buf = new Float32Array(n);
  chip.render(buf, n);
  return buf.subarray(skip);
}

// Frequency from upward crossings of the mean level
function measureHz(buf) {
  let mean = 0;
  for (const v of buf) mean += v;
  mean /= buf.length;
  let crossings = 0, first = -1, last = -1;
  for (let i = 1; i < buf.length; i++) {
    if (buf[i - 1] < mean && buf[i] >= mean) { crossings++; if (first < 0) first = i; last = i; }
  }
  return (crossings - 1) * RATE / (last - first);
}

const setTone = (chip, ch, tp) => { chip.write(ch * 2, tp & 255); chip.write(ch * 2 + 1, tp >> 8); };
const hzOf = tp => CLOCK / (16 * tp);

test("tone frequency matches fMaster / (16 x period)", () => {
  for (const tp of [100, 284, 1000, 4000]) {
    const chip = rawChip();
    setTone(chip, 0, tp);
    chip.write(7, 0x3e);
    chip.write(8, 15);
    const hz = measureHz(renderSeconds(chip, 2, 4000));
    assert.ok(Math.abs(hz / hzOf(tp) - 1) < 0.005, `period ${tp}: ${hz.toFixed(2)} Hz vs ${hzOf(tp).toFixed(2)} Hz`);
  }
});

test("A440 on the ST is period 284", () => {
  assert.ok(Math.abs(hzOf(284) - 440) < 0.5);
});

test("a tone period of 0 behaves as 1, and register writes are masked", () => {
  const chip = rawChip();
  chip.write(0, 0); chip.write(1, 0);
  assert.equal(chip.tonePer[0], 1);
  chip.write(1, 0xff);
  assert.equal(chip.read(1), 15, "R1 keeps 4 bits");
  chip.write(6, 0xff);
  assert.equal(chip.read(6), 31, "R6 keeps 5 bits");
  chip.write(8, 0xff);
  assert.equal(chip.read(8), 31, "R8 keeps 5 bits (level + envelope bit)");
  chip.write(13, 0xff);
  assert.equal(chip.read(13), 15, "R13 keeps 4 bits");
});

test("mixer: all 64 tone/noise enable combinations, three channels", () => {
  const chip = rawChip();
  chip.write(8, 3); chip.write(9, 7); chip.write(10, 11);
  const amp = lv => YM2149.levelToAmp(lv);
  for (let r7 = 0; r7 < 64; r7++) {
    for (const tone of [0, 1]) for (const noise of [0, 1]) {
      chip.write(7, r7);
      chip.toneOut.fill(tone);
      chip.noise = noise ? 1 : 2;     // only bit 0 is the output
      chip.mixOutputs();
      let expect = 0;
      [3, 7, 11].forEach((lv, c) => {
        const toneDisabled = (r7 >> c) & 1, noiseDisabled = (r7 >> (3 + c)) & 1;   // active low
        const on = (tone || toneDisabled) && (noise || noiseDisabled);
        if (on) expect += amp(lv);
      });
      assert.ok(Math.abs(chip.mixMono * 3 - expect) < 1e-12, `R7=${r7.toString(2)} tone=${tone} noise=${noise}`);
    }
  }
});

test("mixer: disabled tone and noise give a steady level (what digidrums rely on)", () => {
  const chip = rawChip();
  chip.write(7, 0x3f); chip.write(8, 15);
  const buf = renderSeconds(chip, 0.2, 2000);
  let min = Infinity, max = -Infinity;
  for (const v of buf) { min = Math.min(min, v); max = Math.max(max, v); }
  assert.ok(max - min < 1e-6, "output is steady");
  assert.ok(max > 0.3, "at the full channel level (1/3 of the mix)");
});

// Independent LFSR reference: 17 bits, feedback bit0 XOR bit3 shifted into bit 16
const refNext = n => (n >> 1) | (((n ^ (n >> 3)) & 1) << 16);

test("noise LFSR follows the reference and has period 2^17 - 1", () => {
  const chip = rawChip();
  chip.write(6, 1);                            // one shift per 2 chip steps
  assert.equal(chip.noisePer, 2);
  let ref = chip.noise;
  assert.equal(ref, 1);
  const period = (1 << 17) - 1;
  for (let i = 1; i <= period; i++) {
    chip.tick(); chip.tick();
    ref = refNext(ref);
    assert.equal(chip.noise, ref, `shift ${i}`);
    if (i < period) assert.notEqual(chip.noise, 1, `repeated early at ${i}`);
  }
  assert.equal(chip.noise, 1, "back to the start after 2^17 - 1 shifts");
});

test("noise period scales the shift rate", () => {
  const chip = rawChip();
  chip.write(6, 5);
  const start = chip.noise;
  for (let i = 0; i < 9; i++) chip.tick();
  assert.equal(chip.noise, start, "no shift before 2 x 5 steps");
  chip.tick();
  assert.equal(chip.noise, refNext(start), "shift on step 10");
});

// Independent envelope reference built from two segments per shape (D down, U up, L hold low, H hold high)
const SEGMENTS = {
  0: "DL", 1: "DL", 2: "DL", 3: "DL", 4: "UL", 5: "UL", 6: "UL", 7: "UL",
  8: "DD", 9: "DL", 10: "DU", 11: "DH", 12: "UU", 13: "UH", 14: "UD", 15: "UL",
};
function refEnvelope(shape, i) {
  const seg = SEGMENTS[shape];
  const value = (type, k) => type === "D" ? 31 - k : type === "U" ? k : type === "L" ? 0 : 31;
  if (i < 32) return value(seg[0], i);
  if (seg[1] === "L" || seg[1] === "H") return value(seg[1], 0);
  const j = (i - 32) % 64;
  return j < 32 ? value(seg[1], j) : value(seg[0], j - 32);
}

test("all 16 envelope shapes step through the expected 32-step patterns", () => {
  for (let shape = 0; shape < 16; shape++) {
    const chip = rawChip();
    chip.write(11, 1); chip.write(12, 0);      // period 1: one step per chip step
    chip.write(13, shape);
    for (let i = 0; i < 300; i++) {
      assert.equal(chip.envPos, refEnvelope(shape, i), `shape ${shape} step ${i}`);
      chip.tick();
    }
  }
});

test("writing R13 restarts the envelope", () => {
  const chip = rawChip();
  chip.write(11, 1); chip.write(13, 0x0c);     // sawtooth up
  for (let i = 0; i < 10; i++) chip.tick();
  assert.equal(chip.envPos, 10);
  chip.write(13, 0x0c);
  assert.equal(chip.envPos, 0);
});

test("envelope step rate is 8 x period master clocks", () => {
  const chip = rawChip();
  chip.write(11, 3); chip.write(13, 0x0c);
  for (let i = 0; i < 5; i++) chip.tick();
  assert.equal(chip.envPos, 1, "one step after 3 chip steps, not yet two");
  chip.tick();
  assert.equal(chip.envPos, 2);
});

test("level table: silent at step 0, loudest at step 31, rises with level", () => {
  const dac = YM2149.buildDac32();
  assert.equal(dac[0], 0);
  assert.equal(dac[31], 1);
  for (let i = 1; i < 32; i++) assert.ok(dac[i] > dac[i - 1], `step ${i}`);
  for (let n = 0; n < 16; n++) assert.equal(dac[2 * n + 1], YM2149.LEVELS_4BIT[n] / 32767);
});

test("an envelope channel follows the envelope and a fixed channel ignores it", () => {
  const chip = rawChip();
  chip.write(7, 0x3f);
  chip.write(8, 16);                           // envelope mode
  chip.write(9, 15);                           // fixed, loudest
  chip.write(11, 255); chip.write(12, 255);    // very slow envelope
  chip.write(13, 0x0c);                        // starts at step 0
  chip.mixOutputs();
  const dac = chip.dac;
  assert.ok(Math.abs(chip.mixMono * 3 - (dac[0] + 1 + dac[1])) < 1e-12);
});

test("override replaces a channel's output", () => {
  const chip = rawChip();
  chip.write(7, 0x3f);
  chip.setOverride(0, 0.5);
  chip.mixOutputs();
  assert.ok(Math.abs(chip.mixMono * 3 - (0.5 + dac1() + dac1())) < 1e-12);
  chip.setOverride(0, -1);
  chip.mixOutputs();
  assert.ok(Math.abs(chip.mixMono * 3 - 3 * dac1()) < 1e-12);
  function dac1() { return chip.dac[1]; }
});

test("output stays finite and within range with everything running", () => {
  const chip = new YM2149({ clock: CLOCK, sampleRate: RATE });
  for (let c = 0; c < 3; c++) { setTone(chip, c, 37 + c * 11); chip.write(8 + c, 16); }
  chip.write(6, 9); chip.write(7, 0x00); chip.write(11, 40); chip.write(13, 0x0e);
  const buf = renderSeconds(chip, 1);
  for (const v of buf) assert.ok(Number.isFinite(v) && Math.abs(v) <= 1.2);
});

test("rendering is deterministic and independent of how the calls are chunked", () => {
  const make = () => { const c = rawChip(); setTone(c, 0, 123); c.write(7, 0x3e); c.write(8, 12); return c; };
  const whole = renderSeconds(make(), 0.5);
  const chip = make(), parts = new Float32Array(whole.length);
  let pos = 0;
  for (const n of [1, 7, 100, 959, 5000]) {
    const take = Math.min(n, parts.length - pos), b = new Float32Array(take);
    chip.render(b, take); parts.set(b, pos); pos += take;
  }
  const rest = new Float32Array(parts.length - pos);
  chip.render(rest, rest.length); parts.set(rest, pos);
  assert.deepEqual(parts, whole);
});

test("stereo: centre pan gives equal channels, hard pan separates them", () => {
  const chip = rawChip();
  setTone(chip, 0, 100); chip.write(7, 0x3e); chip.write(8, 15);
  const l = new Float32Array(2000), r = new Float32Array(2000);
  chip.renderStereo(l, r, 2000);
  assert.deepEqual(l, r);
  const hard = rawChip();
  setTone(hard, 0, 100); hard.write(7, 0x3e); hard.write(8, 15);
  hard.setPan(0, 0.5, 1);                       // channel A fully left
  hard.renderStereo(l, r, 2000);
  let rMax = 0; for (let i = 500; i < 2000; i++) rMax = Math.max(rMax, Math.abs(r[i]));
  // channels B and C sit at their steady level-0 floor, so the right side stays almost silent
  assert.ok(rMax < 0.01, `right max ${rMax}`);
});

// ---- aliasing (T2.6) ----

function fftPower(x) {
  const n = x.length, re = Float64Array.from(x), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] *= 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);    // Hann
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  const p = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) p[i] = re[i] * re[i] + im[i] * im[i];
  return p;
}

// Energy away from the harmonics of f0, relative to the total, in dB
function inharmonicDb(filter, tp) {
  const chip = rawChip({ filter });
  setTone(chip, 0, tp); chip.write(7, 0x3e); chip.write(8, 15);
  const n = 1 << 16, buf = renderSeconds(chip, n / RATE, 4000).subarray(0, n);
  const p = fftPower(buf), f0 = hzOf(tp), binHz = RATE / n;
  let total = 0, bad = 0;
  const skip = new Uint8Array(p.length);
  for (let h = 1; h * f0 < RATE / 2; h++) {
    const c = Math.round(h * f0 / binHz);
    for (let b = c - 6; b <= c + 6; b++) if (b >= 0 && b < p.length) skip[b] = 1;
  }
  for (let b = 3; b < p.length; b++) { total += p[b]; if (!skip[b]) bad += p[b]; }
  return 10 * Math.log10(bad / total);
}

test("aliasing: the FIR decimator keeps inharmonic energy well down, and beats a plain box average", () => {
  for (const tp of [37, 53]) {
    const fir = inharmonicDb("fir", tp), box = inharmonicDb("box", tp);
    console.log(`  period ${tp}: inharmonic energy fir ${fir.toFixed(1)} dB, box ${box.toFixed(1)} dB`);
    assert.ok(fir < -50, `fir ${fir}`);
    assert.ok(fir < box - 10, `fir ${fir} vs box ${box}`);
  }
});

// ---- the "done when" check for Phase 1: a scale written through register writes ----

test("a scale written through register writes renders the right pitches", () => {
  const chip = rawChip();
  chip.write(7, 0x3e); chip.write(8, 12);
  for (const note of [60, 62, 64, 65, 67, 69, 71, 72]) {
    const ideal = 440 * 2 ** ((note - 69) / 12), tp = Math.round(CLOCK / (16 * ideal));
    setTone(chip, 0, tp);
    renderSeconds(chip, 0.05);
    const hz = measureHz(renderSeconds(chip, 1));
    assert.ok(Math.abs(hz / hzOf(tp) - 1) < 0.005, `note ${note}: ${hz.toFixed(2)} Hz vs period ${tp}`);
    assert.ok(Math.abs(hz / ideal - 1) < 0.01, `note ${note}: ${hz.toFixed(2)} Hz vs ideal ${ideal.toFixed(2)} Hz`);
  }
});
