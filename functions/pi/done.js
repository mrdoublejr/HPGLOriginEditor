// POST /pi/done : {id, ok: true|false, message}
// The Pi reports how a job went. A finished job's file is removed from R2; a failed
// one is kept so it can be looked at.
import { json, ensurePlotTables, jobKey } from "../_plotjobs.js";

export async function onRequestPost({ request, env }) {
  let b;
  try { b = await request.json(); } catch (e) { return json(400, { error: "bad request" }); }
  const id = parseInt(b.id, 10);
  if (!id) return json(400, { error: "no id" });
  await ensurePlotTables(env.DB);
  await env.DB.prepare(
    "UPDATE plot_jobs SET status = ?, message = ?, updated = datetime('now') WHERE id = ?"
  ).bind(b.ok ? "done" : "failed", String(b.message || "").slice(0, 500), id).run();
  if (b.ok) await env.MY_BUCKET.delete(jobKey(id));
  return json(200, { ok: true });
}