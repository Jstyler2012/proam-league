// netlify/functions/proscore.js

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders, body: "" };

  const q = event.queryStringParameters || {};
  return {
    statusCode: 200,
    headers: { "content-type": "application/json", ...corsHeaders },
    body: JSON.stringify({
      ok: true,
      pro_id: q.pro_id || null,
      pro_to_par: null,
      note: "Placeholder. Wire to PGA score provider later.",
    }),
  };
};
