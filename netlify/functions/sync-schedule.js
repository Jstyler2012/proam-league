// netlify/functions/sync-schedule.js
//
// DataGolf schedule → Supabase weeks alignment
//
// GUARANTEES:
// - NEVER updates weeks.week_number (UI sacred)
// - NEVER changes a week's chosen event once weeks.tourn_id or weeks.org_id is set
//
// BEHAVIOR:
// - If a week row has tourn_id/org_id: refresh name + dates for THAT SAME DG event.
// - If missing IDs: choose DG event by similarity to existing weeks.tournament_name.
//   If ambiguous, skip (do not guess).
//
// Env vars (Netlify):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   DATAGOLF_API_KEY
// Optional protection:
//   ADMIN_PIN (or ADMIN_TOKEN or SYNC_PIN)
//
// Usage:
//   /.netlify/functions/sync-schedule?season=2026&pin=XXXX

const ADMIN_PIN = (process.env.ADMIN_PIN || process.env.ADMIN_TOKEN || process.env.SYNC_PIN || "").trim();
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const DATAGOLF_API_KEY = (process.env.DATAGOLF_API_KEY || "").trim();

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    },
    body: JSON.stringify(body),
  };
}

async function fetchJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { res, text, data };
}

async function sb(method, restPath, bodyObj, prefer) {
  const url = `${SUPABASE_URL}/rest/v1/${restPath}`;
  const headers = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    Prefer: prefer || "return=representation",
  };
  if (method !== "GET") headers["content-type"] = "application/json";

  const res = await fetch(url, { method, headers, body: bodyObj ? JSON.stringify(bodyObj) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase REST error (${res.status}) ${text || res.statusText}`);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function pickArray(json) {
  if (!json) return [];
  if (Array.isArray(json.schedule)) return json.schedule;
  if (Array.isArray(json.events)) return json.events;
  if (Array.isArray(json.tournaments)) return json.tournaments;
  if (Array.isArray(json.data)) return json.data;
  if (Array.isArray(json.results)) return json.results;
  if (Array.isArray(json)) return json;
  return [];
}

function norm(s) {
  return String(s || "").trim();
}
function normLower(s) {
  return norm(s).toLowerCase().replace(/\s+/g, " ");
}

// Simple similarity: shared tokens count
function tokenScore(a, b) {
  const ta = new Set(normLower(a).split(" ").filter(Boolean));
  const tb = new Set(normLower(b).split(" ").filter(Boolean));
  let score = 0;
  for (const t of ta) if (tb.has(t)) score++;
  return score;
}

function getEvIds(ev) {
  return {
    tourn_id: norm(ev?.tourn_id ?? ev?.tournament_id ?? ev?.event_id ?? ev?.id),
    org_id: norm(ev?.org_id ?? ev?.tour_event_id ?? ev?.pga_tourn_id),
  };
}

function getEvDates(ev) {
  const start = norm(ev?.start_date ?? ev?.start ?? ev?.startDate).slice(0, 10);
  const end = norm(ev?.end_date ?? ev?.end ?? ev?.endDate).slice(0, 10);
  return { start_date: start || null, end_date: end || null };
}

function getEvName(ev) {
  return norm(ev?.event_name ?? ev?.tournament_name ?? ev?.name);
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(204, { ok: true });

  try {
    if (!SUPABASE_URL) return json(500, { ok: false, error: "Missing SUPABASE_URL" });
    if (!SERVICE_KEY) return json(500, { ok: false, error: "Missing SUPABASE_SERVICE_ROLE_KEY" });
    if (!DATAGOLF_API_KEY) return json(500, { ok: false, error: "Missing DATAGOLF_API_KEY" });

    const q = event.queryStringParameters || {};
    const pin = norm(q.pin);
    if (ADMIN_PIN && pin !== ADMIN_PIN) return json(401, { ok: false, error: "Invalid pin" });

    const season = norm(q.season) || String(new Date().getFullYear());

    const dgUrl =
      `https://feeds.datagolf.com/get-schedule` +
      `?tour=pga&season=${encodeURIComponent(season)}&upcoming_only=no&file_format=json&key=${encodeURIComponent(DATAGOLF_API_KEY)}`;

    const dg = await fetchJson(dgUrl);
    if (!dg.res.ok) {
      return json(502, {
        ok: false,
        error: `DataGolf get-schedule failed (${dg.res.status})`,
        preview: (dg.text || "").slice(0, 700),
      });
    }

    const events = pickArray(dg.data);
    if (!events.length) {
      return json(400, {
        ok: false,
        error: "DataGolf schedule returned no events array.",
        preview: (dg.text || "").slice(0, 700),
      });
    }

    // Load your league weeks. week_number is sacred.
    const weeks = await sb(
      "GET",
      "weeks?select=id,week_number,label,tournament_name,start_date,end_date,tourn_id,org_id,season_year&order=week_number.asc"
    );

    // Index DG events by ID for locked updates
    const byTournId = new Map();
    const byOrgId = new Map();
    for (const ev of events) {
      const ids = getEvIds(ev);
      if (ids.tourn_id) byTournId.set(ids.tourn_id, ev);
      if (ids.org_id) byOrgId.set(ids.org_id, ev);
    }

    let updated_locked = 0;
    let filled_missing = 0;
    let skipped_ambiguous = 0;

    const ambiguous = [];
    const filled = [];
    const refreshed = [];

    for (const w of weeks || []) {
      const lockedTournId = norm(w.tourn_id);
      const lockedOrgId = norm(w.org_id);
      const nowIso = new Date().toISOString();

      // A) Locked: refresh only that same event
      if (lockedTournId || lockedOrgId) {
        const ev =
          (lockedTournId && byTournId.get(lockedTournId)) ||
          (lockedOrgId && byOrgId.get(lockedOrgId)) ||
          null;

        if (!ev) continue;

        const ids = getEvIds(ev);
        const dates = getEvDates(ev);
        const name = getEvName(ev);

        await sb(
          "PATCH",
          `weeks?id=eq.${w.id}`,
          {
            // DO NOT TOUCH week_number
            tourn_id: ids.tourn_id || w.tourn_id || null,
            org_id: ids.org_id || w.org_id || null,
            season_year: Number(season) || w.season_year || null,
            tournament_name: name || w.tournament_name || null,
            start_date: dates.start_date || w.start_date || null,
            end_date: dates.end_date || w.end_date || null,
            api_status: "datagolf",
            api_last_synced_at: nowIso,
          },
          "return=minimal"
        );

        updated_locked++;
        refreshed.push({ week_number: w.week_number, tourn_id: ids.tourn_id || null, org_id: ids.org_id || null, name });
        continue;
      }

      // B) Missing IDs: choose by matching your existing tournament_name (your chosen week name)
      const baseName = norm(w.tournament_name);
      if (!baseName) continue;

      // Score all DG events against your existing name
      const scored = events
        .map((ev) => {
          const name = getEvName(ev);
          const score = tokenScore(baseName, name);
          return { ev, name, score };
        })
        .filter((x) => x.score > 0) // ignore totally unrelated names
        .sort((a, b) => b.score - a.score);

      if (!scored.length) continue;

      const best = scored[0];
      const second = scored[1];

      // Ambiguity rule:
      // - If the top two scores are equal, we refuse to guess (two events week)
      // - If the best score is too weak, also skip (prevents bad matches)
      const MIN_SCORE = 2;
      if (best.score < MIN_SCORE || (second && second.score === best.score)) {
        skipped_ambiguous++;
        ambiguous.push({
          week_number: w.week_number,
          week_name: baseName,
          top_candidates: scored.slice(0, 3).map((x) => ({ name: x.name, score: x.score, ids: getEvIds(x.ev) })),
        });
        continue;
      }

      const ids = getEvIds(best.ev);
      const dates = getEvDates(best.ev);

      if (!ids.tourn_id && !ids.org_id) {
        skipped_ambiguous++;
        ambiguous.push({
          week_number: w.week_number,
          week_name: baseName,
          error: "Best match had no usable tourn_id/org_id.",
          candidate_name: best.name,
        });
        continue;
      }

      await sb(
        "PATCH",
        `weeks?id=eq.${w.id}`,
        {
          // DO NOT TOUCH week_number
          tourn_id: ids.tourn_id || null,
          org_id: ids.org_id || null,
          season_year: Number(season) || w.season_year || null,
          tournament_name: best.name || w.tournament_name || null,
          start_date: dates.start_date || w.start_date || null,
          end_date: dates.end_date || w.end_date || null,
          api_status: "datagolf",
          api_last_synced_at: nowIso,
        },
        "return=minimal"
      );

      filled_missing++;
      filled.push({ week_number: w.week_number, chosen_name: best.name, ids, score: best.score });
    }

    return json(200, {
      ok: true,
      season,
      datagolf_events: events.length,
      weeks_total: (weeks || []).length,
      updated_locked,
      filled_missing,
      skipped_ambiguous,
      filled,
      refreshed,
      ambiguous,
      note:
        "week_number is never updated. Weeks with existing tourn_id/org_id are locked and will not be remapped to a different event.",
    });
  } catch (err) {
    console.error("sync-schedule error:", err);
    return json(500, { ok: false, error: err?.message || String(err) });
  }
};
