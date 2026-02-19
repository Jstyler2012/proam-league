// netlify/functions/auth.js
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json", ...corsHeaders },
    body: JSON.stringify(body),
  };
}

async function getAuthedUser(event, SUPABASE_URL, SUPABASE_ANON_KEY) {
  const auth = (event.headers?.authorization || event.headers?.Authorization || "").trim();
  if (!auth.startsWith("Bearer ")) return null;

  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: auth,
    },
  });

  if (!r.ok) return null;
  return await r.json();
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SERVICE_KEY) {
    return json(500, { error: "Missing SUPABASE_URL or SUPABASE_ANON_KEY or SUPABASE_SERVICE_ROLE_KEY" });
  }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { body = {}; }

  const name = String(body.name || "").trim();
  const handicap_index_raw = body.handicap_index;

  if (!name) return json(400, { error: "Missing name" });

  // handicap is optional (per your latest note). Store null if blank/invalid.
  let handicap_index = null;
  if (handicap_index_raw !== null && handicap_index_raw !== undefined && String(handicap_index_raw).trim() !== "") {
    const n = Number(handicap_index_raw);
    if (!Number.isFinite(n)) return json(400, { error: "Invalid handicap_index" });
    handicap_index = n;
  }

  const user = await getAuthedUser(event, SUPABASE_URL, SUPABASE_ANON_KEY);
  const userId = user?.id;
  const email = user?.email || null;
  if (!userId) return json(401, { error: "Not logged in" });

  // 1) See if this user already has a player row
  const find = await fetch(
    `${SUPABASE_URL}/rest/v1/players?select=id,name,handicap_index,user_id&user_id=eq.${userId}&limit=1`,
    {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
    }
  );

  const findText = await find.text();
  if (!find.ok) return json(find.status, { error: findText });

  let existing = null;
  try { existing = JSON.parse(findText || "[]")[0] || null; } catch { existing = null; }

  // 2) Upsert behavior:
  // - if exists: update name/handicap (lets users fix typos mid-season)
  // - else: insert a new row
  if (existing?.id) {
    const patch = await fetch(`${SUPABASE_URL}/rest/v1/players?id=eq.${existing.id}`, {
      method: "PATCH",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "content-type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({ name, handicap_index }),
    });

    const patchText = await patch.text();
    if (!patch.ok) return json(patch.status, { error: patchText });

    let updated = null;
    try { updated = JSON.parse(patchText || "[]")[0] || null; } catch { updated = null; }
    return json(200, { ok: true, mode: "updated", user: { id: userId, email }, player: updated });
  }

  // Insert new player linked to auth user
  const insert = await fetch(`${SUPABASE_URL}/rest/v1/players`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "content-type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({ user_id: userId, name, handicap_index }),
  });

  const insertText = await insert.text();
  if (!insert.ok) return json(insert.status, { error: insertText });

  let created = null;
  try { created = JSON.parse(insertText || "[]")[0] || null; } catch { created = null; }
  return json(200, { ok: true, mode: "created", user: { id: userId, email }, player: created });
};
