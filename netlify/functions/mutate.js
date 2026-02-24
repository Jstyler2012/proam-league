// netlify/functions/mutate.js

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-admin-token, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json", ...corsHeaders },
    body: JSON.stringify(body),
  };
}

function getHeader(event, name) {
  const h = event.headers || {};
  return (h[name] || h[name.toLowerCase()] || "").trim();
}

async function getAuthedUserId(event, SUPABASE_URL, SUPABASE_ANON_KEY) {
  const auth = (event.headers?.authorization || event.headers?.Authorization || "").trim();
  if (!auth.startsWith("Bearer ")) return null;

  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: auth,
    },
  });

  if (!r.ok) return null;
  const u = await r.json();
  return u?.id || null;
}

async function sbService(SUPABASE_URL, SERVICE_KEY, method, restPath, bodyObj, prefer) {
  const headers = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
  };

  if (method !== "GET") headers["content-type"] = "application/json";
  if (prefer) headers.Prefer = prefer;

  const r = await fetch(`${SUPABASE_URL}/rest/v1/${restPath}`, {
    method,
    headers,
    body: bodyObj ? JSON.stringify(bodyObj) : undefined,
  });

  const t = await r.text();
  if (!r.ok) throw new Error(t || r.statusText);
  return t ? JSON.parse(t) : null;
}
function safeJson(body) {
  if (!body) return {};
function safeJson(body) {
  if (!body) return {};
  try { return JSON.parse(body); } catch (e) { return {}; }
}
async function getWeekUuidFromNumberService(SUPABASE_URL, SERVICE_KEY, weekNumber) {
  const wk = await sbService(
    SUPABASE_URL,
    SERVICE_KEY,
    "GET",
    `weeks?select=id&week_number=eq.${weekNumber}&limit=1`
  );
  return wk?.[0]?.id || null;
}

// Used by draft logic (keep at top-level, NOT nested)
function sortByHandicapDesc(rows) {
  return rows.slice().sort((a, b) => {
    const ah = a?.player?.handicap_index;
    const bh = b?.player?.handicap_index;
    const aNull = ah === null || ah === undefined;
    const bNull = bh === null || bh === undefined;
    if (aNull && bNull) return String(a?.player?.name || "").localeCompare(String(b?.player?.name || ""));
    if (aNull) return 1;
    if (bNull) return -1;
    if (bh !== ah) return Number(bh) - Number(ah);
    return String(a?.player?.name || "").localeCompare(String(b?.player?.name || ""));
  });
}

async function getDraftRow(SUPABASE_URL, SERVICE_KEY, weekIdText) {
  const rows = await sbService(
    SUPABASE_URL,
    SERVICE_KEY,
    "GET",
    `week_drafts?select=week_id,status,starts_at,turn_player_id,turn_started_at,turn_number&week_id=eq.${encodeURIComponent(weekIdText)}&limit=1`
  );
  return rows?.[0] || null;
}

async function upsertDraftRow(SUPABASE_URL, SERVICE_KEY, row) {
  const out = await sbService(
    SUPABASE_URL,
    SERVICE_KEY,
    "POST",
    `week_drafts?on_conflict=week_id`,
    row,
    "resolution=merge-duplicates,return=representation"
  );
  return out?.[0] || null;
}function routeFrom(event) {
  const raw = (event.path || "").split("?")[0];

  // because netlify.toml uses /.netlify/functions/mutate/:splat
  if (raw.startsWith("/.netlify/functions/mutate/")) {
    return raw.slice("/.netlify/functions/mutate/".length);
  }

  // fallback if hit directly
  if (raw.startsWith("/api-mutate/")) {
    return raw.slice("/api-mutate/".length);
  }

  return raw.replace(/^\/+|\/+$/g, "");
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

    if (!SUPABASE_URL || !SERVICE_KEY || !SUPABASE_ANON_KEY) {
      return json(500, { error: "Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or SUPABASE_ANON_KEY" });
    }

    const path = routeFrom(event);

    let body = {};
try { body = JSON.parse(event.body || "{}"); } catch (e) { body = {}; }
    // -------------------------
    // participate (AUTH REQUIRED)
    // POST /api-mutate/participate { week_id, participate:true|false }
    // -------------------------
    if (path === "participate") {
      const { week_id, participate } = body;
      if (!week_id) return json(400, { error: "Missing week_id" });

      const userId = await getAuthedUserId(event, SUPABASE_URL, SUPABASE_ANON_KEY);
      if (!userId) return json(401, { error: "Not logged in" });

      // Find player linked to auth user
      const found = await sbService(
        SUPABASE_URL,
        SERVICE_KEY,
        "GET",
        `players?select=id&user_id=eq.${userId}&limit=1`
      );
      const playerId = found?.[0]?.id || null;
      if (!playerId) {
        return json(403, { error: "No player linked to this login yet. Go to Sign Up and create your profile." });
      }

      const want = (participate === undefined || participate === null) ? true : Boolean(participate);
// Participation is locked once enabled: do not allow leaving
if (want === false) {
  return json(403, { error: "Participation is locked for the week once confirmed." });
}      // week_participants.week_id might be either INTEGER (week_number) or UUID (weeks.id)
      let weekKey = week_id;

      if (want) {
        try {
          const row = { week_id: weekKey, player_id: playerId };
          const saved = await sbService(
            SUPABASE_URL,
            SERVICE_KEY,
            "POST",
            `week_participants?on_conflict=week_id,player_id`,
            row,
            "resolution=merge-duplicates,return=representation"
          );
          return json(200, { ok: true, mode: "joined", row: saved?.[0] || null });
        } catch (e) {
          const msg = String(e?.message || "");
          if (msg.includes("invalid input syntax for type uuid")) {
            const weekNumber = Number(week_id);
            if (!Number.isFinite(weekNumber)) return json(400, { error: "Invalid week_id" });
            const uuid = await getWeekUuidFromNumberService(SUPABASE_URL, SERVICE_KEY, weekNumber);
            if (!uuid) return json(404, { error: "Week not found" });
            weekKey = uuid;
            const row = { week_id: weekKey, player_id: playerId };
            const saved = await sbService(
              SUPABASE_URL,
              SERVICE_KEY,
              "POST",
              `week_participants?on_conflict=week_id,player_id`,
              row,
              "resolution=merge-duplicates,return=representation"
            );
            return json(200, { ok: true, mode: "joined", row: saved?.[0] || null });
          }
          throw e;
        }
      } else {
        try {
          await sbService(
            SUPABASE_URL,
            SERVICE_KEY,
            "DELETE",
            `week_participants?week_id=eq.${weekKey}&player_id=eq.${playerId}`
          );
          return json(200, { ok: true, mode: "left" });
        } catch (e) {
          const msg = String(e?.message || "");
          if (msg.includes("invalid input syntax for type uuid")) {
            const weekNumber = Number(week_id);
            if (!Number.isFinite(weekNumber)) return json(400, { error: "Invalid week_id" });
            const uuid = await getWeekUuidFromNumberService(SUPABASE_URL, SERVICE_KEY, weekNumber);
            if (!uuid) return json(404, { error: "Week not found" });
            weekKey = uuid;
            await sbService(
              SUPABASE_URL,
              SERVICE_KEY,
              "DELETE",
              `week_participants?week_id=eq.${weekKey}&player_id=eq.${playerId}`
            );
            return json(200, { ok: true, mode: "left" });
          }
          throw e;
        }
      }
    }
    // -------------------------
// admin-remove-participant (ADMIN ONLY)
// POST body: { week_id, player_id }
// - Removes from week_participants
// - Also deletes any player_rounds for that week/player
// Auth required + email allowlist
// -------------------------
if (path === "admin-remove-participant") {
  const auth = event.headers?.authorization || event.headers?.Authorization || "";
  if (!auth.startsWith("Bearer ")) return json(401, { error: "Missing auth" });

  // Identify user
  const meResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: auth },
  });
  if (!meResp.ok) return json(401, { error: "Invalid auth" });

  const user = await meResp.json();

  // ✅ Put your email here (lowercase)
  const ADMIN_EMAILS = ["jstyler2012@yahoo.com".toLowerCase()];
  const email = String(user?.email || "").toLowerCase();
  if (!ADMIN_EMAILS.includes(email)) {
    return json(403, { error: "Admin only" });
  }

  const body = safeJson(event.body);
  const week_id = Number(body?.week_id);
  const player_id = String(body?.player_id || "").trim();

  if (!Number.isFinite(week_id) || !player_id) {
    return json(400, { error: "week_id and player_id required" });
  }

  // week_participants.week_id might be INT or UUID, so try INT first
  let weekKey = week_id;

  // 1) Remove from week_participants (with uuid fallback)
  try {
    await sbService(
      SUPABASE_URL,
      SERVICE_KEY,
      "DELETE",
      `week_participants?week_id=eq.${weekKey}&player_id=eq.${player_id}`
    );
  } catch (e) {
    const msg = String(e?.message || "");
    if (msg.includes("invalid input syntax for type uuid")) {
      const uuid = await getWeekUuidFromNumberService(SUPABASE_URL, SERVICE_KEY, week_id);
      if (!uuid) return json(404, { error: "Week not found" });
      weekKey = uuid;

      await sbService(
        SUPABASE_URL,
        SERVICE_KEY,
        "DELETE",
        `week_participants?week_id=eq.${weekKey}&player_id=eq.${player_id}`
      );
    } else {
      throw e;
    }
  }

  // 2) Also delete any submitted rounds for that player/week (player_rounds uses week_number)
  await sbService(
    SUPABASE_URL,
    SERVICE_KEY,
    "DELETE",
    `player_rounds?week_id=eq.${week_id}&player_id=eq.${player_id}`
  );

  return json(200, { ok: true });
}// -------------------------
// submit-round
// POST /api-mutate/submit-round
// -------------------------
if (path === "submit-round") {

  const { week_id, score_to_par, played_at } = body;

  if (!week_id) {
    return json(400, { error: "Missing week_id" });
  }

  const userId = await getAuthedUserId(
    event,
    SUPABASE_URL,
    SUPABASE_ANON_KEY
  );

  if (!userId) {
    return json(401, { error: "Not logged in" });
  }

  // find player profile
  const found = await sbService(
    SUPABASE_URL,
    SERVICE_KEY,
    "GET",
    `players?select=id&user_id=eq.${userId}&limit=1`
  );

  const playerId = found?.[0]?.id;

  if (!playerId) {
    return json(403, {
      error: "Create your player profile first."
    });
  }

  const score = Number(score_to_par);

  if (!Number.isFinite(score)) {
    return json(400, { error: "Invalid score" });
  }

  const playedAt = played_at || new Date().toISOString();

  const row = {
    week_id,
    player_id: playerId,
    score_to_par: score,
    played_at: playedAt
  };

  const inserted = await sbService(
    SUPABASE_URL,
    SERVICE_KEY,
    "POST",
    "player_rounds",
    row,
    "return=representation"
  );

  return json(200, {
    ok: true,
    round: inserted?.[0]
  });
}    // -------------------------
    // submit-score (PUBLIC)
    // POST /api-mutate/submit-score { week_id, player_id, pro_id, player_to_par, pro_to_par }
    // -------------------------
   // -------------------------
// submit-score (LOCK ENFORCED)
// -------------------------
if (path === "submit-score") {
  const { week_id, player_id, pro_id, player_to_par, pro_to_par } = body;

  if (!week_id || !player_id || !pro_id) {
    return json(400, { error: "Missing required fields" });
  }

  // Load week lock time
  const weeks = await sbService(
    SUPABASE_URL,
    SERVICE_KEY,
    "GET",
    `weeks?select=week_number,label,lock_at&week_number=eq.${week_id}&limit=1`
  );

  const wk = weeks?.[0];

  if (!wk) {
    return json(404, { error: "Week not found" });
  }

  if (!wk.lock_at) {
    return json(403, {
      error: "Scoring disabled: lock time not configured."
    });
  }

  const now = new Date();
  const lockAt = new Date(wk.lock_at);

  if (now < lockAt) {
    return json(403, {
      error: "Draft still open. Scoring unlocks when tournament starts.",
      unlock_at: wk.lock_at
    });
  }

  const your_score = Number(player_to_par);
  const pro_score = pro_to_par != null ? Number(pro_to_par) : null;

  if (!Number.isFinite(your_score)) {
    return json(400, { error: "Invalid player score" });
  }

  if (pro_score != null && !Number.isFinite(pro_score)) {
    return json(400, { error: "Invalid pro score" });
  }

  const total = pro_score != null ? your_score + pro_score : null;

       // Must be live + your turn
      const weekNumber = Number(week_id);
      if (!Number.isFinite(weekNumber)) return json(400, { error: "Invalid week_id" });

      const weekIdText = String(weekNumber);
      const draft = await getDraftRow(SUPABASE_URL, SERVICE_KEY, weekIdText);
      if (!draft) return json(403, { error: "Draft not configured for this week." });
      if (draft.status !== "LIVE") return json(403, { error: "Draft is not live." });

      if (String(draft.turn_player_id || "") !== String(playerId)) {
        return json(403, { error: "Not your turn." });
      }

      // Ensure pro not already taken by someone else
      const picks = await sbService(
        SUPABASE_URL,
        SERVICE_KEY,
        "GET",
        `week_entries?select=player_id,pga_golfer&week_id=eq.${weekNumber}`
      );
      const taken = new Set((picks || []).map(p => String(p.pga_golfer || "")).filter(Boolean));
      if (taken.has(String(pro_id))) {
        return json(409, { error: "That pro is already claimed." });
      }

      // Save pick
      const row = { week_id: weekNumber, player_id: playerId, pga_golfer: String(pro_id), pick_source: "USER" };

      const saved = await sbService(
        SUPABASE_URL,
        SERVICE_KEY,
        "POST",
        `week_entries?on_conflict=week_id,player_id`,
        row,
        "resolution=merge-duplicates,return=representation"
      );

      // Advance turn (reuse tick logic by invoking a local advance)
      // Easiest: just call the same endpoint logic by doing nothing here and letting the next tick advance on stale state.
      // But to keep it snappy, we advance immediately:
      const parts = await sbService(
        SUPABASE_URL,
        SERVICE_KEY,
        "GET",
        `week_participants?select=player_id,player:players(id,name,handicap_index)&week_id=eq.${weekNumber}`
      );
      const ordered = sortByHandicapDesc(parts || []);

      const picks2 = await sbService(
        SUPABASE_URL,
        SERVICE_KEY,
        "GET",
        `week_entries?select=player_id,pga_golfer&week_id=eq.${weekNumber}`
      );
      const picked2 = new Map();
      for (const p of (picks2 || [])) picked2.set(String(p.player_id), p.pga_golfer ?? null);

      const next2 = ordered.find(r => !picked2.get(String(r.player_id)));

      if (!next2) {
        await upsertDraftRow(SUPABASE_URL, SERVICE_KEY, {
          week_id: weekIdText,
          status: "COMPLETE",
          turn_player_id: null,
          turn_started_at: null,
          updated_at: new Date().toISOString(),
        });
      } else {
        await upsertDraftRow(SUPABASE_URL, SERVICE_KEY, {
          week_id: weekIdText,
          status: "LIVE",
          turn_player_id: next2.player_id,
          turn_started_at: new Date().toISOString(),
          turn_number: Number(draft.turn_number || 0) + 1,
          updated_at: new Date().toISOString(),
        });
      }

      try{
        await sbService(SUPABASE_URL, SERVICE_KEY, "POST", "draft_events", {
          week_id: weekIdText,
          turn_number: draft.turn_number || 0,
          player_id: playerId,
          action: "PICK",
          pro_id: String(pro_id),
        }, "return=minimal");
      }catch(e){}

      return json(200, { ok: true, entry: saved?.[0] || null });       // -------------------------
    // draft-tick (NO AUTH)
    // POST /api-mutate/draft-tick { week_id }
    // - Auto-start draft if starts_at passed and still SCHEDULED
    // - Auto-pick if elapsed >= 70s for current turn
    // -------------------------
    if (path === "draft-tick") {
      const { week_id } = body;
      const weekNumber = Number(week_id);
      if (!Number.isFinite(weekNumber)) return json(400, { error: "Missing/invalid week_id" });

      const weekIdText = String(weekNumber);
      const now = new Date();

      const draft = await getDraftRow(SUPABASE_URL, SERVICE_KEY, weekIdText);
      if (!draft) return json(200, { ok: true, status: "NO_DRAFT_ROW" });

      const startsAt = draft.starts_at ? new Date(draft.starts_at) : null;
      if (!startsAt) return json(200, { ok: true, status: "MISSING_STARTS_AT" });

      // Load participants order + picks (recomputed each tick to keep it simple/safe)
      const parts = await sbService(
        SUPABASE_URL,
        SERVICE_KEY,
        "GET",
        `week_participants?select=player_id,player:players(id,name,handicap_index)&week_id=eq.${weekNumber}`
      );

      const ordered = sortByHandicapDesc(parts || []);
      const picks = await sbService(
        SUPABASE_URL,
        SERVICE_KEY,
        "GET",
        `week_entries?select=player_id,pga_golfer&week_id=eq.${weekNumber}`
      );

      const pickedBy = new Map();
      const taken = new Set();
      for (const p of (picks || [])) {
        if (p.player_id) pickedBy.set(String(p.player_id), p.pga_golfer ?? null);
        if (p.pga_golfer) taken.add(String(p.pga_golfer));
      }

      const nextUnpicked = ordered.find(r => !pickedBy.get(String(r.player_id)));

      // Auto-start
      if (draft.status === "SCHEDULED" && now >= startsAt) {
        if (!nextUnpicked) {
          await upsertDraftRow(SUPABASE_URL, SERVICE_KEY, {
            week_id: weekIdText,
            status: "COMPLETE",
            turn_player_id: null,
            turn_started_at: null,
            turn_number: draft.turn_number || 0,
            updated_at: new Date().toISOString(),
          });
          return json(200, { ok: true, status: "COMPLETE_NO_PARTICIPANTS_OR_ALL_PICKED" });
        }

        await upsertDraftRow(SUPABASE_URL, SERVICE_KEY, {
          week_id: weekIdText,
          status: "LIVE",
          turn_player_id: nextUnpicked.player_id,
          turn_started_at: new Date().toISOString(),
          turn_number: 0,
          updated_at: new Date().toISOString(),
        });

        // optional audit
        try{
          await sbService(SUPABASE_URL, SERVICE_KEY, "POST", "draft_events", {
            week_id: weekIdText,
            turn_number: 0,
            player_id: nextUnpicked.player_id,
            action: "START",
            pro_id: null,
          }, "return=minimal");
        }catch(e){}

        return json(200, { ok: true, status: "STARTED" });
      }

      // If not live, nothing else to do
      if (draft.status !== "LIVE") return json(200, { ok: true, status: draft.status });

      // If somehow all picked, complete
      if (!nextUnpicked) {
        await upsertDraftRow(SUPABASE_URL, SERVICE_KEY, {
          week_id: weekIdText,
          status: "COMPLETE",
          turn_player_id: null,
          turn_started_at: null,
          updated_at: new Date().toISOString(),
        });
        try{
          await sbService(SUPABASE_URL, SERVICE_KEY, "POST", "draft_events", {
            week_id: weekIdText,
            turn_number: draft.turn_number || 0,
            player_id: draft.turn_player_id,
            action: "COMPLETE",
            pro_id: null,
          }, "return=minimal");
        }catch(e){}
        return json(200, { ok: true, status: "COMPLETE" });
      }

      const turnStarted = draft.turn_started_at ? new Date(draft.turn_started_at) : now;
      const elapsed = Math.floor((now - turnStarted) / 1000);

      // Auto-pick at >= 70s
      if (elapsed >= 70 && draft.turn_player_id) {
        // Choose "top available" pro.
        // For now: use /week_pros if you have it later; currently fallback to /pros placeholder list.
        let candidates = [];
        try{
          candidates = await sbService(
            SUPABASE_URL,
            SERVICE_KEY,
            "GET",
            `week_pros?select=pro_id,pro_name,odds_rank,tier&week_id=eq.${weekNumber}&order=odds_rank.asc.nullsfirst,tier.asc,pro_name.asc`
          );
        }catch(e){
          candidates = [];
        }

        if (!candidates.length) {
          // fallback to placeholder pros to keep system working now
          candidates = [
            { pro_id: "Scottie Scheffler", pro_name: "Scottie Scheffler" },
            { pro_id: "Rory McIlroy", pro_name: "Rory McIlroy" },
            { pro_id: "Jon Rahm", pro_name: "Jon Rahm" },
            { pro_id: "Viktor Hovland", pro_name: "Viktor Hovland" },
          ];
        }

        const pick = candidates.find(c => !taken.has(String(c.pro_id || c.pro_name)));
        if (pick) {
          const proId = String(pick.pro_id || pick.pro_name);

          await sbService(
            SUPABASE_URL,
            SERVICE_KEY,
            "POST",
            `week_entries?on_conflict=week_id,player_id`,
            { week_id: weekNumber, player_id: draft.turn_player_id, pga_golfer: proId, pick_source: "AUTO" },
            "resolution=merge-duplicates,return=minimal"
          );

          try{
            await sbService(SUPABASE_URL, SERVICE_KEY, "POST", "draft_events", {
              week_id: weekIdText,
              turn_number: draft.turn_number || 0,
              player_id: draft.turn_player_id,
              action: "AUTOPICK",
              pro_id: proId,
            }, "return=minimal");
          }catch(e){}
        }

        // Advance to next unpicked after auto-pick
        const picks2 = await sbService(
          SUPABASE_URL,
          SERVICE_KEY,
          "GET",
          `week_entries?select=player_id,pga_golfer&week_id=eq.${weekNumber}`
        );
        const picked2 = new Map();
        for (const p of (picks2 || [])) picked2.set(String(p.player_id), p.pga_golfer ?? null);

        const next2 = ordered.find(r => !picked2.get(String(r.player_id)));
        if (!next2) {
          await upsertDraftRow(SUPABASE_URL, SERVICE_KEY, {
            week_id: weekIdText,
            status: "COMPLETE",
            turn_player_id: null,
            turn_started_at: null,
            updated_at: new Date().toISOString(),
          });
          return json(200, { ok: true, status: "COMPLETE" });
        }

        await upsertDraftRow(SUPABASE_URL, SERVICE_KEY, {
          week_id: weekIdText,
          status: "LIVE",
          turn_player_id: next2.player_id,
          turn_started_at: new Date().toISOString(),
          turn_number: Number(draft.turn_number || 0) + 1,
          updated_at: new Date().toISOString(),
        });

        return json(200, { ok: true, status: "AUTO_PICKED_AND_ADVANCED" });
      }

      return json(200, { ok: true, status: "NOOP" });
    }  
    // draft-pick (AUTH REQUIRED)
    // POST /api-mutate/draft-pick { week_id, pro_id }
    // -------------------------
    if (path === "draft-pick") {
      const { week_id, pro_id } = body;

      if (!week_id || !pro_id) {
        return json(400, { error: "Missing week_id or pro_id" });
      }

      const userId = await getAuthedUserId(event, SUPABASE_URL, SUPABASE_ANON_KEY);
      if (!userId) return json(401, { error: "Not logged in" });

      const found = await sbService(
        SUPABASE_URL,
        SERVICE_KEY,
        "GET",
        `players?select=id&user_id=eq.${userId}&limit=1`
      );
      const playerId = found?.[0]?.id || null;
      if (!playerId) {
        return json(403, { error: "No player linked to this login yet. Go to Sign Up and create your profile." });
      }

      const row = { week_id, player_id: playerId, pga_golfer: pro_id };

      const saved = await sbService(
        SUPABASE_URL,
        SERVICE_KEY,
        "POST",
        `week_entries?on_conflict=week_id,player_id`,
        row,
        "resolution=merge-duplicates,return=representation"
      );

      return json(200, { ok: true, entry: saved?.[0] || null });
    }

    return json(404, { error: "Not found", path });
  } catch (err) {
    return json(500, { error: err?.message || String(err) });
  }
};
