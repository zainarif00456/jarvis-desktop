// Side panels: activity (approvals + tasks), files, team.

import { el, persona, fmtTime, fmtFull, fmtBytes, ago, duration, copyText, shareFile } from './util.js';

const ACTIVE = new Set(['running', 'queued', 'waiting_approval']);

export function renderActivity(root, state, act) {
  const approvals = [...state.approvals.values()];
  const tasks = [...state.tasks.values()];
  const running = tasks.filter((t) => ACTIVE.has(t.status)).sort((a, b) => a.started_at.localeCompare(b.started_at));
  const recent = tasks.filter((t) => !ACTIVE.has(t.status)).sort((a, b) => (b.finished_at || '').localeCompare(a.finished_at || '')).slice(0, 10);
  root.replaceChildren();
  if (approvals.length) {
    root.append(el('h3', { text: `Needs you (${approvals.length})` }));
    for (const a of approvals) root.append(approvalNode(a, act));
  }
  root.append(el('h3', { text: `Running (${running.length})` }));
  if (!running.length) root.append(el('div', { class: 'empty', text: 'Nothing running.' }));
  for (const t of running) root.append(taskNode(t, act, true));
  root.append(el('h3', { text: 'Recent' }));
  if (!recent.length) root.append(el('div', { class: 'empty', text: 'Nothing finished yet.' }));
  for (const t of recent) root.append(taskNode(t, act, false));
}

function approvalNode(a, act) {
  const left = el('span', { class: 'when', dataset: { expires: a.expires_at } });
  return el('div', { class: 'item attention' },
    el('div', { class: 't', text: `${a.tool}  (tier ${a.tier})` }),
    el('div', { class: 's', text: a.what || '' }),
    ...(a.reasons || []).slice(0, 2).map((r) => el('div', { class: 's', text: r })),
    el('div', { class: 's' }, 'expires in ', left),
    el('div', { class: 'btns' },
      el('button', { class: 'btn primary', type: 'button', text: 'Approve', onclick: () => act.approve(a.id, true) }),
      el('button', { class: 'btn danger', type: 'button', text: 'Deny', onclick: () => act.approve(a.id, false) })));
}

function taskNode(t, act, live) {
  const who = persona(t.owner);
  const sub = live
    ? el('div', { class: 's' }, `since ${fmtTime(t.started_at)} · `, el('span', { class: 'elapsed', dataset: { start: new Date(t.started_at).getTime() } }), t.progress ? ` · ${t.progress}` : '')
    : el('div', { class: 's', title: t.finished_at ? fmtFull(t.finished_at) : '', text: `${t.status} ${t.finished_at ? ago(t.finished_at) : ''} · took ${duration(t.elapsed_s)}` });
  return el('div', { class: 'item', style: `--c:${who.color}` },
    el('div', { class: 't' }, el('span', { style: `color:${who.color}`, text: who.name + '  ' }), t.title),
    sub,
    t.summary || t.error ? el('div', { class: 's', text: (t.error || t.summary).slice(0, 220) }) : null,
    live ? el('div', { class: 'btns' }, el('button', { class: 'mini', type: 'button', text: 'Cancel', onclick: () => act.cancel(t.id) })) : null);
}

export function renderFiles(root, state, act) {
  root.replaceChildren();
  root.append(el('div', { class: 'h3row' },
    el('h3', { text: 'Shared with you' }),
    state.files.length ? el('button', { class: 'mini', type: 'button', text: 'Clear all', title: 'Hide every file from this list (nothing is deleted)', onclick: () => act.clearFiles() }) : null));
  if (!state.files.length) root.append(el('div', { class: 'empty', text: 'Files that Jarvis and the team create for you appear here.' }));
  for (const f of state.files) {
    const who = persona(f.owner);
    const url = `/api/files/${f.id}/download`;
    root.append(el('div', { class: 'item', style: `--c:${who.color}` },
      el('div', { class: 't', text: f.name }),
      el('div', { class: 's', title: fmtFull(f.created_at), text: `${who.name} · ${fmtBytes(f.size)} · ${fmtTime(f.created_at)}${f.description ? ' · ' + f.description : ''}` }),
      el('div', { class: 'btns' },
        el('button', { class: 'mini', type: 'button', text: 'Open', onclick: () => act.preview(f) }),
        el('a', { class: 'mini', href: url, download: f.name, text: 'Download', style: 'text-decoration:none' }),
        isText(f) ? el('button', { class: 'mini', type: 'button', text: 'Copy', onclick: async (e) => { const r = await fetch(`/api/files/${f.id}/preview`); const ok = r.ok && await copyText((await r.json()).text); act.toast(ok ? `Copied ${f.name}` : 'Could not copy'); } }) : null,
        el('button', { class: 'mini', type: 'button', text: 'Remove', title: 'Hide from this list', onclick: () => act.removeFile(f) }),
        navigator.share ? el('button', { class: 'mini', type: 'button', text: 'Share', onclick: async () => { if (!(await shareFile(url, f.name, f.mime))) act.toast('Sharing is not available here'); } }) : null)));
  }
}
const isText = (f) => f.mime.startsWith('text/') || ['application/json', 'application/xml', 'application/x-yaml', 'application/toml', 'application/javascript', 'application/x-sh'].includes(f.mime);

export function renderTeam(root, state, act) {
  root.replaceChildren();
  root.append(el('h3', { text: 'Your team' }));
  for (const m of state.team) {
    const who = persona(m.key);
    root.append(el('div', { class: 'item', style: `--c:${who.color}` },
      el('div', { class: 't' }, el('span', { style: `color:${who.color}`, text: m.name }), `  ${m.checking ? '… checking' : m.busy ? '● busy' : m.available ? '○ ready' : '✕ not ready'}`),
      el('div', { class: 's', text: m.role }),
      !m.available ? el('div', { class: 's', style: 'color:var(--warn)', text: m.detail }) : null,
      el('div', { class: 'btns' }, el('button', { class: 'mini', type: 'button', text: `Ask ${m.name}…`, onclick: () => act.prefill(`${m.name}, `) }))));
  }
  root.append(el('div', { class: 'empty', text: 'Say “give this to Friday”, “ask Veronica to review it”, or use /friday, /edith, /veronica, /karen.' }));
}

const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'the beginning');

/** Sessions: start a new one, search everything ever said, and read the notes of earlier ones. */
export function renderSessions(root, data, act) {
  root.replaceChildren();
  const box = el('input', { type: 'search', class: 'find', placeholder: 'Search every session…', 'aria-label': 'Search every session', value: data.query || '' });
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter') act.searchSessions(box.value.trim()); });
  root.append(
    el('div', { class: 'h3row' }, el('h3', { text: 'Sessions' }),
      el('button', { class: 'mini', type: 'button', text: 'New session', title: 'Jarvis keeps notes; tasks and files stay', onclick: () => act.newSession() })),
    box);
  if (data.matches) {
    root.append(el('h3', { text: `Matches for “${data.query}” (${data.matches.length})` }));
    if (!data.matches.length) root.append(el('div', { class: 'empty', text: 'Nothing found.' }));
    for (const m of data.matches) {
      root.append(el('div', { class: 'item' },
        el('div', { class: 's', text: `Session ${m.session} · ${m.who} · ${when(m.ts)}` }),
        el('div', { class: 't', text: m.text })));
    }
    root.append(el('button', { class: 'mini', type: 'button', text: 'Back to sessions', onclick: () => act.searchSessions('') }));
    return;
  }
  if (!data.sessions) { root.append(el('div', { class: 'empty', text: 'Loading…' })); return; }
  for (const s of data.sessions) {
    root.append(el('div', { class: 'item' + (s.current ? ' attention' : '') },
      el('div', { class: 't', text: `Session ${s.number}${s.current ? ' · now' : ''}` }),
      el('div', { class: 's', text: `${when(s.started_at)}${s.ended_at ? ' → ' + when(s.ended_at) : ''} · ${s.owner_messages} message${s.owner_messages === 1 ? '' : 's'}${s.reason && s.reason !== 'first' ? ' · began: ' + s.reason : ''}` }),
      s.notes ? el('details', {}, el('summary', { text: 'Notes carried forward' }), el('pre', { class: 'notes', text: s.notes })) : null));
  }
}

// ---- briefings and debriefs: every one the agents handed over, to play again ----------------------
const KIND = { debrief: 'DEBRIEF', presentation: 'DECK', codebase: 'CODE', competitors: 'MARKET', explainer: 'EXPLAINER', news: 'NEWS' };
export function renderBriefings(root, list, act) {
  root.replaceChildren(el('div', { class: 'h3row' }, el('h3', { text: 'Briefings & debriefs' }),
    el('button', { class: 'mini', type: 'button', text: 'Refresh', onclick: () => act.loadBriefings() })));
  if (list === null) { root.append(el('div', { class: 'empty', text: 'Loading…' })); return; }
  if (!list.length) { root.append(el('div', { class: 'empty', text: 'Nothing yet. Agents hand back debriefs and briefings here.' })); return; }
  for (const r of list) {
    const who = persona(r.agent || 'friday');
    root.append(el('div', { class: `item brief k-${r.kind}`, style: `--c:${who.color}` },
      el('div', { class: 't' }, el('span', { class: 'bk-kind', text: KIND[r.kind] || 'REPORT' }), ' ', r.title),
      el('div', { class: 's', text: `${who.name} · ${ago(r.created_at)} · ${r.blocks} section${r.blocks === 1 ? '' : 's'}${r.parent_id ? ' · follow-up' : ''}` }),
      el('div', { class: 'btns' },
        el('button', { class: 'mini', type: 'button', text: '▶ Play', title: 'Play it on the stage (read aloud on a call)', onclick: () => act.playReport(r.id, false) }),
        r.parent_id || r.kind === 'debrief' ? el('button', { class: 'mini', type: 'button', text: 'Whole story', title: 'This and its follow-ups, oldest first', onclick: () => act.playReport(r.id, true) }) : null,
        el('button', { class: 'mini', type: 'button', text: 'Open', title: 'Look at it without narration', onclick: () => act.openReport(r.id) }))));
  }
}
