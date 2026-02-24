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

function routeFrom(event) {
  const raw = (event.path || "").split("?")[0];

  // netlify.toml uses /.netlify/functions/mutate/:splat
  if (raw.startsWith("/.netlify/functions/mutate/")) {
    return raw.slice("/.netlify/functions/mutate/".length);
  }
  if (raw.startsWith("/api-mutate/")) {
    return raw.slice("/api-mutate/".length);
  }
  return raw.replace(/^\/+|\/+$/g, "");
}

function safeJson(body) {
  if (!body) return {};
  try { return JSON.parse(body); } catch (e) { return {}; }
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

function looksLikeUuid(x) {
  return typeof x === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
}

async function weekNumberToUuid(SUPABASE_URL, SERVICE_KEY, weekNumber) {
  const wk = await sbService(
    SUPABASE_URL,
    SERVICE_KEY,
    "GET",
    `weeks?select=id&week_number=eq.${encodeURIComponent(String(weekNumber))}&limit=1`
  );
  return wk?.[0]?.id || null;
}

async function normalizeWeekIdToUuid(SUPABASE_URL, SERVICE_KEY, week_id) {
  // Frontend sends week_number (0, -1, 1..15). DB uses weeks.id (uuid).
  if (looksLikeUuid(week_id)) return week_id;
  const n = Number(week_id);
  if (!Number.isFinite(n)) return null;
  return await weekNumberToUuid(SUPABASE_URL, SERVICE_KEY, n);
}

async function authedPlayerId(event, SUPABASE_URL, SUPABASE_ANON_KEY, SERVICE_KEY) {
  const userId = await getAuthedUserId(event, SUPABASE_URL, SUPABASE_ANON_KEY);
  if (!userId) return { error: json(401, { error: "Not logged in" }), playerId: null };

  const found = await sbService(
    SUPABASE_URL,
    SERVICE_KEY,
    "GET",
    `players?select=id&user_id=eq.${encodeURIComponent(userId)}&limit=1`
  );

  const playerId = found?.[0]?.id || null;
  if (!playerId) {
    return { error: json(403, { error: "No player linked to this login yet. Go to Sign Up and create your profile." }), playerId: null };
  }
  return { error: null, playerId };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SERVICE_KEY || !SUPABASE_ANON_KEY) {
    return json(500, { error: "Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or SUPABASE_ANON_KEY" });
  }

  const path = routeFrom(event);
  const body = safeJson(event.body);

  try {
    // -------------------------
    // participate (AUTH REQUIRED)
    // POST /api-mutate/participate { week_id, participate:true|false }
    // -------------------------
    if (path === "participate") {
      const { week_id, participate } = body;
      if (week_id === undefined || week_id === null || week_id === "") return json(400, { error: "Missing week_id" });

      const { error, playerId } = await authedPlayerId(event, SUPABASE_URL, SUPABASE_ANON_KEY, SERVICE_KEY);
      if (error) return error;

      const want = (participate === undefined || participate === null) ? true : Boolean(participate);

      // Your rule: once joined, cannot leave
      if (want === false) return json(403, { error: "Participation is locked for the week once confirmed." });

      const weekUuid = await normalizeWeekIdToUuid(SUPABASE_URL, SERVICE_KEY, week_id);
      if (!weekUuid) return json(404, { error: "Week not found" });

      const row = { week_id: weekUuid, player_id: playerId };

      const saved = await sbService(
        SUPABASE_URL,
        SERVICE_KEY,
        "POST",
        `week_participants?on_conflict=week_id,player_id`,
        row,
        "resolution=merge-duplicates,return=representation"
      );

      return json(200, { ok: true, mode: "joined", row: saved?.[0] || null });
    }

    // -------------------------
    // submit-round (AUTH REQUIRED)
    // POST /api-mutate/submit-round { week_id, score_to_par }
    // -------------------------
    if (path === "submit-round") {
      const { week_id, score_to_par } = body;
      if (week_id === undefined || week_id === null || week_id === "") return json(400, { error: "Missing week_id" });

      const score = Number(score_to_par);
      if (!Number.isFinite(score)) return json(400, { error: "Invalid score_to_par" });

      const { error, playerId } = await authedPlayerId(event, SUPABASE_URL, SUPABASE_ANON_KEY, SERVICE_KEY);
      if (error) return error;

      const weekUuid = await normalizeWeekIdToUuid(SUPABASE_URL, SERVICE_KEY, week_id);
      if (!weekUuid) return json(404, { error: "Week not found" });

      const row = {
        week_id: weekUuid,
        player_id: playerId,
        score_to_par: score,
        played_at: new Date().toISOString(),
      };

      const inserted = await sbService(
        SUPABASE_URL,
        SERVICE_KEY,
        "POST",
        "player_rounds",
        row,
        "return=representation"
      );

      return json(200, { ok: true, round: inserted?.[0] || null });
    }

    return json(404, { error: "Not found", path });
  } catch (err) {
    return json(500, { error: err?.message || String(err) });
  }
};