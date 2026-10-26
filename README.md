# PIXEL RIOT

A 320x200 intro for the browser in the style of the Atari ST and Amiga scene. The plan is to play its music through a software emulation of the Atari ST's YM2149 sound chip. See [PRD.md](PRD.md) for the plan and task list.

## Run it

Open `index.html` in a browser and click to start. There is no build step.

The demo's own music is still the original Web Audio synth. The YM2149 emulator ([src/ym2149.js](src/ym2149.js)), the file loader ([src/lha.js](src/lha.js), [src/ymfile.js](src/ymfile.js)), the player ([src/ymplayer.js](src/ymplayer.js)) and the browser audio ([src/audio.js](src/audio.js)) are built and tested. A dropped tune plays in place of the synth. Making the YM music the demo's soundtrack, with the visuals following it, is Phase 6 in the PRD.

## Try a tune

Open `player.html` for a stand-alone YM player (click Start audio, then drop a `.ym` file on it or press `O`). You can also drop a `.ym` file onto the demo itself: it replaces the built-in music.

Keys: `Space` pause, `M` mute, `L` loop, `O` open a file, left and right arrows seek 5 seconds, up and down arrows change the volume.

The player uses an AudioWorklet where the browser allows it, and falls back to a main-thread processor if not. `player.html` shows which one is in use. Add `?fallback=1` to the address to force the fallback.

## Tests and tools

Needs Node 18 or later.

```
npm test                                   run the tests (chip, parser, player, audio)
npm install --no-save playwright-core      one-off: lets the browser check below run
npm run browser-check                      play tunes in a real Edge or Chrome over file://
                                           (add: chrome | --fallback | --headed)
node tools/gen-test-ym.js                  regenerate the test tunes in tests/data/
node tools/render-wav.js in.ym out.wav     render a .ym file to a WAV you can listen to
                                           options: --start S  --seconds N  --box  --lowpass Hz  --gain G
```

`render-wav.js` reads raw and LHA-compressed YM files and plays them with the real player, including the ST effects (SID voice, sync-buzzer, digidrums). It stops at the end of the song unless you pass `--loop`. It warns about the two things not played yet: sinus-SID and YM2 Mad Max digidrums.

## Music files

The `.ym` tunes in the `ym/` folder are not stored in this repository. They are free downloads from [The Hundred on itch.io](https://mark-wright.itch.io/the-hundred). Download them and put the `.ym` files in `ym/`.

Check the licence terms on that page before using the tunes anywhere public.

Real Atari ST tunes belong to their composers. Do not publish the demo with a ripped tune embedded unless you have permission.

## Reference documents

`docs/` holds notes and third-party reference material on the chip. [docs/ym2149-notes.md](docs/ym2149-notes.md) records the register map, timings, YM file format and where each fact came from. The third-party `.TXT` files are not committed.
