// POST /admin/api/publish   { ids: [3, 7, 12] }
// Adds the chosen uploads to the public library in ONE GitHub commit:
//   - each plot file goes into publicPlotLibrary/ under its export name (Car.plt, Car1.plt ...)
//   - publicPlotLibrary/index.json gets an entry for each, kept in the same order and format
//     as js/build-publicPlotLibrary-index.js writes it (titles/notes you typed are kept)
// Cloudflare Pages then rebuilds the site from GitHub by itself, a minute or two later.
// The library window draws its thumbnails from the plot files, so nothing else is needed.
//
// Setup (Pages project > Settings > Variables and secrets):
//   GITHUB_TOKEN  (secret) a fine-grained GitHub token for this one repository with
//                 "Contents: Read and write" permission
//   GITHUB_REPO   (text)   owner/name, e.g. mrdoublejr/HPGLOriginEditor
//   GITHUB_BRANCH (text)   optional, defaults to main
// Protected by ../_middleware.js (Cloudflare Access), like the rest of /admin/.
import { libraryNames, exportNames, cleanExportName } from "../_names.js";

const LIB = "publicPlotLibrary";

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function b64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(text) {
  const bin = atob(text.replace(/\s/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(out);
}

export async function onRequestPost({ request, env }) {
  if (!env.DB || !env.MY_BUCKET) return json(500, { error: "database or bucket binding is missing" });
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    return json(500, { error: "GitHub is not set up yet: add GITHUB_TOKEN (secret) and GITHUB_REPO (e.g. mrdoublejr/HPGLOriginEditor) to the Pages project's variables, then redeploy." });
  }
  const origin = request.headers.get("Origin");
  if (!origin || new URL(origin).host !== new URL(request.url).host) return json(403, { error: "forbidden" });

  let body;
  try { body = await request.json(); } catch (e) { return json(400, { error: "bad request" }); }
  const ids = [...new Set((body.ids || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return json(400, { error: "nothing selected" });

  const repo = env.GITHUB_REPO, branch = env.GITHUB_BRANCH || "main";
  const gh = async (path, opts = {}) => {
    const r = await fetch("https://api.github.com/repos/" + repo + path, {
      ...opts,
      headers: {
        "Authorization": "Bearer " + env.GITHUB_TOKEN,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "spikes-pen-plotter-tools",
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error("GitHub " + (opts.method || "GET") + " " + path + " → " + r.status + " " + t.slice(0, 200));
    }
    return r.json();
  };

  try {
    // names: the same export names the admin list shows, with .txt sent as .plt
    const { results } = await env.DB.prepare(
      "SELECT id, object_key, original_name, original_filename, fingerprint FROM uploads ORDER BY id"
    ).all();
    const lib = await libraryNames(request, env);
    const names = exportNames(results, lib);
    const taken = new Set(lib);

    // the library as it is on GitHub right now
    const ref = await gh("/git/ref/heads/" + encodeURIComponent(branch));
    const headSha = ref.object.sha;
    const head = await gh("/git/commits/" + headSha);
    let index = { publicPlotLibrary: [] };
    try {
      const f = await gh("/contents/" + LIB + "/index.json?ref=" + encodeURIComponent(branch));
      index = JSON.parse(unb64(f.content));
      if (!Array.isArray(index.publicPlotLibrary)) index.publicPlotLibrary = [];
    } catch (e) { /* no index.json yet: start one */ }
    for (const x of index.publicPlotLibrary) {
      const n = String(x.file || "").split("/").pop();
      if (n) taken.add(n.toLowerCase());
    }

    const tree = [], added = [], skipped = [];
    for (const id of ids) {
      const row = results.find((r) => r.id === id);
      if (!row || !row.object_key) { skipped.push({ id, why: "not found" }); continue; }
      let name = names.get(id) || cleanExportName(row);
      if (/\.txt$/i.test(name)) name = name.replace(/\.txt$/i, ".plt");
      // still free? (the library may have changed since the list was made)
      const dot = name.lastIndexOf(".");
      const base = name.slice(0, dot), ext = name.slice(dot);
      let n = 0, finalName = name;
      while (taken.has(finalName.toLowerCase())) { n++; finalName = base + n + ext; }
      taken.add(finalName.toLowerCase());

      const obj = await env.MY_BUCKET.get(row.object_key);
      if (!obj) { skipped.push({ id, why: "file missing from the bucket" }); continue; }
      const bytes = new Uint8Array(await obj.arrayBuffer());
      const blob = await gh("/git/blobs", { method: "POST", body: JSON.stringify({ content: b64(bytes), encoding: "base64" }) });
      tree.push({ path: LIB + "/" + finalName, mode: "100644", type: "blob", sha: blob.sha });
      index.publicPlotLibrary.push({ file: LIB + "/" + finalName, size: bytes.length });
      added.push({ id, name: finalName, fingerprint: row.fingerprint, size: bytes.length });
    }
    if (!added.length) return json(400, { error: "nothing could be added", skipped });

    // index.json: same order and layout as build-publicPlotLibrary-index.js
    index.publicPlotLibrary.sort((a, b) =>
      String(a.file).split("/").pop().localeCompare(String(b.file).split("/").pop(), undefined, { numeric: true }));
    const indexBlob = await gh("/git/blobs", { method: "POST",
      body: JSON.stringify({ content: JSON.stringify(index, null, 2) + "\n", encoding: "utf-8" }) });
    tree.push({ path: LIB + "/index.json", mode: "100644", type: "blob", sha: indexBlob.sha });

    const newTree = await gh("/git/trees", { method: "POST", body: JSON.stringify({ base_tree: head.tree.sha, tree }) });
    const message = "Add " + added.length + " plot" + (added.length > 1 ? "s" : "") + " to the public library: " +
      added.map((a) => a.name).join(", ");
    const commit = await gh("/git/commits", { method: "POST",
      body: JSON.stringify({ message, tree: newTree.sha, parents: [headSha] }) });
    await gh("/git/refs/heads/" + encodeURIComponent(branch), { method: "PATCH", body: JSON.stringify({ sha: commit.sha }) });

    // remember their fingerprints now, so the admin list shows them as "in the library" straight away
    try {
      const now = new Date().toISOString();
      await env.DB.batch(added.map((a) => env.DB.prepare(
        "INSERT OR REPLACE INTO library_files (name, fingerprint, size, seen) VALUES (?, ?, ?, ?)"
      ).bind(a.name, a.fingerprint, a.size, now)));
    } catch (e) { /* the next library rescan will catch up */ }

    return json(200, { ok: true, added: added.map((a) => a.name), skipped, commit: commit.html_url || commit.sha });
  } catch (e) {
    return json(502, { error: e.message });
  }
}
