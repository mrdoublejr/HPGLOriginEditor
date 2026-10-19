// POST /admin/api/publish   { ids: [3, 7, 12] }
// Adds the chosen uploads to the public library in ONE GitHub commit:
//   - each plot file goes into publicPlotLibrary/ under its export name (Car.plt, Car1.plt ...)
//   - publicPlotLibrary/index.json gets an entry for each, kept in the same order and format
//     as js/build-publicPlotLibrary-index.js writes it (titles/notes you typed are kept)
// Once the commit is made, each published upload's file is removed from the R2 bucket; its
// record stays in the uploads table (name, dates, times sent), and shows as "in the library".
// Cloudflare Pages then rebuilds the site from GitHub by itself, a minute or two later.
//
// Setup (Pages project > Settings > Variables and secrets):
//   GITHUB_TOKEN  (secret) fine-grained token for this one repository, "Contents: Read and write"
//   GITHUB_REPO   (text)   owner/name, e.g. mrdoublejr/HPGLOriginEditor
//   GITHUB_BRANCH (text)   optional, defaults to main
// Protected by ../_middleware.js (Cloudflare Access), like the rest of /admin/.
import { libraryNames, exportNames, cleanExportName } from "../_names.js";
import { LIB, github, githubReady, NOT_READY, base64 } from "../_github.js";

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB || !env.MY_BUCKET) return json(500, { error: "database or bucket binding is missing" });
  if (!githubReady(env)) return json(500, { error: NOT_READY });
  const origin = request.headers.get("Origin");
  if (!origin || new URL(origin).host !== new URL(request.url).host) return json(403, { error: "forbidden" });

  let body;
  try { body = await request.json(); } catch (e) { return json(400, { error: "bad request" }); }
  const ids = [...new Set((body.ids || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return json(400, { error: "nothing selected" });

  const g = github(env);
  let commit, added = [], skipped = [];
  try {
    // names: the same export names the admin list shows, with .txt sent as .plt
    const { results } = await env.DB.prepare(
      "SELECT id, object_key, original_name, original_filename, fingerprint FROM uploads ORDER BY id"
    ).all();
    const lib = await libraryNames(request, env);
    const names = exportNames(results, lib);
    const taken = new Set(lib);

    // plots already in the library (same content, any name) are never added again
    const inLibrary = new Map();
    try {
      const { results: lf } = await env.DB.prepare("SELECT name, fingerprint FROM library_files").all();
      for (const r of lf) if (!inLibrary.has(r.fingerprint)) inLibrary.set(r.fingerprint, r.name);
    } catch (e) { /* no library_files table yet */ }

    const index = await g.readIndex();
    for (const x of index.publicPlotLibrary) {
      const n = String(x.file || "").split("/").pop();
      if (n) taken.add(n.toLowerCase());
    }

    const entries = [];
    for (const id of ids) {
      const row = results.find((r) => r.id === id);
      if (!row || !row.object_key) { skipped.push({ id, why: "not found" }); continue; }
      if (row.fingerprint && inLibrary.has(row.fingerprint)) {
        skipped.push({ id, why: "already in the library as " + inLibrary.get(row.fingerprint) });
        continue;
      }
      let name = names.get(id) || cleanExportName(row);
      if (/\.txt$/i.test(name)) name = name.replace(/\.txt$/i, ".plt");
      const dot = name.lastIndexOf(".");
      const base = name.slice(0, dot), ext = name.slice(dot);
      let n = 0, finalName = name;
      while (taken.has(finalName.toLowerCase())) { n++; finalName = base + n + ext; }
      taken.add(finalName.toLowerCase());

      const obj = await env.MY_BUCKET.get(row.object_key);
      if (!obj) { skipped.push({ id, why: "file missing from the bucket" }); continue; }
      const bytes = new Uint8Array(await obj.arrayBuffer());
      const b = await g.blob(base64(bytes), "base64");
      entries.push({ path: LIB + "/" + finalName, sha: b.sha });
      index.publicPlotLibrary.push({ file: LIB + "/" + finalName, size: bytes.length });
      added.push({ id, key: row.object_key, name: finalName, fingerprint: row.fingerprint, size: bytes.length });
      if (row.fingerprint) inLibrary.set(row.fingerprint, finalName);   // two identical uploads in one go: only the first
    }
    if (!added.length) {
      return json(400, { error: "nothing was added: " + skipped.map((k) => k.why).join("; "), skipped });
    }

    const idx = await g.blob(g.indexText(index), "utf-8");
    entries.push({ path: LIB + "/index.json", sha: idx.sha });
    commit = await g.commit(entries, "Add " + added.length + " plot" + (added.length > 1 ? "s" : "") +
      " to the public library: " + added.map((a) => a.name).join(", "));
  } catch (e) {
    return json(502, { error: e.message });
  }

  // The plots are safely on GitHub now: remember their fingerprints, then clear them out of R2.
  const now = new Date().toISOString();
  let removed = 0, keptInBucket = [];
  try {
    await env.DB.batch(added.map((a) => env.DB.prepare(
      "INSERT OR REPLACE INTO library_files (name, fingerprint, size, seen) VALUES (?, ?, ?, ?)"
    ).bind(a.name, a.fingerprint, a.size, now)));
  } catch (e) { /* the next library rescan will catch up */ }
  for (const a of added) {
    try {
      await env.MY_BUCKET.delete(a.key);
      await env.DB.prepare("UPDATE uploads SET object_key = NULL WHERE id = ?").bind(a.id).run();
      removed++;
    } catch (e) { keptInBucket.push(a.name); }
  }

  return json(200, { ok: true, added: added.map((a) => a.name), skipped, removed, keptInBucket,
                     commit: commit.html_url || commit.sha });
}
