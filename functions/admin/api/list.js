// GET /admin/api/list : every stored plot, newest last, with the name it should have when exported.
import { libraryNames, cleanExportName, exportNames } from "../_names.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json(500, { error: "database binding DB is missing" });
  const { results } = await env.DB.prepare(
    "SELECT id, object_key, original_name, original_filename, size, first_seen, last_seen, times_seen FROM uploads ORDER BY id"
  ).all();
  const lib = await libraryNames(request, env);
  const names = exportNames(results, lib);
  const rows = results.map((r) => ({
    id: r.id,
    key: r.object_key,
    exportName: names.get(r.id),
    originalName: r.original_filename || r.original_name,
    size: r.size,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    timesSeen: r.times_seen,
    inLibrary: lib.has(cleanExportName(r).toLowerCase()),
  }));
  return json(200, { rows, libraryCount: lib.size });
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
