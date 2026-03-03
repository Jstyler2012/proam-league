// netlify/functions/sync-field.js
// Purpose: populate public.week_pro_field for a given week_number.
// This version is "debuggable": it NEVER throws without returning JSON,
// so you can see the real error in the browser instead of "Internal Error ID ...".

const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

// Optional: if you still use RapidAPI for field roster
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST

// Optional: if you use DataGolf directly
const DATAGOLF_API_KEY = process.env.DATAGOLF_API_KEY

const ADMIN_PIN = process.env.ADMIN_PIN || process.env.ADMIN_TOKEN || process.env.SYNC_PIN

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  }
}

async function supabaseFetch(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    const err = new Error(`Supabase ${method} ${path} failed: ${res.status} ${text}`)
    err.status = res.status
    throw err
  }
  return data
}

exports.handler = async (event) => {
  try {
    const q = event.queryStringParameters || {}
    const week_number = Number(q.week_id ?? q.week_number)

    // Pin check (return 401, not crash)
    if (ADMIN_PIN) {
      const pin = q.pin || ''
      if (pin !== ADMIN_PIN) {
        return json(401, { ok: false, error: 'Invalid pin' })
      }
    }

    if (!Number.isFinite(week_number)) {
      return json(400, { ok: false, error: 'Missing or invalid week_id/week_number' })
    }

    // Hard fail early with clear messages (instead of Internal Error)
    if (!SUPABASE_URL) return json(500, { ok: false, error: 'Missing env SUPABASE_URL' })
    if (!SERVICE_KEY) return json(500, { ok: false, error: 'Missing env SUPABASE_SERVICE_ROLE_KEY' })

    // ---- Strategy (minimal): you need SOME source of players to insert.
    // If your system expects RapidAPI roster, require it:
    // If you intend DataGolf-based roster, require DATAGOLF_API_KEY and fetch that instead.
    //
    // For now, we’ll detect which creds exist and report it.
    const hasRapid = !!(RAPIDAPI_KEY && RAPIDAPI_HOST)
    const hasDG = !!DATAGOLF_API_KEY

    // If neither exists, return a readable error
    if (!hasRapid && !hasDG) {
      return json(500, {
        ok: false,
        error:
          'No upstream configured. Set RAPIDAPI_KEY + RAPIDAPI_HOST OR set DATAGOLF_API_KEY in Netlify env vars.',
      })
    }

    // ------------------------------------------------------------------
    // TODO: Replace this block with your actual roster fetch.
    // For immediate debugging, we’ll just validate upstream availability
    // and validate Supabase insert path by doing a no-op read.
    // ------------------------------------------------------------------

    // Sanity check the table exists and we can query it
    await supabaseFetch(`/rest/v1/week_pro_field?select=week_number&week_number=eq.${week_number}&limit=1`)

    // If you get here, your crash is NOT Supabase connectivity.
    // Next you would implement the roster fetch and upsert.

    return json(200, {
      ok: true,
      week_number,
      message:
        'sync-field ran without crashing. Next step: implement upstream roster fetch + upsert into week_pro_field.',
      env_detected: {
        hasRapid,
        hasDG,
      },
    })
  } catch (err) {
    console.error('sync-field error:', err)
    return json(500, {
      ok: false,
      error: err.message || String(err),
      // helpful for debugging without exposing secrets:
      hint:
        'Check Netlify env vars and upstream API responses. This function now returns the real error instead of Internal Error ID.',
    })
  }
}
