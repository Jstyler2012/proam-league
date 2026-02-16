// netlify/functions/public.js

exports.handler = async (event) => {
  try {
    const path = (event.path || "")
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

    // helper
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

    // current week
    const getCurrentWeek = async () => {
      const out = await sb(
        "GET",
        "weeks?select=id,label,created_at&order=created_at.desc&limit=1"
      );

      if (!out.ok) return out;

      return {
        ok: true,
        week: out.json[0] || null
      };
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

    // LEADERBOARD (sorted by best combined)
    if (path === "leaderboard") {
      const cw = await getCurrentWeek();

      if (!cw.ok) return { statusCode: cw.status, body: cw.text };

      if (!cw.week) {
        return {
          statusCode: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ week: null, rows: [] })
        };
      }

      const out = await sb(
        "GET",
        `week_entries?select=your_score,pro_score,total,pga_golfer,players(name)` +
          `&week_id=eq.${cw.week.id}` +
          `&order=total.asc.nullslast`
      );

      if (!out.ok) return { statusCode: out.status, body: out.text };

      const rows = (out.json || []).map((r) => ({
        player_name: r.players?.name || "—",
        playerScore: r.your_score,
        proScore: r.pro_score,
        combined: r.total,
        pga_golfer: r.pga_golfer
      }));

      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          week: cw.week.label,
          rows
        })
      };
    }

    // Old submit endpoint disabled (you now use mutate/submit-score)
    if (path === "submit") {
      return { statusCode: 410, body: "Moved to /.netlify/functions/mutate/submit-score" };
    }

    return { statusCode: 404, body: "Not found" };

  } catch (err) {
    return { statusCode: 500, body: err.message };
  }
};
