// netlify/functions/admin.js
// Commissioner / Admin endpoints (POST) protected by:
//  1) x-admin-token must match PROAM_ADMIN_TOKEN
//  2) Authorization: Bearer <supabase_jwt> must belong to ADMIN_EMAIL (jstyler2012@yahoo.com)
//
// Uses Supabase SERVICE ROLE key (server-side only).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-token, Authorization",
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
    headers: { "content-type": "text/plain", ...corsHeaders },
    body: String(bodyText || ""),
  };
}
function isMissing(v) {
  return v === undefined || v === null || v === "";
}

async function readJsonBody(event) {
  try {
    return JSON.parse(event.body || "{}");
  } catch {
    return {};
  }
}

async function sbService(method, path, bodyObj) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: bodyObj ? JSON.stringify(bodyObj) : undefined,
  });
  const txt = await res.text();
  let js = null;
  try { js = txt ? JSON.parse(txt) : null; } catch { js = null; }
  return { ok: res.ok, status: res.status, text: txt, json: js, headers: res.headers };
}

async function verifyAdmin(event) {
  const token = (event.headers?.["x-admin-token"] || event.headers?.["X-Admin-Token"] || "").trim();
  const expected = (process.env.PROAM_ADMIN_TOKEN || "").trim();
  if (!expected) return { ok: false, status: 500, error: "Missing PROAM_ADMIN_TOKEN env var" };
  if (!token || token !== expected) return { ok: false, status: 401, error: "Unauthorized (bad admin token)" };

  const auth = (event.headers?.authorization || event.headers?.Authorization || "").trim();
  if (!auth.startsWith("Bearer ")) return { ok: false, status: 401, error: "Not logged in" };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Validate JWT and read email
  const meResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: auth,
    },
  });
  const meText = await meResp.text();
  if (!meResp.ok) return { ok: false, status: 401, error: `Invalid session (${meResp.status})` };

  let user = null;
  try { user = JSON.parse(meText); } catch { user = null; }
  const email = String(user?.email || "").toLowerCase();
  const adminEmail = "jstyler2012@yahoo.com";
  if (email !== adminEmail) return { ok: false, status: 403, error: "Forbidden (not admin user)" };

  return { ok: true, user };
}

// weeks helpers
async function getWeekByNumber(weekNumber) {
  const out = await sbService("GET", `weeks?select=id,week_number,label,tournament_name,start_date,end_date,field_last_synced_at&week_number=eq.${weekNumber}&limit=1`);
  if (!out.ok) return out;
  const wk = Array.isArray(out.json) ? out.json[0] : null;
  return { ok: true, status: 200, week: wk };
}

async function getWeekUuidFromNumber(weekNumber) {
  const wk = await getWeekByNumber(weekNumber);
  if (!wk.ok) return { ok: false, status: wk.status, error: wk.text };
  const id = wk.week?.id;
  if (!id) return { ok: false, status: 404, error: "Week not found" };
  return { ok: true, id };
}

async function listParticipantsForWeek(weekNumber) {
  // week_participants.week_id might be integer or uuid — try integer then fallback to uuid.
  let weekKey = weekNumber;

  let out = await sbService("GET",
    `week_participants?week_id=eq.${weekKey}&select=player_id,created_at,player:players(id,name,handicap_index,user_id)`
  );

  if (!out.ok && String(out.text || "").includes("invalid input syntax for type uuid")) {
    const wk = await getWeekUuidFromNumber(weekNumber);
    if (!wk.ok) return { ok: false, status: wk.status, error: wk.error };
    weekKey = wk.id;

    out = await sbService("GET",
      `week_participants?week_id=eq.${weekKey}&select=player_id,created_at,player:players(id,name,handicap_index,user_id)`
    );
  }

  if (!out.ok) return { ok: false, status: out.status, error: out.text };
  const rows = Array.isArray(out.json) ? out.json : [];
  return { ok: true, weekKey, rows };
}

async function deleteWhere(tableAndFilter) {
  // tableAndFilter is like "week_entries?week_id=eq.X&player_id=eq.Y"
  const out = await sbService("DELETE", tableAndFilter);
  if (!out.ok && out.status !== 204) return out;
  return out;
}

exports.handler = async function handler(event) {
  try {
    if (event.httpMethod === "OPTIONS") return json(200, { ok: true });
    if (event.httpMethod !== "POST") return json(405, { error: "POST only" });

    const route = String(event.path || "").split("/").pop();

    const authz = await verifyAdmin(event);
    if (!authz.ok) return json(authz.status, { error: authz.error });

    const body = await readJsonBody(event);
// ---- simple health check
if (route === "ping") {
  return json(200, { ok: true, email });
}
    // -------------------------
    // list-weeks
    // -------------------------
    if (route === "list-weeks") {
      const out = await sbService("GET", "weeks?select=week_number,label,tournament_name,start_date,end_date,field_last_synced_at&order=week_number.asc");
      if (!out.ok) return text(out.status, out.text);
      return json(200, { weeks: out.json || [] });
    }

    // -------------------------
    // week-summary (participants count + draft status + field count)
    // -------------------------
    if (route === "week-summary") {
      const weekNumber = Number(body.week_number);
      if (!Number.isFinite(weekNumber)) return json(400, { error: "Missing/invalid week_number" });

      const wk = await getWeekByNumber(weekNumber);
      if (!wk.ok) return text(wk.status, wk.text);

      const parts = await listParticipantsForWeek(weekNumber);
      if (!parts.ok) return json(parts.status, { error: parts.error });

      const draft = await sbService("GET", `week_draft?week_number=eq.${weekNumber}&limit=1`);
      const draftRow = (draft.ok && Array.isArray(draft.json)) ? draft.json[0] : null;

      const field = await sbService("GET", `week_pro_field?week_number=eq.${weekNumber}&select=player_ext_id`);
      const fieldCount = field.ok && Array.isArray(field.json) ? field.json.length : 0;

      return json(200, {
        week: wk.week,
        participants_count: parts.rows.length,
        draft: draftRow,
        field_count: fieldCount,
      });
    }

    // -------------------------
    // participants-list
    // -------------------------
    if (route === "participants-list") {
      const weekNumber = Number(body.week_number);
      if (!Number.isFinite(weekNumber)) return json(400, { error: "Missing/invalid week_number" });

      const parts = await listParticipantsForWeek(weekNumber);
      if (!parts.ok) return json(parts.status, { error: parts.error });

      // add current pick if any
      const userIds = parts.rows.map(r => r?.player?.user_id).filter(Boolean);
      let picksByUser = {};
      if (userIds.length) {
        // PostgREST "in" uses parentheses: in.(a,b,c)
        const inList = userIds.join(",");
        const picks = await sbService("GET", `week_draft_picks?week_number=eq.${weekNumber}&user_id=in.(${inList})&select=user_id,pro_id,tier,is_swap,created_at`);
        if (picks.ok && Array.isArray(picks.json)) {
          for (const p of picks.json) picksByUser[p.user_id] = p;
        }
      }

      const rows = parts.rows.map(r => {
        const u = r?.player?.user_id;
        return {
          player_id: r.player_id,
          created_at: r.created_at,
          player: r.player,
          pick: u ? (picksByUser[u] || null) : null,
        };
      });

      return json(200, { week_key: parts.weekKey, participants: rows });
    }

    // -------------------------
    // remove-participant
    // -------------------------
    if (route === "remove-participant") {
      const weekNumber = Number(body.week_number);
      const playerId = String(body.player_id || "").trim();
      if (!Number.isFinite(weekNumber)) return json(400, { error: "Missing/invalid week_number" });
      if (!playerId) return json(400, { error: "Missing player_id" });

      // get player -> user_id
      const pl = await sbService("GET", `players?select=id,user_id&` + `id=eq.${playerId}&limit=1`);
      if (!pl.ok) return text(pl.status, pl.text);
      const pRow = Array.isArray(pl.json) ? pl.json[0] : null;
      const userId = pRow?.user_id;

      // resolve weekKey for week_participants/week_entries/player_rounds
      const parts = await listParticipantsForWeek(weekNumber);
      if (!parts.ok) return json(parts.status, { error: parts.error });
      const weekKey = parts.weekKey;

      // delete related
      await deleteWhere(`week_entries?week_id=eq.${weekKey}&player_id=eq.${playerId}`);
      await deleteWhere(`player_rounds?week_id=eq.${weekKey}&player_id=eq.${playerId}`);
      if (userId) await deleteWhere(`week_draft_picks?week_number=eq.${weekNumber}&user_id=eq.${userId}`);
      await deleteWhere(`week_participants?week_id=eq.${weekKey}&player_id=eq.${playerId}`);

      return json(200, { ok: true });
    }

    // -------------------------
    // week-wipe-all (participants + scores + draft + tiers untouched)
    // -------------------------
    if (route === "week-wipe-all") {
      const weekNumber = Number(body.week_number);
      if (!Number.isFinite(weekNumber)) return json(400, { error: "Missing/invalid week_number" });

      // resolve weekKey
      const parts = await listParticipantsForWeek(weekNumber);
      if (!parts.ok) return json(parts.status, { error: parts.error });
      const weekKey = parts.weekKey;

      // Delete week-scoped data
      await deleteWhere(`week_entries?week_id=eq.${weekKey}`);
      await deleteWhere(`player_rounds?week_id=eq.${weekKey}`);
      await deleteWhere(`week_participants?week_id=eq.${weekKey}`);

      // Draft tables are keyed on week_number
      await deleteWhere(`week_draft_picks?week_number=eq.${weekNumber}`);
      await deleteWhere(`week_draft_order?week_number=eq.${weekNumber}`);
      await deleteWhere(`week_draft_state?week_number=eq.${weekNumber}`);
      await deleteWhere(`week_draft_log?week_number=eq.${weekNumber}`);
      await deleteWhere(`week_draft?week_number=eq.${weekNumber}`);

      return json(200, { ok: true });
    }

    // -------------------------
    // draft-get
    // -------------------------
    if (route === "draft-get") {
      const weekNumber = Number(body.week_number);
      if (!Number.isFinite(weekNumber)) return json(400, { error: "Missing/invalid week_number" });

      const d = await sbService("GET", `week_draft?week_number=eq.${weekNumber}&limit=1`);
      if (!d.ok) return text(d.status, d.text);
      const row = Array.isArray(d.json) ? d.json[0] : null;

      const order = await sbService("GET", `week_draft_order?week_number=eq.${weekNumber}&select=player_id,handicap_index,pick_position,player:players(id,name,handicap_index,user_id)&order=pick_position.asc`);
      const picks = await sbService("GET", `week_draft_picks?week_number=eq.${weekNumber}&select=user_id,pro_id,tier,is_swap,created_at&order=created_at.asc`);

      return json(200, {
        draft: row,
        order: order.ok ? (order.json || []) : [],
        picks: picks.ok ? (picks.json || []) : [],
      });
    }

    // -------------------------
    // draft-init (insert if missing)
    // -------------------------
    if (route === "draft-init") {
      const weekNumber = Number(body.week_number);
      if (!Number.isFinite(weekNumber)) return json(400, { error: "Missing/invalid week_number" });

      const existing = await sbService("GET", `week_draft?week_number=eq.${weekNumber}&limit=1`);
      if (!existing.ok) return text(existing.status, existing.text);
      const row = Array.isArray(existing.json) ? existing.json[0] : null;
      if (row) return json(200, { ok: true, draft: row, created: false });

      const nowIso = new Date().toISOString();
      const ins = await sbService("POST", "week_draft", {
        week_number: weekNumber,
        status: "PREP",
        draft_starts_at: body.draft_starts_at || null,
        swap_deadline_at: body.swap_deadline_at || null,
        created_at: nowIso,
        updated_at: nowIso,
      });
      if (!ins.ok) return text(ins.status, ins.text);
      return json(200, { ok: true, draft: Array.isArray(ins.json) ? ins.json[0] : ins.json, created: true });
    }

    // -------------------------
    // draft-update (status + timestamps)
    // -------------------------
    if (route === "draft-update") {
      const weekNumber = Number(body.week_number);
      if (!Number.isFinite(weekNumber)) return json(400, { error: "Missing/invalid week_number" });

      const patch = {};
      if (!isMissing(body.status)) patch.status = String(body.status);
      if (Object.prototype.hasOwnProperty.call(body, "draft_starts_at")) patch.draft_starts_at = body.draft_starts_at;
      if (Object.prototype.hasOwnProperty.call(body, "swap_deadline_at")) patch.swap_deadline_at = body.swap_deadline_at;
      patch.updated_at = new Date().toISOString();

      const out = await sbService("PATCH", `week_draft?week_number=eq.${weekNumber}`, patch);
      if (!out.ok) return text(out.status, out.text);
      return json(200, { ok: true, draft: out.json });
    }

    // -------------------------
    // draft-generate-order
    // Deterministic: handicap_index DESC, then name ASC.
    // Stores current handicap snapshot + pick_position.
    // -------------------------
    if (route === "draft-generate-order") {
      const weekNumber = Number(body.week_number);
      if (!Number.isFinite(weekNumber)) return json(400, { error: "Missing/invalid week_number" });

      const parts = await listParticipantsForWeek(weekNumber);
      if (!parts.ok) return json(parts.status, { error: parts.error });

      // Build sorted list
      const list = (parts.rows || [])
        .map(r => r.player)
        .filter(Boolean)
        .map(p => ({
          player_id: p.id,
          name: p.name || "",
          handicap_index: Number(p.handicap_index ?? 0),
        }))
        .sort((a, b) => {
          if (b.handicap_index !== a.handicap_index) return b.handicap_index - a.handicap_index;
          return String(a.name).localeCompare(String(b.name));
        });

      // wipe old order
      await deleteWhere(`week_draft_order?week_number=eq.${weekNumber}`);

      // insert new order
      let pos = 1;
      for (const p of list) {
        await sbService("POST", "week_draft_order", {
          week_number: weekNumber,
          player_id: p.player_id,
          handicap_index: p.handicap_index,
          handicap_group: null,
          pick_position: pos,
          group_position: pos,
        });
        pos++;
      }

      // update draft row order_generated_at
      await sbService("PATCH", `week_draft?week_number=eq.${weekNumber}`, {
        order_generated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      return json(200, { ok: true, count: list.length });
    }

    // -------------------------
    // draft-reset-pick (delete user's pick for week)
    // -------------------------
    if (route === "draft-reset-pick") {
      const weekNumber = Number(body.week_number);
      const userId = String(body.user_id || "").trim();
      if (!Number.isFinite(weekNumber)) return json(400, { error: "Missing/invalid week_number" });
      if (!userId) return json(400, { error: "Missing user_id" });

      await deleteWhere(`week_draft_picks?week_number=eq.${weekNumber}&user_id=eq.${userId}`);
      return json(200, { ok: true });
    }

    // -------------------------
    // draft-wipe (draft only)
    // -------------------------
    if (route === "draft-wipe") {
      const weekNumber = Number(body.week_number);
      if (!Number.isFinite(weekNumber)) return json(400, { error: "Missing/invalid week_number" });

      await deleteWhere(`week_draft_picks?week_number=eq.${weekNumber}`);
      await deleteWhere(`week_draft_order?week_number=eq.${weekNumber}`);
      await deleteWhere(`week_draft_state?week_number=eq.${weekNumber}`);
      await deleteWhere(`week_draft_log?week_number=eq.${weekNumber}`);
      await deleteWhere(`week_draft?week_number=eq.${weekNumber}`);

      return json(200, { ok: true });
    }

    // -------------------------
    // tiers-list (week_pro_field)
    // -------------------------
    if (route === "tiers-list") {
      const weekNumber = Number(body.week_number);
      if (!Number.isFinite(weekNumber)) return json(400, { error: "Missing/invalid week_number" });

      const out = await sbService(
        "GET",
        `week_pro_field?week_number=eq.${weekNumber}&select=player_ext_id,player_name,odds_display,odds_numeric,odds_rank,tier&order=odds_rank.asc.nullslast`
      );
      if (!out.ok) return text(out.status, out.text);
      return json(200, { field: out.json || [] });
    }

    // -------------------------
    // tiers-auto (by odds_rank)
    // -------------------------
    if (route === "tiers-auto") {
      const weekNumber = Number(body.week_number);
      if (!Number.isFinite(weekNumber)) return json(400, { error: "Missing/invalid week_number" });

      const out = await sbService(
        "GET",
        `week_pro_field?week_number=eq.${weekNumber}&select=player_ext_id,odds_rank`
      );
      if (!out.ok) return text(out.status, out.text);

      const rows = Array.isArray(out.json) ? out.json : [];
      const updates = [];

      for (const r of rows) {
        const rank = Number(r.odds_rank);
        if (!Number.isFinite(rank) || rank <= 0) continue;
        let tier = 4;
        if (rank <= 10) tier = 1;
        else if (rank <= 25) tier = 2;
        else if (rank <= 45) tier = 3;
        updates.push({ player_ext_id: r.player_ext_id, tier });
      }

      // Apply patches one-by-one (safe + simple)
      for (const u of updates) {
        await sbService("PATCH", `week_pro_field?week_number=eq.${weekNumber}&player_ext_id=eq.${encodeURIComponent(u.player_ext_id)}`, { tier: u.tier });
      }

      return json(200, { ok: true, updated: updates.length });
    }

    // -------------------------
    // tiers-set (manual set tier for one pro)
    // -------------------------
    if (route === "tiers-set") {
      const weekNumber = Number(body.week_number);
      const playerExtId = String(body.player_ext_id || "").trim();
      const tier = Number(body.tier);
      if (!Number.isFinite(weekNumber)) return json(400, { error: "Missing/invalid week_number" });
      if (!playerExtId) return json(400, { error: "Missing player_ext_id" });
      if (![1,2,3,4].includes(tier)) return json(400, { error: "Invalid tier (1-4)" });

      const out = await sbService(
        "PATCH",
        `week_pro_field?week_number=eq.${weekNumber}&player_ext_id=eq.${encodeURIComponent(playerExtId)}`,
        { tier }
      );
      if (!out.ok) return text(out.status, out.text);
      return json(200, { ok: true });
    }

    // -------------------------
    // users-search (by email substring)
    // Returns auth users + matching player row (if exists)
    // -------------------------
    if (route === "users-search") {
      const q = String(body.query || "").trim().toLowerCase();
      if (!q) return json(400, { error: "Missing query" });

      const SUPABASE_URL = process.env.SUPABASE_URL;
      const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

      // Get a page of users and filter (MVP/simple)
      const uRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?per_page=200`, {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      });
      const uText = await uRes.text();
      if (!uRes.ok) return json(uRes.status, { error: uText });

      let uJson = null;
      try { uJson = JSON.parse(uText); } catch { uJson = null; }
      const users = Array.isArray(uJson?.users) ? uJson.users : [];

      const matched = users
        .filter(u => String(u?.email || "").toLowerCase().includes(q))
        .slice(0, 25)
        .map(u => ({ id: u.id, email: u.email, created_at: u.created_at }));

      const ids = matched.map(u => u.id).filter(Boolean);
      let players = [];
      if (ids.length) {
        const inList = ids.join(",");
        const p = await sbService("GET", `players?select=id,name,handicap_index,user_id&user_id=in.(${inList})`);
        if (p.ok && Array.isArray(p.json)) players = p.json;
      }

      const playerByUser = {};
      for (const p of players) playerByUser[p.user_id] = p;

      const out = matched.map(u => ({
        user_id: u.id,
        email: u.email,
        created_at: u.created_at,
        player: playerByUser[u.id] || null,
      }));

      return json(200, { users: out });
    }

    // -------------------------
    // users-set-handicap (by player_id)
    // -------------------------
    if (route === "users-set-handicap") {
      const playerId = String(body.player_id || "").trim();
      const handicap = Number(body.handicap_index);
      if (!playerId) return json(400, { error: "Missing player_id" });
      if (!Number.isFinite(handicap)) return json(400, { error: "Missing/invalid handicap_index" });

      const out = await sbService("PATCH", `players?id=eq.${playerId}`, { handicap_index: handicap });
      if (!out.ok) return text(out.status, out.text);
      return json(200, { ok: true });
    }

    return json(404, { error: `Unknown route: ${route}` });
  } catch (e) {
    return json(500, { error: String(e?.message || e) });
  }
};
