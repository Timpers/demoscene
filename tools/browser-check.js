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
  await dropOnDemo(first("tests/data/envelopes.ym"));
  await sleep(500);
  check("demo: a tune dropped before the click is accepted", /Envelope shapes/.test(await demo.textContent("#ymstatus")), await demo.textContent("#ymstatus"));
  await demo.click("#start");
  await sleep(2500);
  const st = await demo.evaluate(() => ({ mode: ymAudio && ymAudio.mode, ready: ymAudio && ymAudio.ready, state: ymAudio && ymAudio.state, timer: typeof schedTimer }));
  check("demo: YM audio started after the click", st.ready && (fallback ? st.mode === "script" : st.mode === "worklet"), st.mode);
  check("demo: that tune plays and the built-in synth never started", st.state.playing && st.state.frame > 50 && st.timer === "undefined", `frame ${st.state.frame}`);
  const lit = await demo.evaluate(() => { const c = document.getElementById("c").getContext("2d").getImageData(0, 0, 320, 200).data; let n = 0; for (let i = 0; i < c.length; i += 4) if (c[i] || c[i + 1] || c[i + 2]) n++; return n; });
  check("demo: visuals are running", lit > 5000, lit + " lit pixels");
  await demo.screenshot({ path: path.join(shots, `demo-${channel}${fallback ? "-fallback" : ""}.png`) });
  await dropOnDemo(first("tests/data/sid-voice.ym"));
  await sleep(1200);
  check("demo: dropping a second tune switches to it", /SID voice/.test(await demo.textContent("#ymstatus")) && await demo.evaluate(() => ymAudio.state.playing), await demo.textContent("#ymstatus"));

  const untouched = await context.newPage();
  await untouched.goto(url("index.html"));
  await untouched.click("#start"); await sleep(1500);
  check("demo: with no tune dropped, the built-in synth still runs", await untouched.evaluate(() => typeof schedTimer !== "undefined"));

  const real = errors.filter(e => !/favicon/i.test(e)), demoReal = demoErrors.filter(e => !/favicon/i.test(e));
  check("no console errors on the player page", real.length === 0, real.join(" | "));
  check("no console errors on the demo page", demoReal.length === 0, demoReal.join(" | "));
  await browser.close();
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error("SCRIPT ERROR", e); process.exit(2); });
