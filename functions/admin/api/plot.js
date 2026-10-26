// The Plot button's side of the plot queue (see ../../_plotjobs.js and /pi/).
// GET  /admin/api/plot          : recent jobs, and when the Pi last checked in
// GET  /admin/api/plot?id=N     : one job (the button polls this for its status)
// GET  /admin/api/plot?id=N&file=1 : the bytes that were sent, while the job is still stored
//                                  (the live plot trace picks a running job up again with it)
// POST /admin/api/plot          : {plotter, name, text}  -> queues a job, returns {id}
// POST /admin/api/plot          : {action: "cancel", id} -> cancels a job that hasn't started
// POST /admin/api/plot          : {action: "stop", id}   -> a waiting job is cancelled; one being
//                                  plotted is marked "stopping", and the Pi stops it at its next
//                                  progress report (/pi/progress), then reports it "cancelled"
// Protected by ../_middleware.js (Cloudflare Access), like the rest of /admin/.
import { PLOTTERS, MAX_BYTES, json, ensurePlotTables, jobKey } from "../../_plotjobs.js";

async function piLastSeen(db) {
  const r = await db.prepare("SELECT value FROM plot_queue_state WHERE key = 'pi_seen'").first();
  return r ? r.value : null;
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json(500, { error: "database binding DB is missing" });
  await ensurePlotTables(env.DB);
  const id = parseInt(new URL(request.url).searchParams.get("id") || "", 10);
  const piSeen = await piLastSeen(env.DB);
  if (id && new URL(request.url).searchParams.get("file")) {
    const obj = env.MY_BUCKET ? await env.MY_BUCKET.get(jobKey(id)) : null;
    if (!obj) return json(404, { error: "the file isn't stored any more" });
    return new Response(obj.body, {
      headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" },
    });
  }
  if (id) {
    const job = await env.DB.prepare("SELECT * FROM plot_jobs WHERE id = ?").bind(id).first();
    if (!job) return json(404, { error: "no such job" });
    return json(200, { job, piSeen });
  }
  const { results } = await env.DB.prepare(
    "SELECT * FROM plot_jobs ORDER BY id DESC LIMIT 30").all();
  return json(200, { jobs: results || [], piSeen, plotters: PLOTTERS });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json(500, { error: "database binding DB is missing" });
  if (!env.MY_BUCKET) return json(500, { error: "bucket binding MY_BUCKET is missing" });
  await ensurePlotTables(env.DB);
  let body;
  try { body = await request.json(); } catch (e) { return json(400, { error: "bad request" }); }

  if (body.action === "stop") {
    const id = +body.id;
    const q = await env.DB.prepare(
      "UPDATE plot_jobs SET status = 'cancelled', updated = datetime('now') WHERE id = ? AND status = 'queued'"
    ).bind(id).run();
    if (q.meta && q.meta.changes) { await env.MY_BUCKET.delete(jobKey(id)); return json(200, { ok: true, status: "cancelled" }); }
    const r = await env.DB.prepare(
      "UPDATE plot_jobs SET status = 'stopping', updated = datetime('now') WHERE id = ? AND status = 'sending'"
    ).bind(id).run();
    return json(200, { ok: true, status: r.meta && r.meta.changes ? "stopping" : "unchanged" });
  }

  if (body.action === "cancel") {
    const r = await env.DB.prepare(
      "UPDATE plot_jobs SET status = 'cancelled', updated = datetime('now') WHERE id = ? AND status = 'queued'"
    ).bind(+body.id).run();
    if (r.meta && r.meta.changes) await env.MY_BUCKET.delete(jobKey(+body.id));
    return json(200, { ok: true, cancelled: !!(r.meta && r.meta.changes) });
  }

  const plotter = String(body.plotter || "");
  if (!PLOTTERS[plotter]) return json(400, { error: "unknown plotter" });
  const text = String(body.text || "");
  if (!text.trim()) return json(400, { error: "nothing to plot" });
  // Plot files are 8-bit; keep every character as one byte (no UTF-8 re-encoding).
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  if (bytes.length > MAX_BYTES) return json(413, { error: "file is too big to plot (20 MB at most)" });
  const name = String(body.name || "plot").slice(0, 200);

  const res = await env.DB.prepare(
    "INSERT INTO plot_jobs (plotter, name, size) VALUES (?, ?, ?)"
  ).bind(plotter, name, bytes.length).run();
  const id = res.meta.last_row_id;
  await env.MY_BUCKET.put(jobKey(id), bytes, { httpMetadata: { contentType: "application/octet-stream" } });
  return json(200, { ok: true, id, piSeen: await piLastSeen(env.DB) });
}