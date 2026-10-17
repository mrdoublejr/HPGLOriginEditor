// Only the Raspberry Pi may use /pi/: it sends "Authorization: Bearer <PLOTQ_TOKEN>".
// PLOTQ_TOKEN is a Secret on the Pages project (Settings > Variables and Secrets) and the
// same value goes in the Pi's /etc/plotq.env.
import { json } from "../_plotjobs.js";

function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function onRequest({ request, env, next }) {
  if (!env.PLOTQ_TOKEN) return json(503, { error: "PLOTQ_TOKEN is not set on the site" });
  const m = (request.headers.get("Authorization") || "").match(/^Bearer\s+(.+)$/);
  if (!m || !same(m[1].trim(), env.PLOTQ_TOKEN)) return json(403, { error: "forbidden" });
  if (!env.DB || !env.MY_BUCKET) return json(500, { error: "DB or MY_BUCKET binding is missing" });
  return next();
}