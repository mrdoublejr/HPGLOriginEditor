// POST /admin/api/sync-library  { restart: true|false }
// Reads the plot files in publicPlotLibrary/ and remembers each one's fingerprint in the
// library_files table, a few files per call (so no single call runs long). The admin page calls
// this repeatedly until "remaining" is 0. After that, list.js can tell which uploads are
// already in the library by content.
import { libraryFileNames } from "../_names.js";
import { plotFingerprint } from "../_fingerprint.js";

const BATCH = 6;

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json(500, { error: "database binding DB is missing" });

  const origin = request.headers.get("Origin");
  if (!origin || new URL(origin).host !== new URL(request.url).host) {
    return json(403, { error: "forbidden" });
  }
  let body = {};
  try { body = await request.json(); } catch (e) { /* no body is fine */ }

  const names = await libraryFileNames(request, env);
  if (!names.length) return json(200, { total: 0, remaining: 0, scanned: 0, failed: [] });

  // forget files that are no longer in the library (or everything, on a full rescan)
  if (body.restart) {
    await env.DB.prepare("DELETE FROM library_files").run();
  } else {
    const have = (await env.DB.prepare("SELECT name FROM library_files").all()).results.map((r) => r.name);
    const gone = have.filter((n) => !names.includes(n));
    if (gone.length) {
      await env.DB.batch(gone.map((n) => env.DB.prepare("DELETE FROM library_files WHERE name = ?").bind(n)));
    }
  }

  const have = new Set((await env.DB.prepare("SELECT name FROM library_files").all()).results.map((r) => r.name));
  const todo = names.filter((n) => !have.has(n));
  const failedBefore = Array.isArray(body.skip) ? new Set(body.skip) : new Set();
  const batch = todo.filter((n) => !failedBefore.has(n)).slice(0, BATCH);

  const failed = [];
  const now = new Date().toISOString();
  for (const name of batch) {
    try {
      const r = await env.ASSETS.fetch(new URL("/publicPlotLibrary/" + encodeURIComponent(name), request.url));
      if (!r.ok) throw new Error("HTTP " + r.status);
      const data = await r.arrayBuffer();
      const head = new TextDecoder("latin1").decode(new Uint8Array(data).subarray(0, 64));
      if (/^\s*<(!doctype|html)/i.test(head)) throw new Error("not a plot file");
      const fp = await plotFingerprint(data);
      await env.DB.prepare(
        "INSERT OR REPLACE INTO library_files (name, fingerprint, size, seen) VALUES (?, ?, ?, ?)"
      ).bind(name, fp, data.byteLength, now).run();
    } catch (e) {
      failed.push(name);
    }
  }

  const left = todo.filter((n) => !batch.includes(n) && !failedBefore.has(n)).length;
  return json(200, {
    total: names.length,
    scanned: have.size + (batch.length - failed.length),
    remaining: left,
    failed,
  });
}
