// netlify/functions/sync-field.js
//
// Admin-only: sync weekly tournament field and assign tiers using World Golf Ranking,
// then store per-week tier assignments server-side.
//
// Call:
//   /.netlify/functions/sync-field?week_id=1&pin=YOURPIN
// Optional:
//   &force=1            => overwrite existing week_pros rows
//   &debug=1            => return schedule parsing diagnostics (no DB writes)
//   &orgId=1            => override orgId (default 1)
//   &year=2026          => override year (default derived from weeks.start_date)
//   &tournament_id=XXXX => force tournament id once you know it
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
      await sleep(800 * (i + 1));
      continue;
    }

    if (!r.ok) throw new Error(`RapidAPI ${r.status}: ${t}`);

    if (!t) return null;
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  }

  throw new Error(`RapidAPI failed: ${lastText}`);
}

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

function normalizeWorldRankingPayload(payload) {
  const arr =
    (payload && Array.isArray(payload) ? payload : null) ||
    (payload && Array.isArray(payload.data) ? payload.data : null) ||
    (payload && Array.isArray(payload.rankings) ? payload.rankings : null) ||
    (payload && Array.isArray(payload.results) ? payload.results : null) ||
    [];

  const out = [];
  for (const r of arr) {
    const rank = r.rank ?? r.worldRank ?? r.world_rank ?? r.position ?? r.pos ?? null;
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

  return out.filter((x) => x.pro_id && x.pro_name);
}

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
    const id = p.playerId ?? p.player_id ?? p.id ?? p.pgaId ?? p.pga_id ?? null;
    const name =
      p.playerName ?? p.player_name ?? p.name ?? p.fullName ?? p.full_name ?? null;
    if (!id && !name) continue;

    out.push({
      pro_id: id != null ? String(id) : String(name),
      pro_name: name != null ? String(name) : String(id),
    });
  }

  const seen = new Set();
  const dedup = [];
  for (const x of out) {
    if (seen.has(x.pro_id)) continue;
    seen.add(x.pro_id);
    dedup.push(x);
  }
  return dedup;
}

function assignTiers(fieldWithRank) {
  const sorted = [...fieldWithRank].sort((a, b) => {
    const ar = a.world_rank, br = b.world_rank;
    const aNull = ar === null || ar === undefined;
    const bNull = br === null || br === undefined;
    if (!aNull && !bNull && ar !== br) return ar - br;
    if (aNull && !bNull) return 1;
    if (!aNull && bNull) return -1;
    return String(a.pro_name || "").localeCompare(String(b.pro_name || ""));
  });

  return sorted.map((p, idx) => {
    let tier = 4;
    if (idx < 10) tier = 1;
    else if (idx < 25) tier = 2;
    else if (idx < 45) tier = 3;
    return { ...p, tier, tier_rank: idx + 1 };
  });
}

function pickScheduleArray(scheduleRaw) {
  // SlashGolf shapes vary a lot; try a wide set of common keys.
  const candidates = [
    scheduleRaw,
    scheduleRaw?.data,
    scheduleRaw?.schedules,
    scheduleRaw?.results,
    scheduleRaw?.schedule,
    scheduleRaw?.events,
    scheduleRaw?.tournaments,
    scheduleRaw?.tours,
    scheduleRaw?.items,
  ];

  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }

  // sometimes nested: { data: { schedule: [...] } } etc
  const nested = [
    scheduleRaw?.data?.schedule,
    scheduleRaw?.data?.events,
    scheduleRaw?.data?.tournaments,
    scheduleRaw?.results?.schedule,
    scheduleRaw?.results?.events,
  ];
  for (const n of nested) {
    if (Array.isArray(n)) return n;
  }

  return [];
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(200, { ok: true });

  try {
    const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
    const SERVICE_ROLE = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
    const RAPID_KEY = (process.env.RAPIDAPI_KEY || "").trim();
    const RAPID_HOST = (process.env.RAPIDAPI_HOST || "").trim();
    const ADMIN_PIN = (process.env.ADMIN_PIN || "").trim();
    const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || "").trim();

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return text(500, "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    }
    if (!RAPID_HOST || !RAPID_KEY) {
      return text(500, "Missing RAPIDAPI_HOST or RAPIDAPI_KEY");
    }
    if (!ADMIN_PIN && !ADMIN_TOKEN) {
      return text(500, "Missing ADMIN_PIN (or ADMIN_TOKEN) env var");
    }

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

    const debug = String(q.debug || "").trim() === "1";
    const force = String(q.force || "").trim() === "1";

    const orgId = Number.isFinite(Number(q.orgId)) ? Number(q.orgId) : 1;

    const sb = makeSupabase(SUPABASE_URL, SERVICE_ROLE);

    // Load week row
    const weeks = await sb(
      "GET",
      `weeks?select=id,week_number,label,tournament_name,start_date,end_date&week_number=eq.${weekNumber}&limit=1`
    );
    const week = Array.isArray(weeks) ? weeks[0] : null;
    if (!week) return json(404, { ok: false, error: "Week not found in weeks table" });

    const startDate = toISODateOnly(week.start_date);
    const endDate = toISODateOnly(week.end_date);

    const derivedYear = startDate
      ? Number(String(startDate).slice(0, 4))
      : new Date().getUTCFullYear();

    const year = Number.isFinite(Number(q.year)) ? Number(q.year) : derivedYear;

    const rapidCtx = { host: RAPID_HOST, key: RAPID_KEY };

    // 1) schedule
    const scheduleResp = await tryRapidPaths(rapidCtx, [
      { path: "/schedule", qs: { orgId, year } },
      { path: "/schedules", qs: { orgId, year } },
    ]);

    if (!scheduleResp.ok) {
      return json(500, { ok: false, step: "schedule", error: scheduleResp.error });
    }

    const scheduleRaw = scheduleResp.data;
    const scheduleArr = pickScheduleArray(scheduleRaw);

    // Extract schedule candidates
    const tournamentIdOverride = String(q.tournament_id || "").trim();

    const normName = (s) =>
      String(s || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

        // Schedule items vary a LOT. Support both flat + nested shapes.
    const getTStart = (t) =>
      toISODateOnly(
        t.startDate ||
          t.start_date ||
          t.start ||
          t.tournamentStartDate ||
          t.tournament_start_date ||
          t.start_date_utc ||
          t?.tournament?.startDate ||
          t?.tournament?.start_date ||
          t?.event?.startDate ||
          t?.event?.start_date
      );

    const getTEnd = (t) =>
      toISODateOnly(
        t.endDate ||
          t.end_date ||
          t.end ||
          t.tournamentEndDate ||
          t.tournament_end_date ||
          t.end_date_utc ||
          t?.tournament?.endDate ||
          t?.tournament?.end_date ||
          t?.event?.endDate ||
          t?.event?.end_date
      );

    const getTName = (t) =>
      t.name ||
      t.tournamentName ||
      t.tournament_name ||
      t.eventName ||
      t.title ||
      t?.tournament?.name ||
      t?.tournament?.tournamentName ||
      t?.event?.name ||
      t?.event?.eventName ||
      "";

    const getTId = (t) =>
      t.tournamentId ??
      t.tournament_id ??
      t.id ??
      t.eventId ??
      t.event_id ??
      t.tourId ??
      t.tour_id ??
      t?.tournament?.id ??
      t?.tournament?.tournamentId ??
      t?.event?.id ??
      t?.event?.eventId ??
      null;
    const scheduleCandidates = scheduleArr
      .map((t) => {
        const ts = getTStart(t);
        const te = getTEnd(t);
        const id = getTId(t);
        const name = getTName(t);
        return { t, id, name, ts, te };
      })
      .filter((x) => x.id && x.ts);

    // DEBUG MODE: show exactly what we got back from schedule
    if (debug) {
      return json(200, {
        ok: true,
        step: "debug-schedule",
        week: {
          weekNumber,
          startDate,
          endDate,
          weekName: week.tournament_name || week.label || null,
        },
        schedule: {
          used_endpoint: scheduleResp.path,
          used_qs: scheduleResp.qs,
          orgId,
          year,
          parsed_count: scheduleArr.length,
          candidate_count: scheduleCandidates.length,
                   sample_candidates: scheduleCandidates.slice(0, 20).map((c) => ({
            tournamentId: c.id,
            name: c.name,
            startDate: c.ts,
            endDate: c.te || null,
          })),

          // NEW: show what keys exist on actual schedule items
          schedule_item_keys_sample: scheduleArr.slice(0, 3).map((t) =>
            t && typeof t === "object" ? Object.keys(t).slice(0, 60) : []
          ),

          // NEW: show a tiny sanitized preview of schedule items so we can map fields
          schedule_item_preview: scheduleArr.slice(0, 3).map((t) => {
            if (!t || typeof t !== "object") return t;
            const preview = {};
            for (const k of Object.keys(t).slice(0, 25)) preview[k] = t[k];
            return preview;
          }),

          // helpful when array parsing fails
          raw_top_level_keys:
            scheduleRaw && typeof scheduleRaw === "object" && !Array.isArray(scheduleRaw)
              ? Object.keys(scheduleRaw).slice(0, 50)
              : null,
        },
        tip:
          "If candidate_count is 0, the schedule response either doesn't contain tournaments for orgId/year, or uses different key names. Paste this debug output back to me and we'll align it exactly.",
      });
    }

    // Tournament matching
    const weekNameNeedle = normName(week.tournament_name || week.label || week.name || "");

    const pickTournament = () => {
      if (tournamentIdOverride) {
        const forced = scheduleCandidates.find((c) => String(c.id) === tournamentIdOverride);
        if (forced) return forced.t;
        return null;
      }

      if (!startDate && scheduleCandidates.length) return scheduleCandidates[0].t;

      const s0 = startDate ? new Date(startDate + "T00:00:00Z") : null;
      const e0 = endDate ? new Date(endDate + "T23:59:59Z") : null;
      const s = s0 ? new Date(s0.getTime() - 24 * 3600 * 1000) : null;
      const e = e0 ? new Date(e0.getTime() + 24 * 3600 * 1000) : null;

      // 1) overlap
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
        score += Math.max(0, 30 - Math.abs(a - s0) / (24 * 3600 * 1000));
        overlapScored.push({ c, score });
      }
      if (overlapScored.length) {
        overlapScored.sort((x, y) => y.score - x.score);
        return overlapScored[0].c.t;
      }

      // 2) name match
      if (weekNameNeedle && weekNameNeedle.length >= 6) {
        const nameScored = [];
        for (const c of scheduleCandidates) {
          const hay = normName(c.name);
          if (!hay) continue;
          const hit = hay.includes(weekNameNeedle) || weekNameNeedle.includes(hay);
          if (!hit) continue;
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

    if (!tournament && !tournamentIdOverride) {
      // nearest list for troubleshooting
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
          "Could not match tournament by overlap or name. Use ?tournament_id=XXXX from the candidates list below, or run with &debug=1 to inspect schedule parsing.",
        week: {
          weekNumber,
          startDate,
          endDate,
          year,
          orgId,
          weekName: week.tournament_name || week.label || null,
        },
        nearest_schedule_candidates: nearest,
      });
    }

    const resolvedTournamentId =
      tournamentIdOverride ||
      (tournament
        ? (tournament.tournamentId ??
            tournament.tournament_id ??
            tournament.id ??
            tournament.eventId ??
            tournament.event_id ??
            null)
        : null);

    const resolvedTournamentName =
      (tournament
        ? (tournament.name ?? tournament.tournamentName ?? tournament.tournament_name ?? null)
        : null) ||
      week.tournament_name ||
      week.label ||
      null;

    if (!resolvedTournamentId) {
      return json(500, {
        ok: false,
        step: "tournament-id",
        error: "No tournamentId resolved. Provide &tournament_id=XXXX (from schedule list).",
      });
    }

    // 2) fetch tournament field
    const tournamentId = resolvedTournamentId;

    const fieldResp = await tryRapidPaths(rapidCtx, [
      { path: "/players", qs: { orgId, tournamentId } },
      { path: "/tournament/players", qs: { orgId, tournamentId } },
      { path: "/tournamentPlayers", qs: { orgId, tournamentId } },
      { path: "/leaderboard", qs: { orgId, tournamentId } },
      { path: "/leaderboards", qs: { orgId, tournamentId } },
    ]);

    if (!fieldResp.ok) {
      return json(500, {
        ok: false,
        step: "field",
        error: fieldResp.error,
        note:
          "If schedule works but field fails, the endpoint/params differ. Copy/paste the RapidAPI Code Snippet for the endpoint that returns the field players and I'll align it.",
        schedule_endpoint: scheduleResp.path,
        schedule_qs: scheduleResp.qs,
        orgId,
        tournamentId,
      });
    }

    const fieldPlayers = normalizeFieldPayload(fieldResp.data);

    if (!fieldPlayers.length) {
      return json(500, {
        ok: false,
        step: "field-empty",
        error: "Field returned 0 players after normalization.",
        hint:
          "This usually means the endpoint response shape differs. Paste the raw JSON (or keys) for the field endpoint.",
        endpoint_used: fieldResp.path,
        qs_used: fieldResp.qs,
      });
    }

    // 3) fetch world ranking
    const wrResp = await tryRapidPaths(rapidCtx, [
      { path: "/worldRanking", qs: {} },
      { path: "/world-ranking", qs: {} },
      { path: "/world_ranking", qs: {} },
      { path: "/rankings/world", qs: {} },
    ]);

    if (!wrResp.ok) {
      return json(500, {
        ok: false,
        step: "world-ranking",
        error: wrResp.error,
        note:
          "World ranking endpoint path may differ. Open RapidAPI playground and copy the Code Snippet for the World Ranking endpoint.",
      });
    }

    const wrList = normalizeWorldRankingPayload(wrResp.data);
    const rankById = new Map(wrList.map((x) => [String(x.pro_id), x.world_rank]));

    const merged = fieldPlayers.map((p) => ({
      ...p,
      world_rank: rankById.has(String(p.pro_id)) ? rankById.get(String(p.pro_id)) : null,
    }));

    const tiered = assignTiers(merged);

    // If not forcing, avoid overwriting existing week_pros
    // You already created week_pros table in earlier SQL.
    // We'll check if anything exists for this week.
    const existing = await sb(
      "GET",
      `week_pros?select=id&week_id=eq.${week.id}&limit=1`
    );
    const hasExisting = Array.isArray(existing) && existing.length > 0;

    if (hasExisting && !force) {
      return json(200, {
        ok: true,
        step: "noop",
        message:
          "week_pros already populated for this week. Re-run with &force=1 to overwrite.",
        week: { week_id: week.id, week_number: week.week_number, tournament: resolvedTournamentName },
        counts: { field: fieldPlayers.length, tiered: tiered.length },
      });
    }

    if (hasExisting && force) {
      // delete old rows
      await sb("DELETE", `week_pros?week_id=eq.${week.id}`);
    }

    // insert week_pros rows
    const inserts = tiered.map((p) => ({
      week_id: week.id,
      pro_id: String(p.pro_id),
      pro_name: String(p.pro_name),
      world_rank: p.world_rank,
      tier: p.tier,
      tier_rank: p.tier_rank,
      data_source: "slashgolf_world_ranking",
    }));

    // chunk inserts to avoid payload limits
    const chunkSize = 500;
    for (let i = 0; i < inserts.length; i += chunkSize) {
      const chunk = inserts.slice(i, i + chunkSize);
      await sb("POST", "week_pros", chunk);
    }

    return json(200, {
      ok: true,
      step: "synced",
      week: {
        week_id: week.id,
        week_number: week.week_number,
        tournament: resolvedTournamentName,
        tournament_id: String(resolvedTournamentId),
        startDate,
        endDate,
        orgId,
        year,
      },
      counts: {
        schedule_items: scheduleArr.length,
        candidates: scheduleCandidates.length,
        field: fieldPlayers.length,
        tiered: tiered.length,
      },
      used: {
        schedule_endpoint: scheduleResp.path,
        schedule_qs: scheduleResp.qs,
        field_endpoint: fieldResp.path,
        field_qs: fieldResp.qs,
        world_ranking_endpoint: wrResp.path,
      },
    });
  } catch (e) {
    return json(500, { ok: false, error: String(e.message || e) });
  }
};
