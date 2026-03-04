/**
 * DataGolf API helper
 * Docs: https://datagolf.com/api-access
 */
// Netlify Functions run on modern Node (18+). `fetch` is available globally.
// Using the global fetch avoids adding `node-fetch` as a dependency.
const fetch = globalThis.fetch;

if (typeof fetch !== "function") {
  throw new Error("Global fetch is not available in this runtime. Set Netlify Node version to 18+ (recommended 20/22)." );
}


function getDGKey() {
  const key = process.env.DATAGOLF_API_KEY || process.env.DATAGOLF_KEY;
  if (!key) throw new Error('Missing DATAGOLF_API_KEY env var');
  return key;
}

async function dgGet(url, params = {}) {
  const key = getDGKey();
  const u = new URL(url);
  // add params and key (DataGolf uses "key")
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  });
  u.searchParams.set('key', key);

  const resp = await fetch(u.toString(), { headers: { 'Accept': 'application/json' } });
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!resp.ok) {
    throw new Error(`DataGolf ${resp.status}: ${text.slice(0, 300)}`);
  }
  return json ?? text;
}

async function getSchedule({ tour = 'pga', season } = {}) {
  // schedule endpoint
  return dgGet('https://feeds.datagolf.com/get-schedule', { tour, season });
}

async function getPreTournament({ tour = 'pga', tourn_id } = {}) {
  // pre-tournament predictions (includes field + outrights / win odds)
  return dgGet('https://feeds.datagolf.com/preds/pre-tournament', { tour, tourn_id });
}

async function getInPlay({ tour = 'pga', tourn_id } = {}) {
  // in-play predictions (often includes live score info + win probs)
  return dgGet('https://feeds.datagolf.com/preds/in-play', { tour, tourn_id });
}

module.exports = { getDGKey, dgGet, getSchedule, getPreTournament, getInPlay };
