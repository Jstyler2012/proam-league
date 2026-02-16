// netlify/functions/mutate.js

const crypto = require("crypto");

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

function sha256Hex(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders };
  }

  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SERVICE_KEY) {
      return json(500, { error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" });
    }

    const path = (event.path || "")
      .replace(/^\/.netlify\/functions\/mutate\/?/, "")
      .replace(/^\/+/, "");

    if (event.httpMethod !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    // Admin token check
    const adminToken = event.headers["x-admin-token"] || event.headers["X-Admin-Token"];

    if (!adminToken) {
      return json(401, { error: "Missing x-admin-token" });
    }

    const tokenHash = sha256Hex(adminToken);

    const checkResp = await fetch(
      `${SUPABASE_URL}/rest/v1/admin_tokens?select=id&token_hash=eq.${tokenHash}&revoked_at=is.null&limit=1`,
      {
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
        },
      }
    );

    const checkText = await checkResp.text();

    if (!checkResp.ok) {
      return json(checkResp.status, { error: checkText });
    }

    const checkRows = JSON.parse(checkText);

    if (!checkRows.length) {
      return json(401, { error: "Invalid admin token" });
    }

    const body = JSON.parse(event.body || "{}");

    // submit-score endpoint
    if (path === "submit-score") {

      const { week_id, player_id, pro_id, player_to_par, pro_to_par } = body;

      if (!week_id || !player_id || !pro_id) {
        return json(400, { error: "Missing week_id, player_id, or pro_id" });
      }

      const your_score = Number(player_to_par);
      const pro_score = pro_to_par != null ? Number(pro_to_par) : null;

      if (!Number.isFinite(your_score)) {
        return json(400, { error: "Invalid player_to_par" });
      }

      if (pro_score != null && !Number.isFinite(pro_score)) {
        return json(400, { error: "Invalid pro_to_par" });
      }

      const total = pro_score != null ? your_score + pro_score : null;

      const row = {
        week_id,
        player_id,
        pga_golfer: pro_id,
        your_score,
        pro_score,
        total,
      };

      const insertResp = await fetch(
        `${SUPABASE_URL}/rest/v1/week_entries?on_conflict=week_id,player_id`,
        {
          method: "POST",
          headers: {
            apikey: SERVICE_KEY,
            Authorization: `Bearer ${SERVICE_KEY}`,
            "content-type": "application/json",
            Prefer: "resolution=merge-duplicates,return=representation",
          },
          body: JSON.stringify(row),
        }
      );

      const insertText = await insertResp.text();

      if (!insertResp.ok) {
        return json(insertResp.status, { error: insertText });
      }

      return json(200, {
        ok: true,
        entry: JSON.parse(insertText)[0],
      });
    }

    return json(404, { error: "Not found" });

  } catch (err) {
    return json(500, { error: err.message });
  }
};
