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

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return text(500, "Missing SUPABASE_URL or SUPABASE_ANON_KEY");
    }

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
    // pros (placeholder list for now)
    // -------------------------
    if (route === "pros") {
      const pros = [
        { id: "Rory McIlroy", name: "Rory McIlroy" },
        { id: "Scottie Scheffler", name: "Scottie Scheffler" },
        { id: "Jon Rahm", name: "Jon Rahm" },
        { id: "Xander Schauffele", name: "Xander Schauffele" },
      ];
      return json(200, pros);
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
    }    // -------------------------
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
