// netlify/functions/mutate.js

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-token",
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
    // award-week-points (ADMIN ONLY)
    // -------------------------
    if (path === "award-week-points") {
      const admin = assertAdmin(event);
      if (!admin.ok) return admin.resp;

      // Stub for next step (points rules + schema)
      return json(200, { ok: true, message: "award-week-points stub (next step)" });
    }

    return json(404, { error: "Not found" });
  } catch (err) {
    return json(500, { error: err?.message || String(err) });
  }
};
