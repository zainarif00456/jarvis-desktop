// The main deck: ties the quick actions, the instrument panels, the file viewer, the camera wall
// and device capture together. main.js hands it server messages and shared state.

import { Capture } from './capture.js';
import { CameraDeck } from './cameras.js';
import { FileViewer } from './viewer.js';
import { Hud } from './hud.js';
import { ScheduleBoard, fmtLeft } from './schedules.js';
import { HoloWindow, windows } from './holowin.js';
import { ReportDeck } from './report.js';
import { panels } from './workspace/registry.js';

import { el } from './util.js';

const $ = (id) => document.getElementById(id);

export function initDeck({ state, send, toast, newSession, removeFile, showStage }) {
  const cameras = new CameraDeck({ toast, send });
  const capture = new Capture({ toast, deviceName: () => state.device || 'this device' });
  const reports = new ReportDeck({ toast, showStage });
  const hud = new Hud({ onOpenCamera: (id) => { showStage(); cameras.open([id], id); } });

  const viewer = new FileViewer({
    files: () => state.files,
    actions: {
      toast, remove: removeFile,
      ask: (file, agent, question) => {
        send({ type: 'user_message', text: `${agent}, take a look at the file ${file.name} (it is on my deck) and tell me: ${question}` });
        toast(`Asked ${agent} about ${file.name}`);
      },
    },
  });

  // ---- scheduled work: a window on the deck, the same board in the admin panel
  const board = () => new ScheduleBoard({ state: () => state.schedules, toast, onChange: () => {} });
  let schedWin = null; let schedBoard = null;
  const openSchedule = () => {
    showStage();
    if (schedWin && !schedWin.closed) { schedWin.restore(); schedWin.focus(); return; }
    schedWin = new HoloWindow({ id: 'schedules', kind: 'schedule', title: 'SCHEDULE', width: 860, height: 640, minW: 380, minH: 360, onClose: () => { schedBoard?.destroy(); schedBoard = null; schedWin = null; } });
    schedBoard = board(); schedWin.body.replaceChildren(el('div', { class: 'sb-wrap' }, schedBoard.render()));
  };
  $('rb-sched').onclick = openSchedule;
  const redrawSchedules = () => {
    if (schedBoard && !schedBoard.editing) schedBoard.render();
    adminBoard?.render?.();
    hud.schedule(state.schedules, openSchedule);
    const waiting = (state.schedules.waiting || []).length; const n = $('rb-sched-n'); n.hidden = !waiting; n.textContent = String(waiting);
  };
  let adminBoard = null;
  const mountAdmin = () => {
    const panel = $('panel-schedule'); if (!panel) return;
    adminBoard = new ScheduleBoard({ state: () => state.schedules, toast, compact: true, onChange: () => {} });
    panel.replaceChildren(adminBoard.render());
  };
  mountAdmin();

  // ---- the views Jarvis can open by name (screen_cmd open {what}); new views register the same way
  panels.register('file', {
    title: 'A file',
    open: (a) => {
      let file = viewer.list.find((f) => f.id === a.id);
      if (!file && a.file && a.file.id === a.id) { viewer.list.unshift(a.file); file = a.file; }  // just un-hidden: its notice may still be on the way
      if (!file) throw new Error('that file is not on the deck');
      viewer.open(file);
      if (a.full) windows.get(`file-${file.id}`)?.setMax(true);
      return file.name;
    },
  });
  panels.register('files', { title: 'All files', open: () => { viewer.open(); return ''; } });
  panels.register('cameras', { title: 'Cameras', open: (a) => { cameras.open(a.ids && a.ids.length ? a.ids : undefined, a.focus); return ''; } });
  panels.register('schedule', { title: 'Schedule', open: () => { openSchedule(); return ''; } });

  capture.onTransfers = () => hud.transfers(capture.transfers);
  capture.onMemo = (recording, seconds) => hud.memo(recording, seconds);

  // ---- the rail
  $('rb-upload').onclick = () => $('rb-file-input').click();
  $('rb-file-input').onchange = (e) => { capture.uploadFiles(e.target.files, { origin: 'upload' }); e.target.value = ''; };
  $('rb-snap').onclick = () => capture.photo();
  $('rb-native-cam').onchange = (e) => { capture.uploadFiles(e.target.files, { origin: 'device', source: capture.label }); e.target.value = ''; };
  $('rb-memo').onclick = () => capture.toggleMemo();
  $('rb-cams').onclick = () => { showStage(); cameras.open(); };
  $('rb-files').onclick = () => { showStage(); state.unseenFiles = 0; viewer.open(); hud.files(state.files.length, 0); };
  $('rb-new').onclick = () => newSession();

  // ---- drop files anywhere on the stage; paste pictures
  const stage = $('stage'); let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  stage.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth += 1; $('drop').hidden = false; } });
  stage.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) $('drop').hidden = true; });
  stage.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  stage.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return; e.preventDefault(); depth = 0; $('drop').hidden = true;
    capture.uploadFiles(e.dataTransfer.files, { origin: 'upload' });
  });
  document.addEventListener('paste', (e) => {
    if (document.body.dataset.mode !== 'stage' || ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
    const files = [...(e.clipboardData?.files || [])]; if (!files.length) return;
    e.preventDefault(); capture.uploadFiles(files, { origin: 'upload', source: 'pasted from clipboard' });
  });

  return {
    cameras, capture, hud, viewer, reports,
    /** Server messages the deck cares about. Returns true when it handled one. */
    handle(m) {
      switch (m.type) {
        case 'camera_open': showStage(); cameras.open(m.ids, m.focus); return true;
        case 'camera_close': cameras.close(); return true;
        case 'cameras': cameras.setCameras(m.cameras); hud.cameras(cameras.cameras); return true;
        case 'camera_status': cameras.applyStatus(m); hud.cameras(cameras.cameras); return true;
        case 'media_added': case 'media_changed': return true;
        case 'schedules': state.schedules = { items: m.items, scheduler: m.scheduler, waiting: m.waiting }; redrawSchedules(); return true;
        default: return false;
      }
    },
    welcome(m) {
      cameras.setCameras(m.cameras || []); hud.cameras(cameras.cameras);
      state.schedules = m.schedules || { items: [], scheduler: {}, waiting: [] }; redrawSchedules();
    },
    openSchedule,
    refresh() {
      hud.team(state.team, state.tasks); hud.tasks(state.tasks, state.approvals); hud.files(state.files.length, state.unseenFiles);
      viewer.sync();
    },
    windows,
  };
}
