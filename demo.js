"use strict";

const W = 320, H = 200;
const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");
ctx.imageSmoothingEnabled = false;
const img = ctx.createImageData(W, H);
const px = new Uint32Array(img.data.buffer);

const PART_LEN = 20;
const SCROLL_TEXT =
  "      YO! PIXEL RIOT PROUDLY PRESENTS... A TINY INTRO IN 320X200 WITH NOT A SINGLE BYTE OF ASSETS...   " +
  "ALL CODE BY YOU-KNOW-WHO, MUSIC SYNTHESISED LIVE WITH SQUARE WAVES AND A LITTLE NOISE...   " +
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
    const centre = H / 2 + Math.sin(t * 1.4 + k * 0.45) * 70 + Math.sin(t * 0.7 + k * 0.2) * 20;
    const [cr, cg, cb] = hsl2rgb((k / bars + t * 0.05) % 1, 1, 0.55);
    for (let d = -12; d <= 12; d++) {
      const y = Math.round(centre) + d;
      if (y < 0 || y >= H) continue;
      const a = Math.cos((d / 12) * Math.PI / 2);
      const i = a * a;
      r[y] = r[y] * (1 - i) + (cr + 80 * i) * i;
      g[y] = g[y] * (1 - i) + (cg + 80 * i) * i;
      b[y] = b[y] * (1 - i) + (cb + 80 * i) * i;
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
  drawCube(W / 2, 112, 28, t * 0.9, t * 1.3, t * 0.5, t * 50);
}
function partB(t, dt) {
  drawPlasma(t);
  for (let i = 0; i < 4; i++) {
    const a = t * 1.5 + i * Math.PI / 2;
    drawCube(W / 2 + Math.cos(a) * 95, 95 + Math.sin(a) * 30, 14, t + i, t * 1.2, i, i * 90 + t * 40);
  }
  drawCube(W / 2, 95, 38, t * 0.8, t * 1.1, t * 0.4, t * 60);
}
function partC(t, dt) {
  drawTunnel(t);
  drawDotSphere(t, W / 2, 95, 65);
}
const PARTS = [partA, partB, partC];

// ---------- main loop ----------
let t0 = 0, last = 0;
function frame(now) {
  // the first rAF timestamp can precede t0, which made t negative
  const t = Math.max(0, (now - t0) / 1000), dt = Math.max(0, Math.min(0.05, t - last));
  last = t;
  const idx = Math.floor(t / PART_LEN) % PARTS.length;
  const local = t % PART_LEN;
  PARTS[idx](t, dt);
  drawScroller(t, H - 52, 12);

  // fade in/out between parts
  const fade = Math.max(1 - local / 0.7, (local - (PART_LEN - 0.7)) / 0.7, 0);
  if (fade > 0) { ctx.fillStyle = `rgba(0,0,0,${fade})`; ctx.fillRect(0, 0, W, H); }
  requestAnimationFrame(frame);
}

// ---------- chiptune ----------
let ac, master, echo, schedTimer;
const midi = n => 440 * 2 ** ((n - 69) / 12);
const PROG = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; // Am F C G
const LEAD = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [81, 0, 0, 79, 0, 76, 0, 0, 72, 0, 76, 0, 79, 0, 0, 0],
  [81, 0, 84, 0, 81, 0, 79, 0, 76, 0, 0, 72, 0, 74, 76, 0],
  [88, 0, 86, 0, 84, 0, 81, 0, 79, 0, 76, 0, 79, 81, 0, 0],
];
const BPM = 125, STEP = 60 / BPM / 4;
let nextTime = 0, step = 0, noiseBuf;

function tone(type, freq, time, dur, vol, send = 0) {
  const o = ac.createOscillator(), g = ac.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, time);
  g.gain.setValueAtTime(vol, time);
  g.gain.exponentialRampToValueAtTime(0.0008, time + dur);
  o.connect(g); g.connect(master);
  if (send) { const s = ac.createGain(); s.gain.value = send; g.connect(s); s.connect(echo); }
  o.start(time); o.stop(time + dur + 0.02);
}
function kick(time) {
  const o = ac.createOscillator(), g = ac.createGain();
  o.frequency.setValueAtTime(160, time);
  o.frequency.exponentialRampToValueAtTime(40, time + 0.14);
  g.gain.setValueAtTime(0.9, time);
  g.gain.exponentialRampToValueAtTime(0.001, time + 0.2);
  o.connect(g); g.connect(master); o.start(time); o.stop(time + 0.25);
}
function noise(time, dur, vol, freq, type) {
  const s = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
  s.buffer = noiseBuf; f.type = type; f.frequency.value = freq;
  g.gain.setValueAtTime(vol, time);
  g.gain.exponentialRampToValueAtTime(0.001, time + dur);
  s.connect(f); f.connect(g); g.connect(master); s.start(time); s.stop(time + dur + 0.02);
}

function scheduleStep(s, time) {
  const bar = Math.floor(s / 16) % 4, st = s % 16;
  const chord = PROG[bar];
  // arpeggio
  const arpIdx = [0, 1, 2, 1][st % 4];
  tone("square", midi(chord[arpIdx] + (st >= 8 ? 12 : 0)), time, STEP * 0.9, 0.07, 0.25);
  // bass
  if (st % 2 === 0) tone("triangle", midi(chord[0] - 24 + (st % 8 === 6 ? 12 : 0)), time, STEP * 1.8, 0.45);
  // drums
  if (st % 4 === 0) kick(time);
  if (st === 4 || st === 12) noise(time, 0.14, 0.35, 1800, "bandpass");
  if (st % 2 === 1) noise(time, 0.04, 0.12, 8000, "highpass");
  // lead, evolves with the song
  const section = Math.floor(s / 16) % 16;
  const pattern = LEAD[Math.min(3, Math.floor(section / 2)) ];
  const n = pattern[st];
  if (n) tone("square", midi(n), time, STEP * 2.5, 0.09, 0.4);
}

function scheduler() {
  while (nextTime < ac.currentTime + 0.15) {
    scheduleStep(step++, nextTime);
    nextTime += STEP;
  }
}

function startAudio() {
  ac = new (window.AudioContext || window.webkitAudioContext)();
  master = ac.createGain(); master.gain.value = 0.5; master.connect(ac.destination);
  echo = ac.createDelay(); echo.delayTime.value = STEP * 3;
  const fb = ac.createGain(); fb.gain.value = 0.35;
  echo.connect(fb); fb.connect(echo); echo.connect(master);
  noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  nextTime = ac.currentTime + 0.1;
  if (!ymui.song) schedTimer = setInterval(scheduler, 25);   // a tune dropped before the click replaces the synth
}

// ---------- YM tunes ----------
// A .ym file dropped on the page (or chosen with O) plays through the YM2149 emulator in place of the
// built-in synth. This is the Phase 5 hook. Phase 6 replaces the synth and ties the visuals to the music.
let ymAudio = null;
function silenceBuiltinMusic() {
  clearInterval(schedTimer);
  if (master) master.gain.setTargetAtTime(0, ac.currentTime, 0.05);
}
const ymui = new YMUI({ status: document.getElementById("ymstatus"), onTune: silenceBuiltinMusic });
ymui.attach();
async function startYmAudio() {
  ymAudio = new YMAudio(ac, { forceFallback: location.search.includes("fallback") });
  await ymAudio.init();
  ymui.setAudio(ymAudio);
}

// ---------- start ----------
document.getElementById("start").addEventListener("click", e => {
  e.currentTarget.remove();
  try { startAudio(); startYmAudio().catch(err => ymui.say("YM audio unavailable: " + err.message)); }
  catch (err) { console.warn("Audio unavailable", err); }
  t0 = performance.now();
  requestAnimationFrame(frame);
});
