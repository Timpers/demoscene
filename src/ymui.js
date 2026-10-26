"use strict";

// Page glue for the YM player: drag and drop, a file picker, keyboard controls and a status line.
// Works with a YMAudio that may not exist yet (the page creates it after the first click), and holds
// on to a tune that is loaded before then.
//
// Keys: Space pause/play, M mute, L loop on/off, O open a file, Left/Right seek 5 s, Up/Down volume.

const _uiDeps = (typeof module !== "undefined" && module.exports && typeof require === "function")
  ? { parseYm: require("./ymfile.js").parseYm }
  : { parseYm };

class YMUI {
  // opts: status (element for the status line), onTune(song, name) called when a tune loads,
  //       onState(state, song) called on every position update (for sliders and meters)
  constructor(opts = {}) {
    this.status = opts.status || null;
    this.onTune = opts.onTune || null;
    this.onState = opts.onState || null;
    this.audio = null;
    this.song = null;
    this.name = "";
    this.message = "";
    this.input = null;
  }

  // Start listening for drops, keys and the file picker. Safe to call once, at page load.
  attach(win = window) {
    const doc = win.document;
    win.addEventListener("dragover", e => { e.preventDefault(); });
    win.addEventListener("drop", e => {
      e.preventDefault();
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) this.openFile(f);
    });
    this.input = doc.createElement("input");
    this.input.type = "file";
    this.input.accept = ".ym,.YM";
    this.input.style.display = "none";
    this.input.addEventListener("change", () => {
      if (this.input.files && this.input.files[0]) this.openFile(this.input.files[0]);
      this.input.value = "";
    });
    doc.body.appendChild(this.input);
    win.addEventListener("keydown", e => this.key(e));
    this.render();
  }

  // Hand over the audio engine once the page has made one (after a click)
  setAudio(audio) {
    this.audio = audio;
    audio.onposition = (st) => { this.render(); if (this.onState) this.onState(st, this.song); };
    audio.onended = () => { this.say("Finished"); };
    audio.onerror = (m) => { this.say("Audio error: " + m); };
    if (this.song) audio.load(this.song);
  }

  openPicker() { if (this.input) this.input.click(); }

  async openFile(file) {
    try {
      const song = _uiDeps.parseYm(new Uint8Array(await file.arrayBuffer()));
      this.loadSong(song, file.name);
    } catch (err) {
      this.say(`Could not open "${file.name}": ${err.message}`);
    }
  }

  loadSong(song, name = "") {
    this.song = song;
    this.name = name;
    this.message = "";
    if (this.audio) this.audio.load(song);
    if (this.onTune) this.onTune(song, name);
    this.render();
  }

  say(text) { this.message = text; this.render(); }

  key(e) {
    const t = e.target && e.target.tagName;
    if (t === "INPUT" || t === "TEXTAREA" || e.ctrlKey || e.metaKey || e.altKey) return;
    const a = this.audio;
    switch (e.key) {
      case "o": case "O": this.openPicker(); break;
      case " ": if (a) { a.toggle(); e.preventDefault(); } break;
      case "m": case "M": if (a) { a.setMuted(!a.muted); this.render(); } break;
      case "l": case "L": if (a) { a.setLoop(!a.loop); this.render(); } break;
      case "ArrowLeft": if (a && this.song) a.seek(a.state.frame - 5 * this.song.frameRate); break;
      case "ArrowRight": if (a && this.song) a.seek(a.state.frame + 5 * this.song.frameRate); break;
      case "ArrowUp": if (a) { a.setVolume(a.volume + 0.05); this.render(); } break;
      case "ArrowDown": if (a) { a.setVolume(a.volume - 0.05); this.render(); } break;
    }
  }

  static clock(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  // The status line text
  describe() {
    if (this.message) return this.message;
    const s = this.song;
    if (!s) return "Drop a .ym file here or press O to open one";
    const a = this.audio, st = a ? a.state : null;
    let line = "♪ " + (s.title || this.name || "(untitled)") + (s.author ? " — " + s.author : "");
    if (!a || !a.ready) return line + "   (click to start the sound)";
    const total = s.frames / s.frameRate;
    const played = st ? Math.min(st.frame, s.frames) / s.frameRate : 0;
    line += `   ${YMUI.clock(played)} / ${YMUI.clock(total)}`;
    if (st && !st.playing && !st.finished) line += "   [paused]";
    if (a.muted) line += "   [muted]";
    if (!a.loop) line += "   [no loop]";
    return line;
  }

  render() {
    if (this.status) this.status.textContent = this.describe();
  }
}

if (typeof module !== "undefined" && module.exports) module.exports = { YMUI };
