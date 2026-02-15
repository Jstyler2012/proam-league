// netlify/functions/public.js  (CommonJS Netlify Function)

exports.handler = async (event) => {
  try {
    const path = (event.path || "")
      .replace(/^\/.netlify\/functions\/public\/?/, "")
      .replace(/^\/+/, "");

    // Health check
    if (path === "" || path === "health") {
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: true }),
      };
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PROAM_ADMIN_TOKEN = process.env.PROAM_ADMIN_TOKEN;

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return { statusCode: 500, body: "Missing SUPABASE_URL or SUPABASE_ANON_KEY" };
    }

 const sb = async (method, restPath, bodyObj, extraHeaders = {}) => {
  const url = `${SUPABASE_URL}/rest/v1/${restPath}`;
  const headers = {if (!SUPABASE_SERVICE_ROLE_KEY) {
  return { statusCode: 500, body: "Missing SUPABASE_SERVICE_ROLE_KEY" };
}

headers: {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  "content-type": "application/json",
  Prefer: "resolution=merge-duplicates,return=representation",
},
  if (method !== "GET") headers["content-type"] = "application/json";

  const r = await fetch(url, {
    method,
    headers,
    body: bodyObj ? JSON.stringify(bodyObj) : undefined,
  });

  const text = await r.text();
  if (!r.ok) return { ok: false, status: r.status, text };
  return { ok: true, json: text ? JSON.parse(text) : null };
};

    // Helper: get "current week" as most recently created
    const getCurrentWeek = async () => {
      const out = await sb(
        "GET",
        "weeks?select=id,label,event_key,start_date,end_date,created_at&order=created_at.desc&limit=1"
      );
      if (!out.ok) return out;
      const wk = Array.isArray(out.json) && out.json[0] ? out.json[0] : null;
      return { ok: true, week: wk };
    };

    // -----------------------
    // GET /players
    // -----------------------
    if (path === "players") {
      const out = await sb("GET", "players?select=id,name&order=name.asc");
      if (!out.ok) return { statusCode: out.status, body: out.text };
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(out.json || []),
      };
    }

    // -----------------------
    // GET /pros
    // (no pros table in Supabase, so return a static list for now)
    // -----------------------
    if (path === "pros") {
      const pros = [
        { id: "Rory McIlroy", name: "Rory McIlroy" },
        { id: "Scottie Scheffler", name: "Scottie Scheffler" },
        { id: "Jon Rahm", name: "Jon Rahm" },
        { id: "Xander Schauffele", name: "Xander Schauffele" },
        { id: "Viktor Hovland", name: "Viktor Hovland" },
      ];
      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(pros),
      };
    }

    // -----------------------
    // GET /leaderboard
    // Uses current week (latest) and returns rows
    // -----------------------
    if (path === "leaderboard") {
      const cw = await getCurrentWeek();
      if (!cw.ok) return { statusCode: cw.status, body: cw.text };
      if (!cw.week) {
        return {
          statusCode: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ week: null, rows: [] }),
        };
      }

      const weekId = cw.week.id;

      // Pull entries + player name
      const out = await sb(
        "GET",
        `week_entries?select=your_score,pro_score,total,rank,points,pga_golfer,players(name)&week_id=eq.${weekId}&order=total.asc.nullslast&order=created_at.asc`
      );
      if (!out.ok) return { statusCode: out.status, body: out.text };

      const rows = (out.json || []).map((r) => ({
        player_name: r.players?.name ?? "—",
        playerScore: r.your_score,
        proScore: r.pro_score,
        combined: r.total,
        pga_golfer: r.pga_golfer,
      }));

      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ week: cw.week.label || "Current", rows }),
      };
    }

    // -----------------------
    // POST /submit
    // body: { player_id, pro_id, player_to_par, pro_to_par }
    // Translate into your schema:
    // - pga_golfer = pro_id (string)
    // - your_score = player_to_par
    // - pro_score = pro_to_par (optional)
    // - total = your + pro (if pro present)
    // Upsert on unique (week_id, player_id)
    // -----------------------
    if (path === "submit") {
      if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };const incomingToken =
  event.headers?.["x-admin-token"] ||
  event.headers?.["X-Admin-Token"] ||
  "";

if (!PROAM_ADMIN_TOKEN || incomingToken !== PROAM_ADMIN_TOKEN) {
  return { statusCode: 401, body: "Unauthorized" };
}

      const cw = await getCurrentWeek();
      if (!cw.ok) return { statusCode: cw.status, body: cw.text };
      if (!cw.week) return { statusCode: 400, body: "No week exists yet" };

      let body = {};
      try {
        body = event.body ? JSON.parse(event.body) : {};
      } catch {
        return { statusCode: 400, body: "Invalid JSON body" };
      }

      const player_id = body.player_id;
      const pga_golfer = body.pro_id; // from your HTML select
      const your_score = Number(body.player_to_par);
      const pro_score = body.pro_to_par === null || body.pro_to_par === undefined ? null : Number(body.pro_to_par);

      if (!player_id) return { statusCode: 400, body: "Missing player_id" };
      if (!pga_golfer) return { statusCode: 400, body: "Missing pro_id" };
      if (!Number.isFinite(your_score)) return { statusCode: 400, body: "Invalid player_to_par" };

      const total = Number.isFinite(pro_score) ? your_score + pro_score : null;

      const row = {
        week_id: cw.week.id,
        player_id,
        pga_golfer,
        your_score,
        pro_score: Number.isFinite(pro_score) ? pro_score : null,
        total,
      };

      // Upsert (requires Prefer: resolution=merge-duplicates)
      const url = `${SUPABASE_URL}/rest/v1/week_entries?on_conflict=week_id,player_id`;
      const r = await fetch(url, {
        method: "POST",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          "content-type": "application/json",
          Prefer: "resolution=merge-duplicates,return=representation",
        },
        body: JSON.stringify(row),
      });

      const text = await r.text();
      if (!r.ok) return { statusCode: r.status, body: text };

      let saved = null;
      try { saved = text ? JSON.parse(text) : null; } catch {}

      return {
        statusCode: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ok: true,
          combined_to_par: total,
          saved,
        }),
      };
    }

    return { statusCode: 404, body: "Not found" };
  } catch (e) {
    return { statusCode: 500, body: `Server error: ${e?.message || e}` };
  }
};
