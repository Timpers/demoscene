"use strict";

// Checks the YM player in a real browser, opened over file:// like a user would.
// Usage: node tools/browser-check.js [msedge|chrome] [--fallback] [--headed]
//
// Needs playwright-core and an installed Edge or Chrome:  npm install --no-save playwright-core
// Uses the generated tunes in tests/data. If the local ym/ folder holds the real tunes, the
// LHA, SID, digidrum and sync-buzzer checks use those as well. Screenshots go to out/browser-check/.

const path = require("path");
const fs = require("fs");
const os = require("os");
let chromium;
try { ({ chromium } = require("playwright-core")); }
catch (e) { console.error("playwright-core is not installed. Run: npm install --no-save playwright-core"); process.exit(2); }

const repo = path.resolve(__dirname, "..");
const url = f => "file:///" + path.join(repo, f).replace(/\\/g, "/");
const channel = process.argv.find(a => a === "msedge" || a === "chrome") || "msedge";
const fallback = process.argv.includes("--fallback");
const shots = path.join(repo, "out", "browser-check");
fs.mkdirSync(shots, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const first = (...names) => names.map(n => path.join(repo, n)).find(f => fs.existsSync(f));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log((ok ? "PASS " : "FAIL ") + name + (detail ? "  [" + detail + "]" : ""));
};

(async () => {
  const browser = await chromium.launch({ channel, headless: !process.argv.includes("--headed"), args: ["--mute-audio"] });
  console.log(`== ${channel} ${browser.version()} ${fallback ? "(forced ScriptProcessor fallback)" : "(AudioWorklet)"} ==`);
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const page = await context.newPage();
  const errors = [];
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", e => errors.push("pageerror: " + e.message));

  // ---------- player.html ----------
  await page.goto(url("player.html") + (fallback ? "?fallback=1" : ""));
  check("page is a secure context on file://", await page.evaluate(() => window.isSecureContext));
  check("AudioWorklet API exists in this browser", await page.evaluate(() => typeof AudioWorkletNode === "function" && !!new AudioContext().audioWorklet));
  await page.click("#start");
  await page.waitForFunction(() => document.getElementById("mode").textContent !== "not started", null, { timeout: 15000 });
  const modeText = await page.textContent("#mode");
  check(fallback ? "fallback mode in use" : "AudioWorklet in use on file://", fallback ? /ScriptProcessor/.test(modeText) : /^AudioWorklet/.test(modeText), modeText);
  check("audio context is running", await page.evaluate(() => window.__ym.audio.ctx.state === "running"));
  console.log("     sample rate " + await page.evaluate(() => window.__ym.audio.ctx.sampleRate));

  const loadFile = async file => {
    await page.setInputFiles("input[type=file]", file);
    await page.waitForFunction(() => window.__ym.ui.song, null, { timeout: 5000 });
  };
  const state = () => page.evaluate(() => ({ ...window.__ym.audio.state, t: performance.now(), ct: window.__ym.audio.ctx.currentTime }));
  const realTime = async (label, minPeak = 0.05) => {
    const x = await state(); await sleep(3000); const y = await state();
    const secs = (y.t - x.t) / 1000, f = (y.frame - x.frame) / secs, r = (y.ct - x.ct) / secs;
    // a loop wrap makes the frame count jump back, which would skew the rate
    const wrapped = y.frame < x.frame;
    check(`${label}: plays in real time`, (wrapped || Math.abs(f - 50) < 1.5) && Math.abs(r - 1) < 0.02 && y.peak > minPeak,
      `${f.toFixed(1)} fps, audio clock ${r.toFixed(3)}, peak ${y.peak.toFixed(2)}`);
    return y;
  };

  const plain = first("ym/so watt 1.ym", "tests/data/scale.ym");
  await loadFile(plain);
  await sleep(600);
  await realTime(path.basename(plain));
  check("status line shows the title", /♪/.test(await page.textContent("#status")), await page.textContent("#status"));
  await page.screenshot({ path: path.join(shots, `player-${channel}${fallback ? "-fallback" : ""}.png`) });

  // transport controls, on a tune long enough not to wrap
  const longTune = first("ym/so watt 1.ym", "ym/001_crystal-requiem.ym");
  if (longTune) {
    await loadFile(longTune);
    await sleep(600);
    await page.click("#playpause"); await sleep(400);
    const p1 = await state(); await sleep(600); const p2 = await state();
    check("pause holds the position", p1.frame === p2.frame && !p2.playing, "frame " + p1.frame);
    await page.click("#playpause"); await sleep(700);
    const p3 = await state();
    check("play resumes", p3.frame > p2.frame && p3.playing);
    await page.keyboard.press("ArrowRight"); await sleep(400);
    const s1 = await state();
    check("right arrow seeks forward about 5 seconds", s1.frame - p3.frame > 200 && s1.frame - p3.frame < 330, `${p3.frame} -> ${s1.frame}`);
    await page.evaluate(() => { const s = document.getElementById("seek"); s.value = 100; s.dispatchEvent(new Event("change")); });
    await sleep(400);
    const s2 = await state();
    check("position slider seeks", s2.frame >= 100 && s2.frame < 160, "frame " + s2.frame);
  }
  await page.keyboard.press("m"); await sleep(200);
  check("M mutes", await page.evaluate(() => window.__ym.audio.muted) === true);
  await page.keyboard.press("m");
  await page.keyboard.press("l"); await sleep(100);
  check("L turns looping off", await page.evaluate(() => window.__ym.audio.loop) === false);
  await page.keyboard.press("l");
  await page.keyboard.press("Space"); await sleep(300);
  check("Space pauses", !(await state()).playing);
  await page.keyboard.press("Space");

  // looping: seek near the end of the short generated tune
  await loadFile(first("tests/data/scale.ym"));
  await sleep(300);
  await page.evaluate(() => window.__ym.audio.seek(318)); await sleep(1500);
  const lp = await state();
  check("looping wraps round at the end", lp.loops >= 1 && lp.playing, "loops " + lp.loops);

  // effects
  const sid = first("ym/VirtualEscape2.ym", "tests/data/sid-voice.ym");
  await loadFile(sid); await sleep(500); await realTime("SID tune " + path.basename(sid));
  const drum = first("ym/jess2.ym");
  if (drum) { await loadFile(drum); await sleep(300); await page.evaluate(() => window.__ym.audio.seek(900)); await sleep(500); await realTime("digidrum tune"); }
  const sync = first("ym/ND-Toxygene.ym");
  if (sync) { await loadFile(sync); await sleep(300); await page.evaluate(() => window.__ym.audio.seek(900)); await sleep(500); await realTime("sync-buzzer tune"); }

  // drag and drop, and a bad file
  const dropBytes = fs.readFileSync(path.join(repo, "tests/data/scale.ym")).toString("base64");
  await page.evaluate(b64 => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], "dropped.ym"));
    window.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
    window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, dropBytes);
  await page.waitForFunction(() => window.__ym.ui.song && window.__ym.ui.song.title === "Scale", null, { timeout: 5000 });
  check("drag and drop loads a tune", true);
  const junk = path.join(os.tmpdir(), "junk.ym");
  fs.writeFileSync(junk, Buffer.from("this is not a ym file at all, sorry"));
  await page.setInputFiles("input[type=file]", junk);
  await sleep(300);
  check("a bad file shows a readable error", /Could not open "junk.ym"/.test(await page.textContent("#status")), await page.textContent("#status"));
  await loadFile(first("tests/data/scale.ym"));
  await sleep(500);
  check("player recovers after a bad file", (await state()).playing);

  // ---------- index.html (the demo) ----------
  const demo = await context.newPage();
  const demoErrors = [];
  demo.on("console", m => { if (m.type() === "error") demoErrors.push(m.text()); });
  demo.on("pageerror", e => demoErrors.push("pageerror: " + e.message));
  await demo.goto(url("index.html") + (fallback ? "?fallback=1" : ""));
  const dropOnDemo = file => demo.evaluate(b64 => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], "tune.ym"));
    window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, fs.readFileSync(file).toString("base64"));
  const dstate = () => demo.evaluate(() => ({ ...window.__demo, audio: ymAudio && ymAudio.state, ctxTime: ac && ac.currentTime }));

  check("demo: the baked default tune is loaded before the click", /Virtual Escape/.test(await demo.textContent("#ymstatus")), await demo.textContent("#ymstatus"));
  check("demo: the start screen names the tune", /MUSIC: Virtual Escape.*Furax/.test(await demo.textContent("#tune")), await demo.textContent("#tune"));
  await demo.click("#start");
  await sleep(3000);
  const st = await demo.evaluate(() => ({ mode: ymAudio && ymAudio.mode, ready: ymAudio && ymAudio.ready, playing: ymAudio && ymAudio.state.playing }));
  check("demo: audio started after the click", st.ready && (fallback ? st.mode === "script" : st.mode === "worklet") && st.playing, st.mode);
  let d = await dstate();
  check("demo: the visuals run on the music clock", d.mode === "music" && d.part === 0, JSON.stringify({ mode: d.mode, part: d.part, t: +d.t.toFixed(2) }));
  check("demo: the old synth is gone", await demo.evaluate(() => typeof schedTimer === "undefined" && typeof scheduleStep === "undefined"));
  const lit = await demo.evaluate(() => { const c = document.getElementById("c").getContext("2d").getImageData(0, 0, 320, 200).data; let n = 0; for (let i = 0; i < c.length; i += 4) if (c[i] || c[i + 1] || c[i + 2]) n++; return n; });
  check("demo: visuals are running", lit > 5000, lit + " lit pixels");
  await demo.screenshot({ path: path.join(shots, `demo-${channel}${fallback ? "-fallback" : ""}.png`) });

  // the demo clock stays locked to the audio clock
  const offs = [];
  for (let i = 0; i < 4; i++) { const x = await dstate(); offs.push(x.ctxTime - x.t); await sleep(1000); }
  check("demo: the demo clock keeps a steady offset from the audio clock", Math.max(...offs) - Math.min(...offs) < 0.06, offs.map(o => o.toFixed(3)).join(", "));

  // beat signal
  let maxBeat = 0;
  for (let i = 0; i < 80; i++) { maxBeat = Math.max(maxBeat, (await dstate()).beat); await sleep(50); }
  check("demo: the beat signal fires with the music", maxBeat > 0.3, "max beat " + maxBeat.toFixed(2));

  // parts follow the music: cross a slice boundary (slices are 1/15 of this 287 s tune)
  const boundary = await demo.evaluate(() => Math.round(currentSong.frames / 15));
  await demo.evaluate(b => ymAudio.seek(b - 75), boundary);      // 1.5 s before the cue point
  await sleep(400);
  const before = await dstate();
  await sleep(1700);
  const after = await dstate();
  check("demo: the part changes exactly at the cue point in the music", before.part === 0 && after.part === 1 && after.local < 1.5, `part ${before.part} -> ${after.part}, ${after.local.toFixed(2)} s into the new part`);

  // loop: the demo restarts at part A when the music loops
  await demo.evaluate(() => ymAudio.seek(currentSong.frames - 40));
  await sleep(500);
  const preLoop = await dstate();
  await sleep(1800);
  const postLoop = await dstate();
  check("demo: the demo restarts at part A when the music loops", preLoop.part === 14 % 3 && postLoop.audio.loops >= 1 && postLoop.part === 0 && postLoop.local < 2, `part ${preLoop.part} -> ${postLoop.part}, loops ${postLoop.audio.loops}`);

  // pause freezes the demo
  await demo.keyboard.press("Space"); await sleep(400);
  const p1 = await dstate(); await sleep(500); const p2 = await dstate();
  check("demo: pausing the music holds the demo clock and part", p1.t === p2.t && p1.part === p2.part && !p2.audio.playing, `t ${p1.t.toFixed(3)}`);
  await demo.keyboard.press("Space"); await sleep(600);
  const p3 = await dstate();
  check("demo: resuming carries on from where it stopped", p3.t > p2.t && p3.t - p2.t < 1.5 && p3.audio.playing, `t ${p2.t.toFixed(2)} -> ${p3.t.toFixed(2)}`);

  // a dropped tune takes over, and the parts follow it
  await dropOnDemo(first("tests/data/envelopes.ym"));
  await sleep(1500);
  d = await dstate();
  check("demo: a dropped tune replaces the default and the demo follows it", /Envelope shapes/.test(await demo.textContent("#ymstatus")) && d.mode === "music" && d.audio.playing, await demo.textContent("#ymstatus"));
  await demo.evaluate(() => ymAudio.seek(0)); await sleep(300);
  await sleep(7000);
  d = await dstate();
  check("demo: a 16 s tune gets three parts of about 5 s each", d.part === 1 && d.length > 5 && d.length < 5.6, `part ${d.part}, length ${d.length.toFixed(2)} s`);

  // a tune dropped before the click is held until the click
  const early = await context.newPage();
  await early.goto(url("index.html") + (fallback ? "?fallback=1" : ""));
  await early.evaluate(b64 => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], "early.ym"));
    window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, fs.readFileSync(first("tests/data/sid-voice.ym")).toString("base64"));
  await sleep(400);
  check("demo: a tune dropped before the click replaces the default", /SID voice/.test(await early.textContent("#ymstatus")), await early.textContent("#ymstatus"));
  await early.click("#start"); await sleep(2000);
  check("demo: and plays after the click", await early.evaluate(() => ymAudio.state.playing && currentSong.title === "SID voice"));

  // the built-in tune: on request, and as the fallback when the baked tune is missing (a fresh copy
  // of the page without the tunes folder)
  const builtin = await context.newPage();
  await builtin.goto(url("index.html") + "?tune=builtin" + (fallback ? "&fallback=1" : ""));
  check("demo: ?tune=builtin loads the built-in tune", /Pixel Riot Theme/.test(await builtin.textContent("#ymstatus")), await builtin.textContent("#ymstatus"));
  await builtin.click("#start"); await sleep(2500);
  const bs = await builtin.evaluate(() => ({ d: window.__demo, a: ymAudio.state }));
  check("demo: the built-in tune plays, with three parts of about 20 s", bs.a.playing && bs.d.mode === "music" && Math.abs(bs.d.length - 20.48) < 0.01 && bs.a.peak > 0.05, `length ${bs.d.length.toFixed(2)} s, peak ${bs.a.peak.toFixed(2)}`);
  await builtin.evaluate(() => ymAudio.seek(currentSong.frames - 40)); await sleep(2200);
  const bl = await builtin.evaluate(() => ({ d: window.__demo, a: ymAudio.state }));
  check("demo: the built-in tune loops and the demo restarts at part A", bl.a.loops >= 1 && bl.d.part === 0 && bl.d.local < 2.5, `loops ${bl.a.loops}, part ${bl.d.part}`);

  const bare = path.join(os.tmpdir(), "pixelriot-no-tunes");
  fs.rmSync(bare, { recursive: true, force: true });
  fs.mkdirSync(bare, { recursive: true });
  for (const f of ["index.html", "demo.js"]) fs.copyFileSync(path.join(repo, f), path.join(bare, f));
  fs.cpSync(path.join(repo, "src"), path.join(bare, "src"), { recursive: true });
  const bareErrors = [];
  const barePage = await context.newPage();
  barePage.on("console", m => { if (m.type() === "error" && !/default-tune|ERR_FILE_NOT_FOUND|favicon/i.test(m.text())) bareErrors.push(m.text()); });
  barePage.on("pageerror", e => bareErrors.push("pageerror: " + e.message));
  await barePage.goto("file:///" + path.join(bare, "index.html").replace(/\\/g, "/") + (fallback ? "?fallback=1" : ""));
  check("demo: with no tunes folder at all it still has a tune (the built-in one)", /Pixel Riot Theme/.test(await barePage.textContent("#ymstatus")), await barePage.textContent("#ymstatus"));
  await barePage.click("#start"); await sleep(2500);
  check("demo: and plays it", await barePage.evaluate(() => ymAudio.state.playing && ymAudio.state.peak > 0.05 && window.__demo.mode === "music"));
  check("demo: with nothing but the page and src/ there are no errors", bareErrors.length === 0, bareErrors.join(" | "));
  fs.rmSync(bare, { recursive: true, force: true });

  // with no audio at all the demo still runs, on its timer
  const mute = await context.newPage();
  await mute.addInitScript(() => { window.AudioContext = undefined; window.webkitAudioContext = undefined; });
  await mute.goto(url("index.html"));
  await mute.click("#start"); await sleep(1500);
  const m = await mute.evaluate(() => window.__demo);
  check("demo: with no audio at all it falls back to its own timer and keeps running", m && m.mode === "timer" && m.t > 0.5, JSON.stringify(m && { mode: m.mode, t: +m.t.toFixed(2) }));

  const real = errors.filter(e => !/favicon/i.test(e)), demoReal = demoErrors.filter(e => !/favicon/i.test(e));
  check("no console errors on the player page", real.length === 0, real.join(" | "));
  check("no console errors on the demo page", demoReal.length === 0, demoReal.join(" | "));
  await browser.close();
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("SCRIPT ERROR", e); process.exit(2); });
