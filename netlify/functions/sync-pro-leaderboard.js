'use strict';

/**
 * sync-pro-leaderboard
 *
 * Goal: PGA-style fields
 *   POS | PLAYER | TOT | TODAY | THRU
 *
 * Storage:
 * - pro_leaderboard_entries.score_to_par  => TOT (tournament total to-par)
 * - pro_leaderboard_entries.today         => TODAY (current round to-par)
 * - pro_leaderboard_entries.round         => current round number (1..4)
 *
 * Problem we observed:
 * - DataGolf live-tournament-stats is a stats feed; per-player fields are not consistent.
 * - In your payload, the reliable "TOT to-par" per player appears in a field named `today`.
 * - The per-player `round` field is NOT a round number (it sometimes equals the to-par value).
 *
 * Fix:
 * - Use the EVENT round from the payload top-level: payload.stat_round (fallback: payload.round/current_round)
 *   and write that into entries.round for every row.
 * - TOT: best-effort tournament to-par (try common keys; fall back to p.today).
 * - TODAY:
 *    - If a proper round-only field exists (round_to_par / r_to_par / etc), use it.
 *    - Otherwise compute TODAY = TOT - sum(previous-round scores) using pro_leaderboard_round_scores.
 *      For round 1, previous sum is 0, so TODAY == TOT (matches PGA).
 *
 * We record round scores when a player finishes a round (thru == 'F' or '18').
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DATAGOLF_API_KEY = process.env.DATAGOLF_API_KEY;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function fetchJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { res, text, data };
}

async function sb(method, path, body, prefer = "return=minimal") {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "content-type": "application/json",
      Prefer: prefer,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const txt = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${txt}`);
  if (!txt) return null;
  try { return JSON.parse(txt); } catch { return txt; }
}

// ET date string (YYYY-MM-DD)
function todayInET() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

async function determineCurrentWeekRowET() {
  const weeks = await sb(
    "GET",
    "weeks?select=week_number,start_date,end_date,tournament_name,tourn_id,org_id,season_year&order=week_number.asc"
  );
  if (!Array.isArray(weeks) || !weeks.length) return null;

  const today = todayInET();

  const inRange = weeks.find((w) => {
    if (!w.start_date || !w.end_date) return false;
    return today >= String(w.start_date).slice(0, 10) && today <= String(w.end_date).slice(0, 10);
  });

  if (inRange) return inRange;

  const first = weeks[0];
  if (first?.start_date && today < String(first.start_date).slice(0, 10)) return first;
  return weeks[weeks.length - 1];
}

function parseToIntMaybe(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (/^(e|even)$/i.test(s)) return 0;
  const n = Number(s.replace(/[^\d\-+]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function toStringMaybe(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function pickPlayers(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;

  const directKeys = ["live_stats", "players", "leaderboard", "data", "results", "rows"];
  for (const k of directKeys) {
    if (Array.isArray(payload[k])) return payload[k];
  }

  for (const [k, v] of Object.entries(payload)) {
    if (!Array.isArray(v) || !v.length) continue;
    const first = v[0];
    if (!first || typeof first !== "object") continue;
    const hasId =
      ("dg_id" in first) ||
      ("player_id" in first) ||
      ("id" in first) ||
      (first.player && typeof first.player === "object" && ("dg_id" in first.player));
    if (hasId) return v;
  }

  return [];
}

function isRoundFinished(thru) {
  if (thru === null || thru === undefined) return false;
  const s = String(thru).trim().toUpperCase();
  return s === "F" || s === "18";
}

async function loadRoundScoreMap(weekNumber) {
  const out = await sb("GET", `pro_leaderboard_round_scores?select=player_ext_id,round,round_score_to_par&week_number=eq.${Number(weekNumber)}`);
  const map = new Map(); // key `${id}|${round}` => score
  if (Array.isArray(out)) {
    for (const r of out) {
      if (!r?.player_ext_id || !r?.round) continue;
      map.set(`${String(r.player_ext_id)}|${Number(r.round)}`, (r.round_score_to_par ?? null));
    }
  }
  return map;
}

function sumPrevRounds(roundScoreMap, playerId, currentRound) {
  if (!currentRound || currentRound <= 1) return 0;
  let sum = 0;
  for (let r = 1; r < currentRound; r++) {
    const v = roundScoreMap.get(`${playerId}|${r}`);
    if (v === null || v === undefined) continue;
    const n = Number(v);
    if (Number.isFinite(n)) sum += n;
  }
  return sum;
}

function normalizePlayerRow(p, weekNumber, nowIso, eventRound, roundScoreMap) {
  const ext = p?.dg_id ?? p?.player_id ?? p?.id ?? p?.player?.dg_id ?? null;
  if (!ext) return null;
  const playerId = String(ext);

  const position = toStringMaybe(p?.position ?? p?.pos ?? p?.place ?? p?.rank ?? p?.finish_position);

  // TOT best-effort (in your current payload, p.today appears to be TOT)
  const tot = parseToIntMaybe(
    p?.score_to_par ??
      p?.to_par ??
      p?.total_to_par ??
      p?.tourn_to_par ??
      p?.total ??
      p?.score ??
      p?.toPar ??
      p?.today
  );

  const thru = toStringMaybe(
    p?.thru ?? p?.holes_completed ?? p?.holes ?? p?.thru_hole ?? p?.thruToday ?? p?.holes_thru
  );

  // Prefer an explicit round-only score if present
  let today = parseToIntMaybe(
    p?.round_to_par ?? p?.r_to_par ?? p?.todays_to_par ?? p?.roundScoreToPar ?? p?.rScoreToPar
  );

  const roundNum = (eventRound && eventRound >= 1 && eventRound <= 4) ? eventRound : null;

  // If no explicit round-only score, compute from stored previous rounds:
  // TODAY = TOT - sum(prev round scores)
  if (today === null && tot !== null && roundNum !== null) {
    const prevSum = sumPrevRounds(roundScoreMap, playerId, roundNum);
    today = tot - prevSum;
  }

  const strokes = parseToIntMaybe(p?.strokes ?? p?.total_strokes ?? p?.totalStrokes);
  const status = toStringMaybe(p?.status ?? p?.player_status ?? p?.result_status);

  return {
    row: {
      week_number: Number(weekNumber),
      player_ext_id: playerId,
      position,
      score_to_par: tot, // TOT
      thru,
      today,             // TODAY
      round: roundNum,
      strokes,
      status,
      is_cut: null,
      updated_at: nowIso,
    },
    // if finished, we can store the round score for this round
    finishedRound: (roundNum !== null && isRoundFinished(thru) && today !== null) ? {
      week_number: Number(weekNumber),
      player_ext_id: playerId,
      round: roundNum,
      round_score_to_par: today,
      updated_at: nowIso,
    } : null
  };
}

function computeCutLine(payload, rows) {
  const direct =
    payload?.cut_line ??
    payload?.cutLine ??
    payload?.cut_line_to_par ??
    payload?.cut?.line ??
    payload?.cutline;

  const directInt = parseToIntMaybe(direct);
  if (directInt !== null) return directInt;

  const cutRows = rows.filter((r) => {
    const pos = (r.position || "").toLowerCase();
    const st = (r.status || "").toLowerCase();
    return pos.includes("cut") || pos === "mc" || st === "mc" || st === "cut";
  });

  const mcScores = cutRows.map((r) => r.score_to_par).filter((n) => n !== null);
  if (mcScores.length) return Math.min(...mcScores);

  return null;
}

function safeTrimRaw(payload) {
  try {
    const players = pickPlayers(payload);
    const trimmed =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? { ...payload }
        : { payload_type: typeof payload };
    if (Array.isArray(players) && players.length) {
      trimmed.__players_preview = players.slice(0, 3);
      trimmed.__players_count = players.length;
    }
    return trimmed;
  } catch {
    return payload;
  }
}

exports.handler = async (event) => {
  try {
    if (!SUPABASE_URL) return json(500, { ok: false, error: "Missing SUPABASE_URL" });
    if (!SERVICE_KEY) return json(500, { ok: false, error: "Missing SUPABASE_SERVICE_ROLE_KEY" });
    if (!DATAGOLF_API_KEY) return json(500, { ok: false, error: "Missing DATAGOLF_API_KEY" });

    let isScheduled = false;
    if (event.body) {
      try {
        const parsed = JSON.parse(event.body);
        if (parsed && typeof parsed.next_run === "string") isScheduled = true;
      } catch {}
    }

    const q = event.queryStringParameters || {};
    let weekRow = null;

    if (q.week_id || q.week_number) {
      const wk = Number(q.week_id ?? q.week_number);
      if (!Number.isFinite(wk)) return json(400, { ok: false, error: "Invalid week_id" });
      const rows = await sb(
        "GET",
        `weeks?select=week_number,start_date,end_date,tournament_name,tourn_id,org_id&week_number=eq.${wk}&limit=1`
      );
      weekRow = Array.isArray(rows) ? rows[0] : null;
    } else {
      weekRow = await determineCurrentWeekRowET();
    }

    if (!weekRow) return json(404, { ok: false, error: "Could not determine current week" });

    const today = todayInET();
    const start = String(weekRow.start_date || "").slice(0, 10);
    const end = String(weekRow.end_date || "").slice(0, 10);

    const inWindow = start && end && today >= start && today <= end;
    if (!inWindow && isScheduled) {
      return json(200, { ok: true, skipped: true, reason: "outside tournament window", week_number: weekRow.week_number });
    }

    const nowIso = new Date().toISOString();

    const dgUrl =
      `https://feeds.datagolf.com/preds/live-tournament-stats` +
      `?tour=pga&file_format=json&key=${encodeURIComponent(DATAGOLF_API_KEY)}`;

    const dg = await fetchJson(dgUrl);
    if (!dg.res.ok) {
      return json(502, { ok: false, error: `DataGolf failed (${dg.res.status})`, preview: (dg.text || "").slice(0, 800) });
    }

    const payload = dg.data ?? null;
    const players = pickPlayers(payload);
    const eventRound = parseToIntMaybe(payload?.stat_round ?? payload?.round ?? payload?.current_round);

    console.log("[sync-pro-leaderboard] week_number:", weekRow.week_number);
    console.log("[sync-pro-leaderboard] eventRound:", eventRound);
    console.log(
      "[sync-pro-leaderboard] datagolf top-level keys:",
      payload && typeof payload === "object" && !Array.isArray(payload) ? Object.keys(payload) : typeof payload
    );
    console.log("[sync-pro-leaderboard] players found:", Array.isArray(players) ? players.length : 0);

    // Load stored round scores so we can compute TODAY properly on R2+
    const roundScoreMap = await loadRoundScoreMap(weekRow.week_number);

    const rows = [];
    const finishedRoundRows = [];

    for (const p of players || []) {
      const out = normalizePlayerRow(p, weekRow.week_number, nowIso, eventRound, roundScoreMap);
      if (!out) continue;
      rows.push(out.row);
      if (out.finishedRound) finishedRoundRows.push(out.finishedRound);
    }

    // Upsert finished round scores (used to compute TODAY on later rounds)
    if (finishedRoundRows.length) {
      await sb(
        "POST",
        "pro_leaderboard_round_scores?on_conflict=week_number,player_ext_id,round",
        finishedRoundRows,
        "resolution=merge-duplicates,return=minimal"
      );
    }

    const cutLine = computeCutLine(payload, rows);

    if (cutLine !== null) {
      for (const r of rows) {
        if (r.score_to_par !== null && r.round !== null && r.round >= 2) {
          r.is_cut = r.score_to_par > cutLine;
        }
      }
    }

    if (rows.length) {
      await sb(
        "POST",
        "pro_leaderboard_entries?on_conflict=week_number,player_ext_id",
        rows,
        "resolution=merge-duplicates,return=minimal"
      );
    }

    await sb(
      "POST",
      "pro_leaderboard_snapshots",
      {
        week_number: Number(weekRow.week_number),
        fetched_at: nowIso,
        tour: "pga",
        tourn_id: payload?.tourn_id ? String(payload.tourn_id) : null,
        event_name: payload?.event_name ?? payload?.tournament_name ?? weekRow.tournament_name ?? null,
        round: eventRound,
        cut_line_to_par: cutLine,
        is_in_progress: inWindow ? true : null,
        source: "datagolf:live-tournament-stats",
        raw: safeTrimRaw(payload),
      },
      "return=minimal"
    );

    const status = inWindow ? "live" : "pre";
    await sb("PATCH", `weeks?week_number=eq.${Number(weekRow.week_number)}`, {
      leaderboard_last_synced_at: nowIso,
      pro_leaderboard_cut_line_to_par: cutLine,
      pro_leaderboard_status: status,
    });

    return json(200, {
      ok: true,
      week_number: weekRow.week_number,
      event_round: eventRound,
      rows_upserted: rows.length,
      round_scores_upserted: finishedRoundRows.length,
      cut_line_to_par: cutLine,
      scheduled: isScheduled,
    });
  } catch (err) {
    console.log("[sync-pro-leaderboard] error:", err);
    return json(500, { ok: false, error: err.message });
  }
};
