// POST /admin/api/delete   { ids: [3, 7, 12] }                  : delete uploads for good
// POST /admin/api/delete   { ids: [3, 7, 12], fileOnly: true }  : only clear their files out of R2
//   (used for plots already in the public library: the record stays in the database, with its
//    name, dates and how many times it was sent, but the file itself is gone from the bucket)
// Plots in the public library are never touched here; they live on GitHub.
// Protected by ../_middleware.js (Cloudflare Access), like the rest of /admin/.

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB || !env.MY_BUCKET) return json(500, { error: "database or bucket binding is missing" });
  const origin = request.headers.get("Origin");
  if (!origin || new URL(origin).host !== new URL(request.url).host) return json(403, { error: "forbidden" });

  let body;
  try { body = await request.json(); } catch (e) { return json(400, { error: "bad request" }); }
  const ids = [...new Set((body.ids || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return json(400, { error: "nothing selected" });

  const deleted = [], failed = [];
  for (const id of ids) {
    try {
      const row = await env.DB.prepare("SELECT object_key FROM uploads WHERE id = ?").bind(id).first();
      if (!row) { failed.push(id); continue; }
      if (row.object_key) await env.MY_BUCKET.delete(row.object_key);
      if (body.fileOnly) await env.DB.prepare("UPDATE uploads SET object_key = NULL WHERE id = ?").bind(id).run();
      else await env.DB.prepare("DELETE FROM uploads WHERE id = ?").bind(id).run();
      deleted.push(id);
    } catch (e) { failed.push(id); }
  }
  return json(200, { ok: true, deleted: deleted.length, failed });
}
