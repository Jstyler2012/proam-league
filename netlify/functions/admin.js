// netlify/functions/admin.js

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function getHeader(event, name) {
  const h = event.headers || {};
  return (h[name] || h[name.toLowerCase()] || "").trim();
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders, body: "" };

  try {
    const path = (event.path || "")
      .replace(/^\/\.netlify\/functions\/admin\/?/, "")
      .replace(/^\/+/, "");

    const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || "").trim();
    const got = getHeader(event, "x-admin-token");

    if (!ADMIN_TOKEN || got !== ADMIN_TOKEN) {
      return { statusCode: 401, headers: corsHeaders, body: "Unauthorized" };
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return { statusCode: 500, headers: corsHeaders, body: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" };
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

    if (event.httpMethod !== "POST") return { statusCode: 405, headers: corsHeaders, body: "Method not allowed" };

    const getCurrentWeek = async () => {
      const weeks = await sb(
        "GET",
        "weeks?select=id,label,week_number,start_date,end_date&week_number=not.is.null&order=week_number.asc"
      );
      if (!weeks?.length) return null;

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

    if (path === "reset-week") {
      const week = await getCurrentWeek();
      if (!week) return { statusCode: 400, headers: corsHeaders, body: "No scheduled weeks exist" };

      await sb("DELETE", `week_entries?week_id=eq.${week.id}`);
      return {
        statusCode: 200,
        headers: { "content-type": "application/json", ...corsHeaders },
        body: JSON.stringify({ ok: true, week_id: week.id }),
      };
    }

    if (path === "recalc") {
      return {
        statusCode: 200,
        headers: { "content-type": "application/json", ...corsHeaders },
        body: JSON.stringify({ ok: true, message: "recalc placeholder" }),
      };
    }

    return { statusCode: 404, headers: corsHeaders, body: "Not found" };
  } catch (e) {
    return { statusCode: 500, headers: corsHeaders, body: `Server error: ${e?.message || e}` };
  }
};
