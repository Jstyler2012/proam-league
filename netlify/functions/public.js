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
  try {
    return { ok: true, json: JSON.parse(t) };
  } catch {
    return { ok: true, json: t };
  }
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
  try {
    return { ok: true, json: JSON.parse(t) };
  } catch {
    return { ok: true, json: t };
  }
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

// Map pro ext_id -> display name for a given week.
async function loadProNameMap(SUPABASE_URL, SUPABASE_ANON_KEY, weekNumber) {
  const f = await sbAnon(
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    "GET",
    `week_pro_field?week_number=eq.${weekNumber}&select=player_ext_id,player_name`
  );
  if (!f.ok) return { ok: false, status: f.status, text: f.text, map: new Map() };
  const map = new Map();
  for (const r of f.json || []) {
    if (r?.player_ext_id != null) map.set(String(r.player_ext_id), r?.player_name || null);
  }
  return { ok: true, map };
}

// Normalize a pick from week_entries into {extId, display}
function normalizePick(pickRow, proNameMap) {
  const ext = pickRow?.pga_golfer_ext_id != null ? String(pickRow.pga_golfer_ext_id) : null;
  const legacy = pickRow?.pga_golfer != null ? String(pickRow.pga_golfer) : null;

  // Prefer explicit ext id column.
  if (ext) {
    const nm = proNameMap?.get(ext) || null;
    return { extId: ext, display: nm || ext };
  }

  // If legacy column happens to store ext_id, try mapping.
  if (legacy) {
    const nm = proNameMap?.get(legacy) || null;
    return { extId: nm ? legacy : null, display: nm || legacy };
  }

  return { extId: null, display: null };
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
    // current-week
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
    // pros (deprecated)
    // -------------------------
    if (route === "pros") {
      return json(200, []);
    }

    // -------------------------
    // me
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
      try {
        user = JSON.parse(meText);
      } catch {
        user = null;
      }
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
    // players
    // -------------------------
    if (route === "players") {
      const out = await sbAnon(
        SUPABASE_URL,
        SUPABASE_ANON_KEY,
        "GET",
        "players?select=id,name,handicap_index&order=name.asc"
      );
      if (!out.ok) return text(out.status, out.text);
      return json(200, { rows: out.json || [] });
    }

    // -------------------------
    // participants
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
            if (playerId) is_participating = rows.some((r) => String(r.player_id) === String(playerId));
          }
        }
      }

      return json(200, { week_id: weekNumber, rows, is_participating });
    }

    // -------------------------
    // draft-board
    // -------------------------
    if (route === "draft-board") {
      const q = event.queryStringParameters || {};
      const weekNumber = Number(q.week_id);
      if (!Number.isFinite(weekNumber)) return json(400, { error: "Missing/invalid week_id" });

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

      const participants = (part.json || []).map((r) => ({
        player_id: r.player_id,
        player_name: r?.player?.name || "—",
        handicap_index: r?.player?.handicap_index ?? null,
      }));

      participants.sort((a, b) => {
        const ah = a.handicap_index,
          bh = b.handicap_index;
        const aNull = ah === null || ah === undefined;
        const bNull = bh === null || bh === undefined;
        if (aNull && bNull) return (a.player_name || "").localeCompare(b.player_name || "");
        if (aNull) return 1;
        if (bNull) return -1;
        if (bh !== ah) return bh - ah;
        return (a.player_name || "").localeCompare(b.player_name || "");
      });

      const proMapOut = await loadProNameMap(SUPABASE_URL, SUPABASE_ANON_KEY, weekNumber);
      const proNameMap = proMapOut.ok ? proMapOut.map : new Map();

      const picks = await sbAnon(
        SUPABASE_URL,
        SUPABASE_ANON_KEY,
        "GET",
        `week_entries?week_id=eq.${weekKey}&select=player_id,pga_golfer,pga_golfer_ext_id`
      );
      if (!picks.ok) return text(picks.status, picks.text);

      const pickDisplayByPlayer = new Map();
      for (const p of picks.json || []) {
        const norm = normalizePick(p, proNameMap);
        pickDisplayByPlayer.set(p.player_id, norm.display);
      }

      const rows = participants.map((pl) => ({
        player_id: pl.player_id,
        player_name: pl.player_name,
        handicap_index: pl.handicap_index,
        pro_id: pickDisplayByPlayer.get(pl.player_id) ?? null,
      }));

      return json(200, { week_id: weekNumber, rows });
    }

    // -------------------------
    // draft-state
    // -------------------------
    if (route === "draft-state") {
      const q = event.queryStringParameters || {};
      const weekNumber = Number(q.week_id);
      if (!Number.isFinite(weekNumber)) return json(400, { error: "Missing/invalid week_id" });

      const d = process.env.SUPABASE_SERVICE_ROLE_KEY
        ? await sbService(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, "GET", `week_draft?week_number=eq.${weekNumber}&limit=1`)
        : await sbAnon(SUPABASE_URL, SUPABASE_ANON_KEY, "GET", `week_draft?week_number=eq.${weekNumber}&limit=1`);
      if (!d.ok) return text(d.status, d.text);

      const draft = (d.json || [])[0] || null;
      if (!draft) return json(404, { error: "Draft not initialized for this week yet." });

      let order = [];
      if (["ORDER_PUBLISHED", "LIVE", "SWAP_OPEN", "LOCKED", "COMPLETE"].includes(draft.status)) {
        const o = process.env.SUPABASE_SERVICE_ROLE_KEY
          ? await sbService(
              SUPABASE_URL,
              process.env.SUPABASE_SERVICE_ROLE_KEY,
              "GET",
              `week_draft_order?week_number=eq.${weekNumber}&select=player_id,handicap_index,handicap_group,pick_position,group_position&order=pick_position.asc`
            )
          : await sbAnon(
              SUPABASE_URL,
              SUPABASE_ANON_KEY,
              "GET",
              `week_draft_order?week_number=eq.${weekNumber}&select=player_id,handicap_index,handicap_group,pick_position,group_position&order=pick_position.asc`
            );
        if (!o.ok) return text(o.status, o.text);
        order = o.json || [];
      }

      let viewer = null;
      const auth = (event.headers?.authorization || event.headers?.Authorization || "").trim();
      if (auth.startsWith("Bearer ")) {
        const meResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
          headers: { apikey: SUPABASE_ANON_KEY, Authorization: auth },
        });
        if (meResp.ok) {
          const u = await meResp.json().catch(() => null);
          const userId = u?.id || null;
          if (userId) {
            const p = await sbAnon(
              SUPABASE_URL,
              SUPABASE_ANON_KEY,
              "GET",
              `players?select=id,name,handicap_index&user_id=eq.${userId}&limit=1`
            );
            const player = p.ok ? (p.json || [])[0] || null : null;
            if (player) {
              const h = Number(player.handicap_index ?? 999);
              const handicap_group = h >= 16 ? 1 : h >= 11 ? 2 : h >= 6 ? 3 : 4;
              viewer = {
                player_id: player.id,
                player_name: player.name,
                handicap_index: player.handicap_index,
                handicap_group,
                min_tier: handicap_group,
              };
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
    // week-pros
    // -------------------------
    if (route === "week-pros") {
      const q = event.queryStringParameters || {};
      const weekNumber = Number(q.week_id);
      if (!Number.isFinite(weekNumber)) return json(400, { error: "Missing/invalid week_id" });

      const f = await sbAnon(
        SUPABASE_URL,
        SUPABASE_ANON_KEY,
        "GET",
        `week_pro_field?week_number=eq.${weekNumber}&select=player_ext_id,player_name,odds_display,odds_numeric,odds_rank,tier&order=odds_rank.asc`
      );
      if (!f.ok) return text(f.status, f.text);

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
      for (const r of taken.json || []) {
        const ext = r?.pga_golfer_ext_id != null ? String(r.pga_golfer_ext_id) : null;
        const legacy = r?.pga_golfer != null ? String(r.pga_golfer) : null;
        if (ext) takenMap.set(ext, r.player_id);
        else if (legacy) takenMap.set(legacy, r.player_id);
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
    // -------------------------
    if (route === "leaderboard") {
      const q = event.queryStringParameters || {};
      const weekNumber = Number(q.week_id);
      if (!Number.isFinite(weekNumber)) return json(400, { error: "Missing/invalid week_id" });

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

      const participants = (part.json || []).map((r) => ({
        player_id: r.player_id,
        player_name: r?.player?.name || "—",
        handicap_index: r?.player?.handicap_index ?? null,
      }));

      const rounds = await sbAnon(
        SUPABASE_URL,
        SUPABASE_ANON_KEY,
        "GET",
        `player_rounds?week_id=eq.${weekNumber}&select=player_id,score_to_par,played_at`
      );
      if (!rounds.ok) return text(rounds.status, rounds.text);

      const bestByPlayer = new Map();
      for (const r of rounds.json || []) {
        const pid = r.player_id;
        const s = Number(r.score_to_par);
        if (!Number.isFinite(s)) continue;
        const cur = bestByPlayer.get(pid);
        if (cur === undefined || s < cur) bestByPlayer.set(pid, s);
      }

      const proMapOut = await loadProNameMap(SUPABASE_URL, SUPABASE_ANON_KEY, weekNumber);
      const proNameMap = proMapOut.ok ? proMapOut.map : new Map();

      const picks = await sbAnon(
        SUPABASE_URL,
        SUPABASE_ANON_KEY,
        "GET",
        `week_entries?week_id=eq.${weekKey}&select=player_id,pga_golfer,pga_golfer_ext_id,pro_score`
      );
      if (!picks.ok) return text(picks.status, picks.text);

      const pickDisplayByPlayer = new Map();
      const proScoreByPlayer = new Map();
      for (const p of picks.json || []) {
        const norm = normalizePick(p, proNameMap);
        pickDisplayByPlayer.set(p.player_id, norm.display);
        const ps = p.pro_score;
        proScoreByPlayer.set(p.player_id, ps === null || ps === undefined ? null : Number(ps));
      }

      const rows = participants.map((pl) => {
        const playerScore = bestByPlayer.has(pl.player_id) ? bestByPlayer.get(pl.player_id) : null;
        const proScore = proScoreByPlayer.has(pl.player_id) ? proScoreByPlayer.get(pl.player_id) : null;

        const hasPlayer = Number.isFinite(playerScore);
        const hasPro = Number.isFinite(proScore);
        const combined = hasPlayer && hasPro ? playerScore + proScore : null;
        const rank_score = combined !== null ? combined : hasPlayer ? playerScore : null;

        return {
          player_id: pl.player_id,
          player_name: pl.player_name,
          handicap_index: pl.handicap_index,
          playerScore: hasPlayer ? playerScore : null,
          proScore: hasPro ? proScore : null,
          combined,
          rank_score,
          pga_golfer: pickDisplayByPlayer.get(pl.player_id) ?? null,
        };
      });

      rows.sort((a, b) => {
        const ar = a.rank_score,
          br = b.rank_score;
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
