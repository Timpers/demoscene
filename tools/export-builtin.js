"use strict";

// Writes the built-in tune to a .ym file, so it can be played in any YM player, rendered with
// tools/render-wav.js, or baked in as the default with tools/ym2js.js.
// Usage: node tools/export-builtin.js [out.ym]      (default: tunes/pixel-riot-theme.ym)

const fs = require("fs");
const path = require("path");
const { ymBuiltinTune } = require("../src/builtintune.js");
const { ymWriteYm5 } = require("../src/ymwrite.js");

const out = process.argv[2] || path.join(__dirname, "..", "tunes", "pixel-riot-theme.ym");
const song = ymBuiltinTune();
const bytes = ymWriteYm5(song);
fs.writeFileSync(out, bytes);
console.log(`${out}: ${bytes.length} bytes, ${song.frames} frames (${(song.frames / song.frameRate).toFixed(1)} s), "${song.title}"`);
