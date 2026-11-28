// REST for the Development Mode panes (server: gateway/devapi.py). The device cookie authorises it.

export async function getJson(path, params = {}) {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const res = await fetch(`/api/dev/${path}${query.size ? `?${query}` : ''}`, { credentials: 'same-origin' });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch { /* not json */ }
    throw new Error(detail);
  }
  return res.json();
}

export const evidenceUrl = (run, shot) => `/api/dev/evidence/${encodeURIComponent(run)}/${encodeURIComponent(shot)}`;

/** Who did it, for colours: the agents keep their identity colours (theme.css). */
export const WHO = { friday: 'var(--friday)', veronica: 'var(--veronica)', edith: 'var(--edith)', karen: 'var(--karen)', jarvis: 'var(--jarvis)', owner: 'var(--you)' };
