import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type Json = Record<string, unknown>;

function corsHeaders(origin = "*") {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(status: number, body: Json) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders("*"), "Content-Type": "application/json" },
  });
}

function getNYParts(d: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const out: Record<string, string> = {};
  for (const p of parts) if (p.type !== "literal") out[p.type] = p.value;

  return {
    weekday: out.weekday, // "Sat"
    hour: Number(out.hour),
    minute: Number(out.minute),
  };
}

function fullName(firstName?: string, lastName?: string) {
  const f = (firstName ?? "").trim();
  const l = (lastName ?? "").trim();
  return `${f} ${l}`.trim();
}

async function rapidGetTournaments(params: {
  host: string;
  key: string;
  org_id: string | number;
  season_year: string | number;
  tourn_id: string | number;
}) {
  const { host, key, org_id, season_year, tourn_id } = params;

  // A few likely query param variants; whichever works first is used.
  const candidates: Array<{ path: string; qs: Record<string, string> }> = [
    { path: "/tournaments", qs: { orgId: String(org_id), year: String(season_year), tournId: String(tourn_id) } },
    { path: "/tournaments", qs: { org_id: String(org_id), season_year: String(season_year), tourn_id: String(tourn_id) } },
    { path: "/tournaments", qs: { orgId: String(org_id), seasonYear: String(season_year), tournId: String(tourn_id) } },
  ];

  let lastErr = "";
  for (const c of candidates) {
    const u = new URL(`https://${host}${c.path}`);
    for (const [k, v] of Object.entries(c.qs)) u.searchParams.set(k, v);

    const res = await fetch(u.toString(), {
      headers: {
        "x-rapidapi-host": host,
        "x-rapidapi-key": key,
      },
    });

    const text = await res.text();
    if (!res.ok) {
      lastErr = `RapidAPI ${res.status} ${res.statusText}: ${text}`;
      continue;
    }

    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      lastErr = `RapidAPI returned non-JSON payload: ${text.slice(0, 200)}`;
      continue;
    }

    return { data, used: { path: c.path, qs: c.qs } };
  }

  throw new Error(lastErr || "RapidAPI call failed (no candidate query worked)");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: corsHeaders("*") });
  if (req.method !== "POST") return json(405, { error: "Use POST" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")?.trim();
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();

  const RAPIDAPI_HOST = Deno.env.get("RAPIDAPI_HOST")?.trim();
  const RAPIDAPI_KEY = Deno.env.get("RAPIDAPI_KEY")?.trim();

  const CRON_SECRET = Deno.env.get("CRON_SECRET")?.trim();

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" });
  }
  if (!RAPIDAPI_HOST || !RAPIDAPI_KEY) {
    return json(500, { error: "Missing RAPIDAPI_HOST or RAPIDAPI_KEY" });
  }
  if (!CRON_SECRET) {
    return json(500, { error: "Missing CRON_SECRET (set it as a Supabase Function secret)" });
  }

  const providedSecret = req.headers.get("x-cron-secret")?.trim() ?? "";
  if (providedSecret !== CRON_SECRET) {
    return json(401, { error: "Unauthorized (bad x-cron-secret)" });
  }

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const force = Boolean(body.force);
  const week_number_raw = body.week_number;

  // DST-safe execution gate:
  // Cron triggers hourly Saturdays, we only proceed at Sat 10:00 America/New_York unless force=true.
  if (!force) {
    const now = new Date();
    const ny = getNYParts(now);
    const isSat10 = ny.weekday === "Sat" && ny.hour === 10 && ny.minute === 0;

    if (!isSat10) {
      return json(200, {
        ok: true,
        skipped: true,
        reason: "Not Saturday 10:00 America/New_York (use force=true to override)",
        ny_time_gate: ny,
      });
    }
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Determine week_number
  let week_number: number | null = null;

  if (Number.isFinite(Number(week_number_raw))) {
    week_number = Number(week_number_raw);
  } else {
    // Auto-select next upcoming week based on start_date
    const todayIso = new Date().toISOString().slice(0, 10);

    const { data: nextWeek, error: nextErr } = await supabase
      .from("weeks")
      .select("week_number,start_date")
      .gte("start_date", todayIso)
      .order("start_date", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (nextErr) return json(500, { error: "Failed selecting next week", details: nextErr.message });
    if (nextWeek?.week_number === null || nextWeek?.week_number === undefined) {
      return json(404, { error: "No upcoming week found; provide week_number explicitly" });
    }

    week_number = Number(nextWeek.week_number);
  }

  // Load week configuration
  const { data: week, error: weekErr } = await supabase
    .from("weeks")
    .select("week_number, tourn_id, org_id, season_year")
    .eq("week_number", week_number)
    .limit(1)
    .maybeSingle();

  if (weekErr) return json(500, { error: "Failed reading weeks row", details: weekErr.message });
  if (!week) return json(404, { error: `Week not found for week_number=${week_number}` });

  const tourn_id = String((week as any).tourn_id ?? "");
  const org_id = String((week as any).org_id ?? "");
  const season_year = String((week as any).season_year ?? "");

  if (!tourn_id || !org_id || !season_year) {
    return json(400, {
      error: "Week is missing required tournament mapping (tourn_id/org_id/season_year)",
      week_number,
      tourn_id,
      org_id,
      season_year,
    });
  }

  // Call RapidAPI GET tournaments
  let tournamentsPayload: any;
  let rapidUsed: any;

  try {
    const out = await rapidGetTournaments({
      host: RAPIDAPI_HOST,
      key: RAPIDAPI_KEY,
      org_id,
      season_year,
      tourn_id,
    });
    tournamentsPayload = out.data;
    rapidUsed = out.used;
  } catch (e) {
    return json(502, {
      error: "RapidAPI GET tournaments failed",
      details: String((e as any)?.message ?? e),
      week_number,
      tourn_id,
      org_id,
      season_year,
    });
  }

  // Extract players[]
  const players: any[] =
    (tournamentsPayload && Array.isArray(tournamentsPayload.players) && tournamentsPayload.players) ||
    (tournamentsPayload && tournamentsPayload.tournament && Array.isArray(tournamentsPayload.tournament.players) && tournamentsPayload.tournament.players) ||
    [];

  if (!Array.isArray(players) || players.length === 0) {
    return json(502, {
      error: "RapidAPI payload missing players[] (no field returned)",
      week_number,
      rapid_used: rapidUsed,
      payload_keys: tournamentsPayload ? Object.keys(tournamentsPayload) : null,
    });
  }

  // Normalize & dedupe
  const normalized = players
    .map((p) => {
      const playerId = p.playerId ?? p.player_id ?? p.id;
      if (playerId === null || playerId === undefined || String(playerId).trim() === "") return null;

      const firstName = String(p.firstName ?? p.first_name ?? "").trim();
      const lastName = String(p.lastName ?? p.last_name ?? "").trim();
      const displayName =
        fullName(firstName, lastName) ||
        String(p.playerName ?? p.name ?? "").trim() ||
        String(playerId);

      const isAmateur = Boolean(p.isAmateur ?? p.is_amateur ?? false);

      return {
        ext_id: String(playerId),
        first_name: firstName || null,
        last_name: lastName || null,
        display_name: displayName, // NOTE: pro_players requires display_name NOT NULL
        is_amateur: isAmateur,
      };
    })
    .filter(Boolean) as Array<{
    ext_id: string;
    first_name: string | null;
    last_name: string | null;
    display_name: string;
    is_amateur: boolean;
  }>;

  const seen = new Set<string>();
  const dedup = normalized.filter((p) => (seen.has(p.ext_id) ? false : (seen.add(p.ext_id), true)));

  const nowIso = new Date().toISOString();

  // Upsert into pro_players (schema-correct)
  const { error: upsertErr } = await supabase
    .from("pro_players")
    .upsert(
      dedup.map((p) => ({
        ...p,
        updated_at: nowIso, // pro_players.updated_at is NOT NULL in your schema
      })),
      { onConflict: "ext_id" },
    );

  if (upsertErr) {
    return json(500, {
      error: "Failed upserting pro_players",
      details: upsertErr.message,
    });
  }

  // Replace week_pro_field for this week_number
  const { error: delErr } = await supabase
    .from("week_pro_field")
    .delete()
    .eq("week_number", week_number);

  if (delErr) return json(500, { error: "Failed deleting prior week_pro_field", details: delErr.message });

  const weekFieldRows = dedup.map((p, idx) => ({
    week_number,
    player_ext_id: p.ext_id,
    player_name: p.display_name,
    odds_rank: idx + 1,      // required NOT NULL
    tier: 1,                 // required NOT NULL
    odds_display: null,
    odds_numeric: null,

    // Optional extra columns you already have:
    first_name: p.first_name,
    last_name: p.last_name,
    is_amateur: p.is_amateur,
    source: "rapidapi_slashgolf_tournaments",
    updated_at: nowIso,
  }));

  // Insert in chunks
  const chunkSize = 500;
  for (let i = 0; i < weekFieldRows.length; i += chunkSize) {
    const chunk = weekFieldRows.slice(i, i + chunkSize);
    const { error: insErr } = await supabase.from("week_pro_field").insert(chunk);
    if (insErr) {
      return json(500, {
        error: "Failed inserting week_pro_field",
        details: insErr.message,
        inserted_so_far: i,
      });
    }
  }

  // Stamp weeks.field_last_synced_at
  const { error: stampErr } = await supabase
    .from("weeks")
    .update({ field_last_synced_at: nowIso })
    .eq("week_number", week_number);

  if (stampErr) return json(500, { error: "Failed updating weeks.field_last_synced_at", details: stampErr.message });

  return json(200, {
    ok: true,
    week_number,
    tourn_id,
    org_id,
    season_year,
    rapid_used: rapidUsed,
    players_received: players.length,
    pros_upserted: dedup.length,
    week_field_inserted: weekFieldRows.length,
  });
});
