'use strict';

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
      Prefer: prefer
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const txt = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${txt}`);
  if (!txt) return null;
  try { return JSON.parse(txt); } catch { return txt; }
}

// ET date string (YYYY-MM-DD) without needing timezone libs
function todayInET() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

async function determineCurrentWeekRowET() {
  const weeks = await sb("GET",
    "weeks?select=week_number,start_date,end_date,tournament_name,tourn_id,org_id,season_year&order=week_number.asc"
  );
  if (!Array.isArray(weeks) || !weeks.length) return null;

  const today = todayInET();

  const inRange = weeks.find((w) => {
    if (!w.start_date || !w.end_date) return false;
    return today >= String(w.start_date).slice(0, 10) && today <= String(w.end_date).slice(0, 10);
  });

  if (inRange) return inRange;

  // fallback: before first → first, after last → last
  const first = weeks[0];
  if (first?.start_date && today < String(first.start_date).slice(0, 10)) return first;
  return weeks[weeks.length - 1];
}

function parseToIntMaybe(v) {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[^\d\-+]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Very defensive: DataGolf shapes can vary over time.
// Try common containers.
function pickPlayers(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.players)) return payload.players;
  if (Array.isArray(payload.leaderboard)) return payload.leaderboard;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.results)) return payload.results;
  return [];
}

function computeCutLine(payload, rows) {
  // 1) if API provides cut line, use it
  const direct =
    payload?.cut_line ??
    payload?.cutLine ??
    payload?.cut_line_to_par ??
    payload?.cut?.line;

  const directInt = parseToIntMaybe(direct);
  if (directInt !== null) return directInt;

  // 2) infer: if some rows look like MC/CUT, find best score among them and use that as cut line proxy
  const cutRows = rows.filter(r => {
    const pos = (r.position || "").toLowerCase();
    const st  = (r.status || "").toLowerCase();
    return pos.includes("cut") || pos === "mc" || st === "mc" || st === "cut";
  });

  // If we have cut-marked players, cut line is usually the score of the last guy who made it,
  // but we don’t have that reliably; using "best MC score" is a decent approximation.
  const mcScores = cutRows.map(r => r.score_to_par).filter(n => n !== null);
  if (mcScores.length) return Math.min(...mcScores);

  return null;
}

exports.handler = async (event) => {
  try {
    if (!SUPABASE_URL) return json(500, { ok: false, error: "Missing SUPABASE_URL" });
    if (!SERVICE_KEY) return json(500, { ok: false, error: "Missing SUPABASE_SERVICE_ROLE_KEY" });
    if (!DATAGOLF_API_KEY) return json(500, { ok: false, error: "Missing DATAGOLF_API_KEY" });

    // scheduled invocation detection
    let isScheduled = false;
    if (event.body) {
      try {
        const parsed = JSON.parse(event.body);
        if (parsed && typeof parsed.next_run === "string") isScheduled = true;
      } catch {}
    }

    // optional manual override: ?week_id=#
    const q = event.queryStringParameters || {};
    let weekRow = null;

    if (q.week_id || q.week_number) {
      const wk = Number(q.week_id ?? q.week_number);
      if (!Number.isFinite(wk)) return json(400, { ok: false, error: "Invalid week_id" });
      const rows = await sb("GET", `weeks?select=week_number,start_date,end_date,tournament_name,tourn_id,org_id&week_number=eq.${wk}&limit=1`);
      weekRow = Array.isArray(rows) ? rows[0] : null;
    } else {
      weekRow = await determineCurrentWeekRowET();
    }

    if (!weekRow) return json(404, { ok: false, error: "Could not determine current week" });

    const today = todayInET();
    const start = String(weekRow.start_date || "").slice(0, 10);
    const end   = String(weekRow.end_date || "").slice(0, 10);

    // If outside tournament window, no-op (still returns 200 for scheduler health)
    const inWindow = start && end && today >= start && today <= end;
    if (!inWindow && isScheduled) {
      return json(200, { ok: true, skipped: true, reason: "outside tournament window", week_number: weekRow.week_number });
    }

    const dgUrl =
      `https://feeds.datagolf.com/preds/live-tournament-stats` +
      `?tour=pga&key=${encodeURIComponent(DATAGOLF_API_KEY)}`;

    const dg = await fetchJson(dgUrl);
    if (!dg.res.ok) {
      return json(502, { ok: false, error: `DataGolf failed (${dg.res.status})`, preview: (dg.text || "").slice(0, 800) });
    }

    const payload = dg.data || {};
    const players = pickPlayers(payload);

    const nowIso = new Date().toISOString();

    // Normalize into table rows
    const rows = [];
    for (const p of (players || [])) {
      const ext =
        p?.dg_id ?? p?.player_id ?? p?.id ?? p?.player?.dg_id ?? null;
      if (!ext) continue;

      const position = p?.position ?? p?.pos ?? p?.place ?? null;

      // score_to_par is typically numeric; handle "+3" etc
      const score_to_par = parseToIntMaybe(p?.score_to_par ?? p?.to_par ?? p?.total_to_par ?? p?.scoreToPar);

      const thru = p?.thru ?? p?.holes_completed ?? p?.holes ?? p?.thru_hole ?? null;
      const round = parseToIntMaybe(p?.round ?? p?.current_round ?? p?.rnd);
      const strokes = parseToIntMaybe(p?.strokes ?? p?.total_strokes);

      const todayScore = parseToIntMaybe(p?.today ?? p?.round_to_par ?? p?.r_to_par);

      const status = p?.status ?? p?.player_status ?? null;

      rows.push({
        week_number: Number(weekRow.week_number),
        player_ext_id: String(ext),
        position: position != null ? String(position) : null,
        score_to_par,
        thru: thru != null ? String(thru) : null,
        today: todayScore,
        round,
        strokes,
        status: status != null ? String(status) : null,
        is_cut: null,
        updated_at: nowIso,
      });
    }

    const cutLine = computeCutLine(payload, rows);

    // Optionally mark is_cut if we can
    if (cutLine !== null) {
      for (const r of rows) {
        // heuristic: if score worse than cut line and round >= 2, likely cut (but don’t be too aggressive)
        if (r.score_to_par !== null && r.round !== null && r.round >= 2) {
          r.is_cut = r.score_to_par > cutLine;
        }
      }
    }

    // Upsert leaderboard entries
    // NOTE: PostgREST upsert needs ?on_conflict=week_number,player_ext_id
    if (rows.length) {
      await sb(
        "POST",
        "pro_leaderboard_entries?on_conflict=week_number,player_ext_id",
        rows,
        "resolution=merge-duplicates,return=minimal"
      );
    }

    // Snapshot row
    const snapshot = {
      week_number: Number(weekRow.week_number),
      fetched_at: nowIso,
      tour: "pga",
      tourn_id: payload?.tourn_id ? String(payload.tourn_id) : null,
      event_name: payload?.event_name ?? payload?.tournament_name ?? weekRow.tournament_name ?? null,
      round: parseToIntMaybe(payload?.round ?? payload?.current_round),
      cut_line_to_par: cutLine,
      is_in_progress: inWindow ? true : null,
      source: "datagolf",
      raw: null, // set to payload if you actually want to store it
    };
    await sb("POST", "pro_leaderboard_snapshots", snapshot, "return=minimal");

    // Update week metadata
    const status =
      inWindow ? "live" : "pre"; // keep simple; you can detect "final" later from payload
    await sb(
      "PATCH",
      `weeks?week_number=eq.${Number(weekRow.week_number)}`,
      {
        leaderboard_last_synced_at: nowIso,
        pro_leaderboard_cut_line_to_par: cutLine,
        pro_leaderboard_status: status
      }
    );

    return json(200, {
      ok: true,
      week_number: weekRow.week_number,
      rows_upserted: rows.length,
      cut_line_to_par: cutLine,
      scheduled: isScheduled
    });

  } catch (err) {
    return json(500, { ok: false, error: err.message });
  }
};
