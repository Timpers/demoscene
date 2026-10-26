# PIXEL RIOT: YM2149 Sound Chip Emulation and ST Music Playback

Status: Draft v1 · Owner: Tim · Repo: `demoscene` (`index.html`, `demo.js`)

---

## 1. Summary

Replace the demo's Web Audio oscillator music with a software emulation of the **YM2149F** (the Atari ST's sound chip), and play **real Atari ST tunes** through it. The primary format is `.YM` register-dump files. Tunes can be dropped in as files, or baked into the demo.

The result should sound like an ST: the same waveforms, volume curve, envelope shapes and noise. Where the original tune used the usual ST hardware tricks, such as SID-voice buzz, sync-buzzer and digidrums, those should play too.

## 2. Background and current state

- [demo.js](demo.js) lines 274–349 hold the current "music": oscillators, a noise buffer and a feedback delay, driven by a 25 ms `setInterval` look-ahead scheduler.
- The tune is hard-coded (Am–F–C–G, a lead pattern, kick/snare/hat). It has about five voices, which the real chip could not do.
- Visuals run on `performance.now()` and audio on `ac.currentTime`. Parts change every `PART_LEN` (20 s) and are not tied to the music.
- The scroller text and page copy claim "no assets" and "square waves and a little noise". Both will change.
- There is no build step, package manager or tests. The page opens straight from `index.html`.

## 3. Goals

| ID | Goal |
|----|------|
| G1 | A faithful YM2149 core: tone, noise, envelope, mixer, DAC volume curve. |
| G2 | Alias-free output at the browser's sample rate (44.1/48 kHz), with no clicks or zipper noise. |
| G3 | Play real ST music from `.YM` files (YM2!/3!/3b!/5!/6!), including LHA-compressed files, which is how most are distributed. |
| G4 | Support the ST "special effects" in YM5/YM6: SID voice, sinus-SID, sync-buzzer, digidrums. |
| G5 | Tie the visuals to the music clock (part changes and effects land on the beat). |
| G6 | Keep it dependency-free and runnable from `file://` with no build step. |
| G7 | Test the emulator core headlessly in Node, because we can't rely on listening alone. |

### Non-goals (v1)

- Full 68000 / SNDH playback. This is a stretch goal (Phase 9) because it needs a CPU emulator.
- Other chips (AY-3-8910 differences, YM2203 and so on). We may expose the AY envelope resolution as a flag, nothing more.
- A tracker or music editor UI.
- YMT1/YMT2 (YM Tracker) formats and the YM "MIX1" sample-mix format.
- Making the demo's existing visuals more complex.

## 4. Users and scenarios

Developers and demo viewers, in the browser on desktop and probably mobile.

1. Viewer clicks "START". The ST tune plays and the demo runs in time with it.
2. Developer drops a `.ym` file onto the page (or uses a file picker) and hears it immediately.
3. Developer runs a script to bake a `.ym` file into `music.js`, so the demo ships as a self-contained page.
4. Developer runs `npm test` and gets a pass/fail on the emulator core without a browser.

## 5. Legal note (needs sign-off)

Real ST tunes are copyrighted works by their composers. Playing them privately for development is low risk. **Publishing or distributing the demo with a rip embedded needs the composer's permission or a licence.** Check this with the appropriate person (legal or compliance) before any public release. Until then, the repo should contain only test tunes we have the right to use, or ones we generate ourselves (see T1.7). Ripped music stays out of git, via `.gitignore`.

## 5c. Reference documents

Eight reference documents are in `docs/`. [docs/ym2149-notes.md](docs/ym2149-notes.md) records what each one gives us and what is still missing.

- **Covered:** the YM2149 register map, tone/noise/envelope timing, envelope shapes (datasheet), the ST clocks and memory map (hardware spec), and the MFP timer prescales and counter behaviour (MK68901 text).
- **Sourced online instead** (ST-Sound, an MIT-licensed open-source YM player, and other open emulators): the level table, noise LFSR, YM file format and effects. See section 9 of the notes file.
- **Still not documented anywhere we hold:** the LH5 algorithm itself. It is Okumura's well-known algorithm, and we will write our own decoder and test it against a real file.
- **Known error in our sources:** the ST hardware spec's register table omits R13 (envelope shape). The datasheet is authoritative.
- **Not relevant:** the STE hardware and coding-book documents cover DMA sample sound, not the YM2149. The 68000 documents matter only for the SNDH stretch goal (Phase 9).
- **Copyright:** these are third-party documents of uncertain redistribution status. Keep them out of any public repository unless that has been checked (see Section 5).

## 5d. Test corpus (`ym/`)

`ym/` holds 75 `.ym` files (13 MB). A survey of all of them found:

| Check | Result |
|---|---|
| Format | All 75 are **YM5!, uncompressed** (no LHA wrapper), interleaved, 16 bytes per frame |
| Header | Clock 2,000,000 Hz, 50 Hz, no digidrums, loop frame 0. Fields parsed exactly as in section 9 of the notes file. Header and data end exactly at the end of the file (no `End!` tag). |
| Length | 4,064 to 25,295 frames, i.e. **81 s to 8.4 min** |
| Chip features used | Tone, noise and mixer only |
| Not used anywhere | **Envelope** (R13 is `0xFF` in every frame and no channel has the envelope bit set), **SID, sync-buzzer, digidrum and sinus-SID effects** (R1/R3/R6/R8/R14/R15 spare bits are always 0) |
| Activity | 1.3 to 5.9 register changes per frame, which is quiet compared with typical ST tunes |
| Metadata | Every file has the same author string, and some titles repeat (for example two "Copper Pulse" files). The tunes look generated or custom-made rather than ripped from ST demos. |

What this means for the plan:

- **Good for:** the parser, the de-interleave, the tone/noise/mixer/level paths, the player, looping (from frame 0), the worklet and the demo integration. Phases 1, 3 (parser), 5 and 6 can be tested with real data.
- **Cannot test:** LHA decompression, the envelope and any ST effect. This was true of the 75 files alone. Since then, six real compressed TCB tunes have been added to `ym/`. They cover LHA and the envelope. Still missing: a real tune that uses SID voice, sync-buzzer or digidrums.
- **Provenance:** we do not know where these came from or on what terms we can use them. Confirm before anything is published (Section 5).
- **Size:** at 13 MB the folder should stay out of git (add `ym/` to `.gitignore`). A single file is 70 to 400 KB raw, which is fine to bake into a page.

## 5b. Requirements

### 5.1 Emulator core (`src/ym2149.js`)

- **R1** 16 registers, with write semantics per the datasheet:
  - R0–R5: 12-bit tone periods for A, B, C.
  - R6: 5-bit noise period.
  - R7: mixer (tone/noise enable per channel; the I/O bits are ignored).
  - R8–R10: 4-bit level plus an envelope-enable bit.
  - R11–R12: 16-bit envelope period.
  - R13: 4-bit envelope shape. Writing it retriggers the envelope. This matters, because tunes rely on rewriting it.
  - R14–R15: I/O ports, ignored by the core.
- **R2** Master clock is configurable. The ST is 2,000,000 Hz, and YM5/6 headers carry the clock.
- **R3** Tone: a period of 0 behaves as 1. Each channel has a flip-flop that toggles at `clock / (16 × period)`.
- **R4** Noise: 17-bit LFSR, with the period applying to all channels.
- **R5** Envelope: 16 shapes, with the correct hold/attack/alternate behaviour. The YM2149 envelope has **32 steps** per cycle. Fixed 4-bit levels map onto the odd steps.
- **R6** Output: per-channel non-linear DAC level table (YM2149, not AY-3-8910). The datasheet gives no table, so use published measurements, sourced and recorded in `docs/`. Start with the provisional 1.5 dB/step model in the notes file.
- **R7** Output filtering: the chip's output is a piecewise-constant signal that changes on each chip step (8 master clocks, 250 kHz on an ST). Low-pass it with a windowed-sinc FIR (cutoff about 20 kHz) evaluated at the **exact** output sample times, using a polyphase table of kernel integrals. This has no oversampling grid and so no timing jitter. A plain average (`filter: "box"`) is kept for comparison. Naive "sample the state" is not acceptable: it aliases badly on high tone periods.
- **R8** Mixing: mono by default (the ST is mono). Optional ABC panning for headphones, off by default.
- **R9** Post-processing options: DC-blocking high-pass (always on), and an optional ST-style output low-pass (configurable cutoff).
- **R10** The core is pure JS: no DOM, no Web Audio. It works in the main thread, an `AudioWorklet` and Node.
- **R11** API sketch:
  ```js
  const chip = new YM2149({ clock: 2000000, sampleRate: 48000 });
  chip.write(reg, value);              // register write
  chip.render(outFloat32Array, n);     // fill n mono samples
  chip.renderStereo(left, right, n);   // optional ABC panning, see chip.setPan()
  chip.setOverride(ch, amp);           // force a channel to a linear amplitude 0..1 (digidrums, SID); amp < 0 clears
  chip.reset();
  ```

### 5.2 YM file support (`src/ymfile.js`, `src/lha.js`)

- **R12** Detect LHA-wrapped files (`-lh5-` method) and decompress them in pure JS. A file with no `-lh5-` header is used as raw data. Support `-lh0-` (stored) only if a real file needs it.
- **R13** Parse the formats:
  - **YM2!/YM3!/YM3b!**: 14 registers per frame, interleaved, with a loop frame for YM3b. YM2 "Mad Max" digidrums are lower priority.
  - **YM5!/YM6!**: header with frame count, attributes (interleaved flag), digidrum count, master clock, frame rate, loop frame, digidrum sample table, then name, author and comment strings.
- **R14** De-interleave frame data into a `Uint8Array(frames × 16)`.
- **R15** Handle truncated files and bad headers with a clear error, never a hang. Do not rely on an `End!` marker: the reference player ignores it and uses the frame count.
- **R16** Expose metadata (title, author, comment, duration) for an on-screen credit line.

### 5.3 Player and effects (`src/ymplayer.js`)

- **R17** Step through frames at the file's frame rate (usually 50 Hz), **sample-accurately**. The player counts samples, not timers, and writes the registers for each frame.
- **R18** Loop at the file's loop frame (or restart, for formats with none).
- **R19** R13 value `0xFF` means "do not retrigger the envelope", per the YM convention.
- **R20** YM5/6 effects, decoded from the frame's R1/R3/R6/R8/R14/R15 per the YM-format spec:
  - SID voice
  - sinus-SID
  - sync-buzzer
  - digidrums
  - The timer rate is `2,457,600 / (prescale × count)`, with prescales 4/10/16/50/64/100/200. In YM files a prescale index of 0 or a count of 0 means no effect (the hardware would treat count 0 as 256).
  - Effects last one frame. The player stops them at the start of each frame and restarts the ones the frame requests.
  - YM6 has two effect slots (R1/R6/R14 and R3/R8/R15). YM5 has SID and digidrum only. Sinus-SID is not implemented in the reference player, so we define it ourselves (low priority).
  - Full layout in section 9 of the notes file.
  - **The bit layout is not in our documents.** Get the published YM format document first (task T0.4).
- **R21** Digidrums: samples from the file header play at the timer rate and replace the channel's level while they run, with the channel's tone and noise forced on. 8-bit samples are treated as linear amplitude. 4-bit samples (header flag 4) go through the level table.
- **R22** Transport: play, pause, seek-to-frame (for tests and sync), and a `position` readout.

### 5.4 Audio integration (`src/audio.js`)

- **R23** Run the chip and player inside an `AudioWorklet`. This gives sample-accurate effects and a stable audio-thread clock, and is immune to main-thread jank from the 320×200 renderer.
- **R24** Build the worklet code from source strings (`YM2149.toString()` and similar) and load it from a **`data:` URL**, then a Blob URL if that is refused. This avoids `file://` module-loading restrictions without a build step. If both fail, fall back to a `ScriptProcessorNode`. (Measured: on `file://`, Edge refuses the Blob URL and accepts the `data:` URL.)
- **R25** The main thread parses the file and sends the song to the worklet in a message.
- **R26** The worklet posts its position (frame, loop count, play state, peak level, audio time) to the main thread every 7 audio blocks, roughly 55 times a second.
- **R27** Autoplay policy: audio starts only from the existing click handler. This is already the case.
- **R28** A volume control (master gain plus the click-through start screen). Mute on `M`. Leave headroom: on loud tunes the raw output overshoots full scale by up to about 8% (measured peak 1.08 on one Union Demo tune), because the low-pass filter rings on full-level square waves. A master gain of about 0.8 avoids clipping.

### 5.5 Demo integration

- **R29** Replace the oscillator music (demo.js lines 274–349) with the new engine.
- **R30** Drive the demo clock `t` from the audio position, smoothed against `performance.now()` so frames don't jitter.
- **R31** Part changes become cue points in the music. One pass through the tune is cut into equal slices (a whole number of A, B, C rounds, each slice close to 20 s), so the demo restarts at part A exactly when the music loops. The fixed `PART_LEN` timer stays as the fallback when there is no music or no audio.
- **R32** A beat signal (0 to 1) read from the tune's register data, so it is exactly in step with the sound: rises in channel level, noise starting up, envelope retriggers and digidrum starts, decaying over about 0.14 s. Used by the cubes, the copper bars and the dot sphere.
- **R33** Input paths for tunes:
  - Drag-and-drop and a file picker, which work on `file://`.
  - A baked `music.js` (base64) generated by `tools/ym2js.js`, loaded automatically if present.
  - A graceful fallback to the built-in tune if neither exists.
- **R34** The credit line (title and author from the YM header) appears on screen. Update the scroller text and start-screen copy.

### 5.6 Built-in default tune (zero-asset fallback)

- **R35** Re-arrange the old built-in tune for 3 channels as register data (a small JS pattern player writing registers at 50 Hz). It uses fast arpeggios, noise for drums and envelope bass, as real ST musicians did.
- **R36** This gives a default tune we own outright, used as the fallback and available on request, which matters if the rights position of the sample tunes is not cleared (see Section 5 and `tunes/README.md`).

## 6. Technical design

### 6.1 File layout

```
index.html            loads scripts in order
demo.js               visuals (existing) + calls into audio engine
src/ym2149.js         chip core (pure, shared by worklet/Node)
src/ymfile.js         YM parser
src/lha.js            LH5 decompressor
src/ymplayer.js       frame sequencer + MFP effects
src/audio.js          AudioWorklet glue, position clock
src/builtin-tune.js   default 3-channel tune (zero-asset)
tools/ym2js.js        node: .ym -> music.js (base64)
tests/*.test.js       node:test, no dependencies
docs/ym2149-notes.md  register map, DAC table, sources
music/                local rips (git-ignored)
```

### 6.2 Data flow

```
.ym / drop / music.js
  → (main) lha → ymfile → Uint8Array frames
  → postMessage → (AudioWorklet) YMPlayer ──writes regs──► YM2149 ──► Float32 out
                         │
                         └── posts {frame, samples} ──► (main) demo clock t
```

### 6.3 Key decisions

| Decision | Choice | Why |
|---|---|---|
| Where the chip runs | `AudioWorklet` | Timing is exact and independent of rendering load. |
| Player location | Inside the worklet | Effects like SID voice need sub-frame register writes, which only the audio thread can time. |
| Sharing code with no build | `Class.toString()` into a Blob | Keeps the "open index.html" workflow. |
| Resampling | Low-pass FIR evaluated at exact output times from the 250 kHz chip steps | No timing jitter, and about 2% of a core. See R7 and the Phase 2 notes. |
| Source of truth | Datasheet and community docs, own implementation | Avoids licence entanglement from copying GPL code. We verify against reference renders instead. |
| Music format v1 | `.YM` | Plain register data, so no CPU emulation. |
| SNDH | Stretch goal | Many ST rips are SNDH. It needs a 68000 and MFP emulator. In the meantime, convert SNDH to YM with existing tools (SC68-based tools, ZXTune and similar; to be verified when we get there). |

### 6.4 Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Worklet blocked on `file://` in some browsers | Falls back to the main thread | Happened for Blob URLs in Edge; now a `data:` URL is tried first. `ScriptProcessorNode` fallback (R24) as the last resort. Firefox is not yet tested. |
| Envelope/noise details subtly wrong | Tune sounds "off" | Golden tests against a reference render (T3.3). A/B listening. |
| SID/sync-buzzer bit layout misread | Effects silent or wrong | Check against the format spec. Test with a known effect-heavy tune. |
| LH5 decoder bugs | Files fail to load | Test against known compressed and uncompressed pairs. |
| Copyright | Can't publish with a rip | Section 5. Ship the built-in tune by default. |
| Audio-clock sync jitter | Visual stutter | Smooth against `performance.now()` (R30). |
| Mobile autoplay or latency | Late start | Already click-gated. Accept some latency. |

## 7. Milestones and task list

Tick the boxes as we go. Each phase ends with its acceptance criteria met.

### Phase 0: Setup and spec

- [ ] **T0.1** Confirm Node is available for tests (`node --version`; `node:test` needs 18+).
- [ ] **T0.2** Create the folder layout (6.1) and a `.gitignore` for `music/`. (`docs/` already exists. Decide whether the third-party reference documents in it are committed. See Section 5c.)
- [x] **T0.3a** Register map, timing formulas and envelope shapes written into [docs/ym2149-notes.md](docs/ym2149-notes.md), from the YM2149 datasheet.
- [x] **T0.3b** Sourced from ST-Sound and other open emulators, and recorded in the notes file:
  - the 16-entry measured level table (the 32-step envelope scale is interpolated from it, and is provisional),
  - the 17-bit noise LFSR (taps bit 0 XOR bit 3, with the disagreement between sources noted),
  - still open: the period-0 behaviour, which is a convention checked by test.
- [x] **T0.4a** MFP timer prescale table, down-counter rule and timer clock recorded in the notes file, from `MK68901 MFP.TXT` and the hardware spec.
- [x] **T0.4b** YM2/3/3b/5/6 header layouts, the effect bit layout, the timer prescale encoding and the effect behaviour recorded in the notes file (section 9), from the ST-Sound source. The author's own format page was unreachable.
- [x] **T0.5a** Header and interleave parts of section 9 confirmed against the 75 files in `ym/` (see Section 5d). The compression wrapper, 4-bit/signed drum flags and all effect behaviour are still untested against real data.
- [ ] **T0.5b** Review the notes file and Section 5d. Decide on the open questions in Section 9, and add `ym/` to `.gitignore`.

**Done when:** you've reviewed the notes file and agree the remaining open items (period-0 behaviour, interpolated envelope table, sinus-SID design) are acceptable.

### Phase 1: Chip core

- [x] **T1.1** `YM2149` class: registers, tone generators, noise LFSR, mixer (R1–R4).
- [x] **T1.2** Envelope generator: 16 shapes, 32 steps, retrigger on R13 write (R5).
- [x] **T1.3** DAC level table and per-channel output sum (R6).
- [x] **T1.4** Exact-time FIR resampling (R7), with a plain-average version kept for comparison.
- [x] **T1.5** DC-block filter, optional ST low-pass, optional ABC pan (R8, R9).
- [x] **T1.6** `tools/render-wav.js`: render a `.ym` register script to a WAV, so we can listen and run analysis. (Now uses the real parser, so it reads compressed files too.)
- [x] **T1.7** `tools/gen-test-ym.js`: generate small `.ym` files we own (scale, noise sweep, every envelope shape, a SID-voice example) into `tests/data/`. The SID example can't be played until Phase 4.

**Done when:** a scale written through register writes renders to the right pitches in Node, and the WAV plays cleanly.

### Phase 2: Core tests

- [x] **T2.1** Tone: for several periods, measure the frequency from zero crossings and check it against `clock/(16×period)` within tolerance.
- [x] **T2.2** Period 0 behaves as 1. The mixer enable bits are correct for all 64 combinations.
- [x] **T2.3** Noise: check the LFSR sequence against an independent reference and the 2^17−1 period.
- [x] **T2.4** Envelope: all 16 shapes against an independently built reference, and retrigger behaviour.
- [x] **T2.5** Level table monotonic, with the fixed-level to envelope-step mapping correct.
- [x] **T2.6** Aliasing check: a high-note spectrum shows no strong inharmonic fold-back above a set threshold.

**Done when:** `npm test` passes. (Currently 18 tests, all passing.)

Notes from Phases 1 and 2:

- The first version of the resampler used an oversampled grid. The aliasing test showed timing jitter limited it to about −38 dB, so it was replaced by the exact-time method in R7, which measures about −57 to −62 dB in the test (individual spurs are below −140 dB). A plain average measures about −24 dB.
- The reference tests for the noise register and the envelope are written independently of the chip code, but from the same notes. Both will be checked again against real tunes that use the envelope.
- CPU cost is about 2% of one core for mono and 2.6% for stereo (measured in Node).
- The output runs about 0.5 ms behind the chip, because the filter needs future chip steps. This is a constant delay and is not audible.
- Still unchecked by ear: whether the volume curve and the interpolated envelope levels sound right. Sample WAVs are in `out/` (git-ignored) for a listening check.

### Phase 3: File loading

- [x] **T3.1** LH5 decoder (`src/lha.js`). `-lh0-` stored is not implemented, since no real file needs it. Verified by the CRC stored in each archive header: all 6 compressed local tunes pass.
- [x] **T3.2** YM parser (`src/ymfile.js`) for YM2!/3!/3b/5!/6!, with de-interleave, text fields, digidrum table and loop frame (R13–R16).
- [x] **T3.3** Parser tests on our generated files and on the local `ym/` files (each must parse; compressed ones must pass their CRC). The `ym/` tests are skipped when the folder is absent. Still wanted: a compressed rip that uses ST effects or digidrums.
- [x] **T3.4** Malformed-input tests: truncated, bad magic, bad sizes, plus random mutation of valid and compressed files (no hangs, only `Error`s).
- [ ] **T3.5** Offline render of a real rip, A/B against a reference player's render. Renders of the six TCB tunes are in `out/`. Remaining: you compare them with your memory or a reference player of the same tunes, and we note any differences.

**Done when:** a real LHA-compressed `.ym` renders to a WAV that matches the reference by ear and spectrum. (Waiting on T3.5.)

Notes from Phase 3:

- Nine tunes from the Union Demo were added later (menu, loader, copier and several screens). Their headers say they were generated under the PaCifiST and SainT emulators, which suggests they are register recordings taken from a running demo. None uses an ST effect, and only one of the nine uses the envelope (the "ninja remix" tune).
- Recordings like this are sampled once per frame, so any effect that works faster than 50 Hz (digidrums, SID voice) would be only partly captured, if at all. That would be a property of the files, not of our player.

- The six TCB tunes (three SoWatt tunes and three Megademo tunes) are real conversions. Their headers name the composer and the converter, and they pass the compression CRC.
- They use the envelope but none of the ST effects. The SoWatt tunes use no envelope. So they exercise tone, noise, mixer and envelope, but not Phase 4.
- Real tunes with ST effects, found in the sample folder of the ST-Sound repository and copied into `ym/` (git-ignored). These are the Phase 4 test material:

  | File | Effects | Notes |
  |---|---|---|
  | `VirtualEscape1.YM`, `VirtualEscape2.ym` | SID voice (about 2,650 and 14,350 frames) | Equinox "Virtual Escape" intro and main tunes, with the envelope |
  | `ND-Loader.ym`, `ND-Toxygene.ym` | SID voice and sync-buzzer | Nostalgic-O-Demo tunes; the header says "Using Sync-Buzzer" |
  | `jess2.ym` | Digidrums (3 samples, 4-bit; 1,333 frames) | "Sharpness Buzztone" |
  | `ANCOOL1.YM` | none | A `YM2!` file: real coverage of the 14-byte format. Mad Max digidrums are untested. |

  The same folder also holds a `MIX1` file and a `YMT1` tracker file. Both formats are out of scope and the parser rejects them with a clear message.
- Not yet covered by any real file: sinus-SID, and `YM3!`/`YM3b` (tested only with synthetic files). The StSound player never implemented sinus-SID, so we may not find a tune that needs it.
- The rights position of these sample tunes is the same as for any ST tune: the composers own them. See Section 5.
- No compressed test file is committed, because the real ones are not ours to redistribute. A synthetic LHA fixture would need our own LH5 compressor, which is a lot of work for little extra confidence.

### Phase 4: Player and effects

- [x] **T4.1** Sample-accurate frame sequencer with loop (R17, R18, R19): [src/ymplayer.js](src/ymplayer.js).
- [x] **T4.2** MFP timer model (R20): timer frequency from the prescale index and count, with effects running per chip step (4 µs resolution) inside the chip.
- [x] **T4.3** SID voice. Sinus-SID is **not** implemented: the reference player never did, and no tune we hold needs it.
- [x] **T4.4** Sync-buzzer.
- [x] **T4.5** Digidrums (R21): 4-bit and 8-bit samples, linear amplitude, playing across frames until they end.
- [x] **T4.6** Transport controls: play, pause, seek, position, loop on or off (R22).
- [x] **T4.7** Tests ([tests/ymplayer.test.js](tests/ymplayer.test.js)): effect decoding for YM5 and YM6, the SID gate, sync-buzzer and digidrum rates each measured to within 1% of the timer rate, the effect lifetime rules, frame timing without drift, looping, and real tunes that use effects.
- [ ] **T4.8** (optional, later) Mad Max digidrums for `YM2!` files, and sinus-SID if a tune turns up that needs it.

**Done when:** an effect-heavy real tune sounds right against a reference render. (Waiting on your listening check: see `out/` for five tunes.)

Notes from Phase 4:

- SID voice toggles the channel's level between its volume and 0 on every timer tick, so the gate runs at half the timer rate. Tone and noise still apply, which gives the buzz. The gate's phase restarts at the start of each frame, as in the reference player.
- For sync-buzzer, the envelope shape is the low nibble of the voice's level register, not R13. Each timer tick restarts the envelope with that shape.
- Digidrum samples are linear amplitudes (255 is a full-level channel). The sample replaces the channel's output, with its tone and noise forced on, until the sample ends.
- The measured frequencies in the tests use a Schmitt-trigger edge counter, because the output filter rings near sharp edges and a plain mean-crossing count over-counts them.
- 47 tests now pass in total.

### Phase 5: Browser audio

- [x] **T5.1** `AudioWorklet` processor built from source strings and loaded from a `data:` URL, then a Blob URL (R23, R24): [src/audio.js](src/audio.js).
- [x] **T5.2** `ScriptProcessorNode` fallback, running the same player on the main thread.
- [x] **T5.3** Message protocol: load, play, pause, seek, loop, position and ended (R25, R26). Volume and mute are handled on the main thread with a gain node, with a short ramp to avoid clicks (R28). The protocol is documented at the top of `src/audio.js`.
- [x] **T5.4** Load from drag-and-drop, a file picker and the `O` key (R33): [src/ymui.js](src/ymui.js). Keys: Space pause, M mute, L loop, Left/Right seek 5 s, Up/Down volume.
- [x] **T5.5** Tested on `file://` with [tools/browser-check.js](tools/browser-check.js) in Edge 156 and Chrome 155, each with the AudioWorklet and with the forced fallback. All 28 checks pass in all four runs. Firefox is **not tested** (the automation cannot drive it), so that is a manual check for you.
- [x] **T5.6** A stand-alone [player.html](player.html) for trying tunes, and a minimal hook in `index.html` and `demo.js`: a dropped tune replaces the built-in synth. Phase 6 replaces that hook properly.

**Done when:** dropping a `.ym` onto the page plays it with no glitches while the demo runs. Met as far as can be measured automatically: audio keeps pace with the wall clock to within 0.2% and the visuals keep running. "No glitches" still needs your ear, in a visible browser.

Notes from Phase 5:

- **What the browser check covers (28 checks per run):** secure context and AudioWorklet availability; which engine loaded; frames advancing at 50 per second of real time and the audio clock keeping pace with the wall clock, for a plain tune and for SID, digidrum and sync-buzzer tunes; an audible peak level; pause, play, seek by key and slider, mute, loop and Space; loop wrap-around; drag and drop; a bad file giving a readable message and the player recovering; on the demo page, a tune dropped before the click, the built-in synth staying off, the visuals running, a second tune replacing the first, the built-in synth still working when nothing is dropped, and no console errors.
- **What it cannot tell us:** whether it sounds clean. A starved audio thread would show up as the audio clock falling behind, which did not happen, but a tiny click would not be caught.
- **A real finding:** the Blob URL did fail on `file://` in Edge ("Failed to load worklet module script"), so the first runs used the fallback without anyone noticing. The `data:` URL fixed it, and the unit tests now cover the whole chain (data, then Blob, then fallback).
- **Why a drop before the click is held:** a drag-and-drop is not a user gesture, so the browser will not let audio start from it. The demo shows "click to start the sound" and starts when the viewer clicks.
- 63 Node tests pass, including the worklet source run in an isolated context against stand-ins for the browser audio objects: its output matches the player sample for sample.

### Phase 6: Demo integration

- [x] **T6.1** The oscillator music is removed from `demo.js`. The YM engine is the soundtrack (R29).
- [x] **T6.2** Audio-driven demo clock (R30): [src/musicsync.js](src/musicsync.js) `MusicClock`. It uses the audio thread's sample count and position, the output latency, and a smoothed offset to the wall clock so frames don't jitter. It holds while paused and snaps on a seek.
- [x] **T6.3** Parts change on cue points in the music, with the `PART_LEN` timer as fallback (R31): `ymPartAt`.
- [x] **T6.4** Beat signal (R32): `YMBeat`, used by the cubes, the copper bars and the dot sphere.
- [x] **T6.5** Credit line, scroller text and start-screen text (R34). The top line shows the title and author from the file header, bright for 10 s after the tune starts or loops, then dimmed. The start screen names the tune. The scroller no longer claims "not a single byte of assets".
- [x] **T6.6** `tools/ym2js.js` bakes a tune into [tunes/default-tune.js](tunes/default-tune.js), which the page loads (R33). Run `npm run default-tune -- tunes/stsound/SomeTune.ym` to change the default.
- [x] **T6.7** Default tune: Virtual Escape main tune (Equinox), 287 s, from the checked-in sample tunes. It gives 15 slices of about 19 s, five rounds of A, B, C. Picked because Equinox is in the demo's greetings and it shows off the SID voice. Changing it is one command.

**Done when:** the demo runs end-to-end with a real ST tune and the visuals follow it. Met, and measured in four browser runs (see below). Whether it *feels* in sync needs your eye and ear.

Notes from Phase 6:

- **Tests:** 87 Node tests, and 39 browser checks in each of four runs (Edge and Chrome, AudioWorklet and fallback). The new browser checks cover: the default tune loading and being named on the start screen; the demo running on the music clock; the demo clock keeping a steady offset from the audio clock; the beat firing; the part changing exactly at a cue point; the demo restarting at part A when the music loops; pause holding the demo and resume continuing; a dropped tune replacing the default and the parts following it; a tune dropped before the click; and the timer fallback when there is no audio at all.
- **The clock tests were checked by breaking the code on purpose** (six deliberate breakages). Two slipped through at first, because the simulated audio clock never drifted and the loop wrap was hidden by how I measured it. Strengthening them exposed a genuine bug, now fixed: just after a loop the audio you hear still lags what has been rendered, so the clock briefly reported a position before the loop point.
- **How good the sync is:** the demo clock and the audio clock stay within about 30 ms of a steady offset in the browser probe, which is itself noisy at that level. The output latency the browser reports is already subtracted. There is no way to measure the true audio-to-eye delay without hardware, so this is as good as the browser allows.
- **Pausing freezes the demo**, not just the music, because the demo's clock is the music's clock.
- **A tune with a short loop** gets fewer, shorter parts: a 10 s tune gets three slices of about 3 s. That is a consequence of following the music and is probably fine for such tunes.
- **The beat signal is generic.** It reacts to any rise in level, so it follows melodies as well as drums. Whether it feels right depends on the tune. The strengths and the 0.14 s decay are constants in `musicsync.js` and `demo.js` that are easy to tune by eye.
- **Rights:** the default tune is third-party music in a public repository. See Section 5 and `tunes/README.md`: the position is unconfirmed.

### Phase 7: Built-in tune

- [x] **T7.1** A tune generated in code into the normal song format (R35): [src/builtintune.js](src/builtintune.js). It writes a register frame per 50 Hz tick, so the existing player, part schedule and beat signal handle it with no new playback code. (This replaced the idea of a separate pattern player.)
- [x] **T7.2** The original demo tune (Am, F, C, G; the same lead patterns) arranged for three channels, as "Pixel Riot Theme", 32 bars, 61.4 s:
  - channel A: the lead melody, or in the breakdown a quiet high arpeggio;
  - channel B: the bass, with the kick taking its first four frames (a falling pitch and a click of noise); in the breakdown an envelope "buzz" bass, with the tone off and the sawtooth envelope running at the note's pitch;
  - channel C: a chord arpeggio that cycles through the chord tones every frame, interrupted by noise for snares and hi-hats.
  - 125 BPM at 50 frames a second makes a sixteenth note exactly 6 frames. The sections are: intro, lead enters, full groove with an octave jump, two breakdown sections with the buzz bass, a snare-roll build, a full finale and a fill into the loop.
- [x] **T7.3** It is the fallback when the baked default is missing or broken, and `?tune=builtin` forces it (R36). It can also be exported to a `.ym` file (`node tools/export-builtin.js`, giving [tunes/pixel-riot-theme.ym](tunes/pixel-riot-theme.ym)) and baked in as the default with `npm run default-tune -- tunes/pixel-riot-theme.ym`.

**Done when:** a fresh clone with no music files still has a good-sounding tune. The first half is verified: the browser check opens a copy of the page with no `tunes/` folder and the demo plays the built-in tune with no errors. "Good-sounding" needs your ear: listen to `out/pixel-riot-theme.wav`.

Notes from Phase 7:

- **It is entirely ours.** It is a re-arrangement of the tune that was already in `demo.js`, so no one else's music is involved. If the sample tunes cannot be cleared (Section 5), run `npm run default-tune -- tunes/pixel-riot-theme.ym`, delete `tunes/stsound/`, and the repository has no third-party music. The demo's three parts then follow this tune (three slices of 20.5 s).
- **Checked from the registers and from the rendered audio** ([tests/builtintune.test.js](tests/builtintune.test.js), 12 tests): every register value is legal and no effect bits are set; the notes match the original tune's chords and lead; the kick sweeps down with a noise click; snares are noise on channel C; the buzz bass is on in bars 16 to 23 only, with the envelope period matching each note's pitch; the loop point and fill; the rendered bass is at 110 Hz in the intro, and the buzz bass is at 87 Hz (F2) in the breakdown, measured from the audio; the output is clean, with no DC and no click at the loop seam; the beat is far stronger on the kicks than elsewhere; the file written by the exporter reads back identically, and `tunes/pixel-riot-theme.ym` matches what the generator makes now.
- **Levels were rebalanced once on paper.** This chip's volume curve is steep (each level step is roughly 3 to 4 dB), so the first arpeggio levels would have been almost inaudible next to the lead and bass. I raised them. Whether the balance sounds right is a listening check.
- **Not done:** the echo effect the old Web Audio tune had. A single channel cannot echo without costing another voice.

### Phase 8: Polish and release readiness

- [ ] **T8.1** Performance check: worklet CPU use and main-thread frame time before and after.
- [ ] **T8.2** Error UI for bad files ("not a YM file", "unsupported format").
- [ ] **T8.3** README with run instructions, supported formats and the legal note.
- [ ] **T8.4** Sign-off on music licensing before any public release (Section 5).

### Phase 8b: README and test-file provenance

- [x] **T8b.1** `ym/` and `music/` added to `.gitignore`. The `ym/` files are free downloads from itch.io.
- [x] **T8b.2** README created with a link to the itch.io project page for the `ym/` files (the public page, not the expiring download link), run instructions and a legal note. Still to confirm: the page URL, and the licence terms stated on the itch.io page. Extend in T8.3.

### Phase 9: Stretch, SNDH support and disk-image ripping

Disk images (`.st`, `.msa`) are a separate, larger problem. Findings so far:

- `.st` is a raw floppy dump. `.msa` is the same data with simple per-track run-length compression, so reading both is easy.
- Getting music out of a disk is hard. It sits either in a standalone SNDH file (often packed) or inside a demo executable that has to be **run** on an emulated ST to produce its register writes.
- The practical route is to record from an existing ST emulator (for example Hatari, with the free EmuTOS in place of the copyrighted TOS ROM) rather than write one. Check what its YM recording captures, since timer-driven effects may be lost.
- A narrow in-house tool is possible: unpack `.msa`/`.st`, list the FAT12 files, and extract SNDH files (including unpacking common packers). Playing them needs the 68000 and MFP emulation below.
- A full ripper means a 68000 core, MFP timers, disk controller and a boot ROM. That is weeks of work and not planned.

- [ ] **T9.1** Feasibility spike: scope a 68000 interpreter, MFP timers and the YM memory map in JS.
- [ ] **T9.2** Decide go/no-go. Likely a separate project, since the CPU core alone is large.
- [ ] **T9.3** If go: SNDH header parser, 68000 core, MFP, YM bridge to the existing chip.

## 8. Test strategy

- **Unit tests** (`node:test`, no dependencies): tone, noise, envelope, levels, parser and decompressor.
- **Golden renders:** for a fixed register script, store hashes or key spectral features, so regressions are caught when we tune the filters.
- **Reference comparison:** render the same real `.ym` in an established player and compare spectra and waveforms. This is the closest we get to "sounds right" without ears.
- **Manual listening:** a checklist per tune (pitch, drums, envelope bass, effects, loop point, no clicks).
- **Browser smoke test:** load the page, click start, drop a file, confirm the audio position advances and the visuals follow.

## 9. Open questions

1. Which tunes do you want to play first, and do you hold the rights to them? This decides our test material (Section 5).
2. Are your tunes `.ym`, or mostly SNDH? SNDH changes the plan (Phase 9).
3. Is the delivery target a hosted page or a local `file://` demo? This decides how much the Blob and fallback workarounds matter.
4. ~~Should the demo structure follow the music?~~ Decided: it follows the music loop (Phase 6).
5. ~~Built-in tune or real music as default?~~ Decided: a real tune is the default, and any dropped tune replaces it (Phase 6). Still open: whether the sample tunes may be redistributed (see Section 5).

## 10. Definition of done (v1)

- A real, LHA-compressed ST `.ym` file plays correctly in the browser from `file://`, including effects.
- Core and parser tests pass with `npm test`.
- The visuals follow the music clock.
- A fresh clone with no extra files plays a tune: the baked default, or our own built-in tune if that is missing (done). Using the baked default publicly depends on the rights position being cleared.
- The README states the licensing position, and sign-off is recorded before any public release.
