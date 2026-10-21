// Plot queue shared by the Plot button (/admin/api/plot) and the Raspberry Pi (/pi/...).
// Jobs live in the D1 table "plot_jobs"; the file itself is in R2 at plotjobs/<id>.
// The table is created the first time it is needed.

export const PLOTTERS = {            // what the Pi can plot on (its name -> label)
  "750c":  "HP DesignJet 750C",
  "7585b": "HP 7585B",
};
export const MAX_BYTES = 20 * 1024 * 1024;

export function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function ensurePlotTables(db) {
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS plot_jobs (" +
    " id INTEGER PRIMARY KEY AUTOINCREMENT," +
    " created TEXT NOT NULL DEFAULT (datetime('now'))," +
    " updated TEXT NOT NULL DEFAULT (datetime('now'))," +
    " plotter TEXT NOT NULL, name TEXT, size INTEGER," +
    " status TEXT NOT NULL DEFAULT 'queued', message TEXT)"
  ).run();
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS plot_queue_state (key TEXT PRIMARY KEY, value TEXT)"
  ).run();
  await ensureProgressColumns(db);
}

// Progress of a job while the Pi sends it (POST /pi/progress): bytes and pen-down moves
// sent so far and in all, seconds since it started, and when the Pi last reported.
// Added to tables made before progress existed; checked once per worker.
const PROGRESS_COLUMNS = {
  sent: "INTEGER", total: "INTEGER", moves: "INTEGER", moves_total: "INTEGER",
  elapsed: "INTEGER", progress_at: "TEXT",
};
let progressColumnsChecked = false;
async function ensureProgressColumns(db) {
  if (progressColumnsChecked) return;
  const { results } = await db.prepare("PRAGMA table_info(plot_jobs)").all();
  const have = new Set((results || []).map((c) => c.name));
  for (const [name, type] of Object.entries(PROGRESS_COLUMNS)) {
    if (!have.has(name)) {
      try { await db.prepare(`ALTER TABLE plot_jobs ADD COLUMN ${name} ${type}`).run(); }
      catch (e) { /* another request added it first */ }
    }
  }
  progressColumnsChecked = true;
}

export const jobKey = (id) => "plotjobs/" + id;