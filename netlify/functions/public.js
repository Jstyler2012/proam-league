// netlify/functions/public.js  (CommonJS Netlify Function)

exports.handler = async (event) => {
  try {
    const path = (event.path || "")
      .replace(/^\/.netlify\/functions\/public\/?/, "")
      .replace(/^\/+/, "");

    // Health check must work even before Supabase is configured
    if (path === "" || path === "health") {
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: true }),
      };
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return {
        statusCode: 500,
        body: "Missing SUPABASE_URL or SUPABASE_ANON_KEY",
      };
    }

    const sbGet = async (restPath) => {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${restPath}`, {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
      });
      const text = await r.text();
      if (!r.ok) return { ok: false, status: r.status, text };
      return { ok: true, json: text ? JSON.parse(text) : null };
    };

    if (path === "weeks") {
      const out = await sbGet(`weeks?select=id,label,event_key,start_date,end_date,created_at&order=created_at.desc`);
      if (!out.ok) return { statusCode: out.status, body: out.text };
      return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(out.json) };
    }

    if (path === "season") {
      const out = await sbGet(`season_standings?select=player,points`);
      if (!out.ok) return { statusCode: out.status, body: out.text };
      return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(out.json) };
    }

    if (path === "week") {
      const qs = event.queryStringParameters || {};
      const weekId = qs.id;
      if (!weekId) return { statusCode: 400, body: "Missing week id" };

      const entries = await sbGet(
        `week_entries?select=your_score,pro_score,total,rank,points,pga_golfer,players(name)&week_id=eq.${weekId}&order=rank.asc`
      );
      if (!entries.ok) return { statusCode: entries.status, body: entries.text };

      const payouts = await sbGet(`payouts?select=winner_name,amount&week_id=eq.${weekId}&order=created_at.asc`);
      if (!payouts.ok) return { statusCode: payouts.status, body: payouts.text };

      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entries: entries.json, payouts: payouts.json }),
      };
    }

    return { statusCode: 404, body: "Not found" };
  } catch (e) {
    return { statusCode: 500, body: `Server error: ${e?.message || e}` };
  }
};
