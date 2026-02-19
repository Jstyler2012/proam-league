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
  const cleaned = raw.replace(/^\/+|\/+$/g, "");
  const parts = cleaned.split("/");
  const idx = parts.lastIndexOf("public");
  if (idx >= 0) return parts.slice(idx + 1).join("/");
  if (parts[0] === ".netlify" && parts[1] === "functions") return parts.slice(3).join("/");
  return cleaned;
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

    const sb = async (method, restPath, bodyObj, extraHeaders = {}) => {
      const url = `${SUPABASE_URL}/rest/v1/${restPath}`;
      const headers = {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        ...extraHeaders,
      };
      if (method !== "GET") headers["content-type"] = "application/json";

      const r = await fetch(url, {
        method,
        headers,
        body: bodyObj ? JSON.stringify(bodyObj) : undefined,
      });

      const t = await r.text();
      if (!r.ok) return { ok: false, status: r.status, text: t };

      if (!t) return { ok: true, json: null };
      try { return { ok: true, json: JSON.parse(t) }; }
      catch { return { ok: true, json: t }; }
    };

    // -------------------------
    // me (auth -> player row)
    // -------------------------
    if (route === "me") {
      const auth = (event.headers?.authorization || event.headers?.Authorization || "").trim();
      if (!auth.startsWith("Bearer ")) return json(401, { error: "Not logged in" });

      const meResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: auth,
        },
      });

      const meText = await meResp.text();
      if (!meResp.ok) return json(meResp.status, { error: meText });

      let user = null;
      try { user = JSON.parse(meText); } catch { user = null; }
      const userId = user?.id;
      if (!userId) return json(401, { error: "Invalid session" });

      const p = await sb(
        "GET",
        `players?select=id,name,handicap_index,user_id&user_id=eq.${userId}&limit=1`
      );
      if (!p.ok) return text(p.status, p.text);

      const player = (p.json || [])[0] || null;
      return json(200, { user: { id: userId, email: user?.email || null }, player });
    }

    // -------------------------
    // players (all players)
    // -------------------------
    if (route === "players") {
      const out = await sb("GET", "players?select=id,name,handicap_index&order=name.asc");
      if (!out.ok) return text(out.status, out.text);
      return json(200, out.json || []);
    }

    // -------------------------
    // participants (ONLY participants for a week)
    // GET /api/participants?week_id=...
    // -------------------------
    if (route === "participants") {
      const params = event.queryStringParameters || {};
      const weekId = params.week_id;
      if (!weekId) return json(400, { error: "Missing week_id" });

      // Join participant -> players (name/handicap)
      const out = await sb(
        "GET",
        `week_participants?week_id=eq.${weekId}` +
          `&select=player_id,created_at,player:players(id,name,handicap_index)` +
          `&order=created_at.asc`
      );
      if (!out.ok) return text(out.status, out.text);

      const rows = (out.json || []).map((r) => ({
        player_id: r.player_id,
        player_name: r?.player?.name || "—",
        handicap_index: r?.player?.handicap_index ?? null,
        created_at: r.created_at || null,
      }));

      // Order: highest handicap -> lowest, nulls last, stable by name
      rows.sort((a, b) => {
        const ah = a.handicap_index, bh = b.handicap_index;
        const aNull = ah == null, bNull = bh == null;
        if (aNull && bNull) return (a.player_name || "").localeCompare(b.player_name || "");
        if (aNull) return 1;
        if (bNull) return -1;
        if (bh !== ah) return bh - ah;
        return (a.player_name || "").localeCompare(b.player_name || "");
      });

      return json(200, { week_id: weekId, rows });
    }

    // -------------------------
    // pros (static for now)
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
    // schedule
    // -------------------------
    if (route === "schedule") {
      const out = await sb(
        "GET",
        "weeks?select=id,week_number,tournament_name,start_date,end_date,logo_url,label,winner_player_name&order=week_number.asc.nullslast"
      );
      if (!out.ok) return text(out.status, out.text);
      return json(200, { weeks: out.json || [] });
    }

    // -------------------------
    // current-week
    // -------------------------
    if (route === "current-week") {
      const out = await sb(
        "GET",
        "weeks?select=id,label,week_number,start_date,end_date,tournament_name,logo_url,winner_player_name&week_number=not.is.null&order=week_number.asc"
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
        (weeks[0]?.start_date && today < new Date(weeks[0].start_date + "T00:00:00") ? weeks[0] : weeks[weeks.length - 1]);

      return json(200, { week });
    }

    // -------------------------
    // draft-board (participants only)
    // -------------------------
    if (route === "draft-board") {
      const params = event.queryStringParameters || {};
      const weekId = params.week_id;
      if (!weekId) return json(400, { error: "Missing week_id" });

      const part = await sb(
        "GET",
        `week_participants?week_id=eq.${weekId}` +
          `&select=player_id,player:players(id,name,handicap_index)`
      );
      if (!part.ok) return text(part.status, part.text);

      const participants = (part.json || []).map((r) => ({
        player_id: r.player_id,
        player_name: r?.player?.name || "—",
        handicap_index: r?.player?.handicap_index ?? null,
      }));

      // Pull any drafted pros from week_entries
      const e = await sb(
        "GET",
        `week_entries?select=player_id,pga_golfer&week_id=eq.${weekId}`
      );
      if (!e.ok) return text(e.status, e.text);
      const entries = e.json || [];
      const byPlayerId = new Map(entries.map((x) => [x.player_id, x.pga_golfer]));

      const rows = participants.map((pl) => ({
        player_id: pl.player_id,
        player_name: pl.player_name,
        handicap_index: pl.handicap_index ?? null,
        pro_id: byPlayerId.get(pl.player_id) ?? null,
      }));

      // Highest handicap first
      rows.sort((a, b) => {
        const ah = a.handicap_index, bh = b.handicap_index;
        const aNull = ah == null, bNull = bh == null;
        if (aNull && bNull) return (a.player_name || "").localeCompare(b.player_name || "");
        if (aNull) return 1;
        if (bNull) return -1;
        if (bh !== ah) return bh - ah;
        return (a.player_name || "").localeCompare(b.player_name || "");
      });

      return json(200, { week_id: weekId, rows });
    }

    // -------------------------
    // leaderboard (participants only)
    // -------------------------
    if (route === "leaderboard") {
      const params = event.queryStringParameters || {};
      const weekIdParam = params.week_id;

      let week = null;

      if (weekIdParam) {
        const w = await sb("GET", `weeks?id=eq.${weekIdParam}&select=id,label,week_number,start_date,end_date`);
        if (!w.ok) return text(w.status, w.text);
        week = w.json && w.json[0] ? w.json[0] : null;
      } else {
        const cw = await sb(
          "GET",
          "weeks?select=id,label,week_number,start_date,end_date&week_number=not.is.null&order=week_number.asc"
        );
        if (!cw.ok) return text(cw.status, cw.text);
        const weeks = cw.json || [];
        if (!weeks.length) return json(200, { week: null, week_id: null, rows: [] });

        const today = new Date();
        const inRange = weeks.find((w) => {
          if (!w.start_date || !w.end_date) return false;
          const s = new Date(w.start_date + "T00:00:00");
          const e = new Date(w.end_date + "T23:59:59");
          return today >= s && today <= e;
        });

        week =
          inRange ||
          (weeks[0]?.start_date && today < new Date(weeks[0].start_date + "T00:00:00") ? weeks[0] : weeks[weeks.length - 1]);
      }

      if (!week) return json(200, { week: null, week_id: null, rows: [] });

      // Participants list (includes name/hcp)
      const part = await sb(
        "GET",
        `week_participants?week_id=eq.${week.id}` +
          `&select=player_id,player:players(id,name,handicap_index)`
      );
      if (!part.ok) return text(part.status, part.text);

      const participants = (part.json || []).map((r) => ({
        player_id: r.player_id,
        player_name: r?.player?.name || "—",
        handicap_index: r?.player?.handicap_index ?? null,
      }));

      // Entries for week (scores + drafted pro)
      const e = await sb(
        "GET",
        `week_entries?select=player_id,your_score,pro_score,total,pga_golfer&week_id=eq.${week.id}`
      );
      if (!e.ok) return text(e.status, e.text);
      const entries = e.json || [];
      const byPlayerId = new Map(entries.map((x) => [x.player_id, x]));

      const rows = participants.map((pl) => {
        const ent = byPlayerId.get(pl.player_id) || {};
        return {
          player_id: pl.player_id,
          player_name: pl.player_name,
          handicap_index: pl.handicap_index ?? null,
          playerScore: ent.your_score ?? null,
          proScore: ent.pro_score ?? null,
          combined: ent.total ?? null,
          pga_golfer: ent.pga_golfer ?? null,
        };
      });

      // Sort: lowest combined first; nulls last; then name
      rows.sort((a, b) => {
        const ac = a.combined;
        const bc = b.combined;
        const aNull = ac == null;
        const bNull = bc == null;
        if (aNull && bNull) return (a.player_name || "").localeCompare(b.player_name || "");
        if (aNull) return 1;
        if (bNull) return -1;
        if (ac !== bc) return ac - bc;
        return (a.player_name || "").localeCompare(b.player_name || "");
      });

      return json(200, { week: week.label || `Week ${week.week_number}`, week_id: week.id, rows });
    }

    // -------------------------
    // season-standings (unchanged; can be all players)
    // -------------------------
    if (route === "season-standings") {
      const out = await sb(
        "GET",
        "season_standings?select=player_id,player_name,points&order=points.desc,player_name.asc"
      );
      if (!out.ok) return text(out.status, out.text);
      return json(200, { rows: out.json || [] });
    }

    return text(404, "Not found");
  } catch (err) {
    return text(500, err?.message || String(err));
  }
};

