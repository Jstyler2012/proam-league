// netlify/functions/sync-field.js
// Purpose: Populate week_pro_field for a given week using OWGR as the ranking signal.
// Tiers: 1-10 => Tier 1, 11-25 => Tier 2, 26-45 => Tier 3, 46+ => Tier 4
// NOTE: Uses Node 18+ global fetch (no node-fetch dependency).

function mustEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing env var: ${name}`);
  return String(v).trim();
}

const SUPABASE_URL = mustEnv("SUPABASE_URL");
const SERVICE_KEY = mustEnv("SUPABASE_SERVICE_ROLE_KEY");

const RAPIDAPI_KEY = mustEnv("RAPIDAPI_KEY");
const RAPIDAPI_HOST = mustEnv("RAPIDAPI_HOST");

// Optional guard: if ADMIN_PIN is set, caller must supply ?pin=... to run the sync
const ADMIN_PIN = process.env.ADMIN_PIN ? String(process.env.ADMIN_PIN).trim() : null;

async function sb(path, { method = "GET", body } = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "content-type": "application/json",
      // Allows upsert on bulk POST when PK exists (week_number, player_ext_id)
      prefer: "resolution=merge-duplicates",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text}`);
  return json;
}

async function rapid(path) {
  const url = `https://${RAPIDAPI_HOST}${path}`;
  const res = await fetch(url, {
    headers: {
      "X-RapidAPI-Key": RAPIDAPI_KEY,
      "X-RapidAPI-Host": RAPIDAPI_HOST,
    },
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!res.ok) {
  if (res.status === 429) {
    throw new Error(
      `RapidAPI 429 Too many requests. Reduce sync calls (the function now supports caching) or upgrade your RapidAPI plan. Raw: ${text}`
    );
  }
  throw new Error(`RapidAPI ${res.status}: ${text}`);
}
  return json;
}

function tierFromPosition(pos1Based) {
  if (pos1Based <= 10) return 1;
  if (pos1Based <= 25) return 2;
  if (pos1Based <= 45) return 3;
  return 4;
}

function bestId(p) {
  const id =
    p?.playerId ??
    p?.player_id ??
    p?.id ??
    p?.personId ??
    p?.person_id ??
    p?.pga_id ??
    p?.dg_id ??
    null;
  return id == null ? "" : String(id).trim();
}

function bestName(p) {
  return (
    p?.displayName ||
    p?.playerName ||
    p?.name ||
    p?.fullName ||
    [p?.firstName, p?.lastName].filter(Boolean).join(" ") ||
    ""
  ).trim();
}

function extractPlayersArray(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.players)) return payload.players;
  if (Array.isArray(payload.field)) return payload.field;
  if (Array.isArray(payload.leaderboard)) return payload.leaderboard;
  if (Array.isArray(payload.results)) return payload.results;
  if (Array.isArray(payload.data)) return payload.data;
  return [];
}

// IMPORTANT: RapidAPI endpoint path names sometimes differ.
// Your RapidAPI UI labels the endpoint "World Ranking" but the path could vary.
// We’ll try a few common variants automatically.
async function fetchOwgr() {
  const candidates = [
    "/worldranking?orgId=1",
    "/world-ranking?orgId=1",
    "/worldRanking?orgId=1",
    "/world_ranking?orgId=1",
  ];

  let lastErr = null;
  for (const p of candidates) {
    try {
      return { payload: await rapid(p), path: p };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Unable to fetch OWGR (no endpoint matched)");
}

// Same for schedule/tournaments list.
async function fetchSchedules(year) {
  const candidates = [
    `/schedules?orgId=1&year=${encodeURIComponent(year)}`,
    `/schedule?orgId=1&year=${encodeURIComponent(year)}`,
  ];

  let lastErr = null;
  for (const p of candidates) {
    try {
      return { payload: await rapid(p), path: p };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Unable to fetch schedules (no endpoint matched)");
}

// Field retrieval can vary; we try a few.
async function fetchFieldForTournament(tournamentId, year) {
  const attempts = [];

  if (tournamentId) {
    attempts.push({ label: "leaderboards", path: `/leaderboards?orgId=1&tournamentId=${encodeURIComponent(tournamentId)}` });
    attempts.push({ label: "tournaments", path: `/tournaments?id=${encodeURIComponent(tournamentId)}` });
    attempts.push({ label: "scorecards", path: `/scorecards?orgId=1&tournamentId=${encodeURIComponent(tournamentId)}` });
  }

  // Fallback: all players for the year (not ideal but better than failing)
  attempts.push({ label: "players (fallback)", path: `/players?orgId=1&year=${encodeURIComponent(year)}` });

  let lastErr = null;
  for (const a of attempts) {
    try {
      const payload = await rapid(a.path);
      return { payload, source: a.label, path: a.path };
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error("Unable to fetch field (no endpoint matched)");
}

exports.handler = async (event) => {
  try {
    // --- Optional PIN guard ---
    if (ADMIN_PIN) {
      const pin = String(event.queryStringParameters?.pin || "");
      if (pin !== ADMIN_PIN) {
        return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized (bad pin)" }) };
      }
    }
const weekNumber = Number(event.queryStringParameters?.week_id);
if (!Number.isFinite(weekNumber)) {
  return { statusCode: 400, body: JSON.stringify({ error: "Missing/invalid week_id" }) };
}

const force = String(event.queryStringParameters?.force || "") === "1";

// If already synced for this week, do NOT hit RapidAPI unless force=1
if (!force) {
  const existing = await sb(
    `week_pro_field?select=player_ext_id&week_number=eq.${weekNumber}&limit=1`
  );
  if (Array.isArray(existing) && existing.length > 0) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        week_number: weekNumber,
        skipped: true,
        reason: "week_pro_field already populated (use &force=1 to re-sync)",
      }),
    };
  }
}

// Load week from DB ...
const w = await sb(
  `weeks?select=week_number,start_date,label,tournament_name&week_number=eq.${weekNumber}&limit=1`
);

    // Load week from DB (your weeks.start_date is tournament Thursday)
    const w = await sb(
  `weeks?select=week_number,start_date,label,tournament_name&week_number=eq.${weekNumber}&limit=1`
);

const week = (w || [])[0];
if (!week) {
  return {
    statusCode: 404,
    body: JSON.stringify({ error: `Week ${weekNumber} not found` })
  };
}

    const startDate = String(week.start_date || "").slice(0, 10); // YYYY-MM-DD
    const year = Number(startDate.slice(0, 4)) || new Date().getUTCFullYear();

    // 1) Find closest tournament to week.start_date
    const sch = await fetchSchedules(year);
    const schedules = sch.payload;

    const tList =
      (Array.isArray(schedules?.tournaments) && schedules.tournaments) ||
      (Array.isArray(schedules?.events) && schedules.events) ||
      extractPlayersArray(schedules); // last-resort if provider uses "data"

    const targetTs = new Date(`${startDate}T00:00:00Z`).getTime();

    let best = null;
    let bestDelta = Infinity;

    for (const t of tList) {
      const dStr = String(t?.startDate || t?.start_date || t?.date || "").slice(0, 10);
      if (!dStr) continue;
      const ts = new Date(`${dStr}T00:00:00Z`).getTime();
      const delta = Math.abs(ts - targetTs);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = t;
      }
    }

    const tournamentId = best?.tournamentId || best?.eventId || best?.id || null;

    // 2) Fetch tournament field
    const field = await fetchFieldForTournament(tournamentId, year);
    const fieldPlayers = extractPlayersArray(field.payload);

    if (!fieldPlayers.length) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: false,
          error: "Fetched field payload but did not find players array",
          week_number: weekNumber,
          schedules_path: sch.path,
          field_path: field.path,
          field_source: field.source,
          tournament_guess: best || null,
          payload_keys: Object.keys(field.payload || {}),
        }),
      };
    }

    // 3) Fetch OWGR list
    const ow = await fetchOwgr();
    const owgrPayload = ow.payload;

    const owgrList = extractPlayersArray(owgrPayload);
    if (!owgrList.length) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: false,
          error: "Could not read OWGR list from payload",
          owgr_path: ow.path,
          payload_keys: Object.keys(owgrPayload || {}),
        }),
      };
    }

    // Build map: playerId -> OWGR rank
    const owgrById = new Map();
    for (const r of owgrList) {
      const id = bestId(r);
      const rank = Number(r?.rank ?? r?.worldRank ?? r?.position ?? r?.owgrRank ?? r?.owgr_rank);
      if (id && Number.isFinite(rank)) owgrById.set(id, rank);
    }

    // Normalize field + attach OWGR
    const normalized = fieldPlayers
      .map((p) => {
        const id = bestId(p);
        const name = bestName(p);
        const owgr = id ? (owgrById.get(id) ?? null) : null;
        return { id, name, owgr };
      })
      .filter((x) => x.id && x.name);

    // Sort by OWGR (lower better). Missing OWGR goes to bottom.
    normalized.sort((a, b) => {
      const ar = a.owgr ?? 999999;
      const br = b.owgr ?? 999999;
      if (ar !== br) return ar - br;
      return a.name.localeCompare(b.name);
    });

    const rows = normalized.map((p, idx) => {
      const pos = idx + 1;
      const owgrRank = p.owgr ?? null;
      return {
        week_number: weekNumber,
        player_ext_id: p.id,
        player_name: p.name,

        // Re-using these columns to store OWGR info
        odds_display: owgrRank ? `OWGR #${owgrRank}` : null,
        odds_numeric: owgrRank, // OWGR rank numeric
        odds_rank: pos,         // rank within this week's field
        tier: tierFromPosition(pos),
      };
    });

    // Replace week field to avoid stale players
    await sb(`week_pro_field?week_number=eq.${weekNumber}`, { method: "DELETE" });
    await sb("week_pro_field", { method: "POST", body: rows });

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        week_number: weekNumber,
        year,
        schedules_path: sch.path,
        owgr_path: ow.path,
        field_path: field.path,
        field_source: field.source,
        tournament_guess: best
          ? {
              id: tournamentId || null,
              name: best?.name || best?.tournamentName || null,
              start: best?.startDate || best?.start_date || null,
            }
          : null,
        inserted: rows.length,
        sample: rows.slice(0, 8),
      }),
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
