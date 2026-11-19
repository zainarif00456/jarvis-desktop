// Getting things from this device to Jarvis in one click: uploads (with progress), photos and
// clips from the device camera, and voice memos from the microphone.

import { el, fmtBytes } from './util.js';
import { HoloWindow, windows } from './holowin.js';

const CAP_ID = 'capture';
const MAX_MEMO_S = 600;
const pickMime = (list) => list.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
const extFor = (mime) => (mime.includes('mp4') ? 'mp4' : mime.includes('ogg') ? 'ogg' : mime.includes('webm') ? (mime.startsWith('audio') ? 'weba' : 'webm') : 'bin');
const canCamera = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

export class Capture {
  constructor({ toast, deviceName }) {
    this.toast = toast; this.deviceName = deviceName || (() => 'this device');
    this.transfers = new Map(); this.onTransfers = () => {}; this.onMemo = () => {};
    this.memo = null; this.memoTimer = 0; this.n = 0;
  }

  get label() {
    const ua = navigator.userAgent || '';
    const kind = /iPhone|Android.*Mobile/i.test(ua) ? 'phone' : /iPad|Tablet/i.test(ua) ? 'tablet' : 'computer';
    return `${this.deviceName()} ${kind} camera`;
  }

  // ---- upload with progress
  upload(file, { origin = 'upload', source = '' } = {}) {
    return new Promise((resolve) => {
      const id = ++this.n; const entry = { id, name: file.name || 'upload', size: file.size, done: 0 };
      this.transfers.set(id, entry); this.onTransfers();
      const body = new FormData();
      body.append('file', file, file.name || 'upload'); body.append('origin', origin); body.append('source', source);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/media/upload');
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) { entry.done = e.loaded / e.total; this.onTransfers(); } };
      const finish = (ok, data, why) => {
        entry.done = 1; entry.state = ok ? 'done' : 'failed'; this.onTransfers();
        setTimeout(() => { this.transfers.delete(id); this.onTransfers(); }, ok ? 1500 : 5000);
        if (ok) this.toast(`${data.name} saved — Jarvis can see it (${fmtBytes(data.size_kb * 1024)})`); else this.toast(`Upload failed: ${why}`);
        resolve(ok ? data : null);
      };
      xhr.onload = () => {
        let data = {}; try { data = JSON.parse(xhr.responseText); } catch { /* not json */ }
        if (xhr.status >= 200 && xhr.status < 300) finish(true, data); else finish(false, null, data.detail || `${xhr.status} ${xhr.statusText}`);
      };
      xhr.onerror = () => finish(false, null, 'network error');
      xhr.onabort = () => finish(false, null, 'cancelled');
      xhr.send(body);
    });
  }

  uploadFiles(files, opts) { return Promise.all([...files].map((f) => this.upload(f, opts))); }

  // ---- the device camera
  async photo() {
    if (!canCamera() || !window.isSecureContext) {
      // Over plain http (or no camera API) the phone's own camera app is the way in.
      this.toast(window.isSecureContext ? 'Opening the camera app…' : 'Live camera needs https — opening the camera app instead.');
      document.getElementById('rb-native-cam').click();
      return;
    }
    const existing = windows.get(CAP_ID); if (existing) { existing.restore(); existing.focus(); return; }
    this.openCamera();
  }

  async openCamera() {
    const win = new HoloWindow({ id: CAP_ID, kind: 'capture', title: 'CAMERA', width: 640, height: 560, minW: 320, minH: 360, onClose: () => this.stopCamera() });
    this.capWin = win; this.facing = 'environment'; this.recorder = null; this.recStart = 0;
    this.video = el('video', { class: 'cap-video', autoplay: true, muted: true, playsinline: true });
    this.video.muted = true;
    this.msg = el('div', { class: 'cap-msg' });
    this.flash = el('i', { class: 'cap-flash' });
    this.shutter = el('button', { type: 'button', class: 'cap-shutter', 'aria-label': 'Take photo', title: 'Take photo (Space)', onclick: () => this.shoot() }, el('i'));
    this.clipBtn = el('button', { type: 'button', class: 'cap-b', title: 'Record a video clip', onclick: () => this.toggleClip() }, '● Clip');
    this.flipBtn = el('button', { type: 'button', class: 'cap-b', title: 'Switch camera', onclick: () => this.flip() }, '⟲ Flip');
    this.timer = el('span', { class: 'cap-timer' });
    win.body.replaceChildren(el('div', { class: 'cap' }, el('div', { class: 'cap-view' }, this.video, this.flash, this.msg, el('i', { class: 'cap-reticle' })), el('div', { class: 'cap-bar' }, this.flipBtn, this.shutter, this.clipBtn, this.timer)));
    this.keys = (e) => { if (e.code === 'Space' && windows.top() === win && !['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(document.activeElement?.tagName)) { e.preventDefault(); this.shoot(); } };
    document.addEventListener('keydown', this.keys);
    await this.startStream();
  }

  async startStream() {
    this.stopTracks();
    this.msg.textContent = 'Starting the camera…'; this.msg.hidden = false;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: this.facing }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      this.video.srcObject = this.stream; await this.video.play().catch(() => {});
      this.msg.hidden = true;
    } catch (err) {
      const text = err.name === 'NotAllowedError' ? 'Camera access was blocked. Allow it for this site in the browser, then reopen this window.'
        : err.name === 'NotFoundError' ? 'No camera was found on this device.'
        : err.name === 'NotReadableError' ? 'Another app is using the camera.' : `Could not start the camera (${err.message || err.name}).`;
      this.msg.textContent = text; this.msg.hidden = false;
    }
  }
  stopTracks() { if (this.stream) { for (const t of this.stream.getTracks()) t.stop(); this.stream = null; } }
  stopCamera() {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.stopTracks(); document.removeEventListener('keydown', this.keys); this.capWin = null;
  }
  async flip() { this.facing = this.facing === 'environment' ? 'user' : 'environment'; await this.startStream(); }

  async shoot() {
    const v = this.video; if (!this.stream || !v.videoWidth) { this.toast('The camera is not ready yet.'); return; }
    const canvas = document.createElement('canvas'); canvas.width = v.videoWidth; canvas.height = v.videoHeight;
    canvas.getContext('2d').drawImage(v, 0, 0);
    this.flash.classList.remove('go'); void this.flash.offsetWidth; this.flash.classList.add('go'); this.click();
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
    if (!blob) { this.toast('Could not capture the picture.'); return; }
    await this.upload(new File([blob], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' }), { origin: 'device', source: this.label });
  }

  async toggleClip() {
    if (this.recorder && this.recorder.state === 'recording') { this.recorder.stop(); return; }
    if (!window.MediaRecorder || !this.stream) { this.toast('Recording is not supported here.'); return; }
    let stream = this.stream;
    try { const audio = await navigator.mediaDevices.getUserMedia({ audio: true }); stream = new MediaStream([...this.stream.getVideoTracks(), ...audio.getAudioTracks()]); } catch { /* clip without sound */ }
    const mime = pickMime(['video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']);
    const chunks = []; const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); this.recorder = rec;
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      clearInterval(this.clipTick); this.timer.textContent = ''; this.clipBtn.textContent = '● Clip'; this.clipBtn.classList.remove('on');
      for (const t of stream.getAudioTracks()) t.stop();
      const type = rec.mimeType || mime || 'video/webm'; const blob = new Blob(chunks, { type });
      if (blob.size) await this.upload(new File([blob], `clip-${Date.now()}.${extFor(type)}`, { type: type.split(';')[0] }), { origin: 'device', source: this.label });
    };
    rec.start(1000); this.recStart = Date.now(); this.clipBtn.textContent = '■ Stop'; this.clipBtn.classList.add('on');
    this.clipTick = setInterval(() => { const s = Math.floor((Date.now() - this.recStart) / 1000); this.timer.textContent = `REC ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }, 500);
  }

  click() { // a tiny shutter sound
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext; const ctx = new Ctx(); const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = 'square'; o.frequency.value = 1500; g.gain.setValueAtTime(0.06, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.07);
      o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.08); setTimeout(() => ctx.close(), 200);
    } catch { /* silent */ }
  }

  // ---- voice memo: tap to start, tap to stop and send
  async toggleMemo() {
    if (this.memo) { this.memo.stop(); return; }
    if (!canCamera() || !window.MediaRecorder) { this.toast('Recording needs a secure (https) connection.'); return; }
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (err) { this.toast(err.name === 'NotAllowedError' ? 'Microphone access was blocked.' : 'No microphone available.'); return; }
    const mime = pickMime(['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']);
    const chunks = []; const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); const started = Date.now();
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const stop = () => { if (rec.state !== 'inactive') rec.stop(); };
    this.memo = { stop }; this.onMemo(true, 0);
    this.memoTimer = setInterval(() => { const s = Math.floor((Date.now() - started) / 1000); this.onMemo(true, s); if (s >= MAX_MEMO_S) stop(); }, 500);
    rec.onstop = async () => {
      clearInterval(this.memoTimer); for (const t of stream.getTracks()) t.stop(); this.memo = null; this.onMemo(false, 0);
      const type = rec.mimeType || mime || 'audio/webm'; const blob = new Blob(chunks, { type });
      if (blob.size < 800) { this.toast('That was too short to keep.'); return; }
      await this.upload(new File([blob], `voice-memo-${Date.now()}.${extFor(type)}`, { type: type.split(';')[0] }), { origin: 'device', source: `${this.deviceName()} voice memo` });
    };
    rec.start(1000);
  }
}
