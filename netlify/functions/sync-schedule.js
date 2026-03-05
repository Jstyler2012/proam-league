'use strict';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DATAGOLF_API_KEY = process.env.DATAGOLF_API_KEY;

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function fetchJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  let data = null;

  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }

  return { res, text, data };
}

async function sb(method, path, body) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "content-type": "application/json",
      Prefer: "return=minimal"
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase error ${res.status}: ${text}`);
  }

  const txt = await res.text();
  if (!txt) return null;

  try {
    return JSON.parse(txt);
  } catch {
    return txt;
  }
}

function pickArray(json) {
  if (!json) return [];
  if (Array.isArray(json.schedule)) return json.schedule;
  if (Array.isArray(json.events)) return json.events;
  if (Array.isArray(json.tournaments)) return json.tournaments;
  if (Array.isArray(json.data)) return json.data;
  if (Array.isArray(json.results)) return json.results;
  if (Array.isArray(json)) return json;
  return [];
}

function normalize(s) {
  return String(s || "").toLowerCase().trim();
}

function tokenScore(a, b) {
  const ta = new Set(normalize(a).split(" "));
  const tb = new Set(normalize(b).split(" "));

  let score = 0;
  for (const t of ta) if (tb.has(t)) score++;

  return score;
}

function getName(ev) {
  return ev.event_name || ev.tournament_name || ev.name || "";
}

function getIds(ev) {
  return {
    tourn_id: ev.tourn_id || ev.tournament_id || ev.id || null,
    org_id: ev.org_id || ev.pga_tourn_id || null
  };
}

function getDates(ev) {
  return {
    start_date: (ev.start_date || ev.start || "").slice(0, 10),
    end_date: (ev.end_date || ev.end || "").slice(0, 10)
  };
}

exports.handler = async () => {

  if (!SUPABASE_URL || !SERVICE_KEY || !DATAGOLF_API_KEY) {
    return json(500, { error: "Missing environment variables" });
  }

  try {

    const season = new Date().getFullYear();

    const dgUrl =
      `https://feeds.datagolf.com/get-schedule?tour=pga&season=${season}&file_format=json&key=${DATAGOLF_API_KEY}`;

    const dg = await fetchJson(dgUrl);

    if (!dg.res.ok) {
      return json(500, {
        error: "DataGolf schedule fetch failed",
        preview: dg.text.slice(0, 500)
      });
    }

    const events = pickArray(dg.data);

    const weeks = await sb(
      "GET",
      "weeks?select=id,week_number,tournament_name,start_date,end_date,tourn_id,org_id"
    );

    let updated = 0;

    for (const w of weeks) {

      if (w.tourn_id || w.org_id) continue;

      const base = w.tournament_name;

      const scored = events
        .map(ev => ({
          ev,
          score: tokenScore(base, getName(ev))
        }))
        .sort((a,b)=>b.score-a.score);

      if (!scored.length || scored[0].score < 2) continue;

      const best = scored[0].ev;

      const ids = getIds(best);
      const dates = getDates(best);

      await sb(
        "PATCH",
        `weeks?id=eq.${w.id}`,
        {
          tourn_id: ids.tourn_id,
          org_id: ids.org_id,
          start_date: dates.start_date,
          end_date: dates.end_date,
          api_status: "datagolf",
          api_last_synced_at: new Date().toISOString()
        }
      );

      updated++;
    }

    return json(200,{
      ok:true,
      events_found: events.length,
      weeks_checked: weeks.length,
      weeks_updated: updated
    });

  } catch (err) {

    return json(500,{
      error: err.message
    });

  }
};
