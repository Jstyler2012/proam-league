// netlify/functions/admin.js
// Admin-only endpoints (POST) protected by x-admin-token header.
// Uses Supabase SERVICE ROLE key (server-side only).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-token",
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

function getHeader(event, name) {
  const h = event.headers || {};
  return (h[name] || h[name.toLowerCase()] || "").trim();
}

// supports:
// /.netlify/functions/admin/<route>
// /admin/<route> (if you later add a redirect)
function getRoute(event) {
  const raw = (event.path || "").split("?")[0];
  const cleaned = raw.replace(/^\/+|\/+$/g, "");
  const parts = cleaned.split("/");

  const idx = parts.lastIndexOf("admin");
  if (idx >= 0) return parts.slice(idx + 1).join("/");

  return cleaned;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return text(405, "Method not allowed");
  }

  try {
    // --- auth gate ---
    const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || "").trim();
    const got = getHeader(event, "x-admin-token");

    if (!ADMIN_TOKEN) return text(500, "Missing ADMIN_TOKEN env var");
    if (!got || got !== ADMIN_TOKEN) return text(401, "Unauthorized");

    // --- supabase env ---
    const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
    const SERVICE_ROLE = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return text(500, "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    }

    const sb = async (method, restPath, bodyObj) => {
      const url = `${SUPABASE_URL}/rest/v1/${restPath}`;
      const headers = {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        Prefer: "return=representation",
      };
      if (method !== "GET") headers["content-type"] = "application/json";

      const r = await fetch(url, {
        method,
        headers,
        body: bodyObj ? JSON.stringify(bodyObj) : undefined,
      });

      const t = await r.text();
      if (!r.ok) throw new Error(t || r.statusText);
      if (!t) return null;

      try { return JSON.parse(t); }
      catch { return t; }
    };

    const getCurrentWeek = async () => {
      const weeks = await sb(
        "GET",
        "weeks?select=id,label,week_number,start_date,end_date&week_number=not.is.null&order=week_number.asc"
      );

      if (!Array.isArray(weeks) || weeks.length === 0) return null;

      const today = new Date();

      const inRange = weeks.find((w) => {
        if (!w.start_date || !w.end_date) return false;
        const s = new Date(w.start_date + "T00:00:00");
        const e = new Date(w.end_date + "T23:59:59");
        return today >= s && today <= e;
      });
      if (inRange) return inRange;

      const firstStart = weeks[0].start_date ? new Date(weeks[0].start_date + "T00:00:00") : null;
      if (firstStart && today < firstStart) return weeks[0];

      return weeks[weeks.length - 1];
    };

    const route = getRoute(event);

    // POST /.netlify/functions/admin/reset-week
    if (route === "reset-week") {
      const week = await getCurrentWeek();
      if (!week?.id) return json(400, { ok: false, error: "No scheduled weeks exist" });

      // deletes all week_entries for current week (scores + draft picks live in this table in your current schema)
      await sb("DELETE", `week_entries?week_id=eq.${week.id}`);

      return json(200, { ok: true, week_id: week.id, label: week.label || null });
    }

    // POST /.netlify/functions/admin/recalc
    if (route === "recalc") {
      return json(200, { ok: true, message: "recalc placeholder" });
    }

    return text(404, "Not found");
  } catch (e) {
    return text(500, `Server error: ${e?.message || String(e)}`);
  }
};

