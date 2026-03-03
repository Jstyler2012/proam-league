console.log("SYNC-FIELD LOADED v2 TEST");
// netlify/functions/sync-field.js
// MINIMAL sanity check function: should ALWAYS return JSON.
// If this still returns "Internal Error. ID ...", the issue is bundling/deploy config, not business logic.

const ADMIN_PIN = process.env.ADMIN_PIN || process.env.ADMIN_TOKEN || process.env.SYNC_PIN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  try {
    const q = event.queryStringParameters || {};
    const pin = q.pin || "";

    if (ADMIN_PIN && pin !== ADMIN_PIN) {
      return json(401, { ok: false, error: "Invalid pin" });
    }

    if (!SUPABASE_URL) return json(500, { ok: false, error: "Missing SUPABASE_URL" });
    if (!SERVICE_KEY) return json(500, { ok: false, error: "Missing SUPABASE_SERVICE_ROLE_KEY" });

    const week_number = Number(q.week_id ?? q.week_number ?? 0);

    // Simple Supabase read to prove connectivity + table exists
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/week_pro_field?select=week_number&week_number=eq.${week_number}&limit=1`,
      {
        headers: {
          apikey: SERVICE_KEY,
          Authorization: `Bearer ${SERVICE_KEY}`,
        },
      }
    );

    const text = await res.text();

    return json(200, {
      ok: true,
      week_number,
      supabase_status: res.status,
      supabase_body_preview: text.slice(0, 200),
      message:
        "sync-field minimal sanity check succeeded. If you see this, the previous Internal Error was caused by code inside your old sync-field implementation.",
    });
  } catch (err) {
    return json(500, { ok: false, error: err.message || String(err) });
  }
};
