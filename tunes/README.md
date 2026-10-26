# Sample tunes from ST-Sound

These eleven `.ym` files are copied unchanged from the `YmSampleFiles` folder of the ST-Sound repository:
<https://github.com/arnaud-carre/StSound/tree/master/YmSampleFiles>

They are here as test material and as a source for the demo's default tune.

## Rights position: not confirmed

- The ST-Sound README says: "ST-Sound library is written by Arnaud Carré and is public domain. You can use it as you wish." That sentence is about the **library code**. The repository's `LICENSE` file is the MIT licence for that code.
- For this folder the README says only that it "contains a set of YM sample files to fastly test the library". It gives no terms for the tunes and names no authors.
- The tunes themselves were composed by the people named in each file's header (table below). The library's author cannot grant rights over their music, and nothing in the repository says the composers did.

So whether these may be redistributed is **unconfirmed**. This repository is public on GitHub. Before pushing, or before releasing the demo with any of these tunes embedded, check the position with someone able to give sign-off, or get the composers' permission. If the answer is no, run `npm run default-tune -- tunes/pixel-riot-theme.ym` (the demo's own tune, which is not third-party music), then delete `tunes/stsound/`. Anyone who has already cloned the repository will still have the files, and they stay in the git history unless it is rewritten, so check before the first push.

## Contents

| File | Format | Length | Title (from the file header) | Author (from the file header) |
|---|---|---|---|---|
| `ANCOOL1.YM` | YM2! | 92 s | (untitled) | (none) |
| `ND-Loader.ym` | YM6! | 10 s | Nostalgic-O-Demo Loader Song | TAO of ACF (Using Sync-Buzzer !!) |
| `ND-Toxygene.ym` | YM6! | 265 s | Nostalgic-O-Demo Toxygen Music. | TAO of ACF (Using Sync-Buzzer !!) |
| `Scout.ym` | YM5! | 246 s | Scout | Jochen Hippel (Jeroen Tel) |
| `Union Tcb 2.ym` | MIX1 | | not supported by the parser | |
| `VirtualEscape1.YM` | YM6! | 53 s | Virtual Escape (Equinox) Intro Tune | Jedi / Sector One |
| `VirtualEscape2.ym` | YM6! | 287 s | Virtual Escape (Equinox) Main Tune | Furax / Equinox |
| `YMKNUCK.YM` | YMT1 | | not supported by the parser | |
| `enchant1.ym` | YM6! | 233 s | Enchanted Lands: Intro | Jochen Hippel |
| `jess1.ym` | YM5! | 476 s | Camerto for acid band | Jean Sebastien Gerard (Jess) |
| `jess2.ym` | YM5! | 392 s | Sharpness Buzztone | Jean Sebastien Gerard |

What each is useful for:

- `VirtualEscape1.YM`, `VirtualEscape2.ym`: SID voice.
- `ND-Loader.ym`, `ND-Toxygene.ym`: SID voice and sync-buzzer.
- `jess2.ym`: digidrums.
- `ANCOOL1.YM`: the older 14-byte `YM2!` format.
- `Union Tcb 2.ym`, `YMKNUCK.YM`: real files in formats we deliberately reject (a sampled-audio format and a tracker format).
