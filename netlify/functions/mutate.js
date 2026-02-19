// netlify/functions/mutate.js

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-token, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json", ...corsHeaders },
    body: JSON.stringify(body),
  };
}

function getHeader(event, name) {
  const h = event.headers || {};
  return (h[name] || h[name.toLowerCase()] || "").trim();
}

function assertAdmin(event) {
  const need = (process.env.ADMIN_TOKEN || "").trim();
  const got = getHeader(event, "x-admin-token");
  if (!need) return { ok: false, resp: json(500, { error: "Missing ADMIN_TOKEN env var" }) };
  if (!got || got !== need) return { ok: false, resp: json(401, { error: "Unauthorized" }) };
  return { ok: true };
}

async function getAuthedUserId(event, SUPABASE_URL, SUPABASE_ANON_KEY) {
  const auth = (event.headers?.authorization || event.headers?.Authorization || "").trim();
  if (!auth.startsWith("Bearer ")) return null;

  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: auth,
    },
  });

  if (!r.ok) return null;
  const u = await r.json();
  return u?.id || null;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders, body: "" };

  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!SUPABASE_URL || !SERVICE_KEY) {
      return json(500, { error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" });
    }

    const path = (event.path || "")
      .replace(/^\/\.netlify\/functions\/mutate\/?/, "")
      .replace(/^\/+/, "");

    if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch { body = {}; }

    // -------------------------
    // submit-score (PUBLIC)
    // -------------------------
    if (path === "submit-score") {
      const { week_id, player_id, pro_id, player_to_par, pro_to_par } = body;

      if (!week_id || !player_id || !pro_id) {
        return json(400, { error: "Missing week_id, player_id, or pro_id" });
      }

      const your_score = Number(player_to_par);
      const pro_score = pro_to_par != null ? Number(pro_to_par) : null;

      if (!Number.isFinite(your_score)) return json(400, { error: "Invalid player_to_par" });
      if (pro_score != null && !Number.isFinite(pro_score)) return json(400, { error: "Invalid pro_to_par" });

      const total = pro_score != null ? your_score + pro_score : null;

      const row = {
        week_id,
        player_id,
        pga_golfer: pro_id,
        your_score,
        pro_score,
        total,
      };

      const insertResp = await fetch(`${SUPABASE_URL}/rest/v1/week_entries?on_conflict=week_id,player_id`, {
        method: "POST",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "content-type": "application/json",
          Prefer: "resolution=merge-duplicates,return=representation",
        },
        body: JSON.stringify(row),
      });

      const insertText = await insertResp.text();
      if (!insertResp.ok) return json(insertResp.status, { error: insertText });

      let inserted = null;
      try { inserted = JSON.parse(insertText)[0]; } catch { inserted = null; }
      return json(200, { ok: true, entry: inserted });
    }

    // -------------------------
    // draft-pick (PUBLIC, AUTH REQUIRED)
    // Sets/updates only pga_golfer for the logged-in user's linked player row.
    // -------------------------
    if (path === "draft-pick") {
      const { week_id, pro_id } = body;

      if (!week_id || !pro_id) {
        return json(400, { error: "Missing week_id or pro_id" });
      }

      const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
      if (!SUPABASE_ANON_KEY) {
        return json(500, { error: "Missing SUPABASE_ANON_KEY" });
      }

      const userId = await getAuthedUserId(event, SUPABASE_URL, SUPABASE_ANON_KEY);
      if (!userId) return json(401, { error: "Not logged in" });

      // Find the player row linked to this auth user
      const findResp = await fetch(
        `${SUPABASE_URL}/rest/v1/players?select=id&user_id=eq.${userId}&limit=1`,
        {
          headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
          },
        }
      );

      const findText = await findResp.text();
      if (!findResp.ok) return json(findResp.status, { error: findText });

      let found = null;
      try { found = JSON.parse(findText || "[]")[0] || null; } catch { found = null; }
      if (!found?.id) {
        return json(403, { error: "No player linked to this login (players.user_id not set)." });
      }

      const row = {
        week_id,
        player_id: found.id,
        pga_golfer: pro_id,
      };

      const upsertResp = await fetch(`${SUPABASE_URL}/rest/v1/week_entries?on_conflict=week_id,player_id`, {
        method: "POST",
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
          "content-type": "application/json",
          Prefer: "resolution=merge-duplicates,return=representation",
        },
        body: JSON.stringify(row),
      });

      const upsertText = await upsertResp.text();
      if (!upsertResp.ok) return json(upsertResp.status, { error: upsertText });

      let saved = null;
      try { saved = JSON.parse(upsertText)[0]; } catch { saved = null; }
      return json(200, { ok: true, entry: saved });
    }

    // -------------------------
    // award-week-points (ADMIN ONLY)
    // -------------------------
    if (path === "award-week-points") {
      const admin = assertAdmin(event);
      if (!admin.ok) return admin.resp;

      return json(200, { ok: true, message: "award-week-points stub (next step)" });
    }

    return json(404, { error: "Not found" });
  } catch (err) {
    return json(500, { error: err?.message || String(err) });
  }
};
