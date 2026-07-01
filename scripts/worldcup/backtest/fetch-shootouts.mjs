// Best-effort fetch of a public penalty-shootout history (fail-soft).
// Source pinned in DATA_SOURCES.md (martj42/international_results shootouts.csv, CC0).
// The penalty layer degrades to "untested, prior retained" if this is unavailable.
export const SHOOTOUTS_URL =
  'https://raw.githubusercontent.com/martj42/international_results/master/shootouts.csv';

export async function fetchShootouts({ fetchImpl = fetch, url = SHOOTOUTS_URL } = {}) {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, rows: await res.text() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
