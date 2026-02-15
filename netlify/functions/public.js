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
      return { statusCode: 500, body: "Missing SUPABASE_URL or SUPABASE_ANON_KEY" };
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

    const sbPost = async (restPath, bodyObj) => {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${restPath}`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          "content-type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify(bodyObj),
      });
      const text = await r.text();
      if (!r.ok) return { ok: false, status: r.status, text };
      return { ok: true, json: text ? JSON.parse(text) : null };
    };

    // ---- existing endpoints you already had ----
    if (path === "weeks") {
      const out = await sbGet(
        `weeks?select=id,label,event_key,start_date,end_date,created_at&order=created_at.desc`
      );
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
        `week_entries?select=player_to_par,pro_to_par,combined_to_par,player_id,pro_id,players(name)&week_id=eq.${weekId}&order=combined_to_par.asc.nullslast`
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

    // ---- NEW: players (so your HTML boot() doesn’t crash) ----
    if (path === "players") {
      const out = await sbGet(`players?select=id,name&order=name.asc`);
      // If table doesn't exist yet, return [] so your HTML falls back to demo list
      if (!out.ok) return { statusCode: 200, headers: { "content-type": "application/json" }, body: "[]" };
      return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(out.json || []) };
    }

    // ---- NEW: pros ----
    if (path === "pros") {
      const out = await sbGet(`pros?select=id,name&order=name.asc`);
      if (!out.ok) return { statusCode: 200, headers: { "content-type": "application/json" }, body: "[]" };
      return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(out.json || []) };
    }

    // ---- NEW: leaderboard (your HTML expects {week, rows}) ----
    if (path === "leaderboard") {
      // Choose most recent week (by created_at desc)
      const w = await sbGet(`weeks?select=id,label&order=created_at.desc&limit=1`);
      if (!w.ok) return { statusCode: w.status, body: w.text };

      const week = (w.json && w.json[0]) || null;
      if (!week) {
        return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ week: "—", rows: [] }) };
      }

      const e = await sbGet(
        `week_entries?select=player_to_par,pro_to_par,combined_to_par,players(name)&week_id=eq.${week.id}&order=combined_to_par.asc.nullslast`
      );
      if (!e.ok) return { statusCode: e.status, body: e.text };

      const rows = (e.json || []).map((r) => ({
        player_name: r.players?.name ?? "—",
        player_to_par: r.player_to_par ?? null,
        pro_to_par: r.pro_to_par ?? null,
        combined_to_par: r.combined_to_par ?? null,
      }));

      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ week: week.label, rows }),
      };
    }

    // ---- NEW: submit (POST) ----
    if (path === "submit") {
      if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

      const body = event.body ? JSON.parse(event.body) : {};
      const { player_id, pro_id, player_to_par, pro_to_par } = body;

      if (!player_id || !pro_id || typeof player_to_par !== "number") {
        return { statusCode: 400, body: "Missing player_id, pro_id, or player_to_par(number)" };
      }

      // Pick latest week
      const w = await sbGet(`weeks?select=id,label&order=created_at.desc&limit=1`);
      if (!w.ok) return { statusCode: w.status, body: w.text };
      const week = (w.json && w.json[0]) || null;
      if (!week) return { statusCode: 400, body: "No week exists yet. Add a row to weeks first." };

      const combined = (typeof pro_to_par === "number") ? (player_to_par + pro_to_par) : null;

      const insert = await sbPost(`week_entries`, {
        week_id: week.id,
        player_id,
        pro_id,
        player_to_par,
        pro_to_par: (typeof pro_to_par === "number") ? pro_to_par : null,
        combined_to_par: combined,
      });

      // If RLS blocks inserts, you'll see it here
      if (!insert.ok) return { statusCode: insert.status, body: insert.text };

      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ok: true,
          week: week.label,
          combined_to_par: combined,
          saved: insert.json?.[0] ?? null,
        }),
      };
    }

    return { statusCode: 404, body: "Not found" };
  } catch (e) {
    return { statusCode: 500, body: `Server error: ${e?.message || e}` };
  }
};
