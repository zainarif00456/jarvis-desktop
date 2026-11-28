// The AI team in one place: name, colours and the shape each one gives the neural core.
//
// Everything that shows "who" reads from here: the theme (css/theme.css has the same colours as
// tokens, see `html[data-ai]`), the neural core's colour and signature, labels and badges.
// To add an agent: add an entry here and a matching `html[data-ai="<key>"]` block in theme.css.
//
// `signature` picks the core's shape while that AI is present (js/neural/shaders.js `shapeOf`):
//   0 = layered neural sphere (Jarvis), 1 = knotted heart (Friday),
//   2 = faceted lattice (EDITH), 3 = spiral arms (Veronica), 4 = rosette of petals (Karen).

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

const TEAM = {
  jarvis: { name: 'Jarvis', role: 'Your assistant', color: '#4cc9f0', color2: '#9be8ff', signature: 0, initial: 'J' },
  friday: { name: 'Friday', role: 'Claude Code', color: '#f59e0b', color2: '#ffd27a', signature: 1, initial: 'F' },
  edith: { name: 'EDITH', role: 'Copilot', color: '#3ee0a1', color2: '#a6f7d6', signature: 2, initial: 'E' },
  veronica: { name: 'Veronica', role: 'Codex', color: '#c084fc', color2: '#e6c8ff', signature: 3, initial: 'V' },
  karen: { name: 'Karen', role: 'Claude Code · Urdu', color: '#f472b6', color2: '#fbcfe8', signature: 4, initial: 'K' },
};
const YOU = { name: 'You', role: 'Owner', color: '#94a3b8', color2: '#cbd5e1', signature: 0, initial: 'Y' };

for (const [key, p] of Object.entries(TEAM)) Object.assign(p, { key, ai: true, rgb: rgb(p.color), rgb2: rgb(p.color2), css: `var(--${key})` });
Object.assign(YOU, { key: 'you', ai: false, rgb: rgb(YOU.color), rgb2: rgb(YOU.color2), css: 'var(--you)' });

export const AI_KEYS = Object.freeze(Object.keys(TEAM));
export const DEFAULT_AI = 'jarvis';

/** Any persona key (any case) -> its entry; unknown keys get a neutral entry with that name. */
export function personaOf(key) {
  const k = String(key || DEFAULT_AI).toLowerCase();
  if (TEAM[k]) return TEAM[k];
  if (k === 'you' || k === 'user') return YOU;
  return { key: k, name: String(key), role: '', color: '#4cc9f0', color2: '#9be8ff', css: 'var(--accent)', signature: 0, initial: String(key || '?')[0].toUpperCase(), ai: false, rgb: rgb('#4cc9f0'), rgb2: rgb('#9be8ff') };
}

/** Only real AI keys (for the theme / presence); anything else falls back to Jarvis. */
export const aiKey = (key) => (TEAM[String(key || '').toLowerCase()] ? String(key).toLowerCase() : DEFAULT_AI);
