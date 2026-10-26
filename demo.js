"use strict";

const W = 320, H = 200;
const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");
ctx.imageSmoothingEnabled = false;
const img = ctx.createImageData(W, H);
const px = new Uint32Array(img.data.buffer);

const PART_LEN = 20;
const SCROLL_TEXT =
  "      YO! PIXEL RIOT PROUDLY PRESENTS... A TINY INTRO IN 320X200 WITH ONE LITTLE TUNE AND A WHOLE LOT OF CODE...   " +
  "ALL CODE BY YOU-KNOW-WHO, MUSIC PLAYED LIVE BY A SOFTWARE YM2149 SOUND CHIP, JUST LIKE ON THE ST... " +
  "DROP ANY .YM FILE ONTO THE SCREEN (OR PRESS O) AND IT PLAYS RIGHT HERE...   " +
  "GREETINGS FLY OUT TO ALL THE LEGENDS: THE CAREBEARS, TCB, THE LOST BOYS, DELTA FORCE, " +
  "ELECTRONIC IMAGES, SYNC, CUDDLY, EQUINOX, ANARCHY, KEFRENS, SPREADPOINT, FAIRLIGHT AND THE REST OF THE OLD CREW!   " +
  "REMEMBER: NO CPU WAS HARMED IN THE MAKING OF THIS DEMO... WELL, MAYBE A LITTLE. " +
  "NOW GO AND FIND A JOYSTICK, A BOXED DISK AND A CRT MONITOR...   WRAP!      ";

// ---------- helpers ----------
const rgb = (r, g, b) => (255 << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255);
const clamp255 = v => v < 0 ? 0 : v > 255 ? 255 : v | 0;

function hsl2rgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = n => { const k = (n + h * 12) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

// 256-entry cyclic palette for plasma/tunnel
const PAL = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  const a = (i / 256) * Math.PI * 2;
  PAL[i] = rgb(128 + 127 * Math.sin(a), 128 + 127 * Math.sin(a + 2.1), 128 + 127 * Math.sin(a + 4.2));
}

// ---------- scroller ----------
const FONT_H = 30;
function makeScroller() {
  const probe = document.createElement("canvas").getContext("2d");
  const font = 'bold 26px "Courier New", monospace';
  probe.font = font;
  const width = Math.ceil(probe.measureText(SCROLL_TEXT).width);
  const c = document.createElement("canvas");
  c.width = width; c.height = FONT_H;
  const g = c.getContext("2d");
  g.font = font; g.textBaseline = "middle";
  const grad = g.createLinearGradient(0, 0, 0, FONT_H);
  grad.addColorStop(0, "#ff0"); grad.addColorStop(0.5, "#fff"); grad.addColorStop(0.55, "#f80"); grad.addColorStop(1, "#f20");
  g.fillStyle = grad;
  g.fillText(SCROLL_TEXT, 0, FONT_H / 2 + 1);
  // hard-edge alpha for that crisp, un-antialiased look
  const d = g.getImageData(0, 0, width, FONT_H);
  for (let i = 3; i < d.data.length; i += 4) d.data[i] = d.data[i] > 110 ? 255 : 0;
  g.putImageData(d, 0, 0);
  // black shadow copy
  const s = document.createElement("canvas");
  s.width = width; s.height = FONT_H;
  const sg = s.getContext("2d");
  sg.drawImage(c, 0, 0);
  sg.globalCompositeOperation = "source-in";
  sg.fillStyle = "#000"; sg.fillRect(0, 0, width, FONT_H);
  return { c, s, width };
}
const scroller = makeScroller();

function drawScroller(t, baseY, amp) {
  const off = (t * 110) % scroller.width;
  for (let x = 0; x < W; x++) {
    const sx = (off + x) % scroller.width | 0;
    const y = baseY + Math.sin(x * 0.035) * amp;
    ctx.drawImage(scroller.s, sx, 0, 1, FONT_H, x + 1, Math.round(y) + 2, 1, FONT_H);
    ctx.drawImage(scroller.c, sx, 0, 1, FONT_H, x, Math.round(y), 1, FONT_H);
  }
}

// ---------- starfield ----------
const stars = Array.from({ length: 220 }, () => ({
  x: (Math.random() - 0.5) * 600, y: (Math.random() - 0.5) * 400, z: Math.random() * 256 + 1,
}));
function drawStars(dt, speed) {
  for (const s of stars) {
    s.z -= speed * dt;
    if (s.z < 1) { s.z += 256; s.x = (Math.random() - 0.5) * 600; s.y = (Math.random() - 0.5) * 400; }
    const sx = W / 2 + (s.x / s.z) * 100 | 0;
    const sy = H / 2 + (s.y / s.z) * 100 | 0;
    if (sx < 0 || sx >= W || sy < 0 || sy >= H) continue;
    const v = clamp255(255 - s.z);
    ctx.fillStyle = `rgb(${v},${v},${v})`;
    ctx.fillRect(sx, sy, s.z < 80 ? 2 : 1, 1);
  }
}

// ---------- copper bars ----------
function drawCopper(t) {
  const r = new Float32Array(H), g = new Float32Array(H), b = new Float32Array(H);
  for (let y = 0; y < H; y++) { // dark blue background gradient
    b[y] = 20 + 50 * (y / H); g[y] = 4 + 12 * (y / H); r[y] = 0;
  }
  const bars = 8;
  for (let k = 0; k < bars; k++) {
    const centre = H / 2 + Math.sin(t * 1.4 + k * 0.45) * 70 * (1 + 0.25 * beat) + Math.sin(t * 0.7 + k * 0.2) * 20;
    const [cr, cg, cb] = hsl2rgb((k / bars + t * 0.05) % 1, 1, 0.55);
    for (let d = -12; d <= 12; d++) {
      const y = Math.round(centre) + d;
      if (y < 0 || y >= H) continue;
      const a = Math.cos((d / 12) * Math.PI / 2);
      const i = a * a;
      r[y] = r[y] * (1 - i) + (cr + (80 + 110 * beat) * i) * i;
      g[y] = g[y] * (1 - i) + (cg + (80 + 110 * beat) * i) * i;
      b[y] = b[y] * (1 - i) + (cb + (80 + 110 * beat) * i) * i;
    }
  }
  for (let y = 0; y < H; y++) {
    ctx.fillStyle = `rgb(${clamp255(r[y])},${clamp255(g[y])},${clamp255(b[y])})`;
    ctx.fillRect(0, y, W, 1);
  }
}

// ---------- logo ----------
function drawLogo(t) {
  const text = "PIXEL RIOT";
  ctx.font = 'bold 34px "Impact", "Arial Black", sans-serif';
  ctx.textBaseline = "alphabetic";
  let x = (W - ctx.measureText(text).width) / 2;
  for (const ch of text) {
    const i = x;
    const y = 52 + Math.sin(t * 3 + i * 0.05) * 8;
    const grad = ctx.createLinearGradient(0, y - 28, 0, y);
    const sh = (Math.sin(t * 2 + i * 0.03) + 1) / 2;
    grad.addColorStop(0, "#fff");
    grad.addColorStop(0.45, `hsl(${(t * 60 + i) % 360},100%,60%)`);
    grad.addColorStop(0.5, "#222");
    grad.addColorStop(1, `hsl(${(t * 60 + i + 180) % 360},100%,${40 + sh * 20}%)`);
    ctx.fillStyle = "#000"; ctx.fillText(ch, x + 2, y + 2);
    ctx.fillStyle = grad; ctx.fillText(ch, x, y);
    x += ctx.measureText(ch).width;
  }
}

// ---------- 3D cube ----------
const CUBE_V = [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]];
const CUBE_F = [[0,1,2,3],[5,4,7,6],[4,0,3,7],[1,5,6,2],[4,5,1,0],[3,2,6,7]];

function rotate([x, y, z], ax, ay, az) {
  let c = Math.cos(ax), s = Math.sin(ax); [y, z] = [y * c - z * s, y * s + z * c];
  c = Math.cos(ay); s = Math.sin(ay); [x, z] = [x * c + z * s, -x * s + z * c];
  c = Math.cos(az); s = Math.sin(az); [x, y] = [x * c - y * s, x * s + y * c];
  return [x, y, z];
}

function drawCube(cx, cy, size, ax, ay, az, hue) {
  const v = CUBE_V.map(p => rotate(p, ax, ay, az));
  const proj = v.map(([x, y, z]) => {
    const f = 4 / (4 - z * 0.9);
    return [cx + x * size * f, cy + y * size * f, z];
  });
  const faces = [];
  for (const f of CUBE_F) {
    const a = v[f[0]], b = v[f[1]], c = v[f[2]];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nz = ux * vy - uy * vx;
    if (nz >= 0) continue; // back-face culling
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nzz = nz;
    const len = Math.hypot(nx, ny, nzz) || 1;
    const light = Math.max(0.15, (-nx * 0.3 - ny * 0.5 - nzz * 0.8) / len);
    faces.push({ f, depth: f.reduce((s, i) => s + v[i][2], 0), light });
  }
  faces.sort((p, q) => q.depth - p.depth);
  faces.forEach((o, i) => {
    ctx.beginPath();
    o.f.forEach((idx, j) => j ? ctx.lineTo(proj[idx][0], proj[idx][1]) : ctx.moveTo(proj[idx][0], proj[idx][1]));
    ctx.closePath();
    ctx.fillStyle = `hsl(${(hue + i * 25) % 360},90%,${Math.round(o.light * 60 + 8)}%)`;
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,.8)";
    ctx.lineWidth = 1;
    ctx.stroke();
  });
}

// ---------- plasma ----------
const dist = new Float32Array(W * H);
const ang = new Float32Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const dx = x - W / 2, dy = y - H / 2;
  dist[y * W + x] = Math.hypot(dx, dy);
  ang[y * W + x] = Math.atan2(dy, dx);
}
function drawPlasma(t) {
  for (let y = 0; y < H; y++) {
    const sy = Math.sin(y / 9 + t * 1.3);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const v = Math.sin(x / 14 + t) + sy + Math.sin((x + y) / 17 + t * 0.7) + Math.sin(dist[i] / 10 - t * 1.5);
      const p = PAL[((v + 4) * 32 + t * 20 | 0) & 255];
      px[i] = p;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// ---------- tunnel ----------
function drawTunnel(t) {
  const sh = t * 90, sa = t * 60;
  for (let i = 0; i < W * H; i++) {
    const d = dist[i] + 0.5;
    const u = (ang[i] / Math.PI * 128 + sa) | 0;
    const v = (6000 / d + sh) | 0;
    const tex = ((u ^ v) & 255);
    const c = PAL[(tex + (t * 30 | 0)) & 255];
    const shade = Math.min(1, d / 90);
    const r = (c & 255) * shade, g = ((c >> 8) & 255) * shade, b = ((c >> 16) & 255) * shade;
    px[i] = rgb(r, g, b);
  }
  ctx.putImageData(img, 0, 0);
}

// ---------- dot sphere ----------
const DOTS = Array.from({ length: 400 }, (_, i) => {
  const y = 1 - (i / 399) * 2, r = Math.sqrt(1 - y * y), th = i * 2.399963;
  return [Math.cos(th) * r, y, Math.sin(th) * r];
});
function drawDotSphere(t, cx, cy, size) {
  const k = 1 + 0.25 * Math.sin(t * 2);
  for (const p of DOTS) {
    const [x, y, z] = rotate(p, t * 0.7, t, 0);
    const f = 3 / (3 - z);
    const v = clamp255(150 + z * 100);
    ctx.fillStyle = `rgb(${v},${clamp255(v * 0.8 + 40)},255)`;
    const s = z > 0 ? 2 : 1;
    ctx.fillRect(cx + x * size * k * f | 0, cy + y * size * k * f | 0, s, s);
  }
}

// ---------- parts ----------
function partA(t, dt) {
  drawCopper(t);
  drawStars(dt, 70);
  drawLogo(t);
  drawCube(W / 2, 112, 28 * (1 + 0.35 * beat), t * 0.9, t * 1.3, t * 0.5, t * 50);
}
function partB(t, dt) {
  drawPlasma(t);
  for (let i = 0; i < 4; i++) {
    const a = t * 1.5 + i * Math.PI / 2;
    drawCube(W / 2 + Math.cos(a) * 95, 95 + Math.sin(a) * 30, 14 * (1 + 0.3 * beat), t + i, t * 1.2, i, i * 90 + t * 40);
  }
  drawCube(W / 2, 95, 38 * (1 + 0.3 * beat), t * 0.8, t * 1.1, t * 0.4, t * 60);
}
function partC(t, dt) {
  drawTunnel(t);
  drawDotSphere(t, W / 2, 95, 65 * (1 + 0.15 * beat));
}
const PARTS = [partA, partB, partC];

// ---------- music ----------
// The soundtrack is a YM tune played by the YM2149 emulator. The default is baked into
// tunes/default-tune.js, and any .ym file dropped on the page (or chosen with O) replaces it. The demo
// follows the music: its clock comes from the audio, the parts change at fixed points in the tune
// (and restart when the tune loops), and the beat is read from the tune's registers.
const CREDIT_MS = 10000;                 // how long the credit line stays bright after a tune starts or loops
let ac = null, ymAudio = null, musicClock = null, currentSong = null, onsets = null, beat = 0;
let creditUntil = 0, lastLoops = 0;
const creditEl = document.getElementById("ymstatus");

const ymui = new YMUI({
  status: creditEl,
  onTune(song) {
    currentSong = song;
    onsets = YMBeat.analyse(song);
    if (musicClock) musicClock.setSong(song);
    lastLoops = 0;
    creditUntil = performance.now() + CREDIT_MS;
    const el = document.getElementById("tune");
    if (el) el.textContent = "MUSIC: " + (song.title || "?") + (song.author.trim() ? " - " + song.author.trim() : "");
  },
});
ymui.attach();

// The baked default tune if there is one, otherwise the demo's own built-in tune (src/builtintune.js),
// which needs no file. Add ?tune=builtin to the address to force the built-in tune.
function loadDefaultTune() {
  if (!/[?&]tune=builtin\b/.test(location.search) && typeof YM_DEFAULT_TUNE !== "undefined") {
    try {
      const bytes = Uint8Array.from(atob(YM_DEFAULT_TUNE.data), c => c.charCodeAt(0));
      ymui.loadSong(parseYm(bytes), YM_DEFAULT_TUNE.name);
      return;
    } catch (err) { console.warn("The default tune could not be loaded, using the built-in tune:", err); }
  }
  ymui.loadSong(ymBuiltinTune(), "built-in");
}
loadDefaultTune();

async function startAudio() {
  ac = new (window.AudioContext || window.webkitAudioContext)();
  ymAudio = new YMAudio(ac, { forceFallback: location.search.includes("fallback") });
  musicClock = new MusicClock({ ctx: ac, isLooping: () => ymAudio.loop });
  if (currentSong) musicClock.setSong(currentSong);
  ymAudio.addPositionListener(m => {
    musicClock.onPosition(m, performance.now());
    if (m.loops !== lastLoops) { lastLoops = m.loops; creditUntil = performance.now() + CREDIT_MS; }
  });
  await ymAudio.init();
  ymui.setAudio(ymAudio);                // plays the tune that is already loaded
}

// Where the music is, for the current frame: null until the audio is reporting
function musicSync(now) {
  if (!musicClock || !currentSong || !musicClock.ready(now)) return null;
  const pos = musicClock.position(now);
  const part = ymPartAt(currentSong, pos.frame, pos.loops);
  return {
    t: musicClock.time(now), part: part.part, local: part.local, length: part.length,
    beat: YMBeat.level(onsets, pos.frame, currentSong.frameRate),
  };
}

// ---------- main loop ----------
let t0 = 0, last = 0;
let lastSync = null;                     // what the last frame used, for tests and debugging
Object.defineProperty(window, "__demo", { get: () => lastSync });
function frame(now) {
  const sync = musicSync(now);
  let t, idx, local, len;
  if (sync) {
    ({ t, part: idx, local, length: len, beat } = sync);
  } else {
    // No music yet (or no audio): run on the wall clock with fixed-length parts
    t = Math.max(0, (now - t0) / 1000);
    idx = Math.floor(t / PART_LEN) % PARTS.length;
    local = t % PART_LEN; len = PART_LEN; beat = 0;
  }
  const dt = Math.max(0, Math.min(0.05, t - last));      // t can step back when the music is sought or switched
  last = t;
  lastSync = { mode: sync ? "music" : "timer", t, part: idx, local, length: len, beat };
  PARTS[idx](t, dt);
  drawScroller(t, H - 52, 12);

  // fade in/out between parts
  const fade = Math.max(1 - local / 0.7, (local - (len - 0.7)) / 0.7, 0);
  if (fade > 0) { ctx.fillStyle = `rgba(0,0,0,${fade})`; ctx.fillRect(0, 0, W, H); }
  creditEl.style.opacity = now < creditUntil ? 1 : 0.3;
  requestAnimationFrame(frame);
}

// ---------- start ----------
document.getElementById("start").addEventListener("click", e => {
  e.currentTarget.remove();
  creditUntil = performance.now() + CREDIT_MS;
  startAudio().catch(err => { console.warn("Audio unavailable", err); ymui.say("Audio unavailable: " + err.message); });
  t0 = performance.now();
  requestAnimationFrame(frame);
});
