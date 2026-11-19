'use strict';
// Config (plain JSON) + device token (OS keychain via Electron safeStorage, encrypted-file fallback).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULTS = {
  baseUrl: 'http://localhost:8000',
  configured: false,          // false until the first-run screen has been confirmed
  hotkey: 'CommandOrControl+Shift+M',
  alwaysOnTop: false,
  startOnLogin: false,
  closeToTray: true,
  notifications: true,
  overlay: true,              // hologram overlay over other apps (see docs/OVERLAY.md)
  overlayHotkey: 'CommandOrControl+Shift+H',   // hide / show the overlay instantly
  audioInput: 'auto',         // 'auto' = a non-Bluetooth mic | 'laptop' | 'system' | a device name (docs/AUDIO.md)
  audioOutput: 'auto',        // 'auto' = system default | 'laptop' | 'system' | a device name
};

function normalizeBaseUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Enter the server address.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const local = /^(localhost|127\.|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|[^/:]+\.local\b|100\.)/i.test(s);
    s = (local ? 'http://' : 'https://') + s;
  }
  const u = new URL(s);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Use http:// or https://');
  if (u.protocol === 'http:' && !isLocalHost(u.hostname)) {
    throw new Error('Plain http is only allowed for localhost, LAN and Tailscale addresses (the microphone needs a secure origin). Use https://');
  }
  return u.origin;   // scheme://host[:port], no path
}
function isLocalHost(h) {
  h = h.toLowerCase();
  return h === 'localhost' || h === '[::1]' || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.endsWith('.local') || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) || h.endsWith('.ts.net');
}

class Store {
  constructor(dir, safeStorage) {
    this.dir = dir; this.safe = safeStorage;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.cfgPath = path.join(dir, 'config.json');
    this.tokPath = path.join(dir, 'device-token.bin');
    this.cfg = { ...DEFAULTS };
    try { Object.assign(this.cfg, JSON.parse(fs.readFileSync(this.cfgPath, 'utf8'))); } catch { /* first run */ }
  }
  get(k) { return this.cfg[k]; }
  all() { return { ...this.cfg }; }
  set(patch) {
    Object.assign(this.cfg, patch);
    fs.writeFileSync(this.cfgPath, JSON.stringify(this.cfg, null, 2), { mode: 0o600 });
  }
  // The token is kept per Base URL so switching servers does not send one server's token to another.
  _load() { try { return JSON.parse(this._dec(fs.readFileSync(this.tokPath))); } catch { return {}; } }
  _save(obj) { fs.writeFileSync(this.tokPath, this._enc(JSON.stringify(obj)), { mode: 0o600 }); }
  getToken(baseUrl = this.cfg.baseUrl) { return this._load()[baseUrl] || null; }
  setToken(token, baseUrl = this.cfg.baseUrl) { const o = this._load(); o[baseUrl] = token; this._save(o); }
  clearToken(baseUrl = this.cfg.baseUrl) { const o = this._load(); delete o[baseUrl]; this._save(o); }
  hasToken(baseUrl) { return !!this.getToken(baseUrl); }

  /** 'keychain' = real OS store, 'file' = fallback (no usable keyring). */
  backend() {
    try {
      if (!this.safe.isEncryptionAvailable()) return 'file';  // (sync API: still supported)
      if (process.platform === 'linux' && this.safe.getSelectedStorageBackend?.() === 'basic_text') return 'file';
      return 'keychain';
    } catch { return 'file'; }
  }
  _enc(text) {
    if (this.backend() === 'keychain') return Buffer.concat([Buffer.from('K'), this.safe.encryptString(text)]);
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', this._fileKey(), iv);
    const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return Buffer.concat([Buffer.from('F'), iv, c.getAuthTag(), ct]);
  }
  _dec(buf) {
    if (buf[0] === 0x4b) return this.safe.decryptString(buf.subarray(1));
    const iv = buf.subarray(1, 13), tag = buf.subarray(13, 29), ct = buf.subarray(29);
    const d = crypto.createDecipheriv('aes-256-gcm', this._fileKey(), iv); d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  }
  // Fallback key: random, kept in a 0600 file next to the ciphertext (protects against casual reading/backup
  // leaks, not against another process of the same user; the OS keychain is the real protection).
  _fileKey() {
    const p = path.join(this.dir, 'device-token.key');
    try { return fs.readFileSync(p); } catch { const k = crypto.randomBytes(32); fs.writeFileSync(p, k, { mode: 0o600 }); return k; }
  }
}
module.exports = { Store, normalizeBaseUrl, isLocalHost, DEFAULTS };
