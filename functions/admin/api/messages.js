// GET  /admin/api/messages            : every message visitors sent, newest first.
// GET  /admin/api/messages?file=KEY   : download one file attached to a message.
// POST /admin/api/messages            : {id, action: "read" | "unread" | "delete"}
//                                       (delete also removes the message's attached files)
// Protected by ../_middleware.js (Cloudflare Access), like the rest of /admin/.
import { ensureMessagesTable } from "../../message.js";

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function fileList(row) {
  try { return JSON.parse(row.files || "[]"); } catch (e) { return []; }
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json(500, { error: "database binding DB is missing" });
  await ensureMessagesTable(env.DB);

  const key = new URL(request.url).searchParams.get("file");
  if (key) {
    if (!env.MY_BUCKET) return new Response("bucket binding MY_BUCKET is missing", { status: 500 });
    const m = key.match(/^messages\/(\d+)\//);
    if (!m) return new Response("bad file", { status: 400 });
    const row = await env.DB.prepare("SELECT files FROM messages WHERE id = ?").bind(+m[1]).first();
    const entry = row && fileList(row).find((f) => f.key === key);
    if (!entry) return new Response("not found", { status: 404 });
    const obj = await env.MY_BUCKET.get(key);
    if (!obj) return new Response("file is missing from the bucket", { status: 404 });
    const name = entry.name || key.split("/").pop();
    const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    return new Response(obj.body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="' + ascii + "\"; filename*=UTF-8''" + encodeURIComponent(name),
        "Cache-Control": "no-store",
      },
    });
  }

  const { results } = await env.DB.prepare(
    "SELECT id, created, topic, name, email, plotter, body, context, is_read, files FROM messages ORDER BY id DESC"
  ).all();
  return json(200, { rows: results.map((r) => ({ ...r, files: fileList(r) })) });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json(500, { error: "database binding DB is missing" });
  let data;
  try { data = await request.json(); } catch (e) { return json(400, { error: "bad request" }); }
  const id = parseInt(data.id, 10);
  if (!id) return json(400, { error: "no message id" });
  await ensureMessagesTable(env.DB);
  if (data.action === "read" || data.action === "unread") {
    await env.DB.prepare("UPDATE messages SET is_read = ? WHERE id = ?")
      .bind(data.action === "read" ? 1 : 0, id).run();
  } else if (data.action === "delete") {
    const row = await env.DB.prepare("SELECT files FROM messages WHERE id = ?").bind(id).first();
    const keys = row ? fileList(row).map((f) => f.key) : [];
    if (keys.length && env.MY_BUCKET) await env.MY_BUCKET.delete(keys);
    await env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(id).run();
  } else {
    return json(400, { error: "unknown action" });
  }
  return json(200, { ok: true });
}