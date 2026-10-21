// POST /pi/progress : {id, sent, total, moves, moves_total, elapsed}
// The Pi reports how far it has got with a job, every few seconds while it sends.
// The answer says whether to keep going: {stop: true} when Stop was pressed on the site
// (the job's status is then "stopping").
// Only the Pi may call it (see _middleware.js).
import { json, ensurePlotTables } from "../_plotjobs.js";

const int = (v) => (Number.isFinite(+v) && +v >= 0 ? Math.round(+v) : null);

export async function onRequestPost({ request, env }) {
  let b;
  try { b = await request.json(); } catch (e) { return json(400, { error: "bad request" }); }
  const id = parseInt(b.id, 10);
  if (!id) return json(400, { error: "no id" });
  await ensurePlotTables(env.DB);
  await env.DB.prepare(
    "UPDATE plot_jobs SET sent = ?, total = ?, moves = ?, moves_total = ?, elapsed = ?," +
    " progress_at = datetime('now'), updated = datetime('now')" +
    " WHERE id = ? AND status IN ('sending', 'stopping')"
  ).bind(int(b.sent), int(b.total), int(b.moves), int(b.moves_total), int(b.elapsed), id).run();
  // the Pi is clearly alive: keep "last seen" fresh while it's busy plotting
  await env.DB.prepare(
    "INSERT INTO plot_queue_state (key, value) VALUES ('pi_seen', datetime('now')) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  const job = await env.DB.prepare("SELECT status FROM plot_jobs WHERE id = ?").bind(id).first();
  return json(200, { ok: true, stop: !job || job.status === "stopping" || job.status === "cancelled" });
}
