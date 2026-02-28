// netlify/functions/sync-field.js
//
// Admin-only: sync weekly tournament field and assign tiers using World Golf Ranking,
// then store per-week tier assignments server-side.
//
// Call:
//   /.netlify/functions/sync-field?week_id=1&pin=YOURPIN&force=1
//
// Env required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   RAPIDAPI_KEY
//   RAPIDAPI_HOST   (e.g. live-golf-data.p.rapidapi.com)
//   ADMIN_PIN       (or ADMIN_TOKEN fallback)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(statusCode, bodyObj) {
  return {
    statusCode,
    headers: { "content-type": "application/json", ...corsHeaders },
    body: JSON.stringify(bodyObj),
  };
}

function text(statusCode, bodyText) {
  return {
    statusCode,
    headers: { "content-type": "text/plain; charset=utf-8", ...corsHeaders },
    body: bodyText,
  };
}

function getHeader(event, name) {
  const h = event.headers || {};
  return (h[name] || h[name.toLowerCase()] || "").trim();
}

function toISODateOnly(d) {
  if (!d) return null;
  // weeks table uses YYYY-MM-DD; keep it that way
  return String(d).slice(0, 10);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// RapidAPI fetch with small retry/backoff for 429
async function rapidFetch({ host, key, path, qs = {}, tries = 3 }) {
  const url = new URL(`https://${host}${path}`);
  for (const [k, v] of Object.entries(qs)) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, String(v));
  }

  let lastText = "";
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "x-rapidapi-host": host,
        "x-rapidapi-key": key,
      },
    });

    const t = await r.text();
    lastText = t;

    if (r.status === 429 && i < tries - 1) {
      // exponential-ish backoff
      await sleep(600 * (i + 1));
      continue;
    }

    if (!r.ok) {
      throw new Error(`RapidAPI ${r.status}: ${t}`);
    }

    if (!t) return null;
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  }

  throw new Error(`RapidAPI failed: ${lastText}`);
}

// Supabase REST helper (service role)
function makeSupabase(SUPABASE_URL, SERVICE_ROLE) {
  return async function sb(method, restPath, bodyObj) {
    const url = `${SUPABASE_URL}/rest/v1/${restPath}`;
    const headers = {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      Prefer: "return=representation",
    };
    if (method !== "GET") headers["content-type"] = "application/json";

    const r = await fetch(url, {
      method,
      headers,
      body: bodyObj ? JSON.stringify(bodyObj) : undefined,
    });

    const t = await r.text();
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${t}`);
    if (!t) return null;
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  };
}

// attempt multiple candidate endpoint paths (SlashGolf naming can vary)
async function tryRapidPaths(rapidCtx, candidates) {
  let lastErr = null;
  for (const c of candidates) {
    try {
      const data = await rapidFetch({ ...rapidCtx, path: c.path, qs: c.qs || {} });
      return { ok: true, path: c.path, qs: c.qs || {}, data };
    } catch (e) {
      lastErr = e;
    }
  }
  return { ok: false, error: lastErr ? String(lastErr.message || lastErr) : "Unknown error" };
}

// normalize “world ranking” payload to { pro_id, pro_name, world_rank }
function normalizeWorldRankingPayload(payload) {
  // Accept a bunch of common shapes:
  // - { data: [...] }
  // - { rankings: [...] }
  // - [...]
  const arr =
    (payload && Array.isArray(payload) ? payload : null) ||
    (payload && Array.isArray(payload.data) ? payload.data : null) ||
    (payload && Array.isArray(payload.rankings) ? payload.rankings : null) ||
    (payload && Array.isArray(payload.results) ? payload.results : null) ||
    [];

  const out = [];
  for (const r of arr) {
    // try multiple keys
    const rank =
      r.rank ?? r.worldRank ?? r.world_rank ?? r.position ?? r.pos ?? null;

    const id =
      r.playerId ?? r.player_id ?? r.id ?? r.pgaId ?? r.pga_id ?? r.owgrId ?? null;

    const name =
      r.playerName ?? r.player_name ?? r.name ?? r.fullName ?? r.full_name ?? null;

    const world_rank = Number(rank);
    out.push({
      pro_id: id != null ? String(id) : (name ? String(name) : null),
      pro_name: name != null ? String(name) : (id != null ? String(id) : "Unknown"),
      world_rank: Number.isFinite(world_rank) ? world_rank : null,
    });
  }

  // Filter nonsense
  return out.filter((x) => x.pro_id && x.pro_name);
}

// normalize “field” payload to list of { pro_id, pro_name }
function normalizeFieldPayload(payload) {
  const arr =
    (payload && Array.isArray(payload) ? payload : null) ||
    (payload && Array.isArray(payload.players) ? payload.players : null) ||
    (payload && Array.isArray(payload.field) ? payload.field : null) ||
    (payload && Array.isArray(payload.data) ? payload.data : null) ||
    (payload && Array.isArray(payload.results) ? payload.results : null) ||
    [];

  const out = [];
  for (const p of arr) {
    const id =
      p.playerId ?? p.player_id ?? p.id ?? p.pgaId ?? p.pga_id ?? null;
    const name =
      p.playerName ?? p.player_name ?? p.name ?? p.fullName ?? p.full_name ?? null;

    if (!id && !name) continue;

    out.push({
      pro_id: id != null ? String(id) : String(name),
      pro_name: name != null ? String(name) : String(id),
    });
  }

  // Dedup by pro_id
  const seen = new Set();
  const dedup = [];
  for (const x of out) {
    if (seen.has(x.pro_id)) continue;
    seen.add(x.pro_id);
    dedup.push(x);
  }
  return dedup;
}

// tier assignment using world_rank ascending (best rank = 1)
function assignTiers(fieldWithRank) {
  // sort: world_rank asc, then name
  const sorted = [...fieldWithRank].sort((a, b) => {
    const ar = a.world_rank, br = b.world_rank;
    const aNull = ar === null || ar === undefined;
    const bNull = br === null || br === undefined;
    if (!aNull && !bNull && ar !== br) return ar - br;
    if (aNull && !bNull) return 1;
    if (!aNull && bNull) return -1;
    return String(a.pro_name || "").localeCompare(String(b.pro_name || ""));
  });

  const withTier = [];
  for (let i = 0; i < sorted.length; i++) {
    const idx = i + 1;
    let tier = 4;
    if (idx <= 10) tier = 1;
    else if (idx <= 25) tier = 2;
    else if (idx <= 45) tier = 3;
    else tier = 4;

    withTier.push({ ...sorted[i], tier });
  }
  return withTier;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  try {
    const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
    const SERVICE_ROLE = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

    const RAPID_HOST = (process.env.RAPIDAPI_HOST || "").trim();
    const RAPID_KEY = (process.env.RAPIDAPI_KEY || "").trim();

    const ADMIN_PIN = (process.env.ADMIN_PIN || "").trim();
    const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || "").trim(); // fallback if you use this instead

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return text(500, "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    }
    if (!RAPID_HOST || !RAPID_KEY) {
      return text(500, "Missing RAPIDAPI_HOST or RAPIDAPI_KEY");
    }
    if (!ADMIN_PIN && !ADMIN_TOKEN) {
      return text(500, "Missing ADMIN_PIN (or ADMIN_TOKEN) env var");
    }

    // admin gate (pin can be querystring or header x-admin-token)
    const q = event.queryStringParameters || {};
    const pinFromQuery = String(q.pin || "").trim();
    const pinFromHeader = getHeader(event, "x-admin-token");

    const expected = ADMIN_PIN || ADMIN_TOKEN;
    const got = pinFromQuery || pinFromHeader;

    if (!got || got !== expected) {
      return json(401, { ok: false, error: "Unauthorized (bad pin)" });
    }

    const weekNumber = Number(q.week_id);
    if (!Number.isFinite(weekNumber)) {
      return json(400, { ok: false, error: "Missing/invalid week_id" });
    }

    const force = String(q.force || "").trim() === "1";

    const sb = makeSupabase(SUPABASE_URL, SERVICE_ROLE);

    // 1) Load the week row from your existing weeks table
    // NOTE: your schema uses week_number, tournament_name, start_date, end_date (per public.js)
    const weeks = await sb(
      "GET",
      `weeks?select=id,week_number,label,tournament_name,start_date,end_date&week_number=eq.${weekNumber}&limit=1`
    );
    const week = Array.isArray(weeks) ? weeks[0] : null;
    if (!week) return json(404, { ok: false, error: "Week not found in weeks table" });

    const startDate = toISODateOnly(week.start_date);
    const endDate = toISODateOnly(week.end_date);
    const year = startDate ? Number(String(startDate).slice(0, 4)) : new Date().getUTCFullYear();

    // 2) Find the tournament for this week via SlashGolf schedule
    const rapidCtx = { host: RAPID_HOST, key: RAPID_KEY };

    // schedule endpoint per RapidAPI snippet uses: /schedule?orgId=1&year=YYYY
    const scheduleResp = await tryRapidPaths(rapidCtx, [
      { path: "/schedule", qs: { orgId: 1, year } },
      { path: "/schedules", qs: { orgId: 1, year } },
    ]);

    if (!scheduleResp.ok) {
      return json(500, { ok: false, step: "schedule", error: scheduleResp.error });
    }

    const scheduleRaw = scheduleResp.data;
    const scheduleArr =
      (Array.isArray(scheduleRaw) ? scheduleRaw : null) ||
      (Array.isArray(scheduleRaw.data) ? scheduleRaw.data : null) ||
      (Array.isArray(scheduleRaw.schedules) ? scheduleRaw.schedules : null) ||
      (Array.isArray(scheduleRaw.results) ? scheduleRaw.results : null) ||
      [];

// Tournament matching:
// 1) exact overlap (with +/-1 day tolerance for timezone)
// 2) fuzzy name match vs week.tournament_name / week.label
// 3) nearest-by-date fallback (for debug output)
// Also supports override: &tournament_id=XXXX
const tournamentIdOverride = String(q.tournament_id || "").trim();

const normName = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const getTStart = (t) => toISODateOnly(t.startDate || t.start_date || t.start || t.tournamentStartDate);
const getTEnd = (t) => toISODateOnly(t.endDate || t.end_date || t.end || t.tournamentEndDate);
const getTName = (t) => t.name || t.tournamentName || t.tournament_name || t.eventName || t.title || "";

const getTId = (t) =>
  t.tournamentId ??
  t.tournament_id ??
  t.id ??
  t.eventId ??
  t.event_id ??
  t.tourId ??
  t.tour_id ??
  null;

// build candidates with parsed dates
const scheduleCandidates = scheduleArr
  .map((t) => {
    const ts = getTStart(t);
    const te = getTEnd(t);
    const id = getTId(t);
    const name = getTName(t);
    return { t, id, name, ts, te };
  })
  .filter((x) => x.id && x.ts); // must have at least id + start

const weekNameNeedle = normName(week.tournament_name || week.label || week.name || "");

const pickTournament = () => {
  if (tournamentIdOverride) {
    const forced = scheduleCandidates.find((c) => String(c.id) === tournamentIdOverride);
    if (forced) return forced.t;
    // if override provided but not found in schedule list, still allow it later
    return null;
  }

  if (!startDate && scheduleCandidates.length) return scheduleCandidates[0].t;

  const s0 = startDate ? new Date(startDate + "T00:00:00Z") : null;
  const e0 = endDate ? new Date(endDate + "T23:59:59Z") : null;

  // timezone tolerance (+/- 1 day)
  const s = s0 ? new Date(s0.getTime() - 24 * 3600 * 1000) : null;
  const e = e0 ? new Date(e0.getTime() + 24 * 3600 * 1000) : null;

  // 1) overlap scoring
  const overlapScored = [];
  for (const c of scheduleCandidates) {
    if (!c.ts || !c.te || !s || !e) continue;
    const a = new Date(c.ts + "T00:00:00Z");
    const b = new Date(c.te + "T23:59:59Z");
    const overlaps = a <= e && b >= s;
    if (!overlaps) continue;

    let score = 0;
    if (toISODateOnly(c.ts) === startDate) score += 100;
    if (toISODateOnly(c.te) === endDate) score += 50;
    // smaller date distance gets a bit more score
    score += Math.max(0, 30 - Math.abs(a - s0) / (24 * 3600 * 1000));
    overlapScored.push({ c, score });
  }

  if (overlapScored.length) {
    overlapScored.sort((x, y) => y.score - x.score);
    return overlapScored[0].c.t;
  }

  // 2) name match (only if we have a meaningful week name)
  if (weekNameNeedle && weekNameNeedle.length >= 6) {
    const nameScored = [];
    for (const c of scheduleCandidates) {
      const hay = normName(c.name);
      if (!hay) continue;
      // simple contains either direction
      const hit = hay.includes(weekNameNeedle) || weekNameNeedle.includes(hay);
      if (!hit) continue;
      // prefer closer dates if provided
      let score = 100;
      if (s0 && c.ts) {
        const a = new Date(c.ts + "T00:00:00Z");
        score += Math.max(0, 30 - Math.abs(a - s0) / (24 * 3600 * 1000));
      }
      nameScored.push({ c, score });
    }
    if (nameScored.length) {
      nameScored.sort((x, y) => y.score - x.score);
      return nameScored[0].c.t;
    }
  }

  return null;
};

const tournament = pickTournament();

// If we still don't have a match, return helpful debug info:
if (!tournament && !tournamentIdOverride) {
  // nearest-by-start-date for debug
  const s0 = startDate ? new Date(startDate + "T00:00:00Z") : null;
  const nearest = [...scheduleCandidates]
    .map((c) => {
      const a = c.ts ? new Date(c.ts + "T00:00:00Z") : null;
      const distDays = s0 && a ? Math.round(Math.abs(a - s0) / (24 * 3600 * 1000)) : null;
      return { ...c, distDays };
    })
    .sort((x, y) => (x.distDays ?? 99999) - (y.distDays ?? 99999))
    .slice(0, 12)
    .map((c) => ({
      tournamentId: c.id,
      name: c.name,
      startDate: c.ts,
      endDate: c.te || null,
      distDays: c.distDays,
    }));

  return json(500, {
    ok: false,
    step: "schedule-match",
    error:
      "Could not match tournament by overlap or name. Use ?tournament_id=XXXX from the candidates list below, or verify the schedule endpoint/year/orgId.",
    week: {
      weekNumber,
      startDate,
      endDate,
      year,
      weekName: week.tournament_name || week.label || null,
    },
    nearest_schedule_candidates: nearest,
    tip:
      "Try hitting this function with &debug=1 after we add it (optional), or paste the RapidAPI schedule JSON for 2026 so we can align orgId/fields precisely.",
  });
}

// If override was provided but not found in schedule list, we still allow it:
const resolvedTournamentId =
  tournamentIdOverride ||
  (tournament
    ? (tournament.tournamentId ?? tournament.tournament_id ?? tournament.id ?? tournament.eventId ?? tournament.event_id ?? null)
    : null);

const tournamentName =
  (tournament ? (tournament.name ?? tournament.tournamentName ?? tournament.tournament_name ?? null) : null) ||
  week.tournament_name ||
  week.label ||
  null;

if (!resolvedTournamentId) {
  return json(500, {
    ok: false,
    step: "tournament-id",
    error: "No tournamentId resolved. Provide &tournament_id=XXXX (from RapidAPI schedule list).",
  });
}
    const tournamentId =
      tournament.tournamentId ?? tournament.tournament_id ?? tournament.id ?? tournament.eventId ?? tournament.event_id ?? null;

    const tournamentName =
      tournament.name ?? tournament.tournamentName ?? tournament.tournament_name ?? week.tournament_name ?? week.label ?? null;

    if (!tournamentId) {
      return json(500, {
        ok: false,
        step: "tournament-id",
        error: "Matched a tournament but could not find tournamentId in schedule payload.",
        matched: tournament,
      });
    }

    // 3) Fetch tournament field (best effort: endpoint naming varies)
    // Try a few common variants.
    const fieldResp = await tryRapidPaths(rapidCtx, [
      { path: "/players", qs: { orgId: 1, tournamentId } },
      { path: "/tournament/players", qs: { orgId: 1, tournamentId } },
      { path: "/tournamentPlayers", qs: { orgId: 1, tournamentId } },
      { path: "/leaderboard", qs: { orgId: 1, tournamentId } },
      { path: "/leaderboards", qs: { orgId: 1, tournamentId } },
    ]);

    if (!fieldResp.ok) {
      return json(500, {
        ok: false,
        step: "field",
        error: fieldResp.error,
        note: "You are subscribed and keyed correctly; this error means the specific endpoint/params may differ. Send me the RapidAPI 'Code Snippet' for the players/leaderboard endpoint and I'll align it exactly.",
      });
    }

    // If leaderboard shape, players might be nested
    const fieldPlayers = normalizeFieldPayload(fieldResp.data);

    if (!fieldPlayers.length) {
      return json(500, {
        ok: false,
        step: "field-empty",
        error: "Tournament field came back empty after normalization.",
        hint: "Open RapidAPI playground for players/leaderboard endpoint and confirm response shape.",
      });
    }

    // 4) Fetch world ranking list
    const wrResp = await tryRapidPaths(rapidCtx, [
      { path: "/world-ranking", qs: {} },
      { path: "/worldrankings", qs: {} },
      { path: "/world-rankings", qs: {} },
      { path: "/worldranking", qs: {} },
    ]);

    if (!wrResp.ok) {
      return json(500, { ok: false, step: "world-ranking", error: wrResp.error });
    }

    const worldRankings = normalizeWorldRankingPayload(wrResp.data);

    // index ranking by pro_id and also by lowercase name (fallback)
    const rankById = new Map();
    const rankByName = new Map();

    for (const r of worldRankings) {
      if (r.pro_id && r.world_rank != null && !rankById.has(r.pro_id)) {
        rankById.set(r.pro_id, r.world_rank);
      }
      if (r.pro_name && r.world_rank != null) {
        const key = String(r.pro_name).toLowerCase().trim();
        if (key && !rankByName.has(key)) rankByName.set(key, r.world_rank);
      }
    }

    // merge field + ranking
    const merged = fieldPlayers.map((p) => {
      const byId = rankById.get(p.pro_id);
      const byName = rankByName.get(String(p.pro_name).toLowerCase().trim());
      const world_rank = (byId != null ? byId : (byName != null ? byName : null));
      return { ...p, world_rank };
    });

    const tiered = assignTiers(merged);

    // 5) Write to week_pros table
    // IMPORTANT: if your table name/columns differ, tell me and I'll adjust.
    //
    // Supports both:
    // - week_id = integer week_number
    // - week_id = uuid weeks.id (if your schema uses uuid)
    //
    // Determine weekKey by trying integer first; if uuid error, use uuid.
    let weekKey = weekNumber;
    let usedUuid = false;

    // delete existing rows unless force=0 and rows already exist
    const existingTry = async (keyVal) => {
      return await sb("GET", `week_pros?select=pro_id&week_id=eq.${keyVal}&limit=1`);
    };

    let existing = null;
    try {
      existing = await existingTry(weekKey);
    } catch (e) {
      const msg = String(e.message || e);
      if (msg.includes("invalid input syntax for type uuid")) {
        weekKey = week.id; // uuid
        usedUuid = true;
        existing = await existingTry(weekKey);
      } else {
        throw e;
      }
    }

    const alreadyHas = Array.isArray(existing) && existing.length > 0;
    if (alreadyHas && !force) {
      return json(200, {
        ok: true,
        message: "week_pros already populated; use &force=1 to overwrite",
        week_id: weekNumber,
        week_key: weekKey,
        week_key_type: usedUuid ? "uuid" : "int",
        tournament: { tournamentId, tournamentName, startDate, endDate, year },
        count_existing: existing.length,
      });
    }

    // delete then insert
    const del = async (keyVal) => sb("DELETE", `week_pros?week_id=eq.${keyVal}`);
    await del(weekKey);

    const rowsToInsert = tiered.map((p) => ({
      week_id: weekKey,
      pro_id: p.pro_id,
      pro_name: p.pro_name,
      world_rank: p.world_rank,
      tier: p.tier,
      source: "slashgolf+world_ranking",
    }));

    // Supabase REST has payload limits; chunk inserts
    const chunkSize = 250;
    let inserted = 0;
    for (let i = 0; i < rowsToInsert.length; i += chunkSize) {
      const chunk = rowsToInsert.slice(i, i + chunkSize);
      const ins = await sb("POST", "week_pros", chunk);
      inserted += Array.isArray(ins) ? ins.length : chunk.length;
    }

    return json(200, {
      ok: true,
      message: "Field synced + tiers assigned",
      week_id: weekNumber,
      week_key: weekKey,
      week_key_type: usedUuid ? "uuid" : "int",
      tournament: {
        tournamentId,
        tournamentName,
        startDate,
        endDate,
        year,
        schedule_endpoint: scheduleResp.path,
        field_endpoint: fieldResp.path,
        world_ranking_endpoint: wrResp.path,
      },
      counts: {
        field_players: fieldPlayers.length,
        world_rankings: worldRankings.length,
        inserted_week_pros: inserted,
      },
    });
  } catch (e) {
    return json(500, { ok: false, error: e?.message || String(e) });
  }
};
