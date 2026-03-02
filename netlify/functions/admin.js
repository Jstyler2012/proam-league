// netlify/functions/admin.js
// Admin-only endpoints (POST) protected by x-admin-token header.
// Uses Supabase SERVICE ROLE key (server-side only).
//
// Routes:
//   POST /.netlify/functions/admin/list-weeks
//   POST /.netlify/functions/admin/list-participants { week_id }
//   POST /.netlify/functions/admin/remove-participant { week_id, player_id }
//   POST /.netlify/functions/admin/get-draft { week_id }
//   POST /.netlify/functions/admin/init-draft { week_id, status?, draft_starts_at?, swap_deadline_at? }
//   POST /.netlify/functions/admin/update-draft { week_id, status?, draft_starts_at?, swap_deadline_at? }
//   POST /.netlify/functions/admin/generate-order { week_id }
//   POST /.netlify/functions/admin/wipe-draft { week_id }
//   POST /.netlify/functions/admin/wipe-week { week_id }
//   POST /.netlify/functions/admin/reset-week   (existing behavior: resets current scheduled week)

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
function getRoute(event) {
  const raw = (event.path || "").split("?")[0];
  const cleaned = raw.replace(/^\/+|\/+$/g, "");
  const parts = cleaned.split("/");

  const idx = parts.lastIndexOf("admin");
  if (idx >= 0) return parts.slice(idx + 1).join("/");

  return cleaned;
}

function safeJson(body) {
  if (!body) return {};
  try { return JSON.parse(body); } catch { return {}; }
}

function isMissing(v) {
  return v === undefined || v === null || v === "";
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
    const PROAM_ADMIN_TOKEN = (process.env.PROAM_ADMIN_TOKEN || "").trim();
    const got = getHeader(event, "x-admin-token");

    if (!PROAM_ADMIN_TOKEN) return text(500, "Missing PROAM_ADMIN_TOKEN env var");
    if (!got || got !== PROAM_ADMIN_TOKEN) return text(401, "Unauthorized");

    // --- supabase env ---
    const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
    const SERVICE_ROLE = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return text(500, "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    }

    const sb = async (method, restPath, bodyObj, prefer) => {
      const url = `${SUPABASE_URL}/rest/v1/${restPath}`;
      const headers = {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        Prefer: prefer || "return=representation",
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

    const getWeekUuidFromNumber = async (weekNumber) => {
      const wk = await sb("GET", `weeks?select=id&week_number=eq.${weekNumber}&limit=1`);
      return wk?.[0]?.id || null;
    };

    const getWeekKeyForParticipants = async (weekNumber) => {
      // Try integer key first; if the column is UUID in this project, we need weeks.id
      try {
        await sb("GET", `week_participants?week_id=eq.${weekNumber}&select=week_id&limit=1`);
        return { weekKey: weekNumber, mode: "number" };
      } catch (e) {
        const msg = String(e?.message || "");
        if (!msg.includes("invalid input syntax for type uuid")) throw e;
        const uuid = await getWeekUuidFromNumber(weekNumber);
        if (!uuid) throw new Error("Could not resolve week UUID for that week_number.");
        return { weekKey: uuid, mode: "uuid" };
      }
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
    const body = safeJson(event.body);

    // -------------------------
    // list-weeks
    // -------------------------
    if (route === "list-weeks") {
      const weeks = await sb(
        "GET",
        "weeks?select=id,label,week_number,start_date,end_date&week_number=not.is.null&order=week_number.asc"
      );
      return json(200, { ok: true, weeks: weeks || [] });
    }

    // -------------------------
    // list-participants { week_id }
    // -------------------------
    if (route === "list-participants") {
      const weekNumber = Number(body.week_id);
      if (!Number.isFinite(weekNumber)) return json(400, { ok: false, error: "Missing/invalid week_id" });

      const { weekKey } = await getWeekKeyForParticipants(weekNumber);
      const rows = await sb(
        "GET",
        `week_participants?week_id=eq.${weekKey}&select=player_id,player:players(id,name,handicap_index)`
      );

      const out = (rows || []).map((r) => ({
        player_id: r.player_id,
        player_name: r?.player?.name || "—",
        handicap_index: r?.player?.handicap_index ?? null,
      }));

      return json(200, { ok: true, week_id: weekNumber, rows: out });
    }

    // -------------------------
    // remove-participant { week_id, player_id }
    // Clears: week_participants, week_entries, player_rounds, week_draft_picks
    // -------------------------
    if (route === "remove-participant") {
      const weekNumber = Number(body.week_id);
      const playerId = String(body.player_id || "").trim();
      if (!Number.isFinite(weekNumber)) return json(400, { ok: false, error: "Missing/invalid week_id" });
      if (!playerId) return json(400, { ok: false, error: "Missing player_id" });

      const { weekKey } = await getWeekKeyForParticipants(weekNumber);

      // participation row
      await sb("DELETE", `week_participants?week_id=eq.${weekKey}&player_id=eq.${playerId}`);

      // score/entry rows (these tables use integer week_id in your current app)
      await sb("DELETE", `week_entries?week_id=eq.${weekNumber}&player_id=eq.${playerId}`);
      await sb("DELETE", `player_rounds?week_id=eq.${weekNumber}&player_id=eq.${playerId}`);

      // draft pick rows (if present)
      await sb("DELETE", `week_draft_picks?week_number=eq.${weekNumber}&player_id=eq.${playerId}`);

      return json(200, { ok: true });
    }

    // -------------------------
    // get-draft { week_id }
    // -------------------------
    if (route === "get-draft") {
      const weekNumber = Number(body.week_id);
      if (!Number.isFinite(weekNumber)) return json(400, { ok: false, error: "Missing/invalid week_id" });

      const d = await sb("GET", `week_draft?week_number=eq.${weekNumber}&limit=1`);
      const draft = (d || [])[0] || null;
      return json(200, { ok: true, draft });
    }

    // -------------------------
    // init-draft { week_id, status?, draft_starts_at?, swap_deadline_at? }
    // upserts week_draft row
    // -------------------------
    if (route === "init-draft") {
      const weekNumber = Number(body.week_id);
      if (!Number.isFinite(weekNumber)) return json(400, { ok: false, error: "Missing/invalid week_id" });

      const payload = {
        week_number: weekNumber,
        status: body.status || "PREP",
        draft_starts_at: body.draft_starts_at || null,
        swap_deadline_at: body.swap_deadline_at || null,
      };

      const out = await sb("POST", "week_draft", payload, "return=representation,resolution=merge-duplicates");
      return json(200, { ok: true, draft: (out || [])[0] || null });
    }

    // -------------------------
    // update-draft { week_id, ... }
    // PATCHes week_draft
    // -------------------------
    if (route === "update-draft") {
      const weekNumber = Number(body.week_id);
      if (!Number.isFinite(weekNumber)) return json(400, { ok: false, error: "Missing/invalid week_id" });

      const patch = {};
      if (!isMissing(body.status)) patch.status = body.status;
      if (body.draft_starts_at !== undefined) patch.draft_starts_at = body.draft_starts_at;
      if (body.swap_deadline_at !== undefined) patch.swap_deadline_at = body.swap_deadline_at;

      if (Object.keys(patch).length === 0) return json(400, { ok: false, error: "No fields to update" });

      const out = await sb("PATCH", `week_draft?week_number=eq.${weekNumber}`, patch, "return=representation");
      return json(200, { ok: true, draft: (out || [])[0] || null });
    }

    // -------------------------
    // generate-order { week_id }
    // Generates deterministic order: participants sorted by handicap_index DESC.
    // Writes week_draft_order rows and sets week_draft.status=ORDER_PUBLISHED.
    // -------------------------
    if (route === "generate-order") {
      const weekNumber = Number(body.week_id);
      if (!Number.isFinite(weekNumber)) return json(400, { ok: false, error: "Missing/invalid week_id" });

      const { weekKey } = await getWeekKeyForParticipants(weekNumber);

      const part = await sb(
        "GET",
        `week_participants?week_id=eq.${weekKey}&select=player_id,player:players(id,handicap_index)`
      );

      const rows = (part || [])
        .map((r) => ({
          player_id: r.player_id,
          handicap_index: Number(r?.player?.handicap_index),
        }))
        .filter((r) => r.player_id && Number.isFinite(r.handicap_index))
        .sort((a, b) => b.handicap_index - a.handicap_index);

      // wipe prior order
      await sb("DELETE", `week_draft_order?week_number=eq.${weekNumber}`);

      // insert new
      const payload = rows.map((r, i) => ({
        week_number: weekNumber,
        player_id: r.player_id,
        handicap_index: r.handicap_index,
        handicap_group: null,
        pick_position: i + 1,
        group_position: i + 1,
      }));

      if (payload.length) {
        await sb("POST", "week_draft_order", payload, "return=representation");
      }

      // ensure draft row exists and publish
      await sb(
        "POST",
        "week_draft",
        { week_number: weekNumber, status: "ORDER_PUBLISHED", order_generated_at: new Date().toISOString() },
        "return=representation,resolution=merge-duplicates"
      );

      return json(200, { ok: true, count: payload.length });
    }

    // -------------------------
    // wipe-draft { week_id }
    // Clears week_draft + order + picks + log for week
    // -------------------------
    if (route === "wipe-draft") {
      const weekNumber = Number(body.week_id);
      if (!Number.isFinite(weekNumber)) return json(400, { ok: false, error: "Missing/invalid week_id" });

      await sb("DELETE", `week_draft_picks?week_number=eq.${weekNumber}`);
      await sb("DELETE", `week_draft_order?week_number=eq.${weekNumber}`);
      await sb("DELETE", `week_draft_log?week_number=eq.${weekNumber}`);
      await sb("DELETE", `week_draft_state?week_number=eq.${weekNumber}`);
      await sb("DELETE", `week_draft?week_number=eq.${weekNumber}`);

      return json(200, { ok: true });
    }

    // -------------------------
    // wipe-week { week_id }
    // Clears: participants + entries + rounds + all draft tables for that week_number.
    // -------------------------
    if (route === "wipe-week") {
      const weekNumber = Number(body.week_id);
      if (!Number.isFinite(weekNumber)) return json(400, { ok: false, error: "Missing/invalid week_id" });

      // participants (uuid or number)
      const { weekKey } = await getWeekKeyForParticipants(weekNumber);
      await sb("DELETE", `week_participants?week_id=eq.${weekKey}`);

      // scores
      await sb("DELETE", `week_entries?week_id=eq.${weekNumber}`);
      await sb("DELETE", `player_rounds?week_id=eq.${weekNumber}`);

      // draft
      await sb("DELETE", `week_draft_picks?week_number=eq.${weekNumber}`);
      await sb("DELETE", `week_draft_order?week_number=eq.${weekNumber}`);
      await sb("DELETE", `week_draft_log?week_number=eq.${weekNumber}`);
      await sb("DELETE", `week_draft_state?week_number=eq.${weekNumber}`);
      await sb("DELETE", `week_draft?week_number=eq.${weekNumber}`);

      return json(200, { ok: true });
    }

    // -------------------------
    // reset-week (existing behavior)
    // Deletes all week_entries for the *current scheduled* week.
    // -------------------------
    if (route === "reset-week") {
      const week = await getCurrentWeek();
      if (!week?.id) return json(400, { ok: false, error: "No scheduled weeks exist" });

      await sb("DELETE", `week_entries?week_id=eq.${week.week_number}`);

      return json(200, { ok: true, week_id: week.week_number, label: week.label || null });
    }

    return text(404, "Not found");
  } catch (e) {
    return text(500, `Server error: ${e?.message || String(e)}`);
  }
};
