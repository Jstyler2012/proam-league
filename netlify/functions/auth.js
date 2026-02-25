// netlify/functions/auth.js

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(statusCode, bodyObj) {
  return {
    statusCode,
    headers: { "content-type": "application/json", ...corsHeaders },
    body: JSON.stringify(bodyObj),
  };
}

function text(statusCode, bodyText) {
  return {
    statusCode,
    headers: { "content-type": "text/plain; charset=utf-8", ...corsHeaders },
    body: bodyText,
  };
}

function routeFrom(event) {
  const raw = (event.path || "").split("?")[0];

  // netlify redirect uses /.netlify/functions/auth/:splat
  if (raw.startsWith("/.netlify/functions/auth/")) {
    return raw.slice("/.netlify/functions/auth/".length);
  }
  // fallback
  if (raw.startsWith("/api-auth/")) {
    return raw.slice("/api-auth/".length);
  }
  return raw.replace(/^\/+|\/+$/g, "");
}

async function getUserFromBearer(SUPABASE_URL, SUPABASE_ANON_KEY, authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { ok: false, status: 401, error: "Missing Bearer token" };
  }

  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: authHeader,
    },
  });

  const t = await r.text();
  if (!r.ok) return { ok: false, status: r.status, error: t };

  try {
    return { ok: true, user: JSON.parse(t) };
  } catch {
    return { ok: false, status: 500, error: "Failed to parse auth user" };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE) {
    return text(500, "Missing SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY");
  }

  const route = routeFrom(event);

  // ----------------------------------------
  // POST /api-auth/ensure-profile
  // Creates players row if missing using auth user_metadata (name/handicap_index)
  // ----------------------------------------
  if (route === "ensure-profile" && event.httpMethod === "POST") {
    const authHeader = (event.headers?.authorization || event.headers?.Authorization || "").trim();
    const me = await getUserFromBearer(SUPABASE_URL, SUPABASE_ANON_KEY, authHeader);
    if (!me.ok) return json(me.status, { error: me.error });

    // Check if player already exists
    const check = await fetch(
      `${SUPABASE_URL}/rest/v1/players?select=id,name,handicap_index,user_id&user_id=eq.${encodeURIComponent(me.user.id)}&limit=1`,
      {
        headers: {
          apikey: SERVICE,
          Authorization: `Bearer ${SERVICE}`,
        },
      }
    );

    const checkText = await check.text();
    if (!check.ok) return text(check.status, checkText);

    let existing = null;
    try {
      existing = (JSON.parse(checkText) || [])[0] || null;
    } catch {
      existing = null;
    }

    if (existing) {
      return json(200, { ok: true, player: existing, created: false });
    }

    // Pull from metadata
    const meta = me.user?.user_metadata || {};
    const name = String(meta.name || "").trim();
    const handicap_index = meta.handicap_index ?? null;

    if (!name) {
      return json(400, { error: "Missing name in user metadata; complete profile manually." });
    }

    const payload = {
      name,
      handicap_index,
      user_id: me.user.id,
    };

    const r = await fetch(`${SUPABASE_URL}/rest/v1/players?on_conflict=user_id`, {
      method: "POST",
      headers: {
        apikey: SERVICE,
        Authorization: `Bearer ${SERVICE}`,
        "content-type": "application/json",
        Prefer: "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify(payload),
    });

    const t = await r.text();
    if (!r.ok) return text(r.status, t);

    let out = null;
    try { out = JSON.parse(t); } catch { out = t; }
    const player = Array.isArray(out) ? out[0] : out;

    return json(200, { ok: true, player, created: true });
  }

  // ----------------------------------------
  // POST /api-auth/join
  // (kept compatible) Now allows fallback to user_metadata
  // ----------------------------------------
  if (route === "join" && event.httpMethod === "POST") {
    const authHeader = (event.headers?.authorization || event.headers?.Authorization || "").trim();
    const me = await getUserFromBearer(SUPABASE_URL, SUPABASE_ANON_KEY, authHeader);
    if (!me.ok) return json(me.status, { error: me.error });

    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch {}

    const meta = me.user?.user_metadata || {};
    const name = String((body.name ?? meta.name) || "").trim();
    const handicap_index = (body.handicap_index ?? meta.handicap_index) ?? null;

    if (!name) return json(400, { error: "Missing name" });

    const payload = {
      name,
      handicap_index,
      user_id: me.user.id,
    };

    const r = await fetch(`${SUPABASE_URL}/rest/v1/players?on_conflict=user_id`, {
      method: "POST",
      headers: {
        apikey: SERVICE,
        Authorization: `Bearer ${SERVICE}`,
        "content-type": "application/json",
        Prefer: "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify(payload),
    });

    const t = await r.text();
    if (!r.ok) return text(r.status, t);

    let out = null;
    try { out = JSON.parse(t); } catch { out = t; }
    const player = Array.isArray(out) ? out[0] : out;

    return json(200, { ok: true, player });
  }

  return json(404, { error: "Not found", route });
};
