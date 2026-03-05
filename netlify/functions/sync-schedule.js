// netlify/functions/sync-schedule.js
'use strict';

exports.handler = async () => {
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ok: true, message: "sync-schedule is loading" }),
  };
};
