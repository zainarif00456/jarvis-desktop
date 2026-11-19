// Settings: which brain thinks for Jarvis (LLM or Claude Code), and the skills every Claude/Codex brain shares.
import { el } from './util.js';

const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const STATE = {
  ready: ['ready', 'ok'], warming: ['starting…', 'warn'], failed: ['failed', 'bad'], idle: ['asleep, wakes on the next turn', 'muted'], off: ['', 'muted'],
};
const FIXED = [['friday', 'Friday', 'Claude Code'], ['veronica', 'Veronica', 'Codex'], ['edith', 'EDITH', 'Copilot']];

export class BrainSettings {
  constructor({ brainBox, skillBox, toast }) {
    this.brainBox = brainBox; this.skillBox = skillBox; this.toast = toast;
    this.data = null; this.agents = []; this.skills = null; this.draft = null; this.busy = false;
  }

  /** From the welcome message and every `brain` message. */
  set(data) { this.data = data; if (!this.busy || data.jarvis.state !== 'warming') this.busy = data.jarvis.state === 'warming'; this.draft = null; this.render(); }
  setAgents(status) { this.agents = status?.agents || []; this.render(); }

  async load() {
    const [brain, skills] = await Promise.all([
      fetch('/api/brains').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch('/api/skillhub').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (brain) this.data = brain;
    if (skills) this.skills = skills;
    this.render(); this.renderSkills();
  }

  // ------------------------------------------------------------------------------ brains
  render() {
    const box = this.brainBox; if (!box || !this.data) return;
    const { jarvis, api, claude } = this.data;
    const draft = this.draft || { backend: jarvis.backend, model: jarvis.model || 'sonnet', effort: jarvis.effort || 'low' };
    const [label, tone] = STATE[jarvis.state] || ['', 'muted'];
    const backend = el('select', { 'aria-label': "Jarvis's brain" },
      el('option', { value: 'llm', text: 'LLM (API)', selected: draft.backend === 'llm' }),
      el('option', { value: 'claude_code', text: 'Claude Code (subscription)', selected: draft.backend === 'claude_code', disabled: claude && !claude.available }));
    const model = el('select', { 'aria-label': "Claude's model" }, ['sonnet', 'opus', 'haiku'].map((m) => el('option', { value: m, text: m[0].toUpperCase() + m.slice(1), selected: draft.model === m })));
    const effort = el('select', { 'aria-label': 'Thinking effort' }, ['low', 'medium', 'high'].map((m) => el('option', { value: m, text: `${m} effort`, selected: draft.effort === m })));
    const apply = el('button', { type: 'button', class: 'pill', text: this.busy ? 'Starting…' : 'Apply', disabled: this.busy });
    const sync = () => { const cli = backend.value === 'claude_code'; model.hidden = effort.hidden = !cli; };
    const changed = () => { this.draft = { backend: backend.value, model: model.value, effort: effort.value }; sync(); apply.disabled = this.busy || (this.draft.backend === jarvis.backend && (this.draft.backend === 'llm' || (this.draft.model === jarvis.model && this.draft.effort === jarvis.effort))); };
    backend.onchange = model.onchange = effort.onchange = changed;
    apply.onclick = () => this.apply({ backend: backend.value, model: model.value, effort: effort.value });
    sync(); apply.disabled = true;
    const status = el('div', { class: 'brain-status' },
      el('span', { class: `chip ${tone}`, text: `${jarvis.backend === 'claude_code' ? 'Claude' : 'LLM'}${label ? ` · ${label}` : ''}` }),
      jarvis.detail ? el('small', { class: 'hint', text: jarvis.detail }) : null,
      !claude?.available && claude ? el('small', { class: 'hint', text: `Claude: ${claude.detail}` }) : null);
    const apiLine = el('small', { class: 'hint', text: api ? `API ${api.allowed ? 'open' : 'closed'} · ${api.calls} call${api.calls === 1 ? '' : 's'} this run${api.blocked ? ` · ${api.blocked} blocked` : ''}${api.key ? '' : ' · no key'}` : '' });
    const fixed = FIXED.map(([key, name, cli]) => {
      const a = this.agents.find((x) => x.key === key);
      return el('div', { class: 'brain-fixed' }, el('strong', { text: name }), el('span', { text: `${cli}${a?.model ? ` · ${a.model}` : ''}` }), a ? el('small', { class: a.available ? 'ok' : 'bad', text: a.available ? (a.warm ? 'warm' : 'ready') : a.detail }) : null);
    });
    box.replaceChildren(
      el('div', { class: 'agent-row', style: '--agent:var(--accent)' }, el('strong', { text: 'Jarvis' }), backend, model, effort, apply, status, apiLine),
      el('p', { class: 'hint', text: 'Claude Code uses your subscription and never calls the API. If it fails you are told and Jarvis stays as he is: switch back here.' }),
      ...fixed);
  }

  async apply(body) {
    this.busy = true; this.render();
    const r = await post('/api/brains/jarvis', body).catch(() => null);
    if (!r || !r.ok) {
      this.busy = false;
      const detail = r ? (await r.json().catch(() => ({}))).detail : 'no connection';
      this.toast(detail || 'Could not change the brain.'); this.render(); return;
    }
    this.set(await r.json());
    this.toast(body.backend === 'claude_code' ? 'Starting Claude… Jarvis keeps answering until it is ready.' : 'Jarvis is back on the LLM.');
  }

  // ------------------------------------------------------------------------------ skills
  async refreshSkills(data) { this.skills = data; this.renderSkills(); }

  renderSkills() {
    const box = this.skillBox; if (!box) return;
    if (!this.skills) { box.replaceChildren(el('small', { class: 'hint', text: 'Loading…' })); return; }
    const input = el('input', { type: 'text', placeholder: 'owner/repo or a link to a skill', 'aria-label': 'Skill to install', maxlength: '300' });
    const install = el('button', { type: 'button', class: 'pill', text: 'Install' });
    install.onclick = () => this.install(input.value.trim(), false, input, install);
    input.onkeydown = (e) => { if (e.key === 'Enter') install.click(); };
    const rows = (this.skills.skills || []).map((s) => {
      const on = el('input', { type: 'checkbox', checked: s.enabled, 'aria-label': `${s.name} on` });
      const always = el('input', { type: 'checkbox', checked: s.always_on, disabled: !s.enabled, 'aria-label': `${s.name} always on` });
      on.onchange = () => this.toggle(s.name, { enabled: on.checked });
      always.onchange = () => this.toggle(s.name, { always_on: always.checked });
      const origin = s.source.startsWith('hub:') ? s.source.slice(4) : s.source.replace('claude-plugin:', 'plugin ').replace('claude-user', 'yours');
      return el('div', { class: `skill-row${s.enabled ? '' : ' off'}`, title: s.description },
        el('label', { class: 'sk-on' }, on, el('strong', { text: s.name })),
        el('small', { class: 'sk-src', text: origin + (s.hook_driven ? ' · uses hooks (not loaded)' : '') }),
        el('label', { class: 'sk-always', title: 'Its instructions apply to every turn' }, always, el('span', { text: 'always' })),
        s.flags.length ? el('small', { class: 'bad', text: `⚠ ${s.flags.length}`, title: s.flags.join('\n') }) : null,
        s.source.startsWith('hub:') ? el('button', { type: 'button', class: 'mini', text: 'Remove', onclick: () => this.remove(s.source.slice(4)) }) : null);
    });
    box.replaceChildren(
      el('p', { class: 'hint', text: this.skills.enabled ? 'Shared by Jarvis (on Claude), Friday and Veronica. Changes reach a running Claude a minute after you stop talking.' : 'The skill hub is switched off (JARVIS_SKILLHUB=false).' }),
      el('div', { class: 'skill-install' }, input, install),
      el('div', { class: 'skill-rows' }, rows.length ? rows : el('small', { class: 'hint', text: 'No skills found yet.' })));
  }

  async toggle(name, body) {
    const r = await post(`/api/skillhub/${encodeURIComponent(name)}`, body).catch(() => null);
    if (r?.ok) { this.skills = { ...this.skills, ...(await r.json()) }; this.renderSkills(); } else this.toast('Could not change that skill.');
  }

  async remove(name) {
    if (!confirm(`Remove ${name} and its skills?`)) return;
    const r = await post(`/api/skillhub/remove/${encodeURIComponent(name)}`, {}).catch(() => null);
    if (r?.ok) { this.skills = { ...this.skills, ...(await r.json()) }; this.renderSkills(); this.toast('Removed.'); } else this.toast('Could not remove it.');
  }

  async install(source, accept, input, button) {
    if (!source) return;
    button.disabled = true; button.textContent = 'Reading it…';
    const r = await post('/api/skillhub/install/fetch', { source, accept_flagged: accept }).catch(() => null);
    button.disabled = false; button.textContent = 'Install';
    if (!r) { this.toast('No connection.'); return; }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { this.toast(data.detail || 'Could not install that.'); return; }
    const report = data.report;
    if (report.installed) { this.skills = { ...this.skills, skills: data.skills }; this.renderSkills(); this.toast(`Installed ${report.skills.length} skill${report.skills.length === 1 ? '' : 's'} from ${report.name}.`); return; }
    const flags = [...report.repo_flags, ...report.skills.flatMap((s) => s.flags.map((f) => `${s.name}: ${f}`))];
    const what = report.skills.map((s) => `• ${s.name}: ${s.description}`).join('\n');
    if (confirm(`${report.name} has more than instructions:\n\n${flags.slice(0, 10).join('\n')}\n\nSkills:\n${what}\n\nInstall anyway? (hooks are never loaded)`)) this.install(source, true, input, button);
  }
}
