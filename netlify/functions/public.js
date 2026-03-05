// netlify/functions/public.js

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

function text(statusCode, bodyText) {
  return {
    statusCode,
    headers: { "content-type": "text/plain; charset=utf-8", ...corsHeaders },
    body: bodyText,
  };
}

function getRoute(event) {
  const raw = (event.path || "").split("?")[0];

  // routed via /.netlify/functions/public/:splat
  if (raw.startsWith("/.netlify/functions/public")) {
    const rest = raw.slice("/.netlify/functions/public".length);
    return rest.replace(/^\/+|\/+$/g, "");
  }

  // fallback if hit via /api/*
  if (raw.startsWith("/api/")) {
    return raw.slice("/api/".length).replace(/^\/+|\/+$/g, "");
  }
  if (raw === "/api") return "";

  return raw.replace(/^\/+|\/+$/g, "");
}

async function sbAnon(SUPABASE_URL, SUPABASE_ANON_KEY, method, restPath) {
  const url = `${SUPABASE_URL}/rest/v1/${restPath}`;
  const r = await fetch(url, {
    method,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
  });
  const t = await r.text();
  if (!r.ok) return { ok: false, status: r.status, text: t };
  if (!t) return { ok: true, json: null };
  try { return { ok: true, json: JSON.parse(t) }; } catch { return { ok: true, json: t }; }
}


async function sbService(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, method, restPath) {
  const url = `${SUPABASE_URL}/rest/v1/${restPath}`;
  const r = await fetch(url, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  const t = await r.text();
  if (!r.ok) return { ok: false, status: r.status, text: t };
  if (!t) return { ok: true, json: null };
  try { return { ok: true, json: JSON.parse(t) }; } catch { return { ok: true, json: t }; }
}

async function getWeekUuidFromNumber(SUPABASE_URL, SUPABASE_ANON_KEY, weekNumber) {
  const out = await sbAnon(
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    "GET",
    `weeks?select=id&week_number=eq.${weekNumber}&limit=1`
  );
  if (!out.ok) return { ok: false, status: out.status, text: out.text };
  const id = (out.json || [])[0]?.id || null;
  if (!id) return { ok: false, status: 404, text: "Week not found" };
  return { ok: true, id };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  try {
    const route = getRoute(event);

    if (route === "" || route === "health") {
      return json(200, { ok: true, route, rawPath: event.path });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return text(500, "Missing SUPABASE_URL or SUPABASE_ANON_KEY");
    }
    // SUPABASE_SERVICE_ROLE_KEY is optional; used for public reads that may be blocked by RLS.

    // -------------------------
    // schedule
    // -------------------------
    if (route === "schedule") {
      const out = await sbAnon(
        SUPABASE_URL,
        SUPABASE_ANON_KEY,
        "GET",
        "weeks?select=week_number,label,tournament_name,start_date,end_date,logo_url,winner_player_name&order=week_number.asc"
      );
      if (!out.ok) return text(out.status, out.text);
      return json(200, { weeks: out.json || [] });
    }

    // -------------------------
    // current-week (uses dates; if today < first start_date, returns first)
    // -------------------------
    if (route === "current-week") {
      const out = await sbAnon(
        SUPABASE_URL,
        SUPABASE_ANON_KEY,
        "GET",
        "weeks?select=week_number,label,tournament_name,start_date,end_date,logo_url,winner_player_name&order=week_number.asc"
      );
      if (!out.ok) return text(out.status, out.text);

      const weeks = out.json || [];
      if (!weeks.length) return json(200, { week: null });

      const today = new Date();

      const inRange = weeks.find((w) => {
        if (!w.start_date || !w.end_date) return false;
        const s = new Date(w.start_date + "T00:00:00");
        const e = new Date(w.end_date + "T23:59:59");
        return today >= s && today <= e;
      });

      const week =
        inRange ||
        (weeks[0]?.start_date && today < new Date(weeks[0].start_date + "T00:00:00")
          ? weeks[0]
          : weeks[weeks.length - 1]);

      return json(200, { week });
    }
    // -------------------------
    // pro-leaderboard (PGA live scoring)
    // GET /api/pro-leaderboard?week_id=7 (optional)
    // -------------------------
    if (route === "pro-leaderboard") {
      const q = event.queryStringParameters || {};
      const requestedWeek = q.week_id ? Number(q.week_id) : null;

      // Determine week by date if not provided
      let week = null;
      if (requestedWeek && Number.isFinite(requestedWeek)) {
        const wOut = await sbAnon(
          SUPABASE_URL,
          SUPABASE_ANON_KEY,
          "GET",
          `weeks?select=week_number,label,tournament_name,start_date,end_date,logo_url,leaderboard_last_synced_at,pro_leaderboard_cut_line_to_par,pro_leaderboard_status&week_number=eq.${requestedWeek}&limit=1`
        );
        if (!wOut.ok) return text(wOut.status, wOut.text);
        week = (wOut.json || [])[0] || null;
      } else {
        const out = await sbAnon(
          SUPABASE_URL,
          SUPABASE_ANON_KEY,
          "GET",
          "weeks?select=week_number,label,tournament_name,start_date,end_date,logo_url,leaderboard_last_synced_at,pro_leaderboard_cut_line_to_par,pro_leaderboard_status&order=week_number.asc"
        );
        if (!out.ok) return text(out.status, out.text);

        const weeks = out.json || [];
        if (!weeks.length) return json(200, { week: null, rows: [] });

        const today = new Date();

        const inRange = weeks.find((w) => {
          if (!w.start_date || !w.end_date) return false;
          const s = new Date(w.start_date + "T00:00:00");
          const e = new Date(w.end_date + "T23:59:59");
          return today >= s && today <= e;
        });

        week =
          inRange ||
          (weeks[0]?.start_date && today < new Date(weeks[0].start_date + "T00:00:00")
            ? weeks[0]
            : weeks[weeks.length - 1]);
      }

      if (!week) return json(200, { week: null, rows: [] });

      // Fetch leaderboard entries (fallback to service role if anon blocked)
      const lbPath =
        `pro_leaderboard_entries?select=week_number,player_ext_id,position,score_to_par,today,thru,round,strokes,status,is_cut,updated_at&week_number=eq.${Number(week.week_number)}&order=score_to_par.asc.nullslast` +
        `&order=score_to_par.asc.nullslast`;

      let lbOut = await sbAnon(SUPABASE_URL, SUPABASE_ANON_KEY, "GET", lbPath);
      if (!lbOut.ok && SUPABASE_SERVICE_ROLE_KEY) {
        lbOut = await sbService(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, "GET", lbPath);
      }
      if (!lbOut.ok) return text(lbOut.status, lbOut.text);

      const rows = lbOut.json || [];

      // Optional: hydrate player_name from week_pro_field if table exists / allowed by RLS
      const fieldPath =
        `week_pro_field?select=player_ext_id,player_name` +
        `&week_number=eq.${Number(week.week_number)}`;

      let fieldOut = await sbAnon(SUPABASE_URL, SUPABASE_ANON_KEY, "GET", fieldPath);
      if (!fieldOut.ok && SUPABASE_SERVICE_ROLE_KEY) {
        fieldOut = await sbService(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, "GET", fieldPath);
      }

      if (fieldOut.ok && Array.isArray(fieldOut.json)) {
        const nameMap = new Map();
        for (const r of fieldOut.json) {
          if (r?.player_ext_id && r?.player_name) {
            nameMap.set(String(r.player_ext_id), String(r.player_name));
          }
        }
        for (const r of rows) {
          const nm = nameMap.get(String(r.player_ext_id));
          if (nm) r.player_name = nm;
        }
      }

      return json(200, {
        week,
        cut_line_to_par: week.pro_leaderboard_cut_line_to_par ?? null,
        rows,
      });
    }


   // -------------------------
// pros (deprecated: homepage no longer needs this; keep endpoint for backwards compatibility)
if (route === "pros") {
  return json(200, []);
}
    // -------------------------
    // me (requires Authorization bearer token)
    // -------------------------
    if (route === "me") {
      const auth = (event.headers?.authorization || event.headers?.Authorization || "").trim();
      if (!auth.startsWith("Bearer ")) return json(401, { error: "Not logged in" });

      const meResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: auth },
      });

      const meText = await meResp.text();
      if (!meResp.ok) return json(meResp.status, { error: meText });

      let user = null;
      try { user = JSON.parse(meText); } catch { user = null; }
      const userId = user?.id;
      if (!userId) return json(401, { error: "Invalid session" });

      const p = await sbAnon(
        SUPABASE_URL,
        SUPABASE_ANON_KEY,
        "GET",
        `players?select=id,name,handicap_index,user_id&user_id=eq.${userId}&limit=1`
      );
      if (!p.ok) return text(p.status, p.text);

      const player = (p.json || [])[0] || null;
      return json(200, { user: { id: userId, email: user?.email || null }, player });
    }

    // -------------------------
    // players (public list)
    // -------------------------
    if (route === "players") {
      const out = await sbAnon(
        SUPABASE_URL,
        SUPABASE_ANON_KEY,
        "GET",
        "players?select=id,name,handicap_index&order=name.asc"
      );
      if (!out.ok) return text(out.status, out.text);
      return json(200, out.json || []);
    }

    // -------------------------
    // participants
    // Returns all participants for a week.
    // If Authorization is provided, also returns is_participating for the authed user.
    // Query param: week_id (WEEK NUMBER)
    // -------------------------
    if (route === "participants") {
      const q = event.queryStringParameters || {};
      const weekNumber = Number(q.week_id);
      if (!Number.isFinite(weekNumber)) return json(400, { error: "Missing/invalid week_id" });

      // week_participants.week_id might be either INTEGER (week_number) or UUID (weeks.id)
      let weekKey = weekNumber;
      let part = await sbAnon(
        SUPABASE_URL,
        SUPABASE_ANON_KEY,
        "GET",
        `week_participants?week_id=eq.${weekKey}&select=player_id,player:players(id,name,handicap_index)`
      );

      if (!part.ok && String(part.text || "").includes("invalid input syntax for type uuid")) {
        const wk = await getWeekUuidFromNumber(SUPABASE_URL, SUPABASE_ANON_KEY, weekNumber);
        if (!wk.ok) return text(wk.status, wk.text);
        weekKey = wk.id;
        part = await sbAnon(
          SUPABASE_URL,
          SUPABASE_ANON_KEY,
          "GET",
          `week_participants?week_id=eq.${weekKey}&select=player_id,player:players(id,name,handicap_index)`
        );
      }
      if (!part.ok) return text(part.status, part.text);

      const rows = (part.json || []).map((r) => ({
        player_id: r.player_id,
        player_name: r?.player?.name || "—",
        handicap_index: r?.player?.handicap_index ?? null,
      }));

      // Optional: determine if the authed user is participating
      let is_participating = false;
      const auth = (event.headers?.authorization || event.headers?.Authorization || "").trim();
      if (auth.startsWith("Bearer ")) {
        const meResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
          headers: { apikey: SUPABASE_ANON_KEY, Authorization: auth },
        });
        if (meResp.ok) {
          const user = await meResp.json();
          const userId = user?.id;
          if (userId) {
            const p = await sbAnon(
              SUPABASE_URL,
              SUPABASE_ANON_KEY,
              "GET",
              `players?select=id&user_id=eq.${userId}&limit=1`
            );
            const playerId = (p.ok ? (p.json || [])[0]?.id : null) || null;
            if (playerId) {
              is_participating = rows.some((r) => String(r.player_id) === String(playerId));
            }
          }
        }
      }

      return json(200, { week_id: weekNumber, rows, is_participating });
    }
    // -------------------------
    // draft-board
    // Returns participants sorted by handicap desc, with current pro pick (if any)
    // Query param: week_id (WEEK NUMBER)
    // -------------------------
    if (route === "draft-board") {
      const q = event.queryStringParameters || {};
      const weekNumber = Number(q.week_id);
      if (!Number.isFinite(weekNumber)) return json(400, { error: "Missing/invalid week_id" });

      // week_participants.week_id might be either INTEGER (week_number) or UUID (weeks.id)
      let weekKey = weekNumber;

      // Pull participants (with handicap)
      let part = await sbAnon(
        SUPABASE_URL,
        SUPABASE_ANON_KEY,
        "GET",
        `week_participants?week_id=eq.${weekKey}&select=player_id,player:players(id,name,handicap_index)`
      );

      // If week_id is UUID in DB, retry with uuid
      if (!part.ok && String(part.text || "").includes("invalid input syntax for type uuid")) {
        const wk = await getWeekUuidFromNumber(SUPABASE_URL, SUPABASE_ANON_KEY, weekNumber);
        if (!wk.ok) return text(wk.status, wk.text);
        weekKey = wk.id;

        part = await sbAnon(
          SUPABASE_URL,
          SUPABASE_ANON_KEY,
          "GET",
          `week_participants?week_id=eq.${weekKey}&select=player_id,player:players(id,name,handicap_index)`
        );
      }
      if (!part.ok) return text(part.status, part.text);

      const participants = (part.json || []).map((r) => ({
        player_id: r.player_id,
        player_name: r?.player?.name || "—",
        handicap_index: r?.player?.handicap_index ?? null,
      }));

      // Sort: highest handicap -> lowest (nulls last)
      participants.sort((a, b) => {
        const ah = a.handicap_index, bh = b.handicap_index;
        const aNull = ah === null || ah === undefined;
        const bNull = bh === null || bh === undefined;
        if (aNull && bNull) return (a.player_name || "").localeCompare(b.player_name || "");
        if (aNull) return 1;
        if (bNull) return -1;
        if (bh !== ah) return bh - ah;
        return (a.player_name || "").localeCompare(b.player_name || "");
      });

      // Pull picks for the week
      const picks = await sbAnon(
        SUPABASE_URL,
        SUPABASE_ANON_KEY,
        "GET",
        `week_entries?week_id=eq.${weekKey}&select=player_id,pga_golfer`
      );
      if (!picks.ok) return text(picks.status, picks.text);

      const pickByPlayer = new Map();
      for (const p of (picks.json || [])) {
        pickByPlayer.set(p.player_id, p.pga_golfer ?? null);
      }

      const rows = participants.map((pl) => ({
        player_id: pl.player_id,
        player_name: pl.player_name,
        handicap_index: pl.handicap_index,
        pro_id: pickByPlayer.get(pl.player_id) ?? null,
      }));

      return json(200, { week_id: weekNumber, rows });
    }   
        // -------------------------
    // draft-state
    // Query param: week_id (WEEK NUMBER)
    // Returns: week_draft row + draft order (if published) + optional viewer eligibility
    // -------------------------
    if (route === "draft-state") {
      const q = event.queryStringParameters || {};
      const weekNumber = Number(q.week_id);
      if (!Number.isFinite(weekNumber)) return json(400, { error: "Missing/invalid week_id" });

      // draft row (created by rpc draft_ensure_week / cron / admin)
      const d = SUPABASE_SERVICE_ROLE_KEY
        ? await sbService(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, "GET", `week_draft?week_number=eq.${weekNumber}&limit=1`)
        : await sbAnon(SUPABASE_URL, SUPABASE_ANON_KEY, "GET", `week_draft?week_number=eq.${weekNumber}&limit=1`);
      if (!d.ok) return text(d.status, d.text);

      const draft = (d.json || [])[0] || null;
      if (!draft) return json(404, { error: "Draft not initialized for this week yet." });

      // order is visible once generated (ORDER_PUBLISHED or later)
      let order = [];
      if (["ORDER_PUBLISHED", "LIVE", "SWAP_OPEN", "LOCKED", "COMPLETE"].includes(draft.status)) {
        const o = SUPABASE_SERVICE_ROLE_KEY
          ? await sbService(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, "GET", `week_draft_order?week_number=eq.${weekNumber}&select=player_id,handicap_index,handicap_group,pick_position,group_position&order=pick_position.asc`)
          : await sbAnon(SUPABASE_URL, SUPABASE_ANON_KEY, "GET", `week_draft_order?week_number=eq.${weekNumber}&select=player_id,handicap_index,handicap_group,pick_position,group_position&order=pick_position.asc`);
        if (!o.ok) return text(o.status, o.text);
        order = o.json || [];
      }

      // Optional: if logged in, return viewer’s player_id + eligibility
      let viewer = null;
      const auth = (event.headers?.authorization || event.headers?.Authorization || "").trim();
      if (auth.startsWith("Bearer ")) {
        const meResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
          headers: { apikey: SUPABASE_ANON_KEY, Authorization: auth },
        });

        if (meResp.ok) {
          const meText = await meResp.text();
          let u = null;
          try { u = JSON.parse(meText); } catch { u = null; }
          const userId = u?.id || null;

          if (userId) {
            const p = await sbAnon(
              SUPABASE_URL,
              SUPABASE_ANON_KEY,
              "GET",
              `players?select=id,name,handicap_index&user_id=eq.${userId}&limit=1`
            );
            if (p.ok) {
              const player = (p.json || [])[0] || null;
              if (player) {
                const h = Number(player.handicap_index ?? 999);
                const handicap_group =
                  h >= 16 ? 1 :
                  h >= 11 ? 2 :
                  h >= 6  ? 3 : 4;

                const min_tier = handicap_group; // same mapping

                viewer = {
                  player_id: player.id,
                  player_name: player.name,
                  handicap_index: player.handicap_index,
                  handicap_group,
                  min_tier,
                };
              }
            }
          }
        }
      }

      return json(200, {
        ok: true,
        server_now: new Date().toISOString(),
        week_number: weekNumber,
        draft,
        order,
        viewer,
      });
    }

    // -------------------------
    // week-pros (weekly field with tier + taken flags)
    // Query param: week_id (WEEK NUMBER)
    // -------------------------
    if (route === "week-pros") {
      const q = event.queryStringParameters || {};
      const weekNumber = Number(q.week_id);
      if (!Number.isFinite(weekNumber)) return json(400, { error: "Missing/invalid week_id" });

      // weekly field
      // IMPORTANT: week_pro_field is safe/public data, but your Supabase RLS may block anon reads.
      // If anon returns 0 rows and a service key is available, fall back to service-role for this read.
      const fieldPath = `week_pro_field?week_number=eq.${weekNumber}&select=player_ext_id,player_name,odds_display,odds_numeric,odds_rank,tier&order=odds_rank.asc`;

      let f = await sbAnon(SUPABASE_URL, SUPABASE_ANON_KEY, "GET", fieldPath);
      if (!f.ok) return text(f.status, f.text);

      const anonRows = Array.isArray(f.json) ? f.json : [];
      if (anonRows.length === 0 && SUPABASE_SERVICE_ROLE_KEY) {
        const svc = await sbService(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, "GET", fieldPath);
        if (svc.ok) f = svc;
      }

      // taken list from week_entries (week_id can be int or uuid)
      let weekKey = weekNumber;
      let taken = await sbAnon(
        SUPABASE_URL,
        SUPABASE_ANON_KEY,
        "GET",
        `week_entries?week_id=eq.${weekKey}&select=player_id,pga_golfer,pga_golfer_ext_id`
      );

      if (!taken.ok && String(taken.text || "").includes("invalid input syntax for type uuid")) {
        const wk = await getWeekUuidFromNumber(SUPABASE_URL, SUPABASE_ANON_KEY, weekNumber);
        if (!wk.ok) return text(wk.status, wk.text);
        weekKey = wk.id;
        taken = await sbAnon(
          SUPABASE_URL,
          SUPABASE_ANON_KEY,
          "GET",
          `week_entries?week_id=eq.${weekKey}&select=player_id,pga_golfer,pga_golfer_ext_id`
        );
      }
      if (!taken.ok) return text(taken.status, taken.text);

      const takenMap = new Map();
      for (const r of (taken.json || [])) {
        if (r?.pga_golfer_ext_id) takenMap.set(String(r.pga_golfer_ext_id), r.player_id);
      }

      const out = (f.json || []).map((p) => ({
        ...p,
        taken: takenMap.has(String(p.player_ext_id)),
        taken_by_player_id: takenMap.get(String(p.player_ext_id)) || null,
      }));

      return json(200, { ok: true, week_number: weekNumber, pros: out });
    }
    // -------------------------
    // leaderboard
    // Ranking rule:
    // - best_player = MIN(player_rounds.score_to_par)
    // - combined = best_player + proScore (when pro scoring exists)
    // - rank_score = COALESCE(combined, best_player)
    //
    // NOTE: for now proScore may be null until you integrate the API.
    // -------------------------
    if (route === "leaderboard") {
      const q = event.queryStringParameters || {};
      const weekNumber = Number(q.week_id);
      if (!Number.isFinite(weekNumber)) return json(400, { error: "Missing/invalid week_id" });

      // week_participants/week_entries might key on INTEGER week_number OR UUID weeks.id
      let weekKey = weekNumber;

      // Pull all participants for the week
      let part = await sbAnon(
        SUPABASE_URL,
        SUPABASE_ANON_KEY,
        "GET",
        `week_participants?week_id=eq.${weekKey}&select=player_id,player:players(id,name,handicap_index)`
      );

      if (!part.ok && String(part.text || "").includes("invalid input syntax for type uuid")) {
        const wk = await getWeekUuidFromNumber(SUPABASE_URL, SUPABASE_ANON_KEY, weekNumber);
        if (!wk.ok) return text(wk.status, wk.text);
        weekKey = wk.id;
        part = await sbAnon(
          SUPABASE_URL,
          SUPABASE_ANON_KEY,
          "GET",
          `week_participants?week_id=eq.${weekKey}&select=player_id,player:players(id,name,handicap_index)`
        );
      }
      if (!part.ok) return text(part.status, part.text);

      const participants = (part.json || []).map((r) => ({
        player_id: r.player_id,
        player_name: r?.player?.name || "—",
        handicap_index: r?.player?.handicap_index ?? null,
      }));

      // Pull all rounds for the week; compute best per player
      const rounds = await sbAnon(
        SUPABASE_URL,
        SUPABASE_ANON_KEY,
        "GET",
        `player_rounds?week_id=eq.${weekNumber}&select=player_id,score_to_par,played_at`
      );
      if (!rounds.ok) return text(rounds.status, rounds.text);

      const bestByPlayer = new Map();
      for (const r of (rounds.json || [])) {
        const pid = r.player_id;
        const s = Number(r.score_to_par);
        if (!Number.isFinite(s)) continue;
        const cur = bestByPlayer.get(pid);
        if (cur === undefined || s < cur) bestByPlayer.set(pid, s);
      }

      // Pull pro picks (stored in week_entries right now)
      const picks = await sbAnon(
        SUPABASE_URL,
        SUPABASE_ANON_KEY,
        "GET",
        `week_entries?week_id=eq.${weekKey}&select=player_id,pga_golfer,pro_score`
      );
      if (!picks.ok) return text(picks.status, picks.text);

      const pickByPlayer = new Map();
      const proScoreByPlayer = new Map();
      for (const p of (picks.json || [])) {
        pickByPlayer.set(p.player_id, p.pga_golfer ?? null);
        // pro_score may be null until pro data integration
        const ps = p.pro_score;
        proScoreByPlayer.set(p.player_id, ps === null || ps === undefined ? null : Number(ps));
      }

      // Build rows:
      // - playerScore = best round (min)
      // - combined = playerScore + proScore if proScore is number
      // - rank_score = combined ?? playerScore
      const rows = participants.map((pl) => {
        const playerScore = bestByPlayer.has(pl.player_id) ? bestByPlayer.get(pl.player_id) : null;
        const proScore = proScoreByPlayer.has(pl.player_id) ? proScoreByPlayer.get(pl.player_id) : null;

        const hasPlayer = Number.isFinite(playerScore);
        const hasPro = Number.isFinite(proScore);

        const combined = (hasPlayer && hasPro) ? (playerScore + proScore) : null;
        const rank_score = (combined !== null) ? combined : (hasPlayer ? playerScore : null);

        return {
          player_id: pl.player_id,
          player_name: pl.player_name,
          handicap_index: pl.handicap_index,
          playerScore: hasPlayer ? playerScore : null,
          proScore: hasPro ? proScore : null,
          combined: combined,          // may be null early
          rank_score: rank_score,      // this is what we sort by
          pga_golfer: pickByPlayer.get(pl.player_id) ?? null,
        };
      });

      // Sort by rank_score ascending (lowest wins). Players with no rounds go last.
      rows.sort((a, b) => {
        const ar = a.rank_score, br = b.rank_score;
        const aNull = ar === null || ar === undefined;
        const bNull = br === null || br === undefined;
        if (aNull && bNull) return (a.player_name || "").localeCompare(b.player_name || "");
        if (aNull) return 1;
        if (bNull) return -1;
        if (ar !== br) return ar - br;
        return (a.player_name || "").localeCompare(b.player_name || "");
      });

      return json(200, { week_id: weekNumber, rows });
    }

    // -------------------------
    // season-standings
    // -------------------------
    if (route === "season-standings") {
      const out = await sbAnon(
        SUPABASE_URL,
        SUPABASE_ANON_KEY,
        "GET",
        "season_standings?select=player_id,player_name,points&order=points.desc,player_name.asc"
      );
      if (!out.ok) return text(out.status, out.text);
      return json(200, { rows: out.json || [] });
    }

    return json(404, { error: "Not found", route, rawPath: event.path });
  } catch (err) {
    return text(500, err?.message || String(err));
  }
};
