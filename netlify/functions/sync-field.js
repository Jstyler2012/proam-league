// netlify/functions/sync-field.js
//
// Production: sync a league week’s pro field + odds using DataGolf only.
// Writes:
//   - public.pro_players (upsert by ext_id)  [FK target]
//   - public.week_pro_field (replace for week_number)
//   - public.weeks.field_last_synced_at (timestamp)
//
// Requires env vars in Netlify:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   DATAGOLF_API_KEY
// Optional protection:
//   ADMIN_PIN (or ADMIN_TOKEN or SYNC_PIN)
// Usage:
//   /.netlify/functions/sync-field?week_id=0&pin=XXXX
//   /.netlify/functions/sync-field?week_id=3&pin=XXXX
//   (if week_id omitted, picks current week by date)
//
// Notes:
// - This function assumes `weeks.week_number` is your canonical league week key.
// - It matches the DataGolf tournament primarily by weeks.tourn_id / org_id, then by date overlap.

const ADMIN_PIN = (process.env.ADMIN_PIN || process.env.ADMIN_TOKEN || process.env.SYNC_PIN || "").trim();
const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const DATAGOLF_API_KEY = (process.env.DATAGOLF_API_KEY || "").trim();

function corsHeaders() {
  return {
    "content-type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  };
}

function json(statusCode, body) {
  return { statusCode, headers: corsHeaders(), body: JSON.stringify(body) };
}

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { res, text, data };
}

async function sb(method, restPath, bodyObj, prefer) {
  const url = `${SUPABASE_URL}/rest/v1/${restPath}`;
  const headers = {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    Prefer: prefer || "return=representation",
  };
  if (method !== "GET") headers["content-type"] = "application/json";

  const res = await fetch(url, {
    method,
    headers,
    body: bodyObj ? JSON.stringify(bodyObj) : undefined,
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase REST error (${res.status}) ${text || res.statusText}`);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function normalizeTournamentId(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function pickArray(json) {
  if (!json) return [];
  if (Array.isArray(json.players)) return json.players;
  if (Array.isArray(json.field)) return json.field;
  if (Array.isArray(json.odds)) return json.odds;
  if (Array.isArray(json.data)) return json.data;
  if (Array.isArray(json.results)) return json.results;
  if (Array.isArray(json.items)) return json.items;
  if (Array.isArray(json)) return json;
  return [];
}

function decimalToAmericanStr(dec) {
  if (!Number.isFinite(dec) || dec <= 1) return null;
  if (dec >= 2) return `+${Math.round((dec - 1) * 100)}`;
  return `${Math.round(-100 / (dec - 1))}`;
}

// Remove diacritics and normalize (used to match names to odds feed)
function cleanName(s) {
  return (s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .replace(/æ/g, "ae")
    .replace(/œ/g, "oe")
    .replace(/ø/g, "o")
    .replace(/å/g, "a")
    .replace(/đ/g, "d")
    .toLowerCase()
    .replace(/[^a-z\s,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitName(name) {
  const n = cleanName(name);
  if (!n) return null;

  if (n.includes(",")) {
    const [lastRaw, firstRaw] = n.split(",").map((x) => x.trim());
    const firstParts = (firstRaw || "").split(" ").filter(Boolean);
    const lastParts = (lastRaw || "").split(" ").filter(Boolean);
    if (!firstParts.length || !lastParts.length) return null;
    return { first: firstParts[0], last: lastParts[lastParts.length - 1] };
  }

  const parts = n.split(" ").filter(Boolean);
  if (parts.length < 2) return null;
  return { first: parts[0], last: parts[parts.length - 1] };
}

function nameKey(name) {
  const sp = splitName(name);
  if (!sp) return null;
  const fi = sp.first?.[0];
  if (!fi) return null;
  return `${sp.last}|${fi}`;
}

function extractName(dg) {
  return dg?.player_name ?? dg?.name ?? dg?.player ?? dg?.golfer ?? dg?.full_name ?? null;
}

// DataGolf outrights entries: { dg_id, draftkings: 4.45, ..., datagolf: { baseline: 5.96 } }
function extractBestDecimal(dg) {
  const decimals = [];
  for (const [k, v] of Object.entries(dg ?? {})) {
    if (k === "dg_id" || k === "datagolf") continue;
    if (typeof v === "number" && Number.isFinite(v) && v > 1) decimals.push(v);
  }
  const baseline = Number(dg?.datagolf?.baseline);
  if (!decimals.length && Number.isFinite(baseline) && baseline > 1) decimals.push(baseline);
  if (!decimals.length) return null;
  return Math.min(...decimals);
}

// field-updates sometimes returns a list of tournaments; sometimes nested.
// This attempts to find the tournament that corresponds to your `weeks` row.
function findTournamentInFieldUpdates(fieldUpdatesJson, weekRow) {
  const candidates = [];

  const containers = [];
  if (Array.isArray(fieldUpdatesJson)) containers.push(fieldUpdatesJson);
  if (Array.isArray(fieldUpdatesJson?.events)) containers.push(fieldUpdatesJson.events);
  if (Array.isArray(fieldUpdatesJson?.tournaments)) containers.push(fieldUpdatesJson.tournaments);
  if (Array.isArray(fieldUpdatesJson?.data)) containers.push(fieldUpdatesJson.data);
  if (Array.isArray(fieldUpdatesJson?.results)) containers.push(fieldUpdatesJson.results);

  for (const arr of containers) for (const t of arr) candidates.push(t);

  // Single-tournament shape
  if (!candidates.length && (fieldUpdatesJson?.field || fieldUpdatesJson?.players)) return fieldUpdatesJson;

  const wantedTournId = normalizeTournamentId(weekRow?.tourn_id);
  const wantedOrgId = normalizeTournamentId(weekRow?.org_id);

  if (wantedTournId) {
    const hit = candidates.find((t) => {
      const tid = normalizeTournamentId(t?.tourn_id ?? t?.tournament_id ?? t?.event_id ?? t?.id);
      return tid && tid === wantedTournId;
    });
    if (hit) return hit;
  }

  if (wantedOrgId) {
    const hit = candidates.find((t) => {
      const oid = normalizeTournamentId(t?.org_id ?? t?.tour_event_id ?? t?.pga_tourn_id);
      return oid && oid === wantedOrgId;
    });
    if (hit) return hit;
  }

  // Date overlap fallback
  const ws = weekRow?.start_date ? new Date(`${weekRow.start_date}T00:00:00Z`) : null;
  const we = weekRow?.end_date ? new Date(`${weekRow.end_date}T23:59:59Z`) : null;

  if (ws && we) {
    const hit = candidates.find((t) => {
      const ts = t?.start_date || t?.start || t?.startDate;
      const te = t?.end_date || t?.end || t?.endDate;
      if (!ts || !te) return false;
      const a = new Date(`${String(ts).slice(0, 10)}T00:00:00Z`);
      const b = new Date(`${String(te).slice(0, 10)}T23:59:59Z`);
      return !(b < ws || a > we);
    });
    if (hit) return hit;
  }

  return null;
}

async function determineCurrentWeekNumber() {
  const weeks = await sb("GET", "weeks?select=week_number,start_date,end_date&order=week_number.asc");
  if (!Array.isArray(weeks) || !weeks.length) return null;

  const now = new Date();

  const inRange = weeks.find((w) => {
    if (!w.start_date || !w.end_date) return false;
    const s = new Date(`${w.start_date}T00:00:00`);
    const e = new Date(`${w.end_date}T23:59:59`);
    return now >= s && now <= e;
  });

  if (inRange?.week_number != null) return Number(inRange.week_number);

  // If before season start, return first; else last
  const first = weeks[0];
  if (first?.start_date && now < new Date(`${first.start_date}T00:00:00`)) return Number(first.week_number);
  return Number(weeks[weeks.length - 1].week_number);
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return json(204, { ok: true });

  try {
    // Basic env validation
    if (!SUPABASE_URL) return json(500, { ok: false, error: "Missing SUPABASE_URL" });
    if (!SERVICE_KEY) return json(500, { ok: false, error: "Missing SUPABASE_SERVICE_ROLE_KEY" });
    if (!DATAGOLF_API_KEY) return json(500, { ok: false, error: "Missing DATAGOLF_API_KEY" });

    const q = event.queryStringParameters || {};
    const pin = String(q.pin || "").trim();
    if (ADMIN_PIN && pin !== ADMIN_PIN) return json(401, { ok: false, error: "Invalid pin" });

    // week_id param (your UI uses week_id)
    let weekNum = Number(q.week_id ?? q.week_number);
    if (!Number.isFinite(weekNum)) {
      const auto = await determineCurrentWeekNumber();
      if (!Number.isFinite(auto)) return json(400, { ok: false, error: "Could not determine current week_number" });
      weekNum = auto;
    }

    // Load target week row (includes tourn_id/org_id for matching)
    const weekRows = await sb(
      "GET",
      `weeks?select=week_number,label,tournament_name,start_date,end_date,season_year,tourn_id,org_id&week_number=eq.${weekNum}&limit=1`
    );
    const weekRow = Array.isArray(weekRows) ? weekRows[0] : null;
    if (!weekRow) return json(404, { ok: false, error: `Week not found (week_number=${weekNum})` });

    // Fetch DataGolf field updates (PGA)
    const fuUrl =
      `https://feeds.datagolf.com/field-updates` +
      `?tour=pga&file_format=json&key=${encodeURIComponent(DATAGOLF_API_KEY)}`;

    const fu = await fetchJson(fuUrl);
    if (!fu.res.ok) {
      return json(502, {
        ok: false,
        error: `DataGolf field-updates failed (status=${fu.res.status})`,
        preview: (fu.text || "").slice(0, 700),
      });
    }

    const tourn = findTournamentInFieldUpdates(fu.data, weekRow);
    if (!tourn) {
      return json(404, {
        ok: false,
        error: "Could not match this week to a tournament in DataGolf field-updates.",
        week: {
          week_number: weekRow.week_number,
          tourn_id: weekRow.tourn_id || null,
          org_id: weekRow.org_id || null,
          start_date: weekRow.start_date || null,
          end_date: weekRow.end_date || null,
          tournament_name: weekRow.tournament_name || null,
        },
        preview: (fu.text || "").slice(0, 700),
      });
    }

    const players = pickArray(tourn) || pickArray(tourn?.field) || pickArray(tourn?.players);
    if (!Array.isArray(players) || !players.length) {
      return json(400, {
        ok: false,
        error: "Tournament matched but no player array found under field/players/etc.",
        tournament_preview: JSON.stringify(tourn).slice(0, 900),
      });
    }

    // Build canonical field list from DataGolf
    const nowIso = new Date().toISOString();

    const field = [];
    const proPlayersUpsert = [];

    for (const p of players) {
      const ext = p?.dg_id ?? p?.player_id ?? p?.id ?? p?.tour_player_id ?? p?.pga_id ?? null;
      const fullName = p?.player_name ?? p?.name ?? p?.full_name ?? p?.player ?? null;

      if (!ext || !fullName) continue;

      const first = p?.first_name ?? null;
      const last = p?.last_name ?? null;
      const isAm = p?.is_amateur ?? p?.amateur ?? null;

      // Upsert into pro_players (FK target)
      proPlayersUpsert.push({
        ext_id: String(ext),
        first_name: first,
        last_name: last,
        display_name: String(fullName),
        is_amateur: isAm === true,
        updated_at: nowIso,
      });

      // Week field row; odds populated later
      field.push({
        week_number: weekNum,
        player_ext_id: String(ext),
        player_name: String(fullName),
        first_name: first,
        last_name: last,
        is_amateur: isAm === true,
        odds_numeric: null,
        odds_display: null,
        odds_rank: 100000, // required NOT NULL
        tier: 4,           // required NOT NULL
        source: "datagolf_field_updates",
        updated_at: nowIso,
      });
    }

    if (!field.length) {
      return json(400, { ok: false, error: "No usable players extracted (missing id/name)." });
    }

    // 1) Upsert pro_players (so week_pro_field FK insert never fails)
    // Supabase REST upsert: Prefer: resolution=merge-duplicates and on_conflict
    await sb(
      "POST",
      "pro_players?on_conflict=ext_id",
      proPlayersUpsert,
      "resolution=merge-duplicates,return=minimal"
    );

    // 2) Replace week_pro_field rows for this week
    await sb("DELETE", `week_pro_field?week_number=eq.${weekNum}`, null, "return=minimal");
    await sb("POST", "week_pro_field", field, "return=minimal");

    // 3) Attach odds (DataGolf outrights)
    let odds = {
      dg_status: null,
      dg_count: 0,
      mapped_count: 0,
      odds_updated: 0,
      dg_error: null,
      preview: null,
    };

    try {
      const ogUrl =
        `https://feeds.datagolf.com/betting-tools/outrights` +
        `?tour=pga&market=win&odds_format=decimal&file_format=json&key=${encodeURIComponent(DATAGOLF_API_KEY)}`;

      const og = await fetchJson(ogUrl);
      odds.dg_status = og.res.status;
      odds.preview = (og.text || "").slice(0, 500);

      if (!og.res.ok) {
        odds.dg_error = `DataGolf outrights not ok (status=${og.res.status})`;
      } else {
        const dgPlayers = pickArray(og.data);
        odds.dg_count = dgPlayers.length;

        // Build odds map keyed by last|firstInitial
        const oddsMap = new Map();
        for (const dg of dgPlayers) {
          const nm = extractName(dg);
          if (!nm) continue;
          const bestDec = extractBestDecimal(dg);
          if (!bestDec) continue;
          const k = nameKey(nm);
          if (k) oddsMap.set(k, bestDec);
        }

        const matched = field
          .map((r) => {
            const k = nameKey(r.player_name);
            if (!k) return null;
            const dec = oddsMap.get(k);
            if (!Number.isFinite(dec)) return null;
            return { ...r, _dec: dec };
          })
          .filter(Boolean);

        odds.mapped_count = matched.length;

        // Rank favorites by lowest decimal
        matched.sort((a, b) => a._dec - b._dec);

        // Assign odds_rank + tier and update week_pro_field rows
        for (let i = 0; i < matched.length; i++) {
          const r = matched[i];
          const oddsRank = i + 1;

          let tier = 4;
          if (oddsRank <= 10) tier = 1;
          else if (oddsRank <= 25) tier = 2;
          else if (oddsRank <= 45) tier = 3;

          const dec = r._dec;
          const american = decimalToAmericanStr(dec);

          await sb(
            "PATCH",
            `week_pro_field?week_number=eq.${weekNum}&player_ext_id=eq.${encodeURIComponent(r.player_ext_id)}`,
            {
              odds_numeric: dec,
              odds_display: american,
              odds_rank: oddsRank,
              tier,
              source: "datagolf_field_updates+datagolf_outrights",
              updated_at: nowIso,
            },
            "return=minimal"
          );

          odds.odds_updated++;
        }

        // For anyone without odds, keep tier=4, but make odds_rank deterministic
        // (so ordering is stable; required by NOT NULL)
        let tailRank = (matched.length || 0) + 1000;
        const matchedSet = new Set(matched.map((m) => m.player_ext_id));

        for (const r of field) {
          if (matchedSet.has(r.player_ext_id)) continue;
          tailRank++;
          await sb(
            "PATCH",
            `week_pro_field?week_number=eq.${weekNum}&player_ext_id=eq.${encodeURIComponent(r.player_ext_id)}`,
            {
              odds_rank: tailRank,
              tier: 4,
              source: "datagolf_field_updates",
              updated_at: nowIso,
            },
            "return=minimal"
          );
        }
      }
    } catch (e) {
      odds.dg_error = e?.message || String(e);
    }

    // 4) Stamp weeks.field_last_synced_at
    try {
      await sb(
        "PATCH",
        `weeks?week_number=eq.${weekNum}`,
        { field_last_synced_at: nowIso },
        "return=minimal"
      );
    } catch {
      // non-fatal
    }

    return json(200, {
      ok: true,
      week_number: weekNum,
      week: {
        week_number: weekRow.week_number,
        label: weekRow.label,
        tournament_name: weekRow.tournament_name,
        start_date: weekRow.start_date,
        end_date: weekRow.end_date,
        tourn_id: weekRow.tourn_id,
        org_id: weekRow.org_id,
        season_year: weekRow.season_year,
      },
      datagolf: {
        field_updates_status: fu.res.status,
        field_count: field.length,
        tournament_match: {
          tourn_id: tourn?.tourn_id ?? tourn?.tournament_id ?? tourn?.event_id ?? tourn?.id ?? null,
          org_id: tourn?.org_id ?? tourn?.tour_event_id ?? tourn?.pga_tourn_id ?? null,
          name: tourn?.event_name ?? tourn?.tournament_name ?? tourn?.name ?? null,
          start_date: tourn?.start_date ?? null,
          end_date: tourn?.end_date ?? null,
        },
        odds,
      },
    });
  } catch (err) {
    console.error("sync-field error:", err);
    return json(500, {
      ok: false,
      error: err?.message || String(err),
      stack: err?.stack ? String(err.stack).split("\n").slice(0, 15).join("\n") : undefined,
    });
  }
};
