// Jarvis web UI: boots, pairs, connects and wires the conversation, panels and composer.

import { connect } from './net.js';
import { Voice } from './voice.js';
import { createOrb } from './neural/core.js';
import { presence } from './core/presence.js';
import { Workspace } from './workspace/workspace.js';
import { PointerWatch } from './core/pointer.js';
import { LiveWork } from './debrief/live.js';
import { HoloDeck } from './holo.js';
import { Timeline } from './timeline.js';
import { renderActivity, renderFiles, renderTeam, renderSessions, renderBriefings } from './panels.js';
import { el, copyText, duration, fmtBytes, persona } from './util.js';
import { initDeck } from './deck.js';
import { ScreenController } from './screen.js';
import { PerfGovernor } from './perf.js';
import { windows } from './holowin.js';
import { RecordingChips } from './recordings.js';
import { AgentDock } from './agents.js';
import { BrainSettings } from './brains.js';
import { ExecLayer } from './exec/layer.js';
import { Terminals } from './terminal.js';
// Development Mode (js/dev/): loaded on its first message, so it can never break the normal page
let dev = null; let devLoading = null;

const $ = (id) => document.getElementById(id);
const state = { tasks: new Map(), approvals: new Map(), files: [], team: [], status: {}, busy: false, attachments: [], unseenFiles: 0, panel: 'activity', schedules: { items: [], scheduler: {}, waiting: [] }, sessions: { sessions: null, matches: null, query: '' } };
const agents = new AgentDock({ send: (m) => send(m), toast: (t) => toast(t) });   // who answers the call (js/agents.js)
let brains = null;   // settings: Jarvis's brain and the shared skills (js/brains.js), created with the stage
let conn = null; let timeline = null; let toastTimer = 0; let voice = null; let callStarting = false;
let exec = null; let terminals = null;
let live = null; let deck = null; let recordings = null; let orb = null; let workspace = null; let holo = null; let screen = null; let perf = null; let wantCall = true; let micBlocked = false; let sheetOpen = false;
// A dropped connection does not end the call: the microphone and speakers stay ready and the call
// carries on when the socket is back (the server keeps its side for a while too, Hub.park_call).
const CALL_HOLD_MS = 3 * 60 * 1000;
let held = false; let holdTimer = 0; let releaseCallLock = null;

const COMMANDS = [
  ['/help', 'list commands'], ['/tasks', 'what is running'], ['/stop', 'emergency stop'], ['/cancel', 'cancel a task <id>'],
  ['/approve', 'approve the latest request'], ['/deny', 'deny the latest request'], ['/friday', '<project> :: <job>  (Claude Code)'],
  ['/edith', '<project> :: <job>  (Copilot)'], ['/veronica', '<project> :: <job>  (Codex)'], ['/karen', '<project> :: <job>  (Claude Code, Urdu)'], ['/team', 'who is free'], ['/agent', 'who answers: /agent friday | veronica | edith | karen | jarvis'],
  ['/files', 'shared files'], ['/status', 'spend and uptime'], ['/run', 'run a shell command'], ['/tool', 'call a tool with JSON'], ['/new', 'start a fresh session'], ['/clear', 'clear this screen'],
];

function toast(text) {
  const t = $('toast'); t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

// ---------------------------------------------------------------- pairing / boot
async function boot() {
  const hashCode = new URLSearchParams(location.hash.slice(1)).get('pair');
  let paired = (await (await fetch('/api/session')).json()).paired;
  if (!paired && hashCode) paired = await pairWith(hashCode, 'Browser');
  history.replaceState(null, '', location.pathname + location.search);   // drop the pairing code, keep ?fx= / ?orb= / ?perf=
  if (!paired) { showPair(); return; }
  startApp();
}
function showPair() {
  $('app').hidden = true; $('pair').hidden = false; $('pair-code').focus();
  $('pair-form').onsubmit = async (e) => {
    e.preventDefault();
    $('pair-error').textContent = '';
    if (await pairWith($('pair-code').value, $('pair-name').value || 'Browser')) { $('pair').hidden = true; startApp(); }
  };
}
async function pairWith(code, name) {
  const r = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name }) });
  if (r.ok) return true;
  const detail = (await r.json().catch(() => ({}))).detail || 'pairing failed';
  $('pair-error').textContent = detail; return false;
}

function startApp() {
  $('pair').hidden = true; $('app').hidden = false;
  document.body.dataset.mode = 'stage'; $('stage').hidden = false;
  timeline = new Timeline({ root: $('timeline'), scroller: $('scroller'), jump: $('jump'), onCancel: (id) => send({ type: 'cancel_task', task_id: id }) });
  wireUi();
  agents.mount($('agent-dock-stage')); agents.mount($('agent-dock-console'));
  agents.watch((now) => {   // the page names whoever is answering
    const name = persona(now).name;
    $('input').placeholder = `Message ${name}… (/ for commands)`;
    $('call').title = `Talk to ${name} (voice call)`;
    $('interrupt').title = `Interrupt ${name}`;
    toast(now === 'jarvis' ? 'Jarvis is back' : `${name} is in front`);
  });
  voice = new Voice({
    sendBinary: (buf) => conn && conn.sendBinary(buf), send,
    onState: setCallState, onCaption: (t) => { $('caption').textContent = t; },
    onError: (text, recoverable) => toast(recoverable ? `Voice hiccup: ${text}` : text),
  });
  orb = createOrb($('orb-canvas'), { micLevel: () => voice.micLevel, outLevel: () => voice.outLevel() });
  presence.watch((p) => { orb.setPersona(p); $('cx-present').textContent = p.name; });   // the AI in front colours the app and shapes the core
  workspace = new Workspace({ core: orb });   // before any panel opens: it forms, places and links them
  window.__jarvis = { presence, agents, orb: () => orb, workspace: () => workspace, live: () => live };   // for tests and diagnosis
  holo = new HoloDeck({ root: $('holo'), onToast: toast, onOpen: (f) => deck && deck.viewer.open(f) });
  recordings = new RecordingChips(toast);
  live = new LiveWork({ core: orb });   // agents at work: moons orbiting the core
  deck = initDeck({ state, send, toast, newSession: () => act.newSession(), removeFile: (f) => act.removeFile(f), showStage: () => { if (document.body.dataset.mode !== 'stage') showMode('stage'); } });
  wireStage();
  // the live work view (cards out of the core) and live terminals: js/exec/, js/terminal.js
  exec = new ExecLayer({ core: orb, send, toast, openFile: (f) => deck?.viewer.open(f) });
  terminals = new Terminals({ send, toast });
  $('rb-term').onclick = () => terminals.launch();
  $('rb-work').onclick = () => { const level = exec.cycleLevel(); $('rb-work').dataset.level = level; toast(`Live work view: ${level}`); };
  $('rb-work').dataset.level = exec.level;
  window.__jarvis.exec = () => exec; window.__jarvis.terminals = () => terminals;
  const pointer = new PointerWatch({ onPoint: () => screen?.report() });   // hovering = "this" for Jarvis
  screen = new ScreenController({ deck, workspace, pointer, send: (p) => !!conn && conn.send(p), showStage: () => { if (document.body.dataset.mode !== 'stage') showMode('stage'); } });
  perf = new PerfGovernor({ onTier: (tier) => { orb.setTier(tier); tierFps = tier === 'lite' ? 24 : tier === 'standard' ? 40 : 60; applyFps(); } });
  windows.onChange(() => {
    orb.setCovered(windows.all().some((w) => w.full && !w.minimised));
    applyFps();
    presence.claim('window', windows.top()?.persona || null);   // an agent's portal in front: her colour
  });
  conn = connect({ onMessage: onMessage, onState: onState, onBinary: (buf) => voice.push(buf) });
  setInterval(tick, 1000);
  if (new URLSearchParams(location.search).get('perf') === '1') import('./core/perfhud.js').then((m) => m.startPerfHud({ orb, perf }));
}

// The core's frame budget: the quality tier's, and at most 30 a second while live video plays in a
// panel (decoding video and drawing the core share the same small GPU).
const VIDEO_KINDS = new Set(['cameras', 'capture']);
let tierFps = 60;
function applyFps() {
  const video = windows.all().some((w) => !w.minimised && VIDEO_KINDS.has(w.kind));
  orb?.setMaxFps(video ? Math.min(tierFps, 30) : tierFps);
}

function devUi(m) {
  if (!dev && !devLoading && m.type === 'dev_state' && !m.dev?.active) return undefined;   // never on: nothing to load
  devLoading = devLoading || import('./dev/mode.js').then((mod) => {
    dev = new mod.DevUI({ send, toast, terminals });
    window.__jarvis.dev = () => dev;
    return dev;
  }).catch((err) => { devLoading = null; toast(`The Development Mode view could not load: ${err.message}`); return null; });
  return devLoading.then((ui) => ui?.handle(m));
}

function send(payload) {
  if (!conn || !conn.send(payload)) { toast('Not connected — retrying…'); return false; }
  return true;
}

function onState(s) {
  const box = $('conn'); box.className = 'conn'; $('s-conn').className = 'conn';
  $('s-conn-text').textContent = s === 'open' ? 'online' : s === 'connecting' ? 'connecting…' : 'reconnecting…';
  if (s === 'open') $('s-conn').classList.add('ok'); else if (s !== 'connecting') $('s-conn').classList.add('bad');
  renderStage();
  if (s === 'open') { box.classList.add('ok'); $('conn-text').textContent = 'connected'; }
  else if (s === 'unauthorized') { showPair(); }
  else if (s === 'closed' && voice && voice.active) { holdCall(); }
  else { if (s !== 'connecting') box.classList.add('bad'); $('conn-text').textContent = s === 'connecting' ? 'connecting…' : 'reconnecting…'; }
}

// ---------------------------------------------------------------- server messages
function onMessage(m) {
  switch (m.type) {
    case 'welcome': return onWelcome(m);
    case 'screen_cmd': return screen.handle(m);
    case 'status': return setStatus(m);
    case 'turn_started': state.busy = true; syncBusy(); return timeline.startTurn(m.turn_id, m.kind, m.voice, m.agent);
    case 'text_delta': return timeline.delta(m.turn_id, m.text);
    case 'tool_started': return timeline.toolStart(m.turn_id, m.call_id, m.name, m.args);
    case 'tool_finished': return timeline.toolFinish(m.turn_id, m);
    case 'model_switched': return timeline.notice(`↑ Jarvis escalated to ${m.model.replace('claude-', '')}: ${m.reason}`);
    case 'turn_done': state.busy = false; syncBusy(); return timeline.finishTurn(m.turn_id, m);
    case 'turn_failed': state.busy = false; syncBusy(); return timeline.failTurn(m.turn_id, m.message);
    case 'turn_interrupted': state.busy = false; syncBusy(); return timeline.interrupted(m.turn_id);
    case 'turn_queued': return timeline.notice(`Queued (${m.position} ahead).`);
    case 'task_update': return onTask(m.task);
    case 'agent_message': return timeline.agentMessage({ ...m });
    case 'approval_request': state.approvals.set(m.approval.id, m.approval); refreshActivity(); notifyApproval(m.approval); return;
    case 'approval_resolved': state.approvals.delete(m.id); refreshActivity(); return;
    case 'call_started': return onCallStarted();
    case 'call_ended': return endCallUi(m.reason);
    case 'announcement': return timeline.push({ kind: 'message', role: 'assistant', name: 'Jarvis', text: m.text, ts: m.ts });
    case 'voice_stop': timeline.voiceStopped(); return voice.handle(m);
    case 'voice_state': if (m.state === 'listening') deck.reports.keepAll(); return voice.handle(m);  // the owner is talking: nothing closes under them
    case 'voice_partial': case 'voice_final': case 'voice_error': return voice.handle(m);
    case 'tts_start': setSpeaker(m.speaker); if (m.turn_id && m.display) timeline.reveal(m.turn_id, m.display); return undefined;
    case 'tts_end': return undefined;
    case 'recording_update': return recordings?.update(m.recordings);
    case 'agents': brains?.setAgents(m); return agents.set(m);
    case 'brain': return brains?.set(m);
    case 'exec_start': return exec?.start(m);
    case 'exec_end': return exec?.end(m);
    case 'exec_action_result': return exec?.actionResult(m);
    case 'terminal_opened': return terminals?.open(m.terminal, ['friday', 'veronica', 'edith', 'karen'].includes(m.terminal.by) ? m.terminal.by : null);
    case 'terminal_focus': return terminals?.focus(m.id);
    case 'terminal_closed': return terminals?.gone(m.id);
    case 'dev_state': case 'dev_pane': case 'dev_layout': case 'dev_focus': case 'dev_refresh': case 'dev_event': case 'dev_diff': case 'dev_explain':
    case 'dev_explain_step': case 'qa_update': case 'browser_frame': case 'browser_cmd': return devUi(m);
    case 'team_update': state.team = m.team; return renderTeam($('panel-team'), state, act);
    case 'file_added': return onFile(m.file);
    case 'file_removed': return onFilesRemoved(m.ids);
    case 'briefing_request': return onBriefing(m.runs);
    case 'briefing_cleared': return clearBriefing(m.ids);
    case 'schedules': deck.handle(m); return refreshBadges();
    case 'session_reset': return onSessionReset(m);
    case 'user_message': return timeline.addUser(m.text, m.ts);
    case 'command_result': if (m.line.trim() === '/clear') return; return timeline.commandResult({ ...m });
    case 'notice': case 'error': return toast(m.text);
    default: return deck ? deck.handle(m) : undefined;
  }
}

function onWelcome(m) {
  recordings?.load();
  asked.clear(); renderBriefingPop();
  state.tasks = new Map(m.tasks.map((t) => [t.id, t])); live?.update(state.tasks);
  state.approvals = new Map(m.approvals.map((a) => [a.id, a]));
  state.files = m.files; state.team = m.team; state.busy = m.busy; state.device = m.device;
  agents.set(m.agents);
  brains?.setAgents(m.agents); if (m.brain) brains?.set(m.brain);
  terminals?.sync(m.terminals);
  if (window.jarvisBrowser) send({ type: 'browser_caps', native: true, snapshot_version: window.jarvisBrowser.version || 1 });   // the desktop app can drive a native browser
  if (m.dev?.active) devUi({ type: 'dev_state', dev: m.dev });
  deck.welcome(m);
  setStatus(m.status);
  timeline.setHistory(m.history);
  $('load-more').hidden = m.history.length < 60;
  refreshAll(); syncBusy(); ensureCall();
  screen.report();  // a fresh connection: tell Jarvis what this screen shows
}
function setStatus(s) {
  state.status = s;
  $('spend').textContent = `$${s.spent_usd.toFixed(4)} / $${s.budget_usd.toFixed(2)}`;
  if (deck) deck.hud.setSpend(s);
  if (typeof s.busy === 'boolean') { state.busy = s.busy; syncBusy(); }
}
function onTask(t) {
  const before = state.tasks.get(t.id);
  state.tasks.set(t.id, t);
  timeline.taskUpdate(t);
  live?.update(state.tasks);
  refreshActivity();
  if ((!before || before.status !== t.status) && ['done', 'failed', 'cancelled'].includes(t.status)) toast(`${t.name}: ${t.status} — ${t.title.slice(0, 50)}`);
}
function onFile(f) {
  state.files = [f, ...state.files.filter((x) => x.id !== f.id)];
  if (state.panel !== 'files') state.unseenFiles += 1;
  refreshFiles(); if (holo) { holo.receive(f); syncOrbLift(); }
  if (f.owner !== 'you') toast(`${f.owner === 'jarvis' ? 'Jarvis' : persona(f.owner).name} shared ${f.name}`);
}

function onFilesRemoved(ids) {
  const gone = new Set(ids);
  state.files = state.files.filter((f) => !gone.has(f.id));
  refreshFiles();
}
function onSessionReset(m) {
  timeline.clearView();
  timeline.push({ kind: 'session', number: m.number, reason: m.reason, ts: new Date().toISOString() });
  $('load-more').hidden = true;
  toast(`New session (${m.number}). Tasks and files carry over.`);
  loadSessions();
}
async function loadSessions() {
  try { state.sessions.sessions = (await (await fetch('/api/sessions')).json()).sessions; } catch { state.sessions.sessions = []; }
  if (state.panel === 'sessions') renderSessions($('panel-sessions'), state.sessions, act);
}

// ---------------------------------------------------------------- panels
const act = {
  removeFile: async (f) => { const r = await fetch(`/api/files/${f.id}`, { method: 'DELETE' }); if (!r.ok) toast('Could not remove that file'); },
  clearFiles: async () => {
    if (!confirm('Clear the file list? Files are only hidden, not deleted.')) return;
    const r = await fetch('/api/files/clear?kind=output', { method: 'POST' });
    toast(r.ok ? `Cleared ${(await r.json()).removed.length} files` : 'Could not clear files');
  },
  newSession: async () => {
    const r = await fetch('/api/sessions/new', { method: 'POST' });
    if (!r.ok) return toast('Could not start a new session');
    const d = await r.json();
    if (!d.started) toast(`Already fresh — ${d.note || 'nothing to summarise'}.`);
  },
  searchSessions: async (q) => {
    state.sessions.query = q; state.sessions.matches = null;
    if (q.length >= 2) {
      const r = await fetch(`/api/sessions/search?q=${encodeURIComponent(q)}`);
      if (r.ok) state.sessions.matches = (await r.json()).matches;
    }
    renderSessions($('panel-sessions'), state.sessions, act);
  },
  approve: (id, ok) => send({ type: 'approval', id, approve: ok }),
  cancel: (id) => send({ type: 'cancel_task', task_id: id }),
  toast, prefill: (text) => { showView('chat'); $('input').value = text; $('input').focus(); },
  preview: openPreview,
  loadBriefings: async () => {
    if (state.briefings === undefined) state.briefings = null;
    renderBriefings($('panel-briefings'), state.briefings, act);
    try { state.briefings = (await (await fetch('/api/reports?limit=80')).json()).reports; } catch { state.briefings = []; }
    renderBriefings($('panel-briefings'), state.briefings, act);
  },
  playReport: (id, thread) => { if (send({ type: 'report_play', id, thread })) { showMode('stage'); toast(thread ? 'Playing the whole story' : 'Playing it on the stage'); } },
  openReport: async (id) => { showMode('stage'); try { await deck.reports.open(id); } catch (err) { toast(String(err.message || err)); } },
};
function refreshActivity() {
  renderActivity($('panel-activity'), state, act);
  tick();
  const attention = state.approvals.size; const running = [...state.tasks.values()].filter((t) => ['running', 'queued', 'waiting_approval'].includes(t.status)).length;
  for (const id of ['b-activity', 'm-activity']) { const b = $(id); b.hidden = !(attention || running); b.textContent = attention ? `${attention}!` : running; }
  renderApprovalPop(); renderStage(); if (deck) deck.refresh();
  document.title = attention ? `(${attention}) Jarvis` : 'Jarvis';
}
function refreshFiles() {
  renderFiles($('panel-files'), state, act);
  if (holo) { holo.set(state.files); syncOrbLift(); }
  const b = $('b-files'); b.hidden = !state.unseenFiles; b.textContent = state.unseenFiles;
  if (deck) deck.refresh();
}
// The orb rises to make room for the holograms.
function syncOrbLift() { if (orb) orb.lift(holo && holo.size > 0); }
function refreshAll() { refreshActivity(); refreshFiles(); renderTeam($('panel-team'), state, act); }
function showPanel(name) {
  state.panel = name;
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
  for (const n of ['activity', 'files', 'team', 'schedule', 'sessions', 'briefings']) $(`panel-${n}`).hidden = n !== name;
  if (name === 'briefings') act.loadBriefings();
  if (name === 'files') { state.unseenFiles = 0; refreshFiles(); }
  if (name === 'sessions') { renderSessions($('panel-sessions'), state.sessions, act); loadSessions(); }
}
function showView(view) {
  document.body.dataset.view = view;
  for (const b of document.querySelectorAll('.tabbar button')) b.toggleAttribute('aria-current', b.dataset.view === view);
  for (const b of document.querySelectorAll('.tabbar button')) if (b.dataset.view === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  if (view !== 'chat') showPanel(view);
}

// ---------------------------------------------------------------- modal / preview
function openModal(title, node, copy) {
  $('modal-title').textContent = title; $('modal-body').replaceChildren(node); $('modal').hidden = false;
  $('modal-copy').hidden = !copy; $('modal-copy').onclick = async () => toast((await copyText(copy)) ? 'Copied' : 'Could not copy');
}
async function openPreview(f) {
  if (f.mime.startsWith('image/')) {
    const blob = await (await fetch(`/api/files/${f.id}/download`)).blob();
    return openModal(f.name, el('img', { src: URL.createObjectURL(blob), alt: f.name }), null);
  }
  const r = await fetch(`/api/files/${f.id}/preview`);
  if (!r.ok) return toast('No preview for this file type — use Download.');
  const data = await r.json();
  openModal(f.name + (data.truncated ? ' (truncated)' : ''), el('pre', { text: data.text }), data.text);
}

// ---------------------------------------------------------------- composer
function syncBusy() { $('interrupt').hidden = !state.busy; }
function autosize() { const t = $('input'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, window.innerHeight * 0.4) + 'px'; }

async function submit() {
  const input = $('input'); const text = input.value.trim();
  if (!text && !state.attachments.length) return;
  if (text === '/clear') { timeline.clearView(); input.value = ''; autosize(); return; }
  if (state.attachments.some((a) => a.uploading)) return toast('Still uploading…');
  const ids = state.attachments.map((a) => a.id);
  const echo = text + state.attachments.map((a) => `\n📎 ${a.name}`).join('');
  if (!send({ type: 'user_message', text: text || '(see attached files)', attachments: ids })) return;
  if (!text.startsWith('/')) timeline.addUser(echo);
  input.value = ''; state.attachments = []; renderChips(); autosize(); hideHints();
}

function renderChips() {
  $('attachments').replaceChildren(...state.attachments.map((a, i) => el('span', { class: 'chip file' },
    `${a.uploading ? '⏳ ' : '📎 '}${a.name}`, a.size ? ` (${fmtBytes(a.size)})` : '',
    el('button', { type: 'button', 'aria-label': 'Remove', text: ' ✕', onclick: () => { state.attachments.splice(i, 1); renderChips(); } }))));
}
async function upload(file) {
  const entry = { name: file.name, uploading: true }; state.attachments.push(entry); renderChips();
  const body = new FormData(); body.append('file', file);
  try {
    const r = await fetch('/api/uploads', { method: 'POST', body });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    Object.assign(entry, await r.json(), { uploading: false });
  } catch (err) { state.attachments.splice(state.attachments.indexOf(entry), 1); toast(`Upload failed: ${err.message}`); }
  renderChips();
}

function showHints() {
  const v = $('input').value; const box = $('hints');
  if (!v.startsWith('/') || /\s/.test(v)) return hideHints();
  const matches = COMMANDS.filter(([c]) => c.startsWith(v.toLowerCase()));
  if (!matches.length) return hideHints();
  box.replaceChildren(...matches.map(([c, d], i) => el('button', { type: 'button', class: i === 0 ? 'sel' : '', onclick: () => { $('input').value = c + ' '; $('input').focus(); hideHints(); } }, el('code', { text: c }), el('span', { text: d }))));
  box.hidden = false;
}
const hideHints = () => { $('hints').hidden = true; };

function wireUi() {
  const input = $('input');
  $('composer').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
    else if (e.key === 'Tab' && !$('hints').hidden) { e.preventDefault(); const first = $('hints').querySelector('code'); input.value = first.textContent + ' '; hideHints(); }
    else if (e.key === 'Escape') { hideHints(); $('modal').hidden = true; }
  });
  input.addEventListener('input', () => { autosize(); showHints(); });
  $('interrupt').onclick = () => send({ type: 'interrupt' });
  $('call').onclick = toggleCall;
  $('hangup').onclick = toggleCall;
  $('mute').onclick = () => setMuted(!voice.muted);
  $('voice-select').onchange = (e) => changeVoice(e.target.value);
  $('speed').oninput = (e) => changeSpeed(Number(e.target.value));
  $('voice-preview').onclick = () => previewVoice($('voice-select').value);
  $('stop-all').onclick = () => { if (confirm('Stop everything? This interrupts Jarvis, cancels every task and kills every process he started.')) send({ type: 'stop_all' }); };
  $('attach').onclick = () => $('file-input').click();
  $('file-input').onchange = (e) => { [...e.target.files].forEach(upload); e.target.value = ''; };
  input.addEventListener('paste', (e) => { const files = [...(e.clipboardData?.files || [])]; if (files.length) { e.preventDefault(); files.forEach(upload); } });
  const chat = $('tab-chat');
  chat.addEventListener('dragover', (e) => e.preventDefault());
  chat.addEventListener('drop', (e) => { e.preventDefault(); [...e.dataTransfer.files].forEach(upload); });
  $('load-more').onclick = async () => {
    const before = timeline.firstSeq; if (before == null) return;
    const r = await fetch(`/api/history?before=${before}&limit=60`); if (!r.ok) return;
    const { items } = await r.json(); if (items.length) timeline.prepend(items); else $('load-more').hidden = true;
    if (items.length < 60) $('load-more').hidden = true;
  };
  for (const b of document.querySelectorAll('.tabs button')) b.onclick = () => showPanel(b.dataset.tab);
  for (const b of document.querySelectorAll('.tabbar button')) b.onclick = () => showView(b.dataset.view);
  $('modal-close').onclick = () => { $('modal').hidden = true; }; $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) $('modal').hidden = true; });
  document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); showView('chat'); input.focus(); } });
  showView('chat'); showPanel('activity'); input.focus();
}

// ---------------------------------------------------------------- voice call
const CALL_TEXT = { idle: 'Listening…', listening: 'Hearing you…', thinking: 'Thinking…', speaking: 'Speaking… talk to interrupt' };
const STAGE_TEXT = { idle: 'Listening', listening: 'Hearing you', thinking: 'Thinking', speaking: 'Speaking' };
// Who is talking right now: an agent reading her report, or Jarvis (null).
let speaker = null;
function setSpeaker(key) {
  const next = key || null;
  if (next === speaker) return;
  speaker = next;
  document.body.dataset.speaker = next || '';
  presence.claim('voice', next);   // her colour while her voice plays; Jarvis again after a short pause
  renderStage();
}
function setCallState(st) { $('orb').dataset.state = st; $('call-state').textContent = CALL_TEXT[st] || st; if (st !== 'speaking') { speaker = null; document.body.dataset.speaker = ''; presence.claim('voice', null); } renderStage(); }

// The call starts by itself and comes back by itself (after a reload or a dropped connection),
// unless the owner ended it on purpose.
function ensureCall() {
  if (!conn || !conn.open) return;
  if (held && voice.active) { send({ type: 'call_start', manual: false }); return; }  // pick the call back up
  if (wantCall && !voice.active && !callStarting) startCall();
}
function holdCall() {
  if (held) return;
  held = true; voice.cutAudio(); $('call-state').textContent = 'Reconnecting…';
  clearTimeout(holdTimer);
  holdTimer = setTimeout(() => { held = false; endCallUi('Connection lost.'); }, CALL_HOLD_MS);
  renderStage();
}
// While a call is open, ask the browser not to freeze or discard this tab when it is in the
// background (a held Web Lock counts as activity); released when the call ends.
function lockCall() {
  if (releaseCallLock || !navigator.locks) return;
  navigator.locks.request('jarvis-call', () => new Promise((resolve) => { releaseCallLock = resolve; })).catch(() => {});
}
async function toggleCall() {
  if (voice.active || callStarting) { wantCall = false; send({ type: 'call_end' }); endCallUi(); return; }
  wantCall = true; micBlocked = false; startCall(true);
}
async function startCall(manual = false) {
  callStarting = true; $('call').disabled = true; renderStage();
  try { await voice.prepare(); } catch (err) {
    callStarting = false; $('call').disabled = false; micBlocked = true; renderStage();
    return toast(`Microphone unavailable: ${err.message || err.name}`);
  }
  if (!send({ type: 'call_start', manual })) { voice.stop(); callStarting = false; $('call').disabled = false; renderStage(); }
  return undefined;
}
async function onCallStarted() {
  if (held && voice.active) {  // the same call, back after a dropped connection
    held = false; clearTimeout(holdTimer); setCallState(voice.state); return;
  }
  callStarting = false; micBlocked = false; voice.start(); lockCall();
  $('call').disabled = false; $('call').classList.add('on'); $('call').textContent = '■ End call';
  $('callbar').hidden = false; $('mute').textContent = 'Mute'; setCallState('idle'); loadVoices();
  if (voice.suspended()) {                      // browser wants one tap before it lets us play sound
    const unlock = async () => { if (await voice.unlock()) { document.removeEventListener('pointerdown', unlock); document.removeEventListener('keydown', unlock); renderStage(); } };
    document.addEventListener('pointerdown', unlock); document.addEventListener('keydown', unlock);
  }
  renderStage();
}
function endCallUi(reason) {
  const wasActive = voice.active || callStarting; callStarting = false;
  held = false; clearTimeout(holdTimer); presence.clear('voice');
  if (releaseCallLock) { releaseCallLock(); releaseCallLock = null; }
  if (voice.active || voice.stream) voice.stop();
  $('call').disabled = false; $('call').classList.remove('on'); $('call').textContent = '🎙 Call';
  $('callbar').hidden = true;
  if (reason && wasActive) toast(reason);
  renderStage();
}
function setMuted(muted) {
  voice.setMuted(muted); $('mute').textContent = muted ? 'Unmute' : 'Mute';
  renderStage();
}
async function loadVoices() {
  const r = await fetch('/api/voice').catch(() => null);
  const data = r && r.ok ? await r.json() : null;
  if (!data) return;
  for (const [sel, speed, val] of [['voice-select', 'speed', 'speed-val'], ['s-voice', 's-speed', 's-speed-val']]) {
    $(speed).value = data.speed; $(val).textContent = `${Number(data.speed).toFixed(2)}×`;
    $(sel).replaceChildren(...data.voices.map((v) => el('option', { value: v.id, text: voiceLabel(v), selected: v.id === data.voice })));
  }
  renderAgentVoices(data);
}
const voiceLabel = (v) => `${v.name} · ${v.accent} ${v.gender === 'masculine' ? '♂' : v.gender === 'feminine' ? '♀' : ''}`;

// Each agent reads her own report in her own voice: pick the voice and pace, hear it before keeping it.
function renderAgentVoices(data) {
  const box = $('s-agents'); if (!box || !data.agents) return;
  const english = [...data.voices].sort((a, b) => (b.gender === 'feminine') - (a.gender === 'feminine') || a.name.localeCompare(b.name));
  box.replaceChildren(...Object.entries(data.agents).map(([key, a]) => {
    // an Urdu agent (Karen) has voices of her own: the server lists them with the agent
    const own = a.voices ? a.voices.map((v) => el('option', { value: v.id, text: v.name, selected: v.id === a.voice })) : null;
    const select = el('select', { 'aria-label': `${a.name}'s voice` }, own || english.map((v) => el('option', { value: v.id, text: voiceLabel(v), selected: v.id === a.voice })));
    const speed = el('input', { type: 'range', min: '0.8', max: '1.4', step: '0.05', value: String(a.speed || data.speed), 'aria-label': `${a.name}'s speed` });
    const out = el('output', { text: `${Number(a.speed || data.speed).toFixed(2)}×` });
    const hear = el('button', { type: 'button', class: 'pill', text: 'Hear it' });
    const row = el('div', { class: 'agent-row', style: `--agent:${persona(key).color}` }, [el('strong', { text: a.name }), select, hear, el('label', { class: 'speed' }, [el('span', { text: 'Pace' }), speed, out])]);
    select.onchange = async () => { const r = await postVoice({ agent: key, voice: select.value }); toast(r ? `${a.name} will read in this voice.` : 'Could not change the voice.'); };
    let timer = 0;
    speed.oninput = () => { out.textContent = `${Number(speed.value).toFixed(2)}×`; clearTimeout(timer); timer = setTimeout(() => postVoice({ agent: key, speed: Number(speed.value) }), 250); };
    hear.onclick = () => previewVoice(select.value, { agent: key, speed: Number(speed.value) });
    return row;
  }));
}
const postVoice = (body) => fetch('/api/voice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.ok).catch(() => false);

// ---------------------------------------------------------------- stage (the default screen)
function renderStage() {
  if (!orb) return;
  const online = conn && conn.open;
  const inCall = voice.active;
  let label; let mode = voice.state;
  if (!online) { label = held ? 'Reconnecting' : 'Connecting'; mode = 'offline'; }
  else if (micBlocked) { label = 'Microphone blocked'; mode = 'offline'; }
  else if (callStarting) { label = 'Connecting'; mode = 'idle'; }
  else if (!inCall) { label = 'Paused'; mode = 'offline'; }
  else if (voice.muted && voice.state === 'idle') label = 'Muted';
  else if (speaker && voice.state === 'speaking') label = `${persona(speaker).name} is speaking`;
  else label = STAGE_TEXT[voice.state] || 'Listening';
  orb.set(mode, voice.muted);
  $('s-state').textContent = label;
  const mute = $('s-mute'); mute.setAttribute('aria-pressed', String(voice.muted)); mute.querySelector('.lbl').textContent = voice.muted ? 'Unmute' : 'Mute';
  mute.disabled = !inCall;
  $('s-stop').disabled = !inCall || (voice.state !== 'speaking' && voice.state !== 'thinking');
  const call = $('s-call'); call.classList.toggle('resume', !inCall && !callStarting);
  call.querySelector('.lbl').textContent = inCall || callStarting ? 'End' : micBlocked ? 'Retry' : 'Resume'; call.title = inCall ? 'End the call' : 'Start the call';
  const running = [...state.tasks.values()].filter((t) => ['running', 'queued'].includes(t.status));
  const waiting = state.approvals.size;
  let hint = '';
  if (micBlocked) hint = 'Allow the microphone for this site, then tap Retry.';
  else if (inCall && voice.suspended()) hint = 'Tap anywhere to turn the sound on.';
  else if (waiting) hint = waiting === 1 ? 'One thing needs your approval.' : `${waiting} things need your approval.`;
  else if (running.length) { const who = [...new Set(running.map((t) => persona(t.owner).name))]; hint = `${who.join(' and ')} ${who.length > 1 ? 'are' : 'is'} working on it.`; }
  else if (voice.muted && inCall) hint = 'Your microphone is off.';
  $('s-hint').textContent = hint;
}

function showMode(mode) {
  document.body.dataset.mode = mode;
  if (mode === 'admin') { $('app').hidden = false; requestAnimationFrame(() => { $('scroller').scrollTop = $('scroller').scrollHeight; }); }
  else { setSheet(false); renderStage(); }
  screen?.report();
}
function setSheet(open) { sheetOpen = open; $('s-sheet').hidden = !open; $('s-settings').setAttribute('aria-expanded', String(open)); }

function wireStage() {
  brains = new BrainSettings({ brainBox: $('s-brains'), skillBox: $('s-skills'), toast: (t) => toast(t) });
  $('to-admin').onclick = () => showMode('admin');
  $('to-stage').onclick = () => showMode('stage');
  $('s-mute').onclick = () => setMuted(!voice.muted);
  $('s-stop').onclick = () => { voice.cutAudio(); send({ type: 'interrupt' }); };
  $('s-call').onclick = toggleCall;
  $('s-settings').onclick = () => { setSheet(!sheetOpen); if (sheetOpen) { loadVoices(); brains?.load(); } };
  $('s-newsession').onclick = () => { act.newSession(); setSheet(false); };
  $('holo-clear').onclick = () => act.clearFiles();
  $('s-stopall').onclick = () => { if (confirm('Stop everything? This interrupts Jarvis, cancels every task and kills every process he started.')) send({ type: 'stop_all' }); };
  $('s-voice').onchange = (e) => changeVoice(e.target.value);
  $('s-preview').onclick = () => previewVoice($('s-voice').value);
  $('s-speed').oninput = (e) => changeSpeed(Number(e.target.value));
  let saved = 1; try { saved = Number(localStorage.getItem('jarvis.volume') ?? 1); } catch { /* storage unavailable */ }
  voice.volume = Number.isFinite(saved) ? saved : 1; $('s-volume').value = String(voice.volume);
  $('s-volume').oninput = (e) => { const v = Number(e.target.value); voice.setVolume(v); try { localStorage.setItem('jarvis.volume', String(v)); } catch { /* ignore */ } };
  document.addEventListener('keydown', (e) => {
    if (document.body.dataset.mode !== 'stage' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
    if (e.key.toLowerCase() === 'm' && voice.active) setMuted(!voice.muted);
    else if (e.key === 'Escape') { if (sheetOpen) setSheet(false); else if (!$('s-stop').disabled) $('s-stop').click(); }
  });
  document.addEventListener('pointerdown', () => { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {}); }, { once: true });
  renderStage();
}

async function changeVoice(voiceId) {
  const r = await fetch('/api/voice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voice: voiceId }) });
  toast(r.ok ? 'Voice changed from his next sentence.' : 'Could not change the voice.');
  for (const id of ['voice-select', 's-voice']) $(id).value = voiceId;
}
let speedTimer = 0;
function changeSpeed(value) {
  for (const [r, v] of [['speed', 'speed-val'], ['s-speed', 's-speed-val']]) { $(r).value = String(value); $(v).textContent = `${value.toFixed(2)}×`; }
  clearTimeout(speedTimer);
  speedTimer = setTimeout(() => fetch('/api/voice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ speed: value }) }), 250);
}
async function previewVoice(voiceId, extra = {}) {
  const r = await fetch('/api/voice/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voice: voiceId, ...extra }) });
  if (!r.ok) return toast('Preview failed.');
  new Audio(URL.createObjectURL(await r.blob())).play();
  return undefined;
}

// ---------------------------------------------------------------- scheduled briefings: "Jarvis wants to talk"
const asked = new Map();
function refreshBadges() {
  const n = (state.schedules.waiting || []).length; const b = $('b-sched'); if (b) { b.hidden = !n; b.textContent = String(n); }
}
function onBriefing(runs) {
  for (const r of runs) asked.set(r.id, r);
  renderBriefingPop();
  const top = runs.find((r) => r.priority === 'critical') || runs[0];
  chime(top.priority);
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification(`Jarvis: ${top.title}`, { body: top.preview || 'Jarvis wants to talk.', tag: 'briefing', requireInteraction: true }); } catch { /* not allowed here */ }
  }
}
function clearBriefing(ids) { for (const id of ids) asked.delete(id); renderBriefingPop(); }
function renderBriefingPop() {
  const pop = $('briefing-pop'); const list = [...asked.values()];
  if (!list.length) { pop.hidden = true; pop.replaceChildren(); return; }
  const top = list.some((r) => r.priority === 'critical') ? 'critical' : list.some((r) => r.priority === 'high') ? 'high' : 'normal';
  pop.hidden = false; pop.dataset.priority = top;
  pop.replaceChildren(...[
    el('div', { class: 'bp-head' }, el('i', { class: 'bp-pulse' }), el('b', { text: 'JARVIS WANTS TO TALK' }), el('span', { class: `pri ${top}`, text: top })),
    ...list.slice(0, 3).map((r) => el('div', { class: 'bp-item' }, el('b', { text: r.title }), el('small', { text: r.failed ? 'Something went wrong' : r.preview || '' }))),
    list.length > 3 ? el('small', { class: 'bp-more', text: `+${list.length - 3} more` }) : null,
    el('div', { class: 'bp-btns' },
      el('button', { type: 'button', class: 'bp-later', text: 'Later', onclick: () => { asked.clear(); pop.hidden = true; } }),
      el('button', { type: 'button', class: 'bp-skip', text: 'Dismiss', onclick: () => send({ type: 'briefing_dismiss', ids: list.map((r) => r.id) }) }),
      el('button', { type: 'button', class: 'bp-yes', text: 'Talk now', onclick: acceptBriefing })),
  ].filter(Boolean));
}
async function acceptBriefing() {
  document.body.dataset.mode !== 'stage' && showMode('stage');
  if (voice.active) { send({ type: 'briefing_accept', text_only: false }); return; }
  wantCall = true; micBlocked = false;
  await startCall();                                   // the server briefs by voice the moment the call is up
  if (!voice.active && !callStarting) send({ type: 'briefing_accept', text_only: true });   // no microphone: show it instead
}
function chime(priority) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext; const ctx = new Ctx(); const g = ctx.createGain(); g.connect(ctx.destination);
    const notes = priority === 'critical' ? [880, 660, 880, 660] : [660, 880];
    notes.forEach((f, i) => { const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f; o.connect(g); g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.16); g.gain.exponentialRampToValueAtTime(0.07, ctx.currentTime + i * 0.16 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.16 + 0.14); o.start(ctx.currentTime + i * 0.16); o.stop(ctx.currentTime + i * 0.16 + 0.15); });
    setTimeout(() => ctx.close(), 1200);
  } catch { /* silent */ }
}

// ---------------------------------------------------------------- approvals: popup + notification
function describeApproval(a) {
  const text = String(a.what || '');
  if (a.tool === 'shell.run') return { what: 'Run a command', code: text };
  if (a.tool === 'fs.write' || a.tool === 'fs.edit') return { what: `Change ${text.split('/').pop() || 'a file'}`, code: text };
  return { what: `Use ${a.tool}`, code: text };
}
function renderApprovalPop() {
  const pop = $('approval-pop');
  const list = [...state.approvals.values()];
  if (!list.length) { pop.hidden = true; pop.replaceChildren(); return; }
  const a = list[0]; const d = describeApproval(a);
  pop.hidden = false;
  pop.replaceChildren(
    el('h4', {}, 'Jarvis needs your OK', el('span', { class: `tier${a.tier >= 3 ? ' high' : ''}`, text: a.tier >= 3 ? 'sensitive' : `tier ${a.tier}` })),
    el('div', { class: 'what', text: d.what }),
    d.code ? el('code', { text: d.code.slice(0, 600) }) : null,
    ...(a.reasons || []).slice(0, 1).map((r) => el('div', { class: 'why', text: r })),
    el('div', { class: 'meta' }, 'Say yes or no, or tap. Expires in ', el('span', { dataset: { expires: a.expires_at } }), list.length > 1 ? ` · ${list.length - 1} more waiting` : ''),
    el('div', { class: 'btns' },
      el('button', { type: 'button', class: 'no', text: 'Deny', onclick: () => act.approve(a.id, false) }),
      el('button', { type: 'button', class: 'yes', text: 'Approve', onclick: () => act.approve(a.id, true) })));
  tick();
}
function notifyApproval(a) {
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    const d = describeApproval(a);
    try { new Notification('Jarvis needs your OK', { body: d.what, tag: `approval-${a.id}`, requireInteraction: true }); } catch { /* not allowed here */ }
  }
}

function tick() {
  const now = Date.now();
  for (const n of document.querySelectorAll('.elapsed[data-start]')) n.textContent = duration((now - Number(n.dataset.start)) / 1000);
  for (const n of document.querySelectorAll('[data-expires]')) n.textContent = duration((new Date(n.dataset.expires) - now) / 1000);
}

boot();
