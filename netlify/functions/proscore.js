exports.handler = async function(event, context) {
  try {
    const response = await fetch("https://api.sportsdata.io/golf/v2/json/Tournaments", {
      headers: {
        "Ocp-Apim-Subscription-Key": process.env.SPORTSDATAIO_API_KEY
      }
    });

    const data = await response.json();

    return {
      statusCode: 200,
      body: JSON.stringify(data)
    };

  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: error.message })
    };
  }
};
