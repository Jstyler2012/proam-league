// netlify/functions/proscore.js
exports.handler = async (event) => {
  // Placeholder:
  // Later we can wire this to a real data source to pull PGA scores.
  const q = event.queryStringParameters || {};
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ok: true,
      pro_id: q.pro_id || null,
      pro_to_par: null,
      note: "Placeholder. Wire to PGA score provider later.",
    }),
  };
};
