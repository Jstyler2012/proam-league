console.log("SYNC-FIELD LOADED v3 DEBUG");

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
    const week_number = Number(q.week_id ?? q.week_number);
    const pin = q.pin || "";

    if (ADMIN_PIN && pin !== ADMIN_PIN) {
      return json(401, { ok: false, error: "Invalid pin" });
    }
    if (!Number.isFinite(week_number)) {
      return json(400, { ok: false, error: "Missing/invalid week_id" });
    }

    if (!SUPABASE_URL) return json(500, { ok: false, error: "Missing env SUPABASE_URL" });
    if (!SERVICE_KEY) return json(500, { ok: false, error: "Missing env SUPABASE_SERVICE_ROLE_KEY" });

    // Probe Supabase + table existence.
    const url = `${SUPABASE_URL}/rest/v1/week_pro_field?select=week_number&week_number=eq.${week_number}&limit=1`;
    const res = await fetch(url, {
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
      },
    });

    const text = await res.text();

    return json(200, {
      ok: true,
      week_number,
      supabase_status: res.status,
      supabase_body_preview: text.slice(0, 300),
      message: "sync-field debug probe succeeded. Next step is roster fetch + upsert.",
    });
  } catch (err) {
    console.error("sync-field runtime error:", err);
    return json(500, {
      ok: false,
      error: err?.message || String(err),
      stack: err?.stack ? String(err.stack).split("\n").slice(0, 12).join("\n") : undefined,
    });
  }
};
