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

async function sbService(SUPABASE_URL, SERVICE_KEY, method, restPath, bodyObj, prefer) {
  const headers = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
  };

  if (method !== "GET") headers["content-type"] = "application/json";
  if (prefer) headers.Prefer = prefer;

  const r = await fetch(`${SUPABASE_URL}/rest/v1/${restPath}`, {
    method,
    headers,
    body: bodyObj ? JSON.stringify(bodyObj) : undefined,
  });

  const t = await r.text();
  if (!r.ok) throw new Error(t || r.statusText);
  return t ? JSON.parse(t) : null;
}

function routeFrom(event) {
  const raw = (event.path || "").split("?")[0];

  // because netlify.toml uses /.netlify/functions/mutate/:splat
  if (raw.startsWith("/.netlify/functions/mutate/")) {
    return raw.slice("/.netlify/functions/mutate/".length);
  }

  // fallback if hit directly
  if (raw.startsWith("/api-mutate/")) {
    return raw.slice("/api-mutate/".length);
  }

  return raw.replace(/^\/+|\/+$/g, "");
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

    if (!SUPABASE_URL || !SERVICE_KEY || !SUPABASE_ANON_KEY) {
      return json(500, { error: "Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or SUPABASE_ANON_KEY" });
    }

    const path = routeFrom(event);

    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch { body = {}; }

    // -------------------------
    // participate (AUTH REQUIRED)
    // POST /api-mutate/participate { week_id, participate:true|false }
    // -------------------------
    if (path === "participate") {
      const { week_id, participate } = body;
      if (!week_id) return json(400, { error: "Missing week_id" });

      const userId = await getAuthedUserId(event, SUPABASE_URL, SUPABASE_ANON_KEY);
      if (!userId) return json(401, { error: "Not logged in" });

      // Find player linked to auth user
      const found = await sbService(
        SUPABASE_URL,
        SERVICE_KEY,
        "GET",
        `players?select=id&user_id=eq.${userId}&limit=1`
      );
      const playerId = found?.[0]?.id || null;
      if (!playerId) {
        return json(403, { error: "No player linked to this login yet. Go to Sign Up and create your profile." });
      }

      const want = (participate === undefined || participate === null) ? true : Boolean(participate);

      if (want) {
        const row = { week_id, player_id: playerId };
        const saved = await sbService(
          SUPABASE_URL,
          SERVICE_KEY,
          "POST",
          `week_participants?on_conflict=week_id,player_id`,
          row,
          "resolution=merge-duplicates,return=representation"
        );
        return json(200, { ok: true, mode: "joined", row: saved?.[0] || null });
      } else {
        await sbService(
          SUPABASE_URL,
          SERVICE_KEY,
          "DELETE",
          `week_participants?week_id=eq.${week_id}&player_id=eq.${playerId}`
        );
        return json(200, { ok: true, mode: "left" });
      }
    }

    // -------------------------
    // submit-score (PUBLIC)
    // POST /api-mutate/submit-score { week_id, player_id, pro_id, player_to_par, pro_to_par }
    // -------------------------
   // -------------------------
// submit-score (LOCK ENFORCED)
// -------------------------
if (path === "submit-score") {
  const { week_id, player_id, pro_id, player_to_par, pro_to_par } = body;

  if (!week_id || !player_id || !pro_id) {
    return json(400, { error: "Missing required fields" });
  }

  // Load week lock time
  const weeks = await sbService(
    SUPABASE_URL,
    SERVICE_KEY,
    "GET",
    `weeks?select=week_number,label,lock_at&week_number=eq.${week_id}&limit=1`
  );

  const wk = weeks?.[0];

  if (!wk) {
    return json(404, { error: "Week not found" });
  }

  if (!wk.lock_at) {
    return json(403, {
      error: "Scoring disabled: lock time not configured."
    });
  }

  const now = new Date();
  const lockAt = new Date(wk.lock_at);

  if (now < lockAt) {
    return json(403, {
      error: "Draft still open. Scoring unlocks when tournament starts.",
      unlock_at: wk.lock_at
    });
  }

  const your_score = Number(player_to_par);
  const pro_score = pro_to_par != null ? Number(pro_to_par) : null;

  if (!Number.isFinite(your_score)) {
    return json(400, { error: "Invalid player score" });
  }

  if (pro_score != null && !Number.isFinite(pro_score)) {
    return json(400, { error: "Invalid pro score" });
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

  const inserted = await sbService(
    SUPABASE_URL,
    SERVICE_KEY,
    "POST",
    `week_entries?on_conflict=week_id,player_id`,
    row,
    "resolution=merge-duplicates,return=representation"
  );

  return json(200, { ok: true, entry: inserted?.[0] || null });
}
    // -------------------------
    // draft-pick (AUTH REQUIRED)
    // POST /api-mutate/draft-pick { week_id, pro_id }
    // -------------------------
    if (path === "draft-pick") {
      const { week_id, pro_id } = body;

      if (!week_id || !pro_id) {
        return json(400, { error: "Missing week_id or pro_id" });
      }

      const userId = await getAuthedUserId(event, SUPABASE_URL, SUPABASE_ANON_KEY);
      if (!userId) return json(401, { error: "Not logged in" });

      const found = await sbService(
        SUPABASE_URL,
        SERVICE_KEY,
        "GET",
        `players?select=id&user_id=eq.${userId}&limit=1`
      );
      const playerId = found?.[0]?.id || null;
      if (!playerId) {
        return json(403, { error: "No player linked to this login yet. Go to Sign Up and create your profile." });
      }

      const row = { week_id, player_id: playerId, pga_golfer: pro_id };

      const saved = await sbService(
        SUPABASE_URL,
        SERVICE_KEY,
        "POST",
        `week_entries?on_conflict=week_id,player_id`,
        row,
        "resolution=merge-duplicates,return=representation"
      );

      return json(200, { ok: true, entry: saved?.[0] || null });
    }

    return json(404, { error: "Not found", path });
  } catch (err) {
    return json(500, { error: err?.message || String(err) });
  }
};
