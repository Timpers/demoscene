# PIXEL RIOT

A 320x200 intro for the browser in the style of the Atari ST and Amiga scene. Its music is played through a software emulation of the Atari ST YM2149 sound chip. See [PRD.md](PRD.md) for the plan and task list.

## Run it

Open `index.html` in a browser and click to start. There is no build step.

The demo's soundtrack is a YM tune played by the YM2149 emulator. The emulator ([src/ym2149.js](src/ym2149.js)), the file loader ([src/lha.js](src/lha.js), [src/ymfile.js](src/ymfile.js)), the player ([src/ymplayer.js](src/ymplayer.js)) and the browser audio ([src/audio.js](src/audio.js)) are built and tested. The demo follows the music: its clock comes from the audio, the three parts change at fixed points in the tune and restart when it loops, and the cubes and copper bars pulse with a beat read from the tune's registers. The default tune is baked into `tunes/default-tune.js`; drop another `.ym` file on the page to replace it. If that file is missing, the demo plays its own built-in tune ([src/builtintune.js](src/builtintune.js)), and `index.html?tune=builtin` forces it.

## Try a tune

Open `player.html` for a stand-alone YM player (click Start audio, then drop a `.ym` file on it or press `O`). You can also drop a `.ym` file onto the demo itself: it replaces the default tune.

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
node tools/export-builtin.js               write the built-in tune to tunes/pixel-riot-theme.ym
npm run default-tune -- tunes/stsound/X.ym  choose the default tune (writes tunes/default-tune.js)
node tools/render-wav.js in.ym out.wav     render a .ym file to a WAV you can listen to
                                           options: --start S  --seconds N  --box  --lowpass Hz  --gain G
```

`render-wav.js` reads raw and LHA-compressed YM files and plays them with the real player, including the ST effects (SID voice, sync-buzzer, digidrums). It stops at the end of the song unless you pass `--loop`. It warns about the two things not played yet: sinus-SID and YM2 Mad Max digidrums.

## Music files

`tunes/stsound/` holds eleven sample tunes copied from the ST-Sound repository, and `tunes/default-tune.js` is one of them baked for the page. **Their rights position is unconfirmed**: see [tunes/README.md](tunes/README.md) before publishing anything.

`tunes/pixel-riot-theme.ym` is the demo's own tune, so it has no such question. To make it the default instead: `npm run default-tune -- tunes/pixel-riot-theme.ym`.

The `.ym` tunes in the `ym/` folder are not stored in this repository. They are free downloads from [The Hundred on itch.io](https://mark-wright.itch.io/the-hundred). Download them and put the `.ym` files in `ym/`.

Check the licence terms on that page before using the tunes anywhere public.

Real Atari ST tunes belong to their composers. Do not publish the demo with a ripped tune embedded unless you have permission.

## Reference documents

`docs/` holds notes and third-party reference material on the chip. [docs/ym2149-notes.md](docs/ym2149-notes.md) records the register map, timings, YM file format and where each fact came from. The third-party `.TXT` files are not committed.
