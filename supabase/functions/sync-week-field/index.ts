import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";
const DATAGOLF_API_KEY = Deno.env.get("DATAGOLF_API_KEY") ?? "";

// Resilient: attaches DataGolf odds to existing week_pro_field rows.
// Does NOT depend on RapidAPI being healthy.

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function decimalToAmericanStr(dec: number): string | null {
  if (!Number.isFinite(dec) || dec <= 1) return null;
  if (dec >= 2) return `+${Math.round((dec - 1) * 100)}`;
  return `${Math.round(-100 / (dec - 1))}`;
}

// Remove diacritics (Å -> A, ø -> o, etc) and normalize whitespace/punctuation
function cleanName(s: string): string {
  return (s || "")
    .normalize("NFD")
    // Strip combining marks/diacritics
    .replace(/[\u0300-\u036f]/g, "")
    // Extra mappings that sometimes don't decompose as expected
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

// Handles "Last, First" and "First Last"
function splitName(name: string): { first: string; last: string } | null {
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

// Stable key across formats: lastName|firstInitial
function nameKey(name: string): string | null {
  const sp = splitName(name);
  if (!sp) return null;
  const fi = sp.first?.[0];
  if (!fi) return null;
  return `${sp.last}|${fi}`;
}

async function fetchJson(url: string, opts?: RequestInit) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // ignore parse error; caller can inspect preview
  }
  return { res, text, json };
}

function pickArray(json: any): any[] {
  if (!json) return [];
  if (Array.isArray(json.players)) return json.players;
  if (Array.isArray(json.data)) return json.data;
  if (Array.isArray(json.results)) return json.results;
  if (Array.isArray(json.items)) return json.items;
  // DataGolf outrights uses `odds` as the array
  if (Array.isArray(json.odds)) return json.odds;
  return [];
}

function extractName(dg: any): string | null {
  // DataGolf outrights entries typically include one of these
  return dg?.player_name ?? dg?.name ?? dg?.player ?? dg?.golfer ?? dg?.full_name ?? null;
}

// DataGolf outrights entries look like:
// { dg_id: 18417, draftkings: 4.45, fanduel: 4.5, ... , datagolf: { baseline: 5.96, ... } }
function extractBestDecimal(dg: any): number | null {
  const decimals: number[] = [];

  // Collect bookmaker decimals directly from object fields
  for (const [k, v] of Object.entries(dg ?? {})) {
    if (k === "dg_id" || k === "datagolf") continue;
    if (typeof v === "number" && Number.isFinite(v) && v > 1) decimals.push(v);
  }

  // If no books, fall back to DataGolf baseline model (still decimal)
  const baseline = Number(dg?.datagolf?.baseline);
  if (!decimals.length && Number.isFinite(baseline) && baseline > 1) decimals.push(baseline);

  if (!decimals.length) return null;
  return Math.min(...decimals);
}

serve(async (req) => {
  try {
    if (req.headers.get("x-cron-secret") !== CRON_SECRET) {
      return new Response(JSON.stringify({ success: false, error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const week_number = body?.week_number;

    if (week_number == null || Number.isNaN(Number(week_number))) {
      return new Response(JSON.stringify({ success: false, error: "Missing/invalid week_number" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const weekNum = Number(week_number);

    // Load existing field rows (your table has player_ext_id; it does NOT have an id column)
    const { data: fieldRows, error: fieldErr } = await supabase
      .from("week_pro_field")
      .select("week_number, player_ext_id, player_name, odds_numeric, odds_display, odds_rank, tier, source")
      .eq("week_number", weekNum);

    if (fieldErr) {
      return new Response(JSON.stringify({ success: false, error: `DB load failed: ${fieldErr.message}` }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const existing_rows = fieldRows?.length ?? 0;
    if (!existing_rows) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "No week_pro_field rows exist for this week. Sync the field first when RapidAPI is healthy.",
          week_number: weekNum,
        }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // DataGolf odds
    let dg_status: number | null = null;
    let dg_count = 0;
    let mapped_count = 0;
    let odds_updated = 0;
    let dg_error: string | null = null;
    let preview: string | null = null;

    if (!DATAGOLF_API_KEY) {
      dg_error = "DATAGOLF_API_KEY missing in Supabase Edge Function secrets";
    } else {
      const dgUrl =
        `https://feeds.datagolf.com/betting-tools/outrights` +
        `?tour=pga&market=win&odds_format=decimal&file_format=json&key=${encodeURIComponent(DATAGOLF_API_KEY)}`;

      const { res, json, text } = await fetchJson(dgUrl);
      dg_status = res.status;
      preview = (text ?? "").slice(0, 500);

      const dgPlayers = pickArray(json);
      dg_count = dgPlayers.length;

      if (!res.ok) {
        dg_error = `DataGolf not ok. status=${res.status}`;
      } else if (!dg_count) {
        dg_error = "DataGolf returned 200 but no array found under players/data/results/items/odds.";
      } else {
        // Build odds map keyed by last|firstInitial
        const oddsMap: Record<string, number> = {};

        for (const dg of dgPlayers) {
          const nm = extractName(dg);
          if (!nm) continue;
          const bestDec = extractBestDecimal(dg);
          if (!bestDec) continue;
          const k = nameKey(nm);
          if (k) oddsMap[k] = bestDec;
        }

        // Match field rows
        const matched = (fieldRows || [])
          .map((row: any) => {
            const k = nameKey(row.player_name);
            if (!k) return null;
            const dec = oddsMap[k];
            if (!Number.isFinite(dec)) return null;
            return { ...row, _dec: dec as number };
          })
          .filter(Boolean) as any[];

        mapped_count = matched.length;

        // Rank favorites first: lower decimal odds
        matched.sort((a, b) => a._dec - b._dec);

        for (let i = 0; i < matched.length; i++) {
          const row = matched[i];
          const american = decimalToAmericanStr(row._dec);
          const oddsRank = i + 1;

          let tier = 4;
          if (oddsRank <= 10) tier = 1;
          else if (oddsRank <= 25) tier = 2;
          else if (oddsRank <= 45) tier = 3;

          const { error: updErr } = await supabase
            .from("week_pro_field")
            .update({
              odds_numeric: row._dec,
              odds_display: american,
              odds_rank: oddsRank,
              tier,
              source: (row.source || "rapidapi_slashgolf_tournament") + "+datagolf",
            })
            .eq("week_number", weekNum)
            .eq("player_ext_id", row.player_ext_id);

          if (!updErr) odds_updated++;
        }
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        week_number: weekNum,
        existing_rows,
        datagolf: {
          dg_status,
          dg_count,
          mapped_count,
          odds_updated,
          dg_error,
          preview,
        },
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ""}` : String(err);
    return new Response(JSON.stringify({ success: false, error: msg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
