// netlify/functions/admin.js

exports.handler = async (event) => {
  try {
    const path = (event.path || "")
      .replace(/^\/.netlify\/functions\/admin\/?/, "")
      .replace(/^\/+/, "");

    const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
    const got = (event.headers?.["x-admin-token"] || event.headers?.["X-Admin-Token"] || "").trim();

    if (!ADMIN_TOKEN || got !== ADMIN_TOKEN) {
      return { statusCode: 401, body: "Unauthorized" };
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return { statusCode: 500, body: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" };
    }

    const sb = async (method, restPath, bodyObj) => {
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
      const text = await r.text();
      if (!r.ok) throw new Error(text || r.statusText);
      return text ? JSON.parse(text) : null;
    };

    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

    if (path === "reset-week") {
      // Example: wipe current week's entries (latest week)
      const w = await sb("GET", `weeks?select=id&order=created_at.desc&limit=1`);
      const week = w?.[0];
      if (!week) return { statusCode: 400, body: "No week exists" };

      // delete entries for that week
      await sb("DELETE", `week_entries?week_id=eq.${week.id}`);
      return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true }) };
    }

    if (path === "recalc") {
      // Placeholder: you can implement a recalc strategy later.
      return { statusCode: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ ok: true, message: "recalc placeholder" }) };
    }

    return { statusCode: 404, body: "Not found" };
  } catch (e) {
    return { statusCode: 500, body: `Server error: ${e?.message || e}` };
  }
};
