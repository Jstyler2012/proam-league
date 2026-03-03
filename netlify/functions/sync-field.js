// netlify/functions/sync-field.js
//
// Admin-only: seed week_pro_field from DataGolf outright odds (no RapidAPI dependency).
//
// Call:
//   /.netlify/functions/sync-field?week_id=0&pin=YOURPIN&force=1
//
// Env required (Netlify):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   DATAGOLF_API_KEY
//   ADMIN_PIN (or PROAM_ADMIN_TOKEN / ADMIN_TOKEN)

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-token, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(statusCode, bodyObj) {
  return {
    statusCode,
    headers: { "content-type": "application/json", ...corsHeaders },
    body: JSON.stringify(bodyObj),
  };
}

function getHeader(event, name) {
  const h = event.headers || {};
  return (h[name] || h[name.toLowerCase()] || "").trim();
}

// Supabase REST helper (service role)
function makeSupabase(SUPABASE_URL, SERVICE_ROLE) {
  return async function sb(method, restPath, bodyObj, extraHeaders) {
    const url = `${SUPABASE_URL}/rest/v1/${restPath}`;
    const headers = {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      Prefer: "return=representation",
      ...(extraHeaders || {}),
    };
    if (method !== "GET") headers["content-type"] = "application/json";

    const r = await fetch(url, {
      method,
      headers,
      body: bodyObj ? JSON.stringify(bodyObj) : undefined,
    });

    const t = await r.text();
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${t}`);
    if (!t) return null;
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  };
}

function decimalToAmerican(dec) {
  const d = Number(dec);
  if (!Number.isFinite(d) || d <= 1) return null;
  if (d >= 2) return `+${Math.round((d - 1) * 100)}`;
  return `${Math.round(-100 / (d - 1))}`;
}

// Extract best decimal odds from DataGolf outrights entry
function extractBestDecimal(entry) {
  const decimals = [];
  for (const [k, v] of Object.entries(entry || {})) {
    if (k === "dg_id" || k === "datagolf") continue;
    if (typeof v === "number" && Number.isFinite(v) && v > 1) decimals.push(v);
  }
  const baseline = Number(entry?.datagolf?.baseline);
  if (!decimals.length && Number.isFinite(baseline) && baseline > 1) decimals.push(baseline);
  if (!decimals.length) return null;
  return Math.min(...decimals);
}

function extractName(entry) {
  return entry?.player_name || entry?.name || entry?.player || entry?.golfer || entry?.full_name || null;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders, body: "" };

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return json(500, { ok: false, error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars" });
    }

    // Admin auth
    const q = event.queryStringParameters || {};
    const pin = String(q.pin || "").trim();
    const headerToken = getHeader(event, "x-admin-token");
    const ADMIN_PIN = process.env.ADMIN_PIN || process.env.ADMIN_TOKEN || process.env.PROAM_ADMIN_TOKEN;

    if (!ADMIN_PIN) {
      return json(500, { ok:false, error:"Missing ADMIN_PIN/ADMIN_TOKEN/PROAM_ADMIN_TOKEN env var on Netlify" });
    }
    if (pin !== ADMIN_PIN && headerToken !== ADMIN_PIN) {
      return json(401, { ok:false, error:"Unauthorized" });
    }

    const weekNum = Number(q.week_id);
    if (!Number.isFinite(weekNum)) return json(400, { ok:false, error:"Missing/invalid week_id" });

    const force = String(q.force || "") === "1";
    const sb = makeSupabase(SUPABASE_URL, SERVICE_ROLE);

    // If not forcing and rows already exist, just report
    const existing = await sb("GET", `week_pro_field?week_number=eq.${weekNum}&select=player_ext_id&limit=1`);
    if (!force && Array.isArray(existing) && existing.length) {
      return json(200, { ok:true, week_number: weekNum, skipped:true, reason:"Rows already exist. Use force=1 to overwrite." });
    }

    const DATAGOLF_API_KEY = process.env.DATAGOLF_API_KEY;
    if (!DATAGOLF_API_KEY) return json(500, { ok:false, error:"Missing DATAGOLF_API_KEY env var on Netlify" });

    const dgUrl =
      `https://feeds.datagolf.com/betting-tools/outrights` +
      `?tour=pga&market=win&odds_format=decimal&file_format=json&key=${encodeURIComponent(DATAGOLF_API_KEY)}`;

    const dgRes = await fetch(dgUrl);
    const dgText = await dgRes.text();
    let dgJson = null;
    try { dgJson = dgText ? JSON.parse(dgText) : null; } catch (_) {}

    if (!dgRes.ok) {
      return json(502, { ok:false, error:`DataGolf ${dgRes.status}`, preview: dgText.slice(0, 300) });
    }

    const arr =
      (dgJson && Array.isArray(dgJson.odds) ? dgJson.odds : null) ||
      (dgJson && Array.isArray(dgJson.players) ? dgJson.players : null) ||
      (dgJson && Array.isArray(dgJson.data) ? dgJson.data : null) ||
      [];

    if (!arr.length) {
      return json(502, { ok:false, error:"DataGolf returned 200 but did not contain odds array", preview: dgText.slice(0, 300) });
    }

    // Build rows
    const rows = [];
    for (const e of arr) {
      const name = extractName(e);
      const dgId = e?.dg_id;
      const bestDec = extractBestDecimal(e);
      if (!name || dgId == null || bestDec == null) continue;

      rows.push({
        week_number: weekNum,
        player_ext_id: String(dgId),
        player_name: String(name),
        odds_numeric: Number(bestDec),
        odds_display: decimalToAmerican(bestDec),
        source: "datagolf",
      });
    }

    if (!rows.length) {
      return json(502, { ok:false, error:"No usable players found in DataGolf response", preview: dgText.slice(0, 300) });
    }

    // Rank by odds (lower decimal = more likely)
    rows.sort((a,b) => a.odds_numeric - b.odds_numeric);
    rows.forEach((r, idx) => { r.odds_rank = idx + 1; });

    // Wipe existing (for force)
    if (force) {
      try { await sb("DELETE", `week_pro_field?week_number=eq.${weekNum}`); } catch (_) {}
    }

    // Upsert in chunks (requires unique constraint on (week_number, player_ext_id))
    const chunk = 200;
    let inserted = 0;
    for (let i=0; i<rows.length; i+=chunk) {
      const part = rows.slice(i, i+chunk);
      const ins = await sb(
        "POST",
        "week_pro_field?on_conflict=week_number,player_ext_id",
        part,
        { Prefer: "return=representation,resolution=merge-duplicates" }
      );
      inserted += Array.isArray(ins) ? ins.length : 0;
    }

    return json(200, { ok:true, week_number: weekNum, inserted_or_updated: inserted, dg_count: arr.length, usable: rows.length });
  } catch (e) {
    console.error("sync-field error:", e);
    return json(500, { ok:false, error: String(e && e.message ? e.message : e) });
  }
};
