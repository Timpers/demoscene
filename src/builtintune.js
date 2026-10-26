"use strict";

// The demo's own tune, "Pixel Riot Theme": the original Am-F-C-G demo tune re-arranged for the three
// channels of the YM2149 the way ST musicians did it. It is generated in code into the same song
// object parseYm() returns, so the player, the part schedule and the beat signal treat it like any
// other tune. No file is needed, and nobody else's music is involved.
//
//   channel A  the lead melody; in the breakdown, a quiet high arpeggio (sparkle) instead
//   channel B  the bass. The kick steals its first four frames with a falling pitch and a click of
//              noise. In the breakdown the bass is an envelope "buzz" bass: tone off, with the
//              envelope's sawtooth running at the note's pitch
//   channel C  a chord arpeggio that cycles through the chord tones every frame (the classic ST chord
//              sound), interrupted by noise for snares and hi-hats
//
// 125 BPM at 50 frames a second makes a sixteenth note exactly 6 frames, so a bar is 96 frames.
// 32 bars is 61.4 s, which the demo's part schedule cuts into three parts of about 20 s.

const BUILTIN = (() => {
  const CLOCK = 2000000, FPS = 50, STEP = 6, STEPS_PER_BAR = 16, BAR = STEP * STEPS_PER_BAR, BARS = 32;
  const FRAMES = BAR * BARS, TOTAL_STEPS = STEPS_PER_BAR * BARS;
  const hz = n => 440 * 2 ** ((n - 69) / 12);
  const tonePeriod = n => Math.max(1, Math.min(4095, Math.round(CLOCK / (16 * hz(n)))));
  const PROG = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]];   // Am F C G
  const LEAD = [
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [81, 0, 0, 79, 0, 76, 0, 0, 72, 0, 76, 0, 79, 0, 0, 0],
    [81, 0, 84, 0, 81, 0, 79, 0, 76, 0, 0, 72, 0, 74, 76, 0],
    [88, 0, 86, 0, 84, 0, 81, 0, 79, 0, 76, 0, 79, 81, 0, 0],
  ];
  const every = () => true, never = () => false;
  const onSteps = (...s) => st => s.includes(st);

  // What each bar does
  function plan(bar) {
    const p = { lead: 0, kick: every, snare: never, hat: never, octave: false, buzz: false, sparkle: false, build: false };
    p.kick = st => st % 4 === 0;
    p.hat = st => st % 2 === 1;
    if (bar < 2) { p.snare = never; }
    else if (bar < 4) { p.snare = onSteps(4, 12); }
    else if (bar < 8) { p.lead = 1; p.snare = onSteps(4, 12); }
    else if (bar < 16) { p.lead = 2; p.snare = onSteps(4, 12); p.octave = true; }
    else if (bar < 20) { p.sparkle = true; p.buzz = true; p.kick = never; p.snare = never; }                       // breakdown
    else if (bar < 23) { p.lead = 1; p.buzz = true; p.kick = never; p.snare = onSteps(4, 12); }                    // breakdown, lead returns
    else if (bar === 23) { p.lead = 1; p.buzz = true; p.kick = never; p.snare = every; p.build = true; }           // snare roll
    else if (bar < 31) { p.lead = 3; p.snare = onSteps(4, 12); p.octave = true; }                                   // full
    else { p.lead = 3; p.snare = st => st === 4 || st >= 12 || st === 8; p.kick = onSteps(0, 4, 8); p.octave = true; } // fill into the loop
    return p;
  }
  const plans = Array.from({ length: BARS }, (_, b) => plan(b));
  const leadAt = s => LEAD[plans[Math.floor(s / STEPS_PER_BAR)].lead][s % STEPS_PER_BAR];

  // The 14 registers for one frame
  function frameRegs(f) {
    const r = new Uint8Array(16);
    r[13] = 0xff;                                         // leave the envelope alone unless a note retriggers it
    const absStep = Math.floor(f / STEP), bar = Math.floor(absStep / STEPS_PER_BAR), st = absStep % STEPS_PER_BAR, fr = f % STEP;
    const p = plans[bar], chord = PROG[bar % 4];
    let aTp = 0, aVol = 0, bTp = 0, bVol = 0, cTp = 0, cVol = 0;
    let bTone = true, bNoise = false, cTone = true, cNoise = false, noiseP = 0, envP = 0;

    // A: a lead note lasts 15 frames (2.5 steps). Lead notes still ringing from the end of the tune
    // carry over the loop point, so the loop is seamless.
    for (let k = 0; k <= 2; k++) {
      const s = (absStep - k + TOTAL_STEPS) % TOTAL_STEPS, n = leadAt(s), age = k * STEP + fr;
      if (n && age < 15) {
        const base = tonePeriod(n);
        aTp = Math.round(base * (age >= 6 ? 1 + 0.006 * Math.sin(age * 0.9) : 1));      // a little vibrato
        aVol = age < 8 ? 13 : Math.max(6, 13 - (age - 7));
        break;
      }
    }
    if (!aVol && p.sparkle) { aTp = tonePeriod(chord[(f >> 1) % 3] + 24); aVol = 7; }

    // B: the bass, a sixteenth note pair long (11 of 12 frames), an octave up on the third beat
    const age = (st % 2) * STEP + fr, noteStep = st - (st % 2);
    const bass = chord[0] - 12 + (noteStep % 8 === 6 ? 12 : 0);
    if (age < 11) {
      if (p.buzz) {
        envP = Math.round(CLOCK / (256 * hz(bass)));                                   // sawtooth repeats at the note's pitch
        bTone = false; bVol = 0x10;
        if (age === 0) r[13] = 8;                                                       // retrigger on each note
      } else { bTp = tonePeriod(bass); bVol = 13 - Math.floor(age / 3); }
    }
    if (p.kick(st) && fr < 4) {                                                         // the kick takes over for four frames
      bTp = [833, 1400, 2000, 2778][fr]; bVol = [15, 14, 12, 9][fr]; bTone = true;
      if (fr === 0) { bNoise = true; noiseP = 10; }
    }

    // C: chord arpeggio through the chord tones every frame, with drums cutting in
    const arp = [0, 1, 2, 1][f % 4];
    cTp = tonePeriod(chord[arp] + (p.octave && st >= 8 ? 12 : 0));
    cVol = Math.max(5, 13 - fr);
    if (p.snare(st) && fr < 5) {
      cTone = false; cNoise = true; noiseP = 6;
      const vol = [15, 14, 12, 9, 6][fr];
      cVol = p.build ? Math.round(vol * (0.45 + 0.55 * st / 15)) : vol;
    } else if (p.hat(st) && fr < 1) {
      cTone = false; cNoise = true; noiseP = 2; cVol = 11;
    }

    r[0] = aTp & 255; r[1] = aTp >> 8; r[2] = bTp & 255; r[3] = bTp >> 8; r[4] = cTp & 255; r[5] = cTp >> 8;
    r[6] = noiseP;
    // Mixer bits are active low: 0 turns a source on
    const tone = [aVol > 0, bTone && bVol > 0 && !(bVol & 16), cTone];
    const noise = [false, bNoise, cNoise];
    r[7] = 0;
    for (let c = 0; c < 3; c++) { if (!tone[c]) r[7] |= 1 << c; if (!noise[c]) r[7] |= 8 << c; }
    r[8] = aVol; r[9] = bVol; r[10] = cVol;
    r[11] = envP & 255; r[12] = envP >> 8;
    return r;
  }

  return { CLOCK, FPS, FRAMES, frameRegs };
})();

// The built-in tune as a song object (the same shape parseYm returns)
function ymBuiltinTune() {
  const regs = new Uint8Array(BUILTIN.FRAMES * 16);
  for (let f = 0; f < BUILTIN.FRAMES; f++) regs.set(BUILTIN.frameRegs(f), f * 16);
  return {
    format: "YM5!", packed: false, crcOk: null, frames: BUILTIN.FRAMES, regs, clock: BUILTIN.CLOCK, frameRate: BUILTIN.FPS,
    loopFrame: 0, drums: [], drum4bit: false, drumSigned: false,
    title: "Pixel Riot Theme", author: "Pixel Riot", comment: "Built-in tune, generated in code (src/builtintune.js)",
  };
}

if (typeof module !== "undefined" && module.exports) module.exports = { ymBuiltinTune };
