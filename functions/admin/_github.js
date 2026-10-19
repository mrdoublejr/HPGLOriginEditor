// Shared GitHub helpers for the admin functions (publish.js, library.js).
// No onRequest handler here, so this file is not a web address itself.
// Needs GITHUB_TOKEN (secret) and GITHUB_REPO (owner/name); GITHUB_BRANCH is optional (main).

export const LIB = "publicPlotLibrary";

export function githubReady(env) {
  return !!(env.GITHUB_TOKEN && env.GITHUB_REPO);
}
export const NOT_READY =
  "GitHub is not set up yet: add GITHUB_TOKEN (secret) and GITHUB_REPO (e.g. mrdoublejr/HPGLOriginEditor) to the Pages project's variables, then redeploy.";

export function github(env) {
  const repo = env.GITHUB_REPO, branch = env.GITHUB_BRANCH || "main";
  async function gh(path, opts = {}) {
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
  }

  // the library's index.json as it is on GitHub now ({ publicPlotLibrary: [] } if missing)
  async function readIndex() {
    try {
      const f = await gh("/contents/" + LIB + "/index.json?ref=" + encodeURIComponent(branch));
      const bin = atob(f.content.replace(/\s/g, ""));
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const j = JSON.parse(new TextDecoder().decode(bytes));
      if (!Array.isArray(j.publicPlotLibrary)) j.publicPlotLibrary = [];
      return j;
    } catch (e) {
      return { publicPlotLibrary: [] };
    }
  }

  // index.json written the same way js/build-publicPlotLibrary-index.js writes it
  function indexText(index) {
    index.publicPlotLibrary.sort((a, b) =>
      String(a.file).split("/").pop().localeCompare(String(b.file).split("/").pop(), undefined, { numeric: true }));
    return JSON.stringify(index, null, 2) + "\n";
  }

  // One commit on the branch: tree entries are { path, sha } (sha null deletes the file)
  async function commit(entries, message) {
    const ref = await gh("/git/ref/heads/" + encodeURIComponent(branch));
    const headSha = ref.object.sha;
    const head = await gh("/git/commits/" + headSha);
    const tree = await gh("/git/trees", { method: "POST", body: JSON.stringify({
      base_tree: head.tree.sha,
      tree: entries.map((e) => ({ path: e.path, mode: "100644", type: "blob", sha: e.sha })),
    }) });
    const c = await gh("/git/commits", { method: "POST", body: JSON.stringify({ message, tree: tree.sha, parents: [headSha] }) });
    await gh("/git/refs/heads/" + encodeURIComponent(branch), { method: "PATCH", body: JSON.stringify({ sha: c.sha }) });
    return c;
  }

  async function blob(content, encoding) {
    return gh("/git/blobs", { method: "POST", body: JSON.stringify({ content, encoding }) });
  }

  return { gh, branch, readIndex, indexText, commit, blob };
}

export function base64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
