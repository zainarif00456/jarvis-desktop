// The panel registry: every kind of view the deck can open, by name. Plug-and-play for new views.
//
// A view registers once (deck.js does it for the built-in ones):
//   panels.register('newscast', {
//     title: 'Live newscast',
//     open: async (args) => { ...create a HoloWindow with id/kind/persona/item...; return 'what was opened' },
//   });
// Jarvis's `screen_cmd {action: 'open', args: {what: 'newscast', ...}}` then opens it (js/screen.js),
// the workspace lays it out, forms it from the core and links it, and `screen_state` reports it.
// Server side, the `screen.show` tool must also list the new `what` (server/jarvis/tools/screen.py).
//
// A panel is any HoloWindow (js/holowin.js); give it a stable `id`, a `kind`, an `item` (what it
// shows) and, when it belongs to an agent, a `persona` (the app takes her colour while it is in front).

const kinds = new Map();

export const panels = {
  /** spec: { open(args) -> string | Promise<string>, title? } */
  register(kind, spec) {
    if (typeof spec?.open !== 'function') throw new Error(`panel ${kind}: open(args) is required`);
    kinds.set(kind, { kind, title: spec.title || kind, ...spec });
  },
  has: (kind) => kinds.has(kind),
  list: () => [...kinds.values()].map(({ kind, title }) => ({ kind, title })),
  /** Open a registered view; throws a plain sentence when it is unknown (sent back to Jarvis). */
  async open(kind, args = {}) {
    const spec = kinds.get(kind);
    if (!spec) throw new Error(`cannot open ${kind}`);
    return (await spec.open(args)) || '';
  },
};
