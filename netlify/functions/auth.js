// netlify/functions/auth.js
// Self-signup profile creation/update (requires logged-in user)
// Route: POST /.netlify/functions/auth/join  (via /api-auth/join)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

function getRoute(event) {
  const raw = (event.path || "").split("?")[0];
  const cleaned = raw.replace(/^\/+|\/+$/g, "");
  const parts = cleaned.split("/");
  const idx = parts.lastIndexOf("auth");
  if (idx >= 0) return parts.slice(idx + 1).join("/");
  if (parts[0] === ".netlify" && parts[1] === "functions") return parts.slice(3).join("/");
  return cleaned;
}

async function getAuthedUser(event, SUPABASE_URL, SUPABASE_ANON_KEY) {
  const auth = (event.headers?.authorization || event.headers?.Authorization || "").trim();
  if (!auth.startsWith("Bearer ")) return { ok: false, status: 401, error: "Not logged in" };

  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: auth,
    },
  });

  const t = await r.text();
  if (!r.ok) return { ok: false, status: r.status, error: t || "Invalid session" };

  let u = null;
  try { u = JSON.parse(t); } catch { u = null; }
  const userId = u?.id || null;
  if (!userId) return { ok: false, status: 401, error: "Invalid session" };

  return { ok: true, user: { id: userId, email: u?.email || null } };
}

async function sbService(SUPABASE_URL, SERVICE_ROLE, method, restPath, bodyObj) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${restPath}`, {
    method,
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "content-type": "application/json",
      Prefer: "return=representation",
    },
    body: bodyObj ? JSON.stringify(bodyObj) : undefined,
  });

  const t = await r.text();
  if (!r.ok) throw new Error(t || r.statusText);
  return t ? JSON.parse(t) : null;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders, body: "" };

  try {
    const route = getRoute(event);

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_ROLE) {
      return json(500, { error: "Missing SUPABASE_URL, SUPABASE_ANON_KEY, or SUPABASE_SERVICE_ROLE_KEY" });
    }

    if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

    let body = {};
    try { body = JSON.parse(event.body || "{}"); } catch { body = {}; }

    // -------------------------
    // POST join
    // Creates or updates players row linked to auth user_id
    // -------------------------
    if (route === "join") {
      const { name, handicap_index } = body;

      const cleanName = String(name || "").trim();
      if (!cleanName) return json(400, { error: "Missing name" });

      const hRaw = handicap_index === "" || handicap_index == null ? null : Number(handicap_index);
      if (hRaw != null && !Number.isFinite(hRaw)) return json(400, { error: "Invalid handicap_index" });

      const me = await getAuthedUser(event, SUPABASE_URL, SUPABASE_ANON_KEY);
      if (!me.ok) return json(me.status, { error: me.error });

      const userId = me.user.id;

      // find existing player by user_id
      const existing = await sbService(
        SUPABASE_URL,
        SERVICE_ROLE,
        "GET",
        `players?select=id,name,handicap_index,user_id&user_id=eq.${userId}&limit=1`
      );

      if (existing && existing[0]?.id) {
        const id = existing[0].id;

        const updated = await sbService(
          SUPABASE_URL,
          SERVICE_ROLE,
          "PATCH",
          `players?id=eq.${id}`,
          { name: cleanName, handicap_index: hRaw }
        );

        return json(200, { ok: true, mode: "updated", player: updated?.[0] || null });
      }

      // create new player
      const inserted = await sbService(
        SUPABASE_URL,
        SERVICE_ROLE,
        "POST",
        `players`,
        { name: cleanName, handicap_index: hRaw, user_id: userId }
      );

      return json(200, { ok: true, mode: "created", player: inserted?.[0] || null });
    }

    return text(404, "Not found");
  } catch (e) {
    return json(500, { error: e?.message || String(e) });
  }
};
