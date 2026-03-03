// netlify/functions/admin.js
// Commissioner-only endpoints (POST) protected by:
// 1) x-admin-token header equals PROAM_ADMIN_TOKEN env var
// 2) Supabase logged-in user (Authorization: Bearer <sb_access_token>) email matches COMMISSIONER_EMAIL env var (or defaults)
// Uses Supabase SERVICE ROLE key (server-side only).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-admin-token",
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

function getRoute(event) {
  const raw = (event.path || "").split("?")[0];
  const cleaned = raw.replace(/^\/+|\/+$/g, "");
  const parts = cleaned.split("/");
  const idx = parts.lastIndexOf("admin");
  if (idx >= 0) return parts.slice(idx + 1).join("/");
  return cleaned;
}

async function sbRest(SUPABASE_URL, SERVICE_ROLE, method, restPath, bodyObj) {
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
}

async function getUserEmail(SUPABASE_URL, SUPABASE_ANON_KEY, accessToken) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
    }
  });
  if (!r.ok) return null;
  const j = await r.json();
  return (j?.email || j?.user?.email || "").toLowerCase() || null;
}

async function getWeekUuidFromNumber(SUPABASE_URL, SERVICE_ROLE, weekNumber) {
  const rows = await sbRest(
    SUPABASE_URL,
    SERVICE_ROLE,
    "GET",
    `weeks?select=id,week_number&week_number=eq.${weekNumber}&limit=1`,
  );
  return (rows && rows[0] && rows[0].id) ? rows[0].id : null;
}

// For tables where week_id might be INT week_number or UUID weeks.id.
// We'll try int first; if fails on uuid syntax or yields nothing (depending), caller can optionally retry with uuid.
async function deleteByWeekFlexible(SUPABASE_URL, SERVICE_ROLE, table, weekNumber, uuidMaybe) {
  // delete int week_id
  try {
    await sbRest(SUPABASE_URL, SERVICE_ROLE, "DELETE", `${table}?week_id=eq.${weekNumber}`);
    return { used: "int" };
  } catch (e) {
    const msg = String(e.message || e);
    if (msg.includes("invalid input syntax for type uuid") && uuidMaybe) {
      await sbRest(SUPABASE_URL, SERVICE_ROLE, "DELETE", `${table}?week_id=eq.${uuidMaybe}`);
      return { used: "uuid" };
    }
    throw e;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return text(405, "Method not allowed");
  }

  try {
    const ADMIN_TOKEN = (process.env.PROAM_ADMIN_TOKEN || "").trim();
    const got = getHeader(event, "x-admin-token");
    if (!ADMIN_TOKEN) return text(500, "Missing PROAM_ADMIN_TOKEN env var");
    if (!got || got !== ADMIN_TOKEN) return text(401, "Unauthorized");

    const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
    const SERVICE_ROLE = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
    const SUPABASE_ANON_KEY = (process.env.SUPABASE_ANON_KEY || "").trim();

    if (!SUPABASE_URL || !SERVICE_ROLE) {
      return text(500, "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    }
    if (!SUPABASE_ANON_KEY) {
      return text(500, "Missing SUPABASE_ANON_KEY (needed to verify commissioner email)");
    }

    const commissionerEmail = (process.env.COMMISSIONER_EMAIL || "jstyler2012@yahoo.com").trim().toLowerCase();

    // Verify logged-in user email matches commissioner
    const auth = getHeader(event, "authorization") || getHeader(event, "Authorization");
    const accessToken = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!accessToken) return text(401, "Missing Authorization Bearer token");

    const email = await getUserEmail(SUPABASE_URL, SUPABASE_ANON_KEY, accessToken);
    if (!email) return text(401, "Could not validate Supabase user");
    if (email !== commissionerEmail) return text(403, `Forbidden: ${email} is not commissioner`);

    const route = getRoute(event);
    const body = event.body ? JSON.parse(event.body) : {};

    // ---- simple health check
    if (route === "ping") {
      return json(200, { ok: true });
    }

    // ---- participants/list
    if (route === "participants/list") {
      const weekNumber = Number(body.week_number);
      if (!Number.isFinite(weekNumber)) return json(400, { ok: false, error: "Missing/invalid week_number" });

      let weekKey = weekNumber;
      let rows = null;

      // attempt int
      try {
        rows = await sbRest(
          SUPABASE_URL,
          SERVICE_ROLE,
          "GET",
          `week_participants?week_id=eq.${weekKey}&select=player_id,player:players(id,name,handicap_index)`
        );
      } catch (e) {
        const msg = String(e.message || e);
        if (msg.includes("invalid input syntax for type uuid")) {
          const wkUuid = await getWeekUuidFromNumber(SUPABASE_URL, SERVICE_ROLE, weekNumber);
          if (!wkUuid) return json(404, { ok: false, error: "Week not found in weeks table" });
          weekKey = wkUuid;
          rows = await sbRest(
            SUPABASE_URL,
            SERVICE_ROLE,
            "GET",
            `week_participants?week_id=eq.${weekKey}&select=player_id,player:players(id,name,handicap_index)`
          );
        } else {
          throw e;
        }
      }

      const out = (rows || []).map(r => ({
        player_id: r.player_id,
        player_name: r?.player?.name || "—",
        handicap_index: r?.player?.handicap_index ?? null,
      }));
      // sort high -> low handicap (null last)
      out.sort((a,b) => {
        const ah=a.handicap_index, bh=b.handicap_index;
        const an=ah===null||ah===undefined, bn=bh===null||bh===undefined;
        if(an && bn) return 0;
        if(an) return 1;
        if(bn) return -1;
        return Number(bh) - Number(ah);
      });

      return json(200, { ok: true, week_id: weekNumber, rows: out });
    }

    // ---- participants/remove
    if (route === "participants/remove") {
      const weekNumber = Number(body.week_number);
      const playerId = String(body.player_id || "").trim();
      if (!Number.isFinite(weekNumber)) return json(400, { ok:false, error:"Missing/invalid week_number" });
      if (!playerId) return json(400, { ok:false, error:"Missing player_id" });

      const wkUuid = await getWeekUuidFromNumber(SUPABASE_URL, SERVICE_ROLE, weekNumber);

      // remove from week_participants (int or uuid)
      try {
        await sbRest(SUPABASE_URL, SERVICE_ROLE, "DELETE", `week_participants?week_id=eq.${weekNumber}&player_id=eq.${playerId}`);
      } catch (e) {
        const msg = String(e.message || e);
        if (msg.includes("invalid input syntax for type uuid") && wkUuid) {
          await sbRest(SUPABASE_URL, SERVICE_ROLE, "DELETE", `week_participants?week_id=eq.${wkUuid}&player_id=eq.${playerId}`);
        } else {
          throw e;
        }
      }

      // clear pick + entry row(s) for that week (week_entries uses week_id = week_number in your current code)
      let updated = 0;
      try {
        const upd = await sbRest(
          SUPABASE_URL,
          SERVICE_ROLE,
          "PATCH",
          `week_entries?week_id=eq.${weekNumber}&player_id=eq.${playerId}`,
          { pga_golfer: null }
        );
        updated = Array.isArray(upd) ? upd.length : 0;
      } catch (_) {}

      // remove rounds if your schema uses player_rounds
      try {
        await sbRest(SUPABASE_URL, SERVICE_ROLE, "DELETE", `player_rounds?week_id=eq.${weekNumber}&player_id=eq.${playerId}`);
      } catch (_) {}

      return json(200, { ok: true, updated_week_entries: updated });
    }

    // ---- week/wipe (participants + picks + draft + scores)
    if (route === "week/wipe") {
      const weekNumber = Number(body.week_number);
      if (!Number.isFinite(weekNumber)) return json(400, { ok:false, error:"Missing/invalid week_number" });

      const wkUuid = await getWeekUuidFromNumber(SUPABASE_URL, SERVICE_ROLE, weekNumber);
      const deleted = {};

      // participants
      try {
        const used = await deleteByWeekFlexible(SUPABASE_URL, SERVICE_ROLE, "week_participants", weekNumber, wkUuid);
        deleted.week_participants = used.used;
      } catch (_) {}

      // week_entries (week_id can be int or uuid)
      try {
        const used = await deleteByWeekFlexible(SUPABASE_URL, SERVICE_ROLE, "week_entries", weekNumber, wkUuid);
        deleted.week_entries = used.used;
      } catch (_) {}

      // rounds
      try {
        await sbRest(SUPABASE_URL, SERVICE_ROLE, "DELETE", `player_rounds?week_id=eq.${weekNumber}`);
        deleted.player_rounds = "int";
      } catch (_) {}

      // week_pro_field (safe to delete for week 0 / testing)
      try {
        await sbRest(SUPABASE_URL, SERVICE_ROLE, "DELETE", `week_pro_field?week_number=eq.${weekNumber}`);
        deleted.week_pro_field = true;
      } catch (_) {}

      // draft
      try { await sbRest(SUPABASE_URL, SERVICE_ROLE, "DELETE", `week_draft_order?week_number=eq.${weekNumber}`); deleted.week_draft_order = true; } catch(_) {}
      try { await sbRest(SUPABASE_URL, SERVICE_ROLE, "DELETE", `week_draft?week_number=eq.${weekNumber}`); deleted.week_draft = true; } catch(_) {}

      return json(200, { ok:true, deleted });
    }

    // ---- draft/state
    if (route === "draft/state") {
      const weekNumber = Number(body.week_number);
      if (!Number.isFinite(weekNumber)) return json(400, { ok:false, error:"Missing/invalid week_number" });

      const draft = (await sbRest(SUPABASE_URL, SERVICE_ROLE, "GET", `week_draft?week_number=eq.${weekNumber}&limit=1`)) || [];
      const order = (await sbRest(SUPABASE_URL, SERVICE_ROLE, "GET", `week_draft_order?week_number=eq.${weekNumber}&select=player_id,handicap_index,handicap_group,pick_position,group_position&order=pick_position.asc`)) || [];
      return json(200, { ok:true, draft: draft[0] || null, order });
    }

    // ---- draft/init
    if (route === "draft/init") {
      const weekNumber = Number(body.week_number);
      if (!Number.isFinite(weekNumber)) return json(400, { ok:false, error:"Missing/invalid week_number" });

      // If exists, return it
      const existing = (await sbRest(SUPABASE_URL, SERVICE_ROLE, "GET", `week_draft?week_number=eq.${weekNumber}&limit=1`)) || [];
      if (existing[0]) return json(200, { ok:true, draft: existing[0], created: false });

      const nowDate = new Date();
      const nowIso = nowDate.toISOString();
      // week_draft.draft_starts_at is NOT NULL in your schema; set safe defaults for testing
      const draftStartsAt = new Date(nowDate.getTime() + 5 * 60 * 1000).toISOString();
      const swapDeadlineAt = new Date(nowDate.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();

      const inserted = await sbRest(
        SUPABASE_URL,
        SERVICE_ROLE,
        "POST",
        "week_draft",
        [{
          week_number: weekNumber,
          status: "PREP",
          draft_starts_at: draftStartsAt,
          swap_deadline_at: swapDeadlineAt,
          created_at: nowIso,
          updated_at: nowIso,
        }]
      );
      return json(200, { ok:true, draft: (inserted && inserted[0]) || null, created: true });
    }

    // ---- draft/update
    if (route === "draft/update") {
      const weekNumber = Number(body.week_number);
      if (!Number.isFinite(weekNumber)) return json(400, { ok:false, error:"Missing/invalid week_number" });

      const patch = {};
      if (body.status) patch.status = String(body.status);

      // IMPORTANT: week_draft.draft_starts_at is NOT NULL in your schema.
      // Treat null/empty as "leave unchanged" to avoid violating the constraint.
      if ("draft_starts_at" in body) {
        const v = body.draft_starts_at;
        if (v !== null && v !== undefined && String(v).trim() !== "") {
          patch.draft_starts_at = v;
        }
      }

      // swap_deadline_at may be nullable; for safety we also treat empty as "leave unchanged"
      if ("swap_deadline_at" in body) {
        const v = body.swap_deadline_at;
        if (v !== null && v !== undefined && String(v).trim() !== "") {
          patch.swap_deadline_at = v;
        }
      }

      patch.updated_at = new Date().toISOString();

      const updated = await sbRest(
        SUPABASE_URL,
        SERVICE_ROLE,
        "PATCH",
        `week_draft?week_number=eq.${weekNumber}`,
        patch
      );
      return json(200, { ok:true, draft: Array.isArray(updated) ? updated[0] : updated });
    }

    // ---- draft/generate-order
    if (route === "draft/generate-order") {
      const weekNumber = Number(body.week_number);
      if (!Number.isFinite(weekNumber)) return json(400, { ok:false, error:"Missing/invalid week_number" });

      // ensure draft exists
      const existing = (await sbRest(SUPABASE_URL, SERVICE_ROLE, "GET", `week_draft?week_number=eq.${weekNumber}&limit=1`)) || [];
      if (!existing[0]) {
        // auto-init
        const now = new Date();
        const nowIso = now.toISOString();
        const draftStartsAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
        const swapDeadlineAt = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString();
        await sbRest(SUPABASE_URL, SERVICE_ROLE, "POST", "week_draft", [{
          week_number: weekNumber,
          status: "PREP",
          draft_starts_at: draftStartsAt,
          swap_deadline_at: swapDeadlineAt,
          created_at: nowIso,
          updated_at: nowIso,
        }]);

}

      // load participants w/ handicap
      let part = null;
      try {
        part = await sbRest(SUPABASE_URL, SERVICE_ROLE, "GET", `week_participants?week_id=eq.${weekNumber}&select=player_id,player:players(id,name,handicap_index)`);
      } catch (e) {
        const msg = String(e.message || e);
        if (msg.includes("invalid input syntax for type uuid")) {
          const wkUuid = await getWeekUuidFromNumber(SUPABASE_URL, SERVICE_ROLE, weekNumber);
          if (!wkUuid) return json(404, { ok:false, error:"Week not found in weeks table" });
          part = await sbRest(SUPABASE_URL, SERVICE_ROLE, "GET", `week_participants?week_id=eq.${wkUuid}&select=player_id,player:players(id,name,handicap_index)`);
        } else {
          throw e;
        }
      }

      const participants = (part || []).map(r => ({
        player_id: r.player_id,
        handicap_index: r?.player?.handicap_index ?? null,
      }));

      // sort: highest handicap first (null last)
      participants.sort((a,b) => {
        const ah=a.handicap_index, bh=b.handicap_index;
        const an=ah===null||ah===undefined, bn=bh===null||bh===undefined;
        if(an && bn) return 0;
        if(an) return 1;
        if(bn) return -1;
        return Number(bh) - Number(ah);
      });

      // wipe existing order
      try { await sbRest(SUPABASE_URL, SERVICE_ROLE, "DELETE", `week_draft_order?week_number=eq.${weekNumber}`); } catch(_) {}

      
      function handicapGroupFromIndex(h) {
        const v = (h === null || h === undefined) ? null : Number(h);
        if (v === null || !Number.isFinite(v)) return 4; // safest group (worst eligibility)
        if (v >= 16.0) return 1;
        if (v >= 11.0) return 2;
        if (v >= 6.0) return 3;
        return 4;
      }

// insert new order
      const groupCounts = {1:0,2:0,3:0,4:0};

// insert new order
      const rows = participants.map((p, i) => {
        const grp = handicapGroupFromIndex(p.handicap_index);
        groupCounts[grp] = (groupCounts[grp] || 0) + 1;
        return {
          week_number: weekNumber,
          player_id: p.player_id,
          handicap_index: p.handicap_index,
          handicap_group: grp,
          pick_position: i + 1,
          group_position: groupCounts[grp],
        };
      });

      if (rows.length) {
        // chunk insert
        const chunk = 250;
        for (let i=0; i<rows.length; i+=chunk) {
          await sbRest(SUPABASE_URL, SERVICE_ROLE, "POST", "week_draft_order", rows.slice(i, i+chunk));
        }
      }

      return json(200, { ok:true, count: rows.length });
    }

    // ---- draft/reset-pick (clears week_entries.pga_golfer)
    if (route === "draft/reset-pick") {
      const weekNumber = Number(body.week_number);
      const playerId = String(body.player_id || "").trim();
      if (!Number.isFinite(weekNumber)) return json(400, { ok:false, error:"Missing/invalid week_number" });
      if (!playerId) return json(400, { ok:false, error:"Missing player_id" });

      const patch = { pga_golfer: null, pga_golfer_ext_id: null, pro_score: null, your_score: null, total: null };

      let updated = null;
      try {
        updated = await sbRest(
          SUPABASE_URL,
          SERVICE_ROLE,
          "PATCH",
          `week_entries?week_id=eq.${weekNumber}&player_id=eq.${playerId}`,
          patch
        );
      } catch (e) {
        const msg = String(e?.message || e);
        if (msg.includes("invalid input syntax for type uuid")) {
          const wkUuid = await getWeekUuidFromNumber(SUPABASE_URL, SERVICE_ROLE, weekNumber);
          if (!wkUuid) return json(404, { ok:false, error:"Week not found" });
          updated = await sbRest(
            SUPABASE_URL,
            SERVICE_ROLE,
            "PATCH",
            `week_entries?week_id=eq.${wkUuid}&player_id=eq.${playerId}`,
            patch
          );
        } else {
          throw e;
        }
      }
      return json(200, { ok:true, updated: Array.isArray(updated) ? updated.length : 0 });
    }

    // ---- draft/wipe (draft tables + clear picks for week)
    if (route === "draft/wipe") {
      const weekNumber = Number(body.week_number);
      if (!Number.isFinite(weekNumber)) return json(400, { ok:false, error:"Missing/invalid week_number" });

      const deleted = {};
      try { await sbRest(SUPABASE_URL, SERVICE_ROLE, "DELETE", `week_draft_order?week_number=eq.${weekNumber}`); deleted.week_draft_order = true; } catch(_) {}
      try { await sbRest(SUPABASE_URL, SERVICE_ROLE, "DELETE", `week_draft?week_number=eq.${weekNumber}`); deleted.week_draft = true; } catch(_) {}

      // clear picks
      try {
        const patch = { pga_golfer: null, pga_golfer_ext_id: null, pro_score: null, your_score: null, total: null };
        try {
          await sbRest(SUPABASE_URL, SERVICE_ROLE, "PATCH", `week_entries?week_id=eq.${weekNumber}`, patch);
        } catch (e) {
          const msg = String(e?.message || e);
          if (msg.includes("invalid input syntax for type uuid")) {
            const wkUuid = await getWeekUuidFromNumber(SUPABASE_URL, SERVICE_ROLE, weekNumber);
            if (wkUuid) await sbRest(SUPABASE_URL, SERVICE_ROLE, "PATCH", `week_entries?week_id=eq.${wkUuid}`, patch);
          } else {
            throw e;
          }
        }
        deleted.week_entries_picks_cleared = true;
      } catch(_) {}

      return json(200, { ok:true, deleted });
    }

    // ---- field/list
    if (route === "field/list") {
      const weekNumber = Number(body.week_number);
      if (!Number.isFinite(weekNumber)) return json(400, { ok:false, error:"Missing/invalid week_number" });

      const rows = await sbRest(
        SUPABASE_URL,
        SERVICE_ROLE,
        "GET",
        `week_pro_field?week_number=eq.${weekNumber}&select=player_ext_id,player_name,odds_rank,odds_display,tier&order=odds_rank.asc`
      );
      return json(200, { ok:true, rows: rows || [] });
    }

    // ---- field/auto-tier
    if (route === "field/auto-tier") {
      const weekNumber = Number(body.week_number);
      if (!Number.isFinite(weekNumber)) return json(400, { ok:false, error:"Missing/invalid week_number" });

      const rows = await sbRest(
        SUPABASE_URL,
        SERVICE_ROLE,
        "GET",
        `week_pro_field?week_number=eq.${weekNumber}&select=player_ext_id,odds_rank,tier&order=odds_rank.asc`
      );

      const list = rows || [];
      let updatedCount = 0;

      // Tier rules: 1-10 => T1, 11-25 => T2, 26-45 => T3, 46+ => T4
      for (const r of list) {
        const rank = Number(r.odds_rank);
        if (!Number.isFinite(rank)) continue;
        let tier = 4;
        if (rank <= 10) tier = 1;
        else if (rank <= 25) tier = 2;
        else if (rank <= 45) tier = 3;

        if (Number(r.tier) !== tier) {
          await sbRest(
            SUPABASE_URL,
            SERVICE_ROLE,
            "PATCH",
            `week_pro_field?week_number=eq.${weekNumber}&player_ext_id=eq.${encodeURIComponent(String(r.player_ext_id))}`,
            { tier }
          );
          updatedCount++;
        }
      }

      return json(200, { ok:true, updated: updatedCount });
    }

    // ---- field/set-tier
    if (route === "field/set-tier") {
      const weekNumber = Number(body.week_number);
      const playerExtId = String(body.player_ext_id || "").trim();
      const tier = Number(body.tier);
      if (!Number.isFinite(weekNumber)) return json(400, { ok:false, error:"Missing/invalid week_number" });
      if (!playerExtId) return json(400, { ok:false, error:"Missing player_ext_id" });
      if (![1,2,3,4].includes(tier)) return json(400, { ok:false, error:"Tier must be 1-4" });

      const updated = await sbRest(
        SUPABASE_URL,
        SERVICE_ROLE,
        "PATCH",
        `week_pro_field?week_number=eq.${weekNumber}&player_ext_id=eq.${encodeURIComponent(playerExtId)}`,
        { tier }
      );
      return json(200, { ok:true, row: Array.isArray(updated) ? updated[0] : updated });
    }

    return json(404, { ok:false, error:"Not found", route });
  } catch (e) {
    return json(500, { ok:false, error: e?.message || String(e) });
  }
};
