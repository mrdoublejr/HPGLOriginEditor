// GET /admin/api/list : every stored plot, with the name it should have when exported and
// whether the public library already holds the same plot (compared by content, not by name).
import { libraryFileNames, cleanExportName, exportNames } from "../_names.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json(500, { error: "database binding DB is missing" });

  const { results } = await env.DB.prepare(
    "SELECT id, object_key, original_name, original_filename, fingerprint, size, first_seen, last_seen, times_seen FROM uploads ORDER BY id"
  ).all();

  const libNames = await libraryFileNames(request, env);
  const libLower = new Set(libNames.map((n) => n.toLowerCase()));

  // fingerprints of the library files, saved by /admin/api/sync-library
  let libRows = [], needsSetup = false;
  try {
    libRows = (await env.DB.prepare("SELECT name, fingerprint FROM library_files").all()).results
      .filter((r) => libNames.includes(r.name));
  } catch (e) {
    needsSetup = true; // the library_files table has not been created yet
  }
  const byFingerprint = new Map();
  for (const r of libRows) {
    if (!byFingerprint.has(r.fingerprint)) byFingerprint.set(r.fingerprint, []);
    byFingerprint.get(r.fingerprint).push(r.name);
  }

  // fingerprints of files this site handed out (see /functions/made.js)
  const madeBy = new Map();
  try {
    const made = (await env.DB.prepare(
      "SELECT m.fingerprint, m.name FROM made_files m JOIN uploads u ON u.fingerprint = m.fingerprint"
    ).all()).results;
    for (const m of made) madeBy.set(m.fingerprint, m.name);
  } catch (e) { /* no made_files table yet: nothing has been downloaded since this was added */ }

  const names = exportNames(results, libLower);
  const rows = results.map((r) => {
    const same = byFingerprint.get(r.fingerprint) || [];
    return {
      id: r.id,
      key: r.object_key,
      exportName: names.get(r.id),
      originalName: r.original_filename || r.original_name,
      size: r.size,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      timesSeen: r.times_seen,
      sameAs: same,                                                   // library files with identical content
      madeBySite: madeBy.has(r.fingerprint) ? (madeBy.get(r.fingerprint) || "yes") : null, // a file this site produced
      nameTaken: !same.length && libLower.has(cleanExportName(r).toLowerCase()), // same name, different plot
    };
  });
  return json(200, {
    rows,
    library: { total: libNames.length, scanned: libRows.length, needsSetup },
  });
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
