// Cloudflare Pages Function: POST /log
// A simple activity log: which files visitors open and which plotters they pick.
//   { ev: "open",     visit, file, size, src: "upload"|"library", plotter, mode }
//   { ev: "plotter",  visit, plotter, mode, file }          (picked a different plotter)
//   { ev: "download", visit, file, plotter, mode, media }   (file is the downloaded name)
// Nothing personal is kept: no IP address, only the country Cloudflare reports and a
// random "visit" id the page makes up for each browser tab, so one visit's lines group together.
// The file itself is never sent, only its name and size.
// The table is created the first time it is needed (D1 binding DB). Lines older than
// 180 days are cleared out now and then. Read it at /admin/log.html.

const EVENTS = new Set(["open", "plotter", "download"]);

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function clean(v, max) {
  return String(v == null ? "" : v).replace(/[\x00-\x1f\x7f]/g, "").slice(0, max);
}

export async function ensureLogTable(db) {
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS site_log (" +
    " id INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT, visit TEXT, ev TEXT, file TEXT, size INTEGER," +
    " src TEXT, plotter TEXT, mode TEXT, media TEXT, country TEXT)"
  ).run();
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json(500, { error: "database binding DB is missing" });

  // only the site's own page may write to the log
  const origin = request.headers.get("Origin");
  if (!origin || new URL(origin).host !== new URL(request.url).host) return json(403, { error: "forbidden" });

  let b;
  try { b = await request.json(); } catch (e) { return json(400, { error: "bad request" }); }
  const ev = clean(b.ev, 20);
  if (!EVENTS.has(ev)) return json(400, { error: "unknown event" });

  const size = Number.isFinite(+b.size) && +b.size >= 0 ? Math.round(+b.size) : null;
  const src = b.src === "library" ? "library" : b.src === "upload" ? "upload" : "";
  const country = clean(request.cf && request.cf.country, 4);

  await ensureLogTable(env.DB);
  await env.DB.prepare(
    "INSERT INTO site_log (t, visit, ev, file, size, src, plotter, mode, media, country) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).bind(new Date().toISOString(), clean(b.visit, 16), ev, clean(b.file, 200), size, src,
         clean(b.plotter, 80), clean(b.mode, 60), clean(b.media, 60), country).run();

  // tidy up now and then (about one write in a hundred)
  if (Math.random() < 0.01) {
    const cutoff = new Date(Date.now() - 180 * 86400 * 1000).toISOString();
    try { await env.DB.prepare("DELETE FROM site_log WHERE t < ?").bind(cutoff).run(); } catch (e) { /* next time */ }
  }
  return json(200, { ok: true });
}
