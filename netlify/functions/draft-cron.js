// netlify/functions/draft-cron.js
// Scheduled function (runs every minute) to auto-start drafts whose starts_at has passed.
// NOTE: precise 70s autopicks still require /api-mutate/draft-tick heartbeat.

const { schedule } = require("@netlify/functions");

async function sbService(SUPABASE_URL, SERVICE_KEY, method, restPath, bodyObj, prefer) {
  const headers = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
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

function sortByHandicapDesc(rows){
  return rows.slice().sort((a,b) => {
    const ah = a?.player?.handicap_index;
    const bh = b?.player?.handicap_index;
    const aNull = ah === null || ah === undefined;
    const bNull = bh === null || bh === undefined;
    if(aNull && bNull) return String(a?.player?.name||"").localeCompare(String(b?.player?.name||""));
    if(aNull) return 1;
    if(bNull) return -1;
    if(bh !== ah) return Number(bh) - Number(ah);
    return String(a?.player?.name||"").localeCompare(String(b?.player?.name||""));
  });
}

const handler = async () => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SERVICE_KEY) return { statusCode: 200, body: "missing env" };

  const nowIso = new Date().toISOString();

  // Find drafts that should start
  const due = await sbService(
    SUPABASE_URL,
    SERVICE_KEY,
    "GET",
    `week_drafts?select=week_id,status,starts_at&status=eq.SCHEDULED&starts_at=lte.${encodeURIComponent(nowIso)}`
  );

  for (const d of (due || [])) {
    const weekNumber = Number(d.week_id);
    if (!Number.isFinite(weekNumber)) continue;

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
      `week_entries?select=player_id&week_id=eq.${weekNumber}`
    );
    const picked = new Set((picks || []).map(p => String(p.player_id)));

    const next = ordered.find(r => !picked.has(String(r.player_id)));
    if (!next) {
      await sbService(
        SUPABASE_URL,
        SERVICE_KEY,
        "POST",
        `week_drafts?on_conflict=week_id`,
        { week_id: d.week_id, status: "COMPLETE", turn_player_id: null, turn_started_at: null, updated_at: nowIso },
        "resolution=merge-duplicates,return=minimal"
      );
      continue;
    }

    await sbService(
      SUPABASE_URL,
      SERVICE_KEY,
      "POST",
      `week_drafts?on_conflict=week_id`,
      {
        week_id: d.week_id,
        status: "LIVE",
        turn_player_id: next.player_id,
        turn_started_at: nowIso,
        turn_number: 0,
        updated_at: nowIso,
      },
      "resolution=merge-duplicates,return=minimal"
    );
  }

  return { statusCode: 200, body: "ok" };
};

// Every minute
exports.handler = schedule("* * * * *", handler);
