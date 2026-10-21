// GET /pi/next?plotters=750c,7585b
// The Pi asks for work. Records that the Pi is alive, clears jobs left "sending" by a
// plot that was cut off, then hands over the oldest queued job for one of the plotters
// it serves (marking it "sending"), or 204 if there is none.
import { PLOTTERS, json, ensurePlotTables } from "../_plotjobs.js";

export async function onRequestGet({ request, env }) {
  await ensurePlotTables(env.DB);
  await env.DB.prepare(
    "INSERT INTO plot_queue_state (key, value) VALUES ('pi_seen', datetime('now')) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();

  const want = (new URL(request.url).searchParams.get("plotters") || "")
    .split(",").map((s) => s.trim()).filter((s) => PLOTTERS[s]);
  if (!want.length) return new Response(null, { status: 204 });

  const marks = want.map(() => "?").join(",");
  // The Pi plots one job at a time, so when it asks for work nothing of its is still
  // being sent. A job still marked "sending" or "stopping" was cut off (the Pi or its
  // service restarted mid-plot) and would otherwise look busy for ever.
  await env.DB.prepare(
    "UPDATE plot_jobs SET status = 'failed', message = 'the Pi stopped before finishing it'," +
    " updated = datetime('now') WHERE status IN ('sending', 'stopping') AND plotter IN (" + marks + ")"
  ).bind(...want).run();
  const job = await env.DB.prepare(
    "UPDATE plot_jobs SET status = 'sending', updated = datetime('now') WHERE id = (" +
    " SELECT id FROM plot_jobs WHERE status = 'queued' AND plotter IN (" + marks + ")" +
    " ORDER BY id LIMIT 1) RETURNING id, plotter, name, size"
  ).bind(...want).first();
  if (!job) return new Response(null, { status: 204 });
  return json(200, job);
}