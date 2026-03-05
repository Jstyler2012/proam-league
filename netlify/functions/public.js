'use strict';

/**
 * public.js (excerpt focus: /api/pro-leaderboard)
 *
 * This file should already exist in your repo. Replace it ONLY if you want the
 * simplified pro leaderboard API route to:
 *  - return POS, PLAYER (name), TOT
 *  - keep player_ext_id in the payload for internal use (UI should ignore it)
 *
 * Notes on names:
 * - First tries week_pro_field (per-week field) for player_name
 * - Falls back to pro_players.display_name
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

function json(statusCode, body) {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

async function sbAnon(path) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "content-type": "application/json",
    },
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${txt}`);
  if (!txt) return null;
  try { return JSON.parse(txt); } catch { return txt; }
}

function todayInET() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

async function determineCurrentWeekET() {
  const weeks = await sbAnon("weeks?select=week_number,label,tournament_name,start_date,end_date,logo_url,leaderboard_last_synced_at,pro_leaderboard_status&order=week_number.asc");
  if (!Array.isArray(weeks) || !weeks.length) return null;

  const today = todayInET();
  const inRange = weeks.find((w) => {
    if (!w.start_date || !w.end_date) return false;
    return today >= String(w.start_date).slice(0,10) && today <= String(w.end_date).slice(0,10);
  });
  if (inRange) return inRange;

  const first = weeks[0];
  if (first?.start_date && today < String(first.start_date).slice(0,10)) return first;
  return weeks[weeks.length - 1];
}

function fmtToPar(n) {
  if (n === null || n === undefined) return null;
  const num = Number(n);
  if (!Number.isFinite(num)) return n;
  if (num > 0) return `+${num}`;
  return `${num}`;
}

exports.handler = async (event) => {
  try {
    const path = event.path || "";
    if (!SUPABASE_URL) return json(500, { ok:false, error:"Missing SUPABASE_URL" });
    if (!SUPABASE_ANON_KEY) return json(500, { ok:false, error:"Missing SUPABASE_ANON_KEY" });

    // Only implementing the endpoint you asked for in this simplified step.
    if (path.endsWith("/api/pro-leaderboard") || path.endsWith("/.netlify/functions/public/api/pro-leaderboard")) {
      const q = event.queryStringParameters || {};
      let week = null;

      if (q.week_id || q.week_number) {
        const wk = Number(q.week_id ?? q.week_number);
        const rows = await sbAnon(`weeks?select=week_number,label,tournament_name,start_date,end_date,logo_url,leaderboard_last_synced_at,pro_leaderboard_status&week_number=eq.${wk}&limit=1`);
        week = Array.isArray(rows) ? rows[0] : null;
      } else {
        week = await determineCurrentWeekET();
      }

      if (!week) return json(200, { week: null, rows: [] });

      // Load rows (POS + TOT)
      const entries = await sbAnon(
        `pro_leaderboard_entries?select=player_ext_id,position,score_to_par,thru,updated_at&week_number=eq.${Number(week.week_number)}&order=score_to_par.asc.nullslast`
      );

      // Build name map from week_pro_field then pro_players fallback
      const nameMap = new Map();

      try {
        const field = await sbAnon(`week_pro_field?select=player_ext_id,player_name&week_number=eq.${Number(week.week_number)}&limit=5000`);
        if (Array.isArray(field)) {
          for (const r of field) {
            if (r?.player_ext_id && r?.player_name) nameMap.set(String(r.player_ext_id), String(r.player_name));
          }
        }
      } catch {}

      if (nameMap.size === 0) {
        try {
          const pros = await sbAnon("pro_players?select=ext_id,display_name&limit=10000");
          if (Array.isArray(pros)) {
            for (const r of pros) {
              if (r?.ext_id && r?.display_name) nameMap.set(String(r.ext_id), String(r.display_name));
            }
          }
        } catch {}
      }

      const rows = (Array.isArray(entries) ? entries : []).map((r) => ({
        position: r.position,
        player_name: nameMap.get(String(r.player_ext_id)) || null,
        tot: r.score_to_par,          // keep numeric
        tot_display: fmtToPar(r.score_to_par), // convenience for UI
        thru: r.thru,
        player_ext_id: r.player_ext_id, // keep for internal linking
        updated_at: r.updated_at,
      }));

      return json(200, { week, rows });
    }

    return json(404, { ok:false, error:"Not found" });
  } catch (err) {
    return json(500, { ok:false, error: err.message });
  }
};
