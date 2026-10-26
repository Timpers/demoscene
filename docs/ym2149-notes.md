# YM2149 implementation notes

Working notes for the emulator (PRD tasks T0.3 and T0.4). Each fact is tagged with its source:

- **[DS]** `Yamaha YM2149.TXT`, the datasheet text.
- **[HW]** `Engineering Hardware Specification.TXT`, the Atari ST hardware spec.
- **[UNVERIFIED]** not in our documents. It needs a source before we rely on it.

## 1. Clock

- The ST feeds the chip a **2 MHz** clock [HW §4.1]. We treat `fMaster = 2,000,000 Hz` (SEL high, so no extra divide-by-2) [DS pin 5].
- Reasoning: the ST's pitch range and the datasheet formulas below are only consistent with a 2 MHz master.
- The clock must stay configurable, because YM5/6 files carry their own master clock.

## 2. Timing formulas [DS]

| Block | Formula | In master clocks |
|---|---|---|
| Tone (full cycle) | `fT = fMaster / (16 × TP)` | The output flips every `8 × TP` clocks |
| Noise | `fN = fMaster / (16 × NP)` | One LFSR shift every `16 × NP` clocks |
| Envelope repetition | `fE = fMaster / (256 × EP)` | A full 32-step cycle takes `256 × EP` clocks |
| Envelope step | 1/32 of the repetition period | One step every `8 × EP` clocks |

- `TP` is 12 bits (R1/R3/R5 use only the low 4 bits), `NP` is 5 bits, and `EP` is 16 bits (R11 fine, R12 coarse).
- What happens at a period of 0 is **not stated** in the datasheet. The convention is to treat 0 as 1 [UNVERIFIED]. Make it a named constant and test it. (ST-Sound goes further and holds the output high for tone periods of 5 or less, as an anti-alias shortcut. Real tunes use that as a way to make a DC level, so check what our oversampled approach does with very small periods.)
- Handy check: A440 on an ST is `TP ≈ 284` at 2 MHz (`2,000,000 / (16 × 284) ≈ 440 Hz`).

## 3. Register map [DS]

| Reg | Hex | Contents |
|---|---|---|
| R0 / R1 | 0 / 1 | Channel A tone: fine (8 bits) / coarse (low 4 bits) |
| R2 / R3 | 2 / 3 | Channel B tone |
| R4 / R5 | 4 / 5 | Channel C tone |
| R6 | 6 | Noise period (low 5 bits) |
| R7 | 7 | Mixer and I/O direction (see below) |
| R8 / R9 / R10 | 8–A | Channel A/B/C level: bits 0–3 level, **bit 4 = envelope mode** |
| R11 / R12 | B / C | Envelope period: fine / coarse |
| R13 | D | Envelope shape: bit 3 CONT, bit 2 ATT, bit 1 ALT, bit 0 HOLD. **Writing it resets the envelope.** |
| R14 / R15 | E / F | I/O port A / B data (not audio) |

Mixer R7 is **active-low**: a `0` enables the source.

| Bits | Meaning |
|---|---|
| 0, 1, 2 | Tone enable for A, B, C |
| 3, 4, 5 | Noise enable for A, B, C |
| 6, 7 | I/O port A / B direction (ignore) |

Per channel: tone off and noise off outputs nothing, which is the "level only" state. This is where digidrums and SID voice effects get their sound, by moving the level.

### Datasheet errors to watch for

- The ST hardware spec's register table [HW, line ~1236] **omits R13 (envelope shape)**. It labels R13 as "I/O Port A" and skips R14. The YM2149 datasheet is correct, so use it.
- The datasheet's heading for the envelope period section says "R8 and RC". It means **RB and RC**.
- The datasheet mentions "BC5" in the bus control text. It means BC2.

## 4. Envelope [DS]

- The envelope counter has **32 steps** (5-bit output E4–E0). The datasheet confirms this ("5 bit envelope generator", "counts 32 times for each pattern cycle").
- Fixed levels are 4-bit. When a channel uses the envelope (bit 4 set), the 5-bit envelope output sets the level.
- Shapes, from R13 bits CONT/ATT/ALT/HOLD:

| CONT ATT ALT HOLD | Shape |
|---|---|
| 0 0 x x | Decay once (31 → 0), then hold at 0 |
| 0 1 x x | Attack once (0 → 31), then drop to 0 and hold |
| 1 0 0 0 | Repeating decay (sawtooth down) |
| 1 0 0 1 | Decay once, hold at 0 |
| 1 0 1 0 | Repeating triangle, starting down |
| 1 0 1 1 | Decay once, then hold at maximum |
| 1 1 0 0 | Repeating attack (sawtooth up) |
| 1 1 0 1 | Attack once, then hold at maximum |
| 1 1 1 0 | Repeating triangle, starting up |
| 1 1 1 1 | Attack once, then drop to 0 and hold |

- The ASCII diagrams in the datasheet are the source of truth for the exact end states. T2.4 should assert them step by step.
- The mapping from a 4-bit fixed level to the 5-bit scale is **not in the datasheet**. The known convention is level `n` maps to step `2n + 1`, with level 0 silent [UNVERIFIED].

## 5. DAC output levels

- The datasheet says only "built-in 5 bit D/A convertor". It gives **no level table** [DS].
- **Fixed 4-bit levels.** ST-Sound's measured-based table for the ST [STS, `Ym2149Ex.cpp`], 16 entries, level 0 to 15:

  `62, 161, 265, 377, 580, 774, 1155, 1575, 2260, 3088, 4570, 6233, 9330, 13187, 21220, 32767`

  Divide by 32767 to normalise. Level 0 is **not silent** in this table (62, about 0.2 %). Real chips leak a little at level 0, so keep it. The steps are about 3 to 4 dB each.
- **5-bit envelope scale.** The envelope has 32 steps [DS], and the fixed levels sit on the odd steps: level `n` ↔ step `2n + 1` (so step 1 is level 0 and step 31 is level 15). We fill the even steps in between with the **geometric mean** of their neighbours, and step 0 with 0. This is a provisional interpolation for development. [STS] itself only uses 16 envelope levels per phase, so it gives us no better data.
- A finer YM2149 table exists in other emulators (for example ayumi), but I could not extract its values here, so we use the above. Compare against a real reference render in task T3.5 and adjust if the volume balance sounds off.
- Output processing in [STS]: each sample is DC-corrected and passed through a simple 2-tap low-pass. We do better (Phase 1.4/1.5), but this tells us a DC blocker is expected.
- The three DACs are summed. Real hardware is not perfectly linear when channels are mixed. Start with a plain sum and revisit if A/B tests show a difference.
- **Licence note:** [STS] is MIT/BSD-style licensed and requires the copyright notice to be kept if code is copied. We are only using its published **values and behaviour**, writing our own implementation. If the table is copied into our source, keep a credit comment (`// values from ST-Sound, Arnaud Carré, MIT`).

## 6. Noise generator

- The datasheet says only "pseudo-random waveforms", with a variable frequency [DS].
- **17-bit LFSR**, confirmed by three emulators: ST-Sound [STS], ayumi [AYU] and the CLK emulator [CLK].
- **The feedback taps differ between sources:**
  - [AYU] and [CLK]: bit 0 XOR bit 3, shifted into bit 16 (this also matches the common AY-3-8910 documentation).
  - [STS]: bit 0 XOR bit 2, shifted into bit 16.
  - Both give a maximal-length sequence, so the difference is inaudible. **Decision: use bit 0 XOR bit 3**, because two independent sources agree. This is a single constant, easy to change.
- **Shift rate:** one shift every `16 × NP` master clocks [DS], i.e. every 2 tone-counter ticks, where a tone tick is `8` master clocks.
- **Low noise periods:** [STS] freezes the noise for NP below 3. Treat that as that player's quirk, and do not copy it unless a real tune needs it.
- Test plan for T2.3: the full sequence must repeat after 2^17 − 1 shifts, and the first N outputs must match a straight reference implementation.

## 7. ST bus and memory map [HW]

- `$FF8800` (read): read the register selected. `$FF8800` (write): register select (low 4 bits). `$FF8802` (write): write data to the selected register.
- Port A on the ST drives floppy side/drive select, RS232 RTS/DTR, Centronics strobe and a general-purpose output. Port B is the parallel interface data. None of it is audio, so the emulator ignores R14/R15.
- For Phase 9 (SNDH) we would model exactly this three-address interface.

## 8. MFP 68901 timers

- Needed for the YM5/6 effects (PRD R20). Source: **[MFP]**, `MK68901 MFP.TXT`, plus [HW] for the clock.
- **Timer clock: 2.4576 MHz** on the ST [HW, line ~694: "Timer D ... is supplied with 2.4576 MHz"]. [MFP] does not state the crystal frequency, so [HW] is our only source. We assume all four timers share it, as [MFP] says they have "a common independent clock input".
- Timer control registers (low bits select the mode):

| C3 C2 C1 C0 (Timers A/B) | Mode |
|---|---|
| 0 0 0 0 | Stopped |
| 0 0 0 1 / 0 0 1 0 / 0 0 1 1 | Delay, prescale /4 / /10 / /16 |
| 0 1 0 0 / 0 1 0 1 / 0 1 1 0 / 0 1 1 1 | Delay, prescale /50 / /64 / /100 / /200 |
| 1 0 0 0 | Event count |
| 1 x x x (non-zero low bits) | Pulse width mode with the same prescales |

- Timers C and D use a 3-bit field (`C2 C1 C0`) with the same delay prescales (1 = /4 through 7 = /200) and no event or pulse-width modes. TCDCR holds timer C in bits 6–4 and timer D in bits 2–0.
- **Timer rate for the effects** (delay mode):
  `timeout frequency = 2,457,600 / (prescale × count)`
  - The counter is an 8-bit **down** counter.
  - A data value of **0 means 256**, and a value of 1 times out on every prescaler pulse.
  - The effects only need delay mode.
- Examples: prescale /4 with count 100 gives 6,144 Hz. Prescale /200 with count 1 gives 12,288 Hz.
- Register addresses: `$FFFA19` timer A control, `$FFFA1B` B, `$FFFA1D` C and D, `$FFFA1F`–`$FFFA25` the data registers [HW].
- Quirks we do not need to model: reloading a running timer, prescale changes mid-run (first timeout is indeterminate), and the interrupt controller. Our player only needs to know "at what rate does the effect fire".
- The YM5/6 effect fields carry a prescale index and a count. Section 9.4 gives the mapping. Note the one difference from hardware: in YM files a count of 0 disables the effect, whereas the MFP treats 0 as 256.

## 9. YM file format and effects

Source: the **ST-Sound** reference player by Arnaud Carré (Leonard/Oxygene), `Ymload.cpp`, `YmMusic.cpp`, `YmMusic.h`, `Ym2149Ex.cpp` [STS]. The author's own format page was unreachable. The effect decoding was confirmed against the actual source lines. The rest (loader and attribute values) came from a summary of the source, so **re-check anything marked (S) against a real file in T3.3**.

### 9.1 Container (LHA)

- Most `.ym` files are LHA archives holding one file, method `-lh5-`. If byte 1 of the header is 0 or the 5 method bytes at offset 2 are not `-lh5-`, the file is **raw** (not compressed) and is used as is [STS].
- Header fields (all **little-endian**) [STS]:
  - byte 0: header size (excludes bytes 0 and 1)
  - bytes 2–6: method `-lh5-`
  - original (unpacked) size: 32-bit
  - packed size: 32-bit
- The compressed data starts at `headerSize + 2` (this skips a trailing 16-bit CRC). Clamp the packed size to the bytes remaining.
- Validate the unpacked size before allocating (the reference player does not).
- `-lh0-` (stored) is not handled by [STS]. Support it only if a real file needs it.
- The LH5 algorithm is Haruhiko Okumura's: 8 KB sliding window, with Huffman-coded literals/lengths and positions. It is well documented, and [STS] bundles a public-domain-style C implementation. We write our own for T3.1 and test it against a real compressed file.

### 9.2 Format IDs (first 4 bytes, read big-endian)

| ID | Notes |
|---|---|
| `YM2!`, `YM3!`, `YM3b` | 14 bytes per frame, **interleaved**, data starts at offset 4. Frames = `(size − 4) / 14`. 50 Hz, Atari clock, no header strings. `YM3b` has the loop frame in the **last 4 bytes, little-endian**. `YM2!` adds the Mad Max digidrum effect (9.5). |
| `YM4!` | Rejected by [STS] ("use YM5!"). We skip it too. |
| `YM5!`, `YM6!` | 16 bytes per frame, extended header (9.3). |
| `MIX1`, `YMT1`, `YMT2` | Sample-mix and tracker formats. Out of scope (PRD non-goals). |

### 9.3 YM5! / YM6! header (all fields **big-endian**)

| Offset | Size | Field |
|---|---|---|
| 0 | 4 | ID (`YM5!` or `YM6!`) |
| 4 | 8 | `LeOnArD!` (check it) |
| 12 | 4 | Frame count |
| 16 | 4 | Attribute flags |
| 20 | 2 | Number of digidrums |
| 22 | 4 | Master clock in Hz (2,000,000 for the ST) |
| 26 | 2 | Frame rate in Hz (normally 50) |
| 28 | 4 | Loop frame |
| 32 | 2 | Extra data size: skip that many bytes |
| 34+ | | Digidrum table, then three NUL-terminated strings (title, author, comment), then frame data |

Attribute flags (`YmMusic.h`): `1` = frame data is **interleaved**, `2` = digidrum samples are signed, `4` = digidrum samples are 4-bit, `8` = time control (internal), `16` = loop mode.

**Digidrum table** (if the count is above 0), per drum: a 32-bit size, then that many sample bytes. A size of 0 means no sample. In 4-bit mode each byte's low nibble is a level, which [STS] converts to amplitude through its volume table (`table[n & 15] >> 7`). Otherwise the bytes are 8-bit samples. (S)

**Frame data:** 16 bytes per frame, one byte per register R0–R15. There is **no `End!` marker check** in [STS]. Playback length comes from the frame count. (An `End!` marker is commonly present at the end of the file. Ignore it.)

**Interleaved layout** (flag 1): the data is stored as 16 planes of `frameCount` bytes each, plane `k` holding register `k` for every frame. De-interleave into frame-major: `frame[j][k] = data[k × frameCount + j]`. The same applies to the 14-byte formats.

**LHA checked against real files:** the layout in 9.1 and our `-lh5-` decoder were verified on six real TCB tunes. All six unpack to the size in the header and match the CRC stored in it. Three are YM5! and three are YM6!, with no digidrums.

**Checked against real files:** all 75 files in `ym/` parse exactly this way (big-endian fields, `YM5!LeOnArD!`, attribute `1`, clock 2,000,000, 50 Hz, frame data ending at the end of the file, no `End!` tag). They have no digidrums and are not compressed, so the digidrum table and LHA parts remain unchecked.

### 9.4 Per-frame decoding and the effects

Each frame, copy R0–R10 into the chip. Write **R13 only if the frame's R13 is not `0xFF`**, because `0xFF` means "do not retrigger the envelope". Writing R13 retriggers it.

Special-effect state lives in the "spare" bits of the frame:

| Reg | Bits that carry effect data | Normal use of the other bits |
|---|---|---|
| R1 | high nibble: effect slot 1 code | low 4 bits: tone A coarse |
| R3 | high nibble: effect slot 2 code | low 4 bits: tone B coarse |
| R6 | bits 5–7: slot 1 timer prescale index | bits 0–4: noise period |
| R8 | bits 5–7: slot 2 timer prescale index | bits 0–4: level A |
| R14 | slot 1 timer count (8 bits) | |
| R15 | slot 2 timer count (8 bits) | |

**YM6** has two slots (slot 1: R1/R6/R14, slot 2: R3/R8/R15). The effect code is the high nibble of the code register:

| Code (high nibble) | Effect |
|---|---|
| `0001` / `0010` / `0011` | SID voice on A / B / C |
| `0101` / `0110` / `0111` | Digidrum on A / B / C |
| `1001` / `1010` / `1011` | Sinus-SID on A / B / C |
| `1101` / `1110` / `1111` | Sync-buzzer (voice irrelevant to the sound) |
| `0100`, `1000`, `1100` | "Extended FX", not implemented in [STS]. Ignore. |

So: voice = `((code & 0x30) >> 4) − 1` (0 means no effect), and the type is `code & 0xC0` (`0x00` SID, `0x40` digidrum, `0x80` sinus-SID, `0xC0` sync-buzzer).

**YM5** has the same idea with a different layout. SID uses voice `(R1 >> 4) & 3`, prescale index `(R6 >> 5) & 7` and count `R14`. Digidrum uses voice `(R3 >> 4) & 3`, prescale index `(R8 >> 5) & 7` and count `R15`. There is no sync-buzzer or sinus-SID in YM5.

**Timer frequency** (confirmed in the source, and consistent with section 8):

- The prescale index selects from `{0, 4, 10, 16, 50, 64, 100, 200}`. Index 0 means "off". Indices 1–7 line up with the MFP's `/4` to `/200` codes in section 8.
- `divisor = prescale × count`. If the divisor is 0 (index 0 or count 0), **there is no effect**. (Note: unlike the hardware, count 0 does not mean 256 here.)
- `effectFrequency = 2,457,600 / divisor`.

**Volume or sample used by the effect:**

- SID, sinus-SID and sync-buzzer: volume = `R(voice + 8) & 15`.
- Digidrum: sample number = `R(voice + 8) & 31`. Skip it if the number is not below the digidrum count.

### 9.5 What each effect does (the chip side) [STS]

- Effects last **one frame**. The player stops all effects at the start of each frame, then starts the ones the frame requests.
- **SID voice:** a square gate on the channel's volume at `effectFrequency`. While the gate is high the level is the 4-bit volume, otherwise 0. The envelope bit is not used. The tone/noise mixer settings still apply, which is what gives the buzzy "SID" sound.
- **Sync-buzzer:** restarts the envelope at `effectFrequency`, using the envelope shape and period from R11–R13 as written. The tone pitch is not changed. This gives the harsh, locked buzz.
- **Digidrum:** plays the sample at `effectFrequency` (samples per second), writing each sample value into that voice's level in place of the register. The voice's tone and noise are forced on so it sounds whatever the mixer says. The register value is not restored when the drum ends, so the next frame's R8–R10 write does that. 8-bit samples are scaled **linearly**. 4-bit samples go through the level table (9.3).
- **Sinus-SID:** **not implemented in [STS]** (the function is an empty TODO). We must define it ourselves. The natural choice is to modulate the volume with a sine at `effectFrequency` instead of a square. Make it low priority.
- **Mad Max digidrum (YM2! only):** triggered by bit 7 of R10 (the sample number is the low 7 bits). Channel C is muted in the mixer (R7 OR `0x24`). The rate divisor is R12 (0 means none), and the sample plays on voice C at `(2,457,600 / 4) / R12` Hz. If R13 is not `0xFF`, set R11 = frame R11, R12 = 0, R13 = 10. Low priority.

**Implemented in `src/ym2149.js` and `src/ymplayer.js`, and measured in `tests/ymplayer.test.js`:**

- SID: a gate between the written volume and 0, toggling on every timer tick (gate frequency = timer / 2). Its phase starts low at the start of every frame.
- Sync-buzzer: on every timer tick, R13 is rewritten with the shape, which restarts the envelope. The shape is the low nibble of the effect voice's level register (`R8`/`R9`/`R10`), not R13. In slot 2 on voice A, R8 therefore carries the prescale (bits 5–7), the envelope bit (bit 4) and the shape (bits 0–3) at once.
- Digidrum: amplitude = sample / 255, so 255 is a full-level channel. 4-bit samples become `LEVELS_4BIT[n] >> 7` first.
- Not implemented: sinus-SID, and the YM2 Mad Max digidrum.

### 9.6 Looping

Play frames in order. When the frame index reaches the frame count: if looping, jump to the **loop frame** from the header (YM3b: the last 4 bytes). Otherwise stop and reset the chip.

### 9.7 Sources

- [STS] ST-Sound repository: <https://github.com/arnaud-carre/StSound> (MIT licence). Files read: `StSoundLibrary/Ymload.cpp`, `YmMusic.cpp`, `YmMusic.h`, `Ym2149Ex.cpp`.
- [AYU] ayumi, Peter Sovietov: <https://github.com/true-grue/ayumi>. Used only to confirm the noise taps and structure. Its code and tables were not copied.
- [CLK] CLK emulator AY-3-8910 component (via search results): noise shifts and 32-level envelope table.
- The author's page `leonard.oxg.free.fr/ymformat.html` could not be reached. If it comes back, compare it against section 9.

## 10. What each document gives us

| Document | Use |
|---|---|
| Yamaha YM2149.TXT | Primary source for sections 2–4. |
| Engineering Hardware Specification.TXT | Clock (2 MHz), MFP timer clock (2.4576 MHz), memory map, port usage. Cross-check only, since its register table has the R13 error. |
| MK68901 MFP.TXT | Timer prescales, down-counter behaviour and the data-register-0 = 256 rule (section 8). Interrupt controller, USART and GPIP are not needed. |
| Atari STE Hardware.TXT | STE **DMA** sound, mixing and Microwire. Not part of the YM2149, so out of scope. It becomes relevant only if we add STE sample playback. |
| Atari Coding Book 2 | Covers STE DMA sound and states it deliberately skips the Yamaha chip. No use for this project. |
| MC68000 FAQ, Reference and Instruction Timings | Phase 9 (SNDH / 68000 emulation) only. |
