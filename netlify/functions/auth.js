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

  if (raw.startsWith("/.netlify/functions/auth/")) {
    return raw.slice("/.netlify/functions/auth/".length);
  }
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

  // POST /api-auth/join
  if (route === "join" && event.httpMethod === "POST") {
    const authHeader = (event.headers?.authorization || event.headers?.Authorization || "").trim();

    const me = await getUserFromBearer(SUPABASE_URL, SUPABASE_ANON_KEY, authHeader);
    if (!me.ok) return json(me.status, { error: me.error });

    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch {}

    const name = (body.name || "").trim();
    const handicap_index = body.handicap_index ?? null;

    if (!name) return json(400, { error: "Missing name" });

    const payload = {
      name,
      handicap_index,
      user_id: me.user.id,
    };

    // Use service role to upsert player row
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

    return json(200, { ok: true, player: Array.isArray(out) ? out[0] : out });
  }

  return json(404, { error: "Not found", route });
};
