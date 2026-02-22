const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { ...corsHeaders, "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders };
  }

  const path = event.path.replace("/.netlify/functions/public", "").replace("/api", "");

  if (path === "" || path === "/" || path === "/health") {
    return json(200, { ok: true });
  }

  if (path === "/schedule") {
    const res = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/weeks`,
      {
        headers: {
          apikey: process.env.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        },
      }
    );

    const data = await res.json();
    return json(200, { weeks: data });
  }

  return json(404, { error: "Not found", path });
};
