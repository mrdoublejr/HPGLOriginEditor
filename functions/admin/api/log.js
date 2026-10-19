// GET /admin/api/log?days=7   : the activity log (newest first) plus simple counts
//   days: 1 to 180 (default 7). At most 2000 lines are returned.
// Protected by ../_middleware.js (Cloudflare Access), like the rest of /admin/.
import { ensureLogTable } from "../../log.js";

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json(500, { error: "database binding DB is missing" });
  await ensureLogTable(env.DB);

  let days = parseInt(new URL(request.url).searchParams.get("days"), 10);
  if (!(days >= 1 && days <= 180)) days = 7;
  const since = new Date(Date.now() - days * 86400 * 1000).toISOString();

  const { results } = await env.DB.prepare(
    "SELECT t, visit, ev, file, size, src, plotter, mode, media, country FROM site_log" +
    " WHERE t >= ? ORDER BY id DESC LIMIT 2000"
  ).bind(since).all();

  const { results: plotters } = await env.DB.prepare(
    "SELECT plotter, COUNT(*) AS n FROM site_log WHERE t >= ? AND plotter <> '' AND ev IN ('open','plotter','download')" +
    " GROUP BY plotter ORDER BY n DESC LIMIT 15"
  ).bind(since).all();

  const totals = await env.DB.prepare(
    "SELECT COUNT(DISTINCT visit) AS visits," +
    " SUM(ev = 'open') AS opens, SUM(ev = 'download') AS downloads FROM site_log WHERE t >= ?"
  ).bind(since).first();

  return json(200, { days, rows: results, plotters, totals });
}
