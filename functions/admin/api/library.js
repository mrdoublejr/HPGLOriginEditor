// The public library on GitHub, for the admin page.
// GET  /admin/api/library               : every plot file in publicPlotLibrary/ on GitHub now
//                                         (including ones added since the site last rebuilt)
// POST /admin/api/library  { delete: ["Car1.plt", ...] }
//                                       : removes those files and their index.json entries
//                                         in ONE commit; the site rebuilds itself afterwards
// Uses the same GITHUB_TOKEN / GITHUB_REPO settings as publish.js.
// Protected by ../_middleware.js (Cloudflare Access), like the rest of /admin/.
import { LIB, github, githubReady, NOT_READY } from "../_github.js";

const EXT = /\.(hpgl|plt|hpg)$/i;

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function onRequestGet({ env }) {
  if (!githubReady(env)) return json(500, { error: NOT_READY });
  try {
    const g = github(env);
    const list = await g.gh("/contents/" + LIB + "?ref=" + encodeURIComponent(g.branch));
    const files = list.filter((f) => f.type === "file" && EXT.test(f.name))
      .map((f) => ({ name: f.name, size: f.size, url: f.download_url }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return json(200, { files });
  } catch (e) {
    return json(502, { error: e.message });
  }
}

export async function onRequestPost({ request, env }) {
  if (!githubReady(env)) return json(500, { error: NOT_READY });
  const origin = request.headers.get("Origin");
  if (!origin || new URL(origin).host !== new URL(request.url).host) return json(403, { error: "forbidden" });

  let body;
  try { body = await request.json(); } catch (e) { return json(400, { error: "bad request" }); }
  // plain file names only: nothing outside the library folder can be touched
  const names = [...new Set((body.delete || []).map(String))]
    .filter((n) => n && EXT.test(n) && !/[\/\\]|^\.\.?$/.test(n));
  if (!names.length) return json(400, { error: "nothing selected" });

  try {
    const g = github(env);
    const list = await g.gh("/contents/" + LIB + "?ref=" + encodeURIComponent(g.branch));
    const present = new Set(list.filter((f) => f.type === "file").map((f) => f.name));
    const gone = names.filter((n) => present.has(n));
    if (!gone.length) return json(400, { error: "those files are not in the library" });

    const index = await g.readIndex();
    const drop = new Set(gone.map((n) => LIB + "/" + n));
    index.publicPlotLibrary = index.publicPlotLibrary.filter((x) => !drop.has(String(x.file)));
    const idx = await g.blob(g.indexText(index), "utf-8");

    const entries = gone.map((n) => ({ path: LIB + "/" + n, sha: null }));
    entries.push({ path: LIB + "/index.json", sha: idx.sha });
    const c = await g.commit(entries, "Remove " + gone.length + " plot" + (gone.length > 1 ? "s" : "") +
      " from the public library: " + gone.join(", "));

    if (env.DB) {
      try { await env.DB.batch(gone.map((n) => env.DB.prepare("DELETE FROM library_files WHERE name = ?").bind(n))); }
      catch (e) { /* the next library rescan will catch up */ }
    }
    return json(200, { ok: true, deleted: gone, commit: c.html_url || c.sha });
  } catch (e) {
    return json(502, { error: e.message });
  }
}
