// netlify/functions/sync-field.js
// OWGR-based weekly field sync with Supabase + RapidAPI
// Safe version: no duplicate vars, built-in fetch, rate-limit protection

function mustEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) {
    throw new Error(`Missing env var: ${name}`);
  }
  return String(v).trim();
}

const SUPABASE_URL = mustEnv("SUPABASE_URL");
const SERVICE_KEY = mustEnv("SUPABASE_SERVICE_ROLE_KEY");
const RAPIDAPI_KEY = mustEnv("RAPIDAPI_KEY");
const RAPIDAPI_HOST = mustEnv("RAPIDAPI_HOST");

// optional guard
const ADMIN_PIN = process.env.ADMIN_PIN
  ? String(process.env.ADMIN_PIN).trim()
  : null;

async function sb(path, opts = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    method: opts.method || "GET",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "content-type": "application/json",
      prefer: "resolution=merge-duplicates",
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase ${res.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function rapid(path) {
  const url = `https://${RAPIDAPI_HOST}${path}`;

  const res = await fetch(url, {
    headers: {
      "X-RapidAPI-Key": RAPIDAPI_KEY,
      "X-RapidAPI-Host": RAPIDAPI_HOST,
    },
  });

  const text = await res.text();

  if (!res.ok) {
    if (res.status === 429) {
      throw new Error("RapidAPI rate limit hit (429). Wait a minute and retry.");
    }
    throw new Error(`RapidAPI ${res.status}: ${text}`);
  }

  return text ? JSON.parse(text) : null;
}

function tierFromPosition(pos) {
  if (pos <= 10) return 1;
  if (pos <= 25) return 2;
  if (pos <= 45) return 3;
  return 4;
}

function getPlayerId(p) {
  return (
    p.playerId ||
    p.player_id ||
    p.id ||
    p.personId ||
    p.person_id ||
    ""
  ).toString();
}

function getPlayerName(p) {
  return (
    p.displayName ||
    p.playerName ||
    p.fullName ||
    p.name ||
    `${p.firstName || ""} ${p.lastName || ""}`.trim()
  );
}

function extractPlayers(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.players)) return payload.players;
  if (Array.isArray(payload.field)) return payload.field;
  if (Array.isArray(payload.leaderboard)) return payload.leaderboard;
  if (Array.isArray(payload.data)) return payload.data;
  return [];
}

exports.handler = async (event) => {
  try {
    // pin guard
    if (ADMIN_PIN) {
      const pin = String(event.queryStringParameters?.pin || "");
      if (pin !== ADMIN_PIN) {
        return {
          statusCode: 401,
          body: JSON.stringify({ error: "Unauthorized (bad pin)" }),
        };
      }
    }

    const weekNumber = Number(event.queryStringParameters?.week_id);
    if (!Number.isFinite(weekNumber)) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Invalid week_id" }),
      };
    }

    const force = event.queryStringParameters?.force === "1";

    // short-circuit if already populated
    if (!force) {
      const existing = await sb(
        `week_pro_field?select=player_ext_id&week_number=eq.${weekNumber}&limit=1`
      );

      if (existing && existing.length) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            ok: true,
            skipped: true,
            reason: "Already populated",
          }),
        };
      }
    }

    // load week (ONLY DECLARED ONCE)
    const weekRows = await sb(
      `weeks?select=week_number,start_date,label,tournament_name&week_number=eq.${weekNumber}&limit=1`
    );

    const week = weekRows?.[0];

    if (!week) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Week not found" }),
      };
    }

    const year = week.start_date.slice(0, 4);

    // fetch schedules
    const sched = await rapid(`/schedules?orgId=1&year=${year}`);

    const tournaments =
      sched?.tournaments ||
      sched?.events ||
      [];

    const target = new Date(week.start_date).getTime();

    let best = null;
    let bestDelta = Infinity;

    for (const t of tournaments) {
      const d = new Date(
        t.startDate || t.start_date || t.date
      ).getTime();

      const delta = Math.abs(d - target);

      if (delta < bestDelta) {
        bestDelta = delta;
        best = t;
      }
    }

    const tournamentId =
      best?.tournamentId ||
      best?.eventId ||
      best?.id;

    // fetch field
    let fieldPayload = null;

    try {
      fieldPayload = await rapid(
        `/leaderboards?orgId=1&tournamentId=${tournamentId}`
      );
    } catch {
      fieldPayload = await rapid(
        `/players?orgId=1&year=${year}`
      );
    }

    const fieldPlayers = extractPlayers(fieldPayload);

    if (!fieldPlayers.length) {
      throw new Error("No players found in field");
    }

    // fetch OWGR
    const owgrPayload = await rapid(`/worldranking?orgId=1`);

    const owgrPlayers = extractPlayers(owgrPayload);

    const owgrMap = new Map();

    for (const p of owgrPlayers) {
      const id = getPlayerId(p);
      const rank =
        p.rank ||
        p.worldRank ||
        p.position;

      if (id && rank) {
        owgrMap.set(id, Number(rank));
      }
    }

    const normalized = fieldPlayers
      .map((p) => ({
        id: getPlayerId(p),
        name: getPlayerName(p),
        owgr: owgrMap.get(getPlayerId(p)) || null,
      }))
      .filter((p) => p.id && p.name)
      .sort((a, b) => {
        const ar = a.owgr || 999999;
        const br = b.owgr || 999999;
        return ar - br;
      });

    const rows = normalized.map((p, i) => ({
      week_number: weekNumber,
      player_ext_id: p.id,
      player_name: p.name,
      odds_display: p.owgr ? `OWGR #${p.owgr}` : null,
      odds_numeric: p.owgr,
      odds_rank: i + 1,
      tier: tierFromPosition(i + 1),
    }));

    await sb(
      `week_pro_field?week_number=eq.${weekNumber}`,
      { method: "DELETE" }
    );

    await sb(
      "week_pro_field",
      { method: "POST", body: rows }
    );

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        inserted: rows.length,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: err.message,
      }),
    };
  }
};
