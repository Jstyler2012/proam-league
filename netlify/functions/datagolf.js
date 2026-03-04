exports.handler = async function(event, context) {
  try {
    const res = await fetch("https://feeds.datagolf.com/preds/pre-tournament?tour=pga&key=" + process.env.DATAGOLF_API_KEY);

    const data = await res.json();

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(data)
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: err.message
      })
    };
  }
};
