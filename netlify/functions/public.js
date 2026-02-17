// netlify/functions/public.js

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function resp(statusCode, bodyObj) {
  return {
    statusCode,
    headers: { "content-type": "application/json", ...corsHeaders },
    body: JSON.stringify(bodyObj),
  };
}

function respText(statusCode, text) {
  return {
    statusCode,
    headers: { "content-type": "text/plain; charset=utf-8", ...corsHeaders },
    body: text,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  try {
    const rawPath = (event.path || "").split("?")[0];

    // Support direct: /.netlify/functions/public/*
    // Also tolerate if someone calls the function by name only
    const path = rawPath
      .replace(/^\/\.netlify\/functions\/public\/?/, "")
      .replace(/^\/+/, "");

    // Health check (must work even before Supabase is configured)
    if (path === "" || path === "health") {
      return resp(200, { ok: true });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return respText(500, "Missing SUPABASE_URL or SUPABASE_ANON_KEY");
    }

    const sb = async (method, restPath, bodyObj, extraHeaders = {}) => {
      const url = `${SUPABASE_URL}/rest/v1/${restPath}`;
      const headers = {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        ...extraHeaders,
      };
      if (method !== "GET") headers["content-type"] = "application/json";

      const r = await fetch(url, {
        method,
        headers,
        body: bodyObj ? JSON.stringify(bodyObj) : undefined,
      });

      const text = await r.text();
      if (!r.ok) return { ok: false, status: r.status, text };

      if (!text) return { ok: true, json: null };
      try {
        return { ok: true, json: JSON.parse(text) };
      } catch {
        return { ok: true, json: text };
      }
    };

    // Current week based on schedule dates
    const getCurrentWeek = async () => {
      const out = await sb(
        "GET",
        "weeks?select=id,label,week_number,start_date,end_date,tournament_name,logo_url,winner_player_name&week_number=not.is.null&order=week_number.asc"
      );
      if (!out.ok) return out;

      const weeks = out.json || [];
      if (!weeks.length) return { ok: true, week: null };

      const today = new Date();

      const inRange = weeks.find((w) => {
        if (!w.start_date || !w.end_date) return false;
        const start = new Date(w.start_date + "T00:00:00");
        const end = new Date(w.end_date + "T23:59:59");
        return today >= start && today <= end;
      });

      if (inRange) return { ok: true, week: inRange };

      const firstStart = weeks[0].start_date
        ? new Date(weeks[0].start_date + "T00:00:00")
        : null;

      if (firstStart && today < firstStart) return { ok: true, week: weeks[0] };

      return { ok: true, week: weeks[weeks.length - 1] };
    };

    // CURRENT WEEK
    if (path === "current-week") {
      const cw = await getCurrentWeek();
      if (!cw.ok) return respText(cw.status, cw.text);
      return resp(200, { week: cw.week });
    }

    // PLAYERS
    if (path === "players") {
      const out = await sb("GET", "players?select=id,name&order=name.asc");
      if (!out.ok) return respText(out.status, out.text);
      return resp(200, out.json || []);
    }

    // PROS (static for now)
    if (path === "pros") {
      const pros = [
        { id: "Rory McIlroy", name: "Rory McIlroy" },
        { id: "Scottie Scheffler", name: "Scottie Scheffler" },
        { id: "Jon Rahm", name: "Jon Rahm" },
        { id: "Xander Schauffele", name: "Xander Schauffele" },
      ];
      return resp(200, pros);
    }

    // SCHEDULE
    if (path === "schedule") {
      const out = await sb(
        "GET",
        "weeks?select=id,week_number,tournament_name,start_date,end_date,logo_url,label,winner_player_name&order=week_number.asc.nullslast"
      );
      if (!out.ok) return respText(out.status, out.text);
      return resp(200, { weeks: out.json || [] });
    }

    // SEASON STANDINGS (view: public.season_standings)
    if (path === "season-standings") {
      const out = await sb(
        "GET",
        "season_standings?select=player_id,player_name,points&order=points.desc,player_name.asc"
      );
      if (!out.ok) return respText(out.status, out.text);
      return resp(200, { rows: out.json || [] });
    }

    // LEADERBOARD + optional ?week_id=
    if (path === "leaderboard") {
      const params = event.queryStringParameters || {};
      const weekIdParam = params.week_id;

      let week = null;

      if (weekIdParam) {
        const w = await sb("GET", `weeks?id=eq.${weekIdParam}&select=id,label,week_number`);
        if (!w.ok) return respText(w.status, w.text);
        week = w.json && w.json[0] ? w.json[0] : null;
      } else {
        const cw = await getCurrentWeek();
        if (!cw.ok) return respText(cw.status, cw.text);
        week = cw.week;
      }

      if (!week) return resp(200, { week: null, week_id: null, rows: [] });

      const p = await sb("GET", "players?select=id,name&order=name.asc");
      if (!p.ok) return respText(p.status, p.text);
      const players = p.json || [];

      const e = await sb(
        "GET",
        `week_entries?select=player_id,your_score,pro_score,total,pga_golfer&week_id=eq.${week.id}`
      );
      if (!e.ok) return respText(e.status, e.text);
      const entries = e.json || [];

      const byPlayerId = new Map(entries.map((x) => [x.player_id, x]));
      const rows = players.map((pl) => {
        const ent = byPlayerId.get(pl.id) || {};
        return {
          player_id: pl.id,
          player_name: pl.name,
          playerScore: ent.your_score ?? null,
          proScore: ent.pro_score ?? null,
          combined: ent.total ?? null,
          pga_golfer: ent.pga_golfer ?? null,
        };
      });

      rows.sort((a, b) => {
        const ac = a.combined;
        const bc = b.combined;
        const aNull = ac === null || ac === undefined;
        const bNull = bc === null || bc === undefined;
        if (aNull && bNull) return (a.player_name || "").localeCompare(b.player_name || "");
        if (aNull) return 1;
        if (bNull) return -1;
        if (ac !== bc) return ac - bc;
        return (a.player_name || "").localeCompare(b.player_name || "");
      });

      return resp(200, { week: week.label || `Week ${week.week_number}`, week_id: week.id, rows });
    }

    return respText(404, "Not found");
  } catch (err) {
    return respText(500, err?.message || String(err));
  }
};
