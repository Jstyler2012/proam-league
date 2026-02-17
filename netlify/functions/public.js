// netlify/functions/public.js

exports.handler = async (event) => {
  try {
    const path = (event.path || "")
      .split("?")[0] // strip querystring so routing works with ?week_id=...
      .replace(/^\/.netlify\/functions\/public\/?/, "")
      .replace(/^\/+/, "");

    // Health check (must work even before Supabase is configured)
    if (path === "" || path === "health") {
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: true })
      };
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return {
        statusCode: 500,
        body: "Missing SUPABASE_URL or SUPABASE_ANON_KEY"
      };
    }

    // helper: Supabase REST calls
    const sb = async (method, restPath, bodyObj, extraHeaders = {}) => {
      const url = `${SUPABASE_URL}/rest/v1/${restPath}`;

      const headers = {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        ...extraHeaders
      };

      if (method !== "GET") {
        headers["content-type"] = "application/json";
      }

      const r = await fetch(url, {
        method,
        headers,
        body: bodyObj ? JSON.stringify(bodyObj) : undefined
      });

      const text = await r.text();

      if (!r.ok) {
        return { ok: false, status: r.status, text };
      }

      return {
        ok: true,
        json: text ? JSON.parse(text) : null
      };
    };

  // current week based on schedule dates (Phase 2 correct logic)
const getCurrentWeek = async () => {

  // get full schedule ordered by week_number
  const out = await sb(
    "GET",
    "weeks?select=id,label,week_number,start_date,end_date&week_number=not.is.null&order=week_number.asc"
  );

  if (!out.ok) return out;

  const weeks = out.json || [];

  if (!weeks.length) {
    return { ok: true, week: null };
  }

  const today = new Date();

  // find week in range
  const inRange = weeks.find(w => {
    if (!w.start_date || !w.end_date) return false;
    const start = new Date(w.start_date + "T00:00:00");
    const end = new Date(w.end_date + "T23:59:59");
    return today >= start && today <= end;
  });

  if (inRange) return { ok: true, week: inRange };

  // pre-season → first week
  const firstStart = weeks[0].start_date
    ? new Date(weeks[0].start_date + "T00:00:00")
    : null;

  if (firstStart && today < firstStart) {
    return { ok: true, week: weeks[0] };
  }

  // post-season → last week
  return { ok: true, week: weeks[weeks.length - 1] };
};

    // CURRENT WEEK (returns id + label)
    if (path === "current-week") {
      const cw = await getCurrentWeek();
      if (!cw.ok) return { statusCode: cw.status, body: cw.text };

      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ week: cw.week })
      };
    }

    // PLAYERS
    if (path === "players") {
      const out = await sb("GET", "players?select=id,name&order=name.asc");
      if (!out.ok) return { statusCode: out.status, body: out.text };

      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(out.json || [])
      };
    }

    // PROS (static for now)
    if (path === "pros") {
      const pros = [
        { id: "Rory McIlroy", name: "Rory McIlroy" },
        { id: "Scottie Scheffler", name: "Scottie Scheffler" },
        { id: "Jon Rahm", name: "Jon Rahm" },
        { id: "Xander Schauffele", name: "Xander Schauffele" }
      ];

      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(pros)
      };
    }

    // SCHEDULE (Phase 2) - full season schedule
    // Uses sb() (Supabase REST), not a supabase client.
    if (path === "schedule") {
      const out = await sb(
        "GET",
        "weeks?select=id,week_number,tournament_name,start_date,end_date,logo_url,label&order=week_number.asc.nullslast"
      );

      if (!out.ok) return { statusCode: out.status, body: out.text };

      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ weeks: out.json || [] })
      };
    }
if (path === "debug-week-entries") {
  const out = await sb(
    "GET",
    "week_entries?select=*&limit=1"
  );
  if (!out.ok) return { statusCode: out.status, body: out.text };
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(out.json || [])
  };
}
   // LEADERBOARD (sorted by best combined) + optional ?week_id=
if (path === "leaderboard") {
  const params = event.queryStringParameters || {};
  const weekIdParam = params.week_id;

  let week = null;

  // If week_id is provided, fetch that week (id + label)
  if (weekIdParam) {
    const w = await sb("GET", `weeks?id=eq.${weekIdParam}&select=id,label`);
    if (!w.ok) return { statusCode: w.status, body: w.text };
    week = (w.json && w.json[0]) ? w.json[0] : null;
  } else {
    // Otherwise keep existing behavior: current week
    const cw = await getCurrentWeek();
    if (!cw.ok) return { statusCode: cw.status, body: cw.text };
    week = cw.week;
  }

  if (!week) {
    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ week: null, week_id: null, rows: [] })
    };
  }

  // 1) Get all players
  const p = await sb("GET", "players?select=id,name&order=name.asc");
  if (!p.ok) return { statusCode: p.status, body: p.text };
  const players = p.json || [];

  // 2) Get entries for this week (may be empty)
  const e = await sb(
    "GET",
    `week_entries?select=player_id,your_score,pro_score,total,pga_golfer&week_id=eq.${week.id}`
  );

  // If this returns 401/empty due to RLS, you will see it here clearly
  if (!e.ok) return { statusCode: e.status, body: e.text };
  const entries = e.json || [];

  // 3) Merge players + entries
  const byPlayerId = new Map(entries.map((x) => [x.player_id, x]));

  const rows = players.map((pl) => {
    const ent = byPlayerId.get(pl.id) || {};
    return {
      player_id: pl.id,
      player_name: pl.name,
      playerScore: ent.your_score ?? null,
      proScore: ent.pro_score ?? null,
      combined: ent.total ?? null,
      pga_golfer: ent.pga_golfer ?? null
    };
  });

  // 4) Sort: combined asc, nulls last; tie-breaker by name
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

  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ week: week.label, week_id: week.id, rows })
  };
}
    // Old submit endpoint disabled (you now use mutate/submit-score)
    if (path === "submit") {
      return {
        statusCode: 410,
        body: "Moved to /.netlify/functions/mutate/submit-score"
      };
    }

    return { statusCode: 404, body: "Not found" };
  } catch (err) {
    return { statusCode: 500, body: err.message };
  }
};
