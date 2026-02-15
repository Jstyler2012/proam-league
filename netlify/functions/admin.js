exports.handler = async (event) => {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ok: true,
      message: "admin function is alive",
      path: event.path,
      method: event.httpMethod,
    }),
  };
};
