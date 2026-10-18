// Cloudflare Pages Function: POST /made   { fp, name }
// The page sends the fingerprint of every file it hands out (Download), never the file.
// A fingerprint is SHA-256 of the file's bytes with all spacing removed, the same recipe
// upload.js uses, so if a made file is ever uploaded again the admin page can mark it
// "made by this site" instead of letting it pass for an original.
// The table is created the first time it is needed (D1 binding DB).

const FP = /^[0-9a-f]{64}$/;

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function ensureMadeTable(db) {
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS made_files (" +
    " fingerprint TEXT PRIMARY KEY, name TEXT, first_made TEXT, last_made TEXT, times INTEGER DEFAULT 1)"
  ).run();
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json(500, { error: "database binding DB is missing" });

  // only the site's own page may record fingerprints
  const origin = request.headers.get("Origin");
  if (!origin || new URL(origin).host !== new URL(request.url).host) return json(403, { error: "forbidden" });

  let body;
  try { body = await request.json(); } catch (e) { return json(400, { error: "bad request" }); }
  const fp = String(body.fp || "").toLowerCase();
  if (!FP.test(fp)) return json(400, { error: "bad fingerprint" });
  const name = String(body.name || "").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200);

  await ensureMadeTable(env.DB);
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO made_files (fingerprint, name, first_made, last_made, times) VALUES (?, ?, ?, ?, 1) " +
    "ON CONFLICT(fingerprint) DO UPDATE SET last_made = excluded.last_made, times = times + 1"
  ).bind(fp, name, now, now).run();
  return json(200, { ok: true });
}
