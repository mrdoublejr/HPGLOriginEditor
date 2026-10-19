// POST /admin/api/delete   { ids: [3, 7, 12] }
// Deletes uploaded plots for good: the file in the R2 bucket and its row in the uploads list.
// (Plots already in the public library are not touched; they live on GitHub.)
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
      await env.DB.prepare("DELETE FROM uploads WHERE id = ?").bind(id).run();
      deleted.push(id);
    } catch (e) { failed.push(id); }
  }
  return json(200, { ok: true, deleted: deleted.length, failed });
}
