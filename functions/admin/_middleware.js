// Guards everything under /admin/ that runs as a function (the admin data API).
// Cloudflare Access signs every request that passes its login with a token; this checks that
// token, so the API stays closed even if the Access rule is ever set up wrong.
// Needs two plain-text variables on the Pages project (Settings > Variables and secrets):
//   ACCESS_TEAM = your Zero Trust team name (the part before .cloudflareaccess.com)
//   ACCESS_AUD  = the "Application Audience (AUD) Tag" of the Access application

let certCache = { at: 0, keys: null };

function b64uBytes(s) {
  const b = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b.padEnd(Math.ceil(b.length / 4) * 4, "="));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function b64uJson(s) {
  return JSON.parse(new TextDecoder().decode(b64uBytes(s)));
}

async function getKeys(team) {
  if (certCache.keys && Date.now() - certCache.at < 3600 * 1000) return certCache.keys;
  const r = await fetch("https://" + team + ".cloudflareaccess.com/cdn-cgi/access/certs");
  if (!r.ok) throw new Error("could not load Access keys");
  const j = await r.json();
  certCache = { at: Date.now(), keys: j.keys || [] };
  return certCache.keys;
}

async function tokenIsValid(token, env) {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const header = b64uJson(parts[0]);
  const payload = b64uJson(parts[1]);
  if (header.alg !== "RS256") return false;

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) return false;
  if (payload.nbf && payload.nbf > now + 60) return false;
  if (payload.iss !== "https://" + env.ACCESS_TEAM + ".cloudflareaccess.com") return false;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return false;

  const jwk = (await getKeys(env.ACCESS_TEAM)).find((k) => k.kid === header.kid);
  if (!jwk) return false;
  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64uBytes(parts[2]),
    new TextEncoder().encode(parts[0] + "." + parts[1]));
}

function deny(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function onRequest({ request, env, next }) {
  if (!env.ACCESS_TEAM || !env.ACCESS_AUD) {
    return deny(503, "Admin is not set up yet (ACCESS_TEAM / ACCESS_AUD variables are missing)");
  }
  const cookie = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  const token = request.headers.get("Cf-Access-Jwt-Assertion") || (cookie && cookie[1]);
  if (!token) return deny(403, "forbidden");
  try {
    if (!(await tokenIsValid(token, env))) return deny(403, "forbidden");
  } catch (e) {
    return deny(403, "forbidden");
  }
  return next();
}
