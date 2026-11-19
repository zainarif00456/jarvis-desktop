// The camera wall: live hologram windows with a large screen, a strip (or grid) of every other
// camera, sound controls, snapshots, recording, and a form to add cameras.

import { el } from './util.js';
import { HoloWindow, windows } from './holowin.js';
import { LivePlayer } from './player.js';
import { CameraCards } from './cards.js';

const WALL_ID = 'cameras';
const ADD_ID = 'camera-add';
const MAX_LIVE_TILES = 8;         // more tiles than this fall back to refreshed stills
const RECORD_CHOICES = [[30, '30 s'], [60, '1 min'], [300, '5 min'], [900, '15 min'], [3600, '1 hour']];
const STATE_TEXT = { idle: 'STANDBY', starting: 'CONNECTING', reconnecting: 'RECONNECTING', live: 'LIVE', error: 'OFFLINE' };

const svgIcon = (d) => {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); svg.append(p); return svg;
};
const ICONS = {
  sound: 'M4 10v4h4l5 4V6L8 10zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11',
  mute: 'M4 10v4h4l5 4V6L8 10zM17 9l5 6M22 9l-5 6',
  snap: 'M4 8h3l2-3h6l2 3h3v11H4zM12 11.5a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4',
  rec: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10',
  stop: 'M7 7h10v10H7z',
  ask: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7M12 17h.01',
  full: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  focus: 'M3 5h18v10H3zM3 18h4M10 18h4M17 18h4',
  plus: 'M12 5v14M5 12h14',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  mic: 'M9 3h6v11H9zM5 11a7 7 0 0 0 14 0M12 18v3',
};
const btn = (cls, icon, label, onclick) => el('button', { type: 'button', class: `cw-b ${cls}`, 'aria-label': label, title: label, onclick }, svgIcon(ICONS[icon]), el('span', { class: 'cw-bl', text: label }));
const clockText = () => new Date().toLocaleTimeString([], { hour12: false });

export class MainView {
  constructor(deck, camera) {
    this.deck = deck; this.camera = camera; this.recStart = 0; this.raf = 0;
    this.nameEl = el('b', { class: 'cw-name', text: camera.name });
    this.stateEl = el('span', { class: 'cw-state', text: 'CONNECTING' });
    this.clockEl = el('span', { class: 'cw-clock', text: clockText() });
    this.recEl = el('span', { class: 'cw-rec', hidden: true }, el('i'), el('b', { text: 'REC' }), el('span', { class: 'cw-rect', text: '00:00' }));
    this.infoEl = el('span', { class: 'cw-info' });
    this.noteEl = el('span', { class: 'cw-note' });
    this.soundChip = el('button', { type: 'button', class: 'cw-chip', hidden: true, onclick: () => this.toggleMute() }, '🔊 Tap for sound');
    this.wave = el('div', { class: 'cw-wave', 'aria-hidden': 'true' }, ...Array.from({ length: 32 }, () => el('i')));
    this.meter = el('span', { class: 'cw-meter', 'aria-hidden': 'true' }, ...Array.from({ length: 12 }, () => el('i')));
    this.veilText = el('div', { class: 'cw-veil-t', text: 'Connecting…' });
    this.retryBtn = el('button', { type: 'button', class: 'cw-retry', text: 'Retry', hidden: true, onclick: () => this.player.retry() });
    this.veil = el('div', { class: 'cw-veil' }, el('i', { class: 'cw-spin' }), this.veilText, this.retryBtn);
    this.flash = el('i', { class: 'cw-flash' });
    this.box = el('div', { class: 'cw-media' });
    this.view = el('div', { class: 'cw-view', dataset: { state: 'starting' }, ondblclick: () => this.fullView() },
      this.box,
      el('div', { class: 'cw-hud' },
        el('div', { class: 'cw-tl' }, this.nameEl, this.stateEl, this.recEl),
        el('div', { class: 'cw-tr' }, this.clockEl),
        el('div', { class: 'cw-bl-hud' }, this.noteEl),
        el('div', { class: 'cw-br' }, this.infoEl, this.meter),
        el('i', { class: 'cw-reticle' })),
      this.wave, this.soundChip, this.veil, this.flash);
    this.view.classList.toggle('audio-only', camera.kind === 'mic');
    this.build();
    this.snapBtn.hidden = camera.kind === 'mic'; // a microphone has no picture
    this.player = new LivePlayer({ box: this.box, cameraId: camera.id, muted: true, onStatus: (s) => this.onStatus(s) });
    this.root = el('div', { class: 'cw-main' }, this.view, this.controls, this.askRow);
  }

  build() {
    this.muteBtn = btn('cw-mute', 'mute', 'Sound off', () => this.toggleMute());
    this.vol = el('input', { type: 'range', class: 'cw-vol', min: '0', max: '1', step: '0.05', value: '1', 'aria-label': 'Volume', oninput: (e) => this.player.setVolume(Number(e.target.value)) });
    this.snapBtn = btn('cw-snap', 'snap', 'Snapshot', () => this.snapshot());
    this.recSel = el('select', { class: 'cw-sel', 'aria-label': 'Recording length' }, ...RECORD_CHOICES.map(([s, t]) => el('option', { value: String(s), text: t })));
    this.recBtn = btn('cw-recb', 'rec', 'Record', () => this.toggleRecord(false));
    this.audioRecBtn = btn('cw-arec', 'mic', 'Record sound', () => this.toggleRecord(true));
    this.askBtn = btn('cw-ask', 'ask', 'Ask an agent', () => this.toggleAsk());
    this.fsBtn = btn('cw-fs', 'full', 'Full view', () => this.fullView());
    this.delBtn = btn('cw-del', 'trash', 'Remove camera', () => this.deck.removeCamera(this.camera));
    this.controls = el('div', { class: 'cw-ctrl' },
      el('div', { class: 'cw-grp' }, this.muteBtn, this.vol),
      el('div', { class: 'cw-grp' }, this.snapBtn, this.recSel, this.recBtn, this.audioRecBtn),
      el('div', { class: 'cw-grp' }, this.askBtn, this.fsBtn, this.delBtn));
    this.agentSel = el('select', { class: 'cw-sel', 'aria-label': 'Agent' }, el('option', { value: 'Friday', text: 'Friday' }), el('option', { value: 'Veronica', text: 'Veronica' }), el('option', { value: 'EDITH', text: 'EDITH' }));
    this.question = el('input', { class: 'cw-q', type: 'text', maxlength: '300', placeholder: 'What should they look for? e.g. is the door open?', 'aria-label': 'Question', onkeydown: (e) => { if (e.key === 'Enter') this.submitAsk(); } });
    this.askRow = el('div', { class: 'cw-askrow', hidden: true }, this.agentSel, this.question, el('button', { type: 'button', class: 'cw-b cw-send', onclick: () => this.submitAsk() }, 'Send'));
  }

  start() { this.player.start(); this.loop(); this.refresh(); }
  destroy() { cancelAnimationFrame(this.raf); this.player.destroy(); }

  onStatus(s) {
    const { state, detail } = s;
    this.view.dataset.state = state;
    this.stateEl.textContent = STATE_TEXT[state] || state.toUpperCase();
    this.veil.hidden = state === 'live';
    this.retryBtn.hidden = state !== 'error';
    this.veilText.textContent = state === 'error' ? `Offline — ${detail}` : state === 'reconnecting' ? `Reconnecting — ${detail || 'waiting for the camera'}` : 'Connecting…';
    this.noteEl.textContent = state === 'live' && this.player.mode === 'stills' ? 'Still-image mode (this browser cannot play live video)' : '';
    const hasSound = this.player.audio && this.player.mode === 'live';
    this.muteBtn.disabled = !hasSound; this.vol.disabled = !hasSound;
    this.muteBtn.title = hasSound ? (this.player.muted ? 'Sound on' : 'Sound off') : 'This camera has no sound';
    this.audioRecBtn.hidden = !hasSound && this.camera.kind !== 'mic';
    this.soundChip.hidden = !(hasSound && this.player.muted && state === 'live');
    if (state === 'live' && !hasSound && this.camera.kind !== 'mic') this.noteEl.textContent = this.noteEl.textContent || (detail || 'No sound on this feed');
  }

  refresh() {
    const cam = this.deck.byId(this.camera.id) || this.camera; this.camera = cam;
    const rec = !!cam.recording;
    if (rec && !this.recStart) this.recStart = Date.now();
    if (!rec) this.recStart = 0;
    this.recEl.hidden = !rec;
    this.recBtn.classList.toggle('on', rec);
    this.recBtn.replaceChildren(svgIcon(ICONS[rec ? 'stop' : 'rec']), el('span', { class: 'cw-bl', text: rec ? 'Stop' : 'Record' }));
    this.audioRecBtn.disabled = rec;
    this.recSel.disabled = rec;
    this.nameEl.textContent = cam.name;
  }

  loop() {
    const frame = () => {
      this.raf = requestAnimationFrame(frame);
      const now = performance.now();
      if (now - (this.last || 0) < 120) return; this.last = now;
      this.clockEl.textContent = clockText();
      if (this.recStart) { const s = Math.floor((Date.now() - this.recStart) / 1000); this.recEl.querySelector('.cw-rect').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }
      const p = this.player;
      const size = p.mode === 'stills' ? 'STILLS' : p.size;
      this.infoEl.textContent = [size, p.state === 'live' && p.mode === 'live' ? `${p.lagSeconds.toFixed(1)}s` : ''].filter(Boolean).join('  ·  ');
      const level = p.level(); const bars = this.meter.children;
      if (this.camera.kind === 'mic') { const w = this.wave.children; for (let i = 0; i < w.length; i += 1) w[i].style.setProperty('--h', `${Math.max(4, Math.min(100, level * 100 * (0.35 + 0.65 * Math.abs(Math.sin(now / 130 + i * 0.7)))))}%`); }
      for (let i = 0; i < bars.length; i += 1) bars[i].classList.toggle('on', level * bars.length > i + 0.2);
    };
    frame();
  }

  toggleMute() {
    const muted = !this.player.muted; this.player.setMuted(muted);
    this.muteBtn.replaceChildren(svgIcon(ICONS[muted ? 'mute' : 'sound']), el('span', { class: 'cw-bl', text: muted ? 'Sound on' : 'Sound off' }));
    this.muteBtn.classList.toggle('on', !muted);
    this.soundChip.hidden = !muted ? true : this.soundChip.hidden;
  }

  async snapshot() {
    this.snapBtn.disabled = true;
    try {
      const r = await fetch(`/api/cameras/${encodeURIComponent(this.camera.id)}/snapshot?save=true`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
      this.flash.classList.remove('go'); void this.flash.offsetWidth; this.flash.classList.add('go');
      this.deck.toast(`Saved to ${r.headers.get('X-Saved-To') || 'the library'}`);
    } catch (err) { this.deck.toast(`No picture: ${err.message}`); }
    this.snapBtn.disabled = false;
  }

  async toggleRecord(audioOnly) {
    const rec = !!this.camera.recording;
    const url = `/api/cameras/${encodeURIComponent(this.camera.id)}/record${rec ? '/stop' : ''}`;
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: rec ? undefined : JSON.stringify({ seconds: Number(this.recSel.value), audio_only: audioOnly }) });
    if (!r.ok) { this.deck.toast((await r.json().catch(() => ({}))).detail || 'Could not change the recording'); return; }
    this.deck.toast(rec ? 'Stopping — saving what was captured…' : `Recording ${audioOnly ? 'sound' : 'video'} (${this.recSel.selectedOptions[0].text})`);
    this.camera.recording = !rec; this.refresh();
  }

  toggleAsk() { this.askRow.hidden = !this.askRow.hidden; if (!this.askRow.hidden) this.question.focus(); }
  async submitAsk() {
    const q = this.question.value.trim(); if (!q) return;
    this.question.value = ''; this.askRow.hidden = true;
    await this.deck.askAboutCamera(this.camera, this.agentSel.value, q);
  }

  fullView() {
    const node = this.view;
    if (document.fullscreenElement === node) { document.exitFullscreen().catch(() => {}); return; }
    if (this.deck.cards?.cards.has(this.camera.id)) { this.deck.cards.toggleFull(this.camera.id); return; }
    (node.requestFullscreen ? node.requestFullscreen() : Promise.reject()).catch(() => this.deck.wall?.win.toggleFull());
  }
}

class Tile {
  constructor(deck, camera, live) {
    this.deck = deck; this.camera = camera; this.live = live; this.player = null;
    this.stateDot = el('i', { class: 'cw-dot' });
    this.label = el('span', { class: 'cw-tname', text: camera.name });
    this.sub = el('span', { class: 'cw-tsub' });
    this.box = el('div', { class: 'cw-media' });
    this.root = el('button', { type: 'button', class: 'cw-tile', 'aria-label': `Show ${camera.name} large`, dataset: { id: camera.id, state: 'idle' }, onclick: () => deck.focus(camera.id) },
      this.box, el('div', { class: 'cw-tcap' }, this.stateDot, this.label, this.sub), el('i', { class: 'cw-onmain', text: 'ON MAIN SCREEN' }));
  }
  start() {
    if (this.player || !this.live) { this.sub.textContent = this.live ? '' : 'tap to view'; return; }
    this.player = new LivePlayer({ box: this.box, cameraId: this.camera.id, muted: true, onStatus: (s) => { this.root.dataset.state = s.state; this.sub.textContent = s.state === 'live' ? '' : (STATE_TEXT[s.state] || ''); } });
    this.player.start();
  }
  pause() { if (this.player) { this.player.destroy(); this.player = null; this.root.dataset.state = 'idle'; } }
  refresh(camera) { this.camera = camera; this.label.textContent = camera.name; this.root.classList.toggle('rec', !!camera.recording); }
  destroy() { this.pause(); this.root.remove(); }
}

export class CameraDeck {
  constructor({ toast, send }) {
    this.toast = toast; this.send = send; this.cameras = []; this.wall = null; this.ffmpeg = true;
    this.cards = new CameraCards(this, MainView);   // desktop patch: every camera is its own card
  }

  byId(id) { return this.cameras.find((c) => c.id === id); }

  setCameras(list, ffmpegOk) {
    this.cameras = list || [];
    this.cards?.sync();
    if (ffmpegOk !== undefined) this.ffmpeg = ffmpegOk;
    const wall = this.wall;
    if (!wall || wall.win.closed) return;
    for (const id of [...wall.ids]) if (!this.byId(id)) { wall.ids.delete(id); wall.tiles.get(id)?.destroy(); wall.tiles.delete(id); }
    if (!wall.ids.size && this.cameras.length === 0) { this.renderWall(); return; }
    if (!wall.ids.has(wall.focus)) wall.focus = [...wall.ids][0] ?? null;
    if (wall.main && wall.main.camera.id !== wall.focus) { this.renderWall(); return; } // the one on the big screen was removed
    for (const cam of this.cameras) { wall.tiles.get(cam.id)?.refresh(cam); }
    if (wall.main && this.byId(wall.focus)) wall.main.refresh();
    if (!wall.main && wall.focus) this.renderWall();
  }

  applyStatus(m) {
    const cam = this.byId(m.id); if (cam) Object.assign(cam, { state: m.state, detail: m.detail, audio: m.audio, viewers: m.viewers });
  }

  // ---- the wall
  open(ids, focus) {
    if (!this.cameras.length) { this.detectThenOpen(ids, focus); return; }
    const want = (ids && ids.length ? ids : this.cameras.map((c) => c.id)).filter((id) => this.byId(id));
    if (!want.length) { this.toast('Those cameras are not set up.'); return; }
    for (const id of want) this.cards.open(id, id === focus);   // desktop patch: one card each, live side by side
  }

  /** Nothing is set up: detect what is plugged in or on the network, then open it. */
  async detectThenOpen(ids, focus) {
    this.toast('Looking for cameras…');
    try {
      const r = await fetch('/api/cameras/auto', { method: 'POST' });
      const data = r.ok ? await r.json() : null;
      if (data) this.setCameras(data.cameras);
      if (this.cameras.length) { this.open(ids, focus); return; }
      const waiting = data && data.needs_login.length;
      this.toast(waiting ? `Found a camera at ${data.needs_login[0].host}, but it needs a login — tell Jarvis the username and password.` : 'No camera found. Plug one in, or give Jarvis its address and login.');
    } catch { this.toast('Could not look for cameras.'); }
  }

  createWall() {
    const win = new HoloWindow({
      id: WALL_ID, kind: 'cameras', title: 'CAMERAS', width: 980, height: 620, minW: 420, minH: 320,
      onClose: () => this.teardownWall(),
    });
    this.wall = { win, ids: new Set(), focus: null, layout: 'focus', tiles: new Map(), main: null };
    this.wall.layoutBtn = btn('cw-lay', 'grid', 'Grid view', () => this.setLayout(this.wall.layout === 'grid' ? 'focus' : 'grid'));
    this.wall.allBtn = el('button', { type: 'button', class: 'cw-b', text: 'All cameras', onclick: () => { for (const c of this.cameras) this.wall.ids.add(c.id); this.renderWall(); } });
    this.wall.addBtn = btn('cw-addb', 'plus', 'Add camera', () => this.openAdd());
    win.setTags(el('span', { class: 'hw-tag', text: 'LIVE FEED' }));
    return this.wall;
  }

  teardownWall() {
    const wall = this.wall; if (!wall) return;
    wall.main?.destroy(); for (const t of wall.tiles.values()) t.destroy();
    this.wall = null;
  }

  setLayout(layout) {
    const wall = this.wall; if (!wall) return;
    wall.layout = layout; wall.root.dataset.layout = layout;
    if (wall.main) { if (layout === 'grid') wall.main.player.stop(); else wall.main.player.start(); }
    wall.layoutBtn.replaceChildren(svgIcon(ICONS[layout === 'grid' ? 'focus' : 'grid']), el('span', { class: 'cw-bl', text: layout === 'grid' ? 'Focus view' : 'Grid view' }));
    this.syncTiles();
  }

  focus(id) {
    const wall = this.wall; if (!wall || !wall.ids.has(id)) return;
    wall.focus = id; if (wall.layout === 'grid') this.setLayout('focus');
    this.renderWall();
  }

  renderWall() {
    const wall = this.wall; if (!wall) return;
    wall.main?.destroy(); wall.main = null;
    if (!wall.root) { wall.root = el('div', { class: 'cw', dataset: { layout: wall.layout } }); wall.win.body.replaceChildren(wall.root); }
    wall.root.replaceChildren();
    const cams = [...wall.ids].map((id) => this.byId(id)).filter(Boolean);
    if (!cams.length) {
      wall.root.append(el('div', { class: 'cw-empty' }, el('p', { text: this.ffmpeg ? 'No cameras yet.' : 'ffmpeg is not installed, so live video is unavailable.' }), wall.addBtn));
      return;
    }
    const focusCam = this.byId(wall.focus) || cams[0]; wall.focus = focusCam.id;
    wall.main = new MainView(this, focusCam);
    const strip = el('div', { class: 'cw-strip' });
    cams.forEach((cam, i) => {
      let tile = wall.tiles.get(cam.id);
      if (!tile) { tile = new Tile(this, cam, i < MAX_LIVE_TILES); wall.tiles.set(cam.id, tile); }
      tile.refresh(cam); strip.append(tile.root);
    });
    const bar = el('div', { class: 'cw-toolbar' }, wall.layoutBtn, wall.addBtn, this.cameras.length > cams.length ? wall.allBtn : null,
      el('span', { class: 'spacer' }), el('span', { class: 'cw-count', text: `${cams.length} of ${this.cameras.length} camera${this.cameras.length === 1 ? '' : 's'}` }));
    wall.root.append(bar, wall.main.root, strip);
    wall.main.start();
    this.syncTiles();
    wall.win.setTitle(cams.length > 1 ? `CAMERAS · ${focusCam.name.toUpperCase()}` : focusCam.name.toUpperCase());
  }

  /** The tile of the camera on the main screen is paused (it would decode the same picture twice). */
  syncTiles() {
    const wall = this.wall; if (!wall) return;
    const grid = wall.layout === 'grid';
    for (const [id, tile] of wall.tiles) {
      const onMain = !grid && id === wall.focus && !!wall.main;
      tile.root.classList.toggle('on-main', onMain);
      if (onMain) tile.pause(); else tile.start();
    }
  }

  // ---- ask an agent about a camera
  async askAboutCamera(camera, agent, question) {
    this.toast(`Taking a picture for ${agent}…`);
    const r = await fetch(`/api/cameras/${encodeURIComponent(camera.id)}/snapshot?save=true`).catch(() => null);
    if (!r || !r.ok) { this.toast('Could not get a picture to send.'); return; }
    this.send({ type: 'user_message', text: `${agent}, look at the picture I just took from the ${camera.name} camera and tell me: ${question}` });
  }

  async removeCamera(camera) {
    if (!confirm(`Remove ${camera.name}? Its saved photos and recordings are kept.`)) return;
    const r = await fetch(`/api/cameras/${encodeURIComponent(camera.id)}`, { method: 'DELETE' });
    this.toast(r.ok ? `${camera.name} removed` : 'Could not remove it');
  }

  close() { windows.get(WALL_ID)?.close(); this.cards.closeAll(); }

  // ---- adding cameras
  openAdd() {
    const existing = windows.get(ADD_ID); if (existing) { existing.restore(); existing.focus(); return; }
    const win = new HoloWindow({ id: ADD_ID, kind: 'form', title: 'ADD A CAMERA', width: 540, height: 640, minW: 360, minH: 420 });
    const field = (label, input, hint) => el('label', { class: 'af' }, el('span', { text: label }), input, hint ? el('small', { text: hint }) : null);
    const name = el('input', { type: 'text', maxlength: '60', placeholder: 'Garage', 'aria-label': 'Camera name' });
    const host = el('input', { type: 'text', placeholder: '192.168.1.40', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Camera address' });
    const user = el('input', { type: 'text', autocomplete: 'off', placeholder: 'admin', 'aria-label': 'Username' });
    const pass = el('input', { type: 'password', autocomplete: 'new-password', placeholder: '••••••••', 'aria-label': 'Password' });
    const path = el('input', { type: 'text', placeholder: '/Streaming/Channels/101', spellcheck: 'false', 'aria-label': 'Stream path' });
    const url = el('input', { type: 'text', placeholder: 'rtsp://user:pass@192.168.1.40:554/stream1', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Stream address' });
    const device = el('select', { 'aria-label': 'USB camera' });
    const anyway = el('input', { type: 'checkbox', id: 'af-anyway' });
    const status = el('div', { class: 'af-status', role: 'status' });
    const found = el('div', { class: 'af-found' });
    let tab = 'network';
    const tabs = el('div', { class: 'af-tabs', role: 'tablist' });
    const panes = {
      network: el('div', { class: 'af-pane' }, field('Camera address', host, 'On your own network. The right stream address is worked out for you.'), field('Username', user), field('Password', pass, 'Stored privately on this laptop, never shown again.'), field('Stream path (optional)', path)),
      address: el('div', { class: 'af-pane' }, field('Full stream address', url, 'rtsp://, rtsps://, http:// or https://')),
      usb: el('div', { class: 'af-pane' }, field('Camera on this laptop', device)),
      demo: el('div', { class: 'af-pane' }, el('p', { class: 'af-note', text: 'A built-in test camera with sound: handy for trying the live view, snapshots and recordings.' })),
    };
    const setTab = (t) => {
      tab = t;
      for (const [k, p] of Object.entries(panes)) p.hidden = k !== t;
      for (const b of tabs.children) b.setAttribute('aria-selected', String(b.dataset.tab === t));
      if (t === 'demo' && !name.value) name.value = 'Demo';
    };
    for (const [k, label] of [['network', 'Network'], ['address', 'Address'], ['usb', 'USB'], ['demo', 'Demo']]) tabs.append(el('button', { type: 'button', role: 'tab', dataset: { tab: k }, text: label, onclick: () => setTab(k) }));
    const scanBtn = el('button', { type: 'button', class: 'cw-b', text: 'Scan for cameras', onclick: async () => {
      scanBtn.disabled = true; found.replaceChildren(el('p', { class: 'af-note', text: 'Looking on this laptop and your network…' }));
      try {
        const r = await fetch('/api/cameras/discover', { method: 'POST' });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
        showFound(await r.json());
      } catch (err) { found.replaceChildren(el('p', { class: 'af-err', text: `Scan failed: ${err.message}` })); }
      scanBtn.disabled = false;
    } });
    const fillDevices = (list) => device.replaceChildren(...(list.length ? list.map((d) => el('option', { value: d.address.replace('v4l2:', ''), text: `${d.label} (${d.address.replace('v4l2:', '')})` })) : [el('option', { value: '', text: 'No USB camera found — press Scan' })]));
    fillDevices([]);
    const showFound = (d) => {
      const usb = d.this_machine.filter((f) => f.kind === 'usb'); fillDevices(usb);
      const rows = [];
      for (const f of d.this_machine) rows.push(el('button', { type: 'button', class: 'af-hit', disabled: f.added, onclick: () => { if (f.kind === 'usb') { setTab('usb'); device.value = f.address.replace('v4l2:', ''); name.value ||= f.label; } else { setTab('address'); url.value = f.address; name.value ||= f.label; } } }, el('b', { text: f.label }), el('small', { text: f.added ? 'already added' : `${f.kind === 'usb' ? 'USB camera' : 'microphone'} · ${f.address}` })));
      for (const f of d.network) rows.push(el('button', { type: 'button', class: 'af-hit', onclick: () => { setTab('network'); host.value = f.address; name.value ||= f.label; user.focus(); } }, el('b', { text: f.label }), el('small', { text: `network camera · ${f.address} · needs its login` })));
      found.replaceChildren(rows.length ? el('div', { class: 'af-list' }, ...rows) : el('p', { class: 'af-note', text: `Nothing found${d.networks.length ? ` on ${d.networks.join(', ')}` : ''}. If you know a camera's address, enter it above.` }));
    };
    const submit = el('button', { type: 'submit', class: 'cw-b cw-send', text: 'Connect' });
    const form = el('form', { class: 'af-form', autocomplete: 'off', onsubmit: async (e) => {
      e.preventDefault();
      const body = { name: name.value.trim(), save_anyway: anyway.checked };
      if (!body.name) { status.className = 'af-status err'; status.textContent = 'Give the camera a name.'; return; }
      if (tab === 'network') Object.assign(body, { host: host.value.trim(), username: user.value, password: pass.value, path: path.value.trim() });
      else if (tab === 'address') body.url = url.value.trim();
      else if (tab === 'usb') body.device = device.value;
      else body.url = 'demo:';
      submit.disabled = true; status.className = 'af-status busy';
      status.textContent = tab === 'network' ? 'Connecting… trying the usual stream addresses (this can take up to half a minute).' : 'Connecting…';
      try {
        const r = await fetch('/api/cameras', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.detail || r.statusText);
        pass.value = ''; status.className = 'af-status ok';
        status.textContent = `${data.name} is connected${data.resolution ? ` · ${data.resolution}` : ''}${data.audio ? ' · with sound' : ''}.`;
        this.toast(`${data.name} added`);
        setTimeout(() => { win.close(); this.open([data.id], data.id); }, 700);
      } catch (err) {
        status.className = 'af-status err'; status.textContent = err.message;
        anyway.parentElement.hidden = false;
      }
      submit.disabled = false;
    } },
      field('Name', name), tabs, panes.network, panes.address, panes.usb, panes.demo,
      el('label', { class: 'af-check', hidden: true }, anyway, ' Save it even though it did not connect (camera is switched off)'),
      status, el('div', { class: 'af-actions' }, scanBtn, el('span', { class: 'spacer' }), submit), found);
    win.body.replaceChildren(form); setTab('network'); name.focus();
  }
}
