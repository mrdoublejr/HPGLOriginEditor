// Cloudflare Pages Function: POST /message
// Saves a visitor's message (a question, a problem report or a plotter request) in the
// D1 database bound as DB, table "messages", and any attached files (manuals, drivers,
// docs, photos, plot files) in the R2 bucket bound as MY_BUCKET, under "messages/<id>/".
// The table is created (or given its "files" column) the first time it is needed, so
// there is nothing to set up by hand.
// Read the messages and download the files on the admin page: /admin/messages.html

const LIMITS = { topic: 40, name: 100, email: 200, plotter: 120, body: 4000, context: 300 };
const TOPICS = ["Request a plotter", "Something isn't working", "Question", "Other"];
const PER_HOUR = 5;                          // most messages accepted from one visitor in an hour
const MAX_FILES = 5;                         // attachments per message
const MAX_TOTAL = 25 * 1024 * 1024;          // all attachments together (25 MB)
// Documents, pictures, archives and plot files. Programs (.exe and the like) are not
// accepted on their own; drivers can come zipped.
export const ATTACH_EXT = /\.(pdf|txt|md|rtf|doc|docx|odt|xls|xlsx|csv|htm|html|jpg|jpeg|png|gif|webp|bmp|tif|tiff|zip|7z|rar|gz|tgz|tar|lzh|hpgl|hpg|plt|hgl|bas|dmp|ini|inf|cfg)$/i;

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function sha256Hex(text) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// Trim, drop control characters (keeping line breaks in the message), cap the length.
function clean(v, max, keepLines) {
  let s = String(v == null ? "" : v);
  s = keepLines ? s.replace(/\r\n?/g, "\n").replace(/[\x00-\x09\x0b-\x1f\x7f]/g, "")
                : s.replace(/[\x00-\x1f\x7f]/g, " ");
  return s.trim().slice(0, max);
}

// A file name safe to use as part of a storage key (the real name is kept separately).
function safeName(original) {
  const name = String(original || "").split(/[\\/]/).pop();
  const m = name.match(/(\.[A-Za-z0-9]{1,5})$/);
  const ext = m ? m[1].toLowerCase() : "";
  let base = name.slice(0, name.length - ext.length)
    .replace(/[^A-Za-z0-9._-]+/g, "_").replace(/\.{2,}/g, "_").replace(/^[._-]+/, "");
  return (base.slice(0, 80) || "file") + ext;
}

export async function ensureMessagesTable(db) {
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS messages (" +
    " id INTEGER PRIMARY KEY AUTOINCREMENT," +
    " created TEXT NOT NULL DEFAULT (datetime('now'))," +
    " topic TEXT, name TEXT, email TEXT, plotter TEXT, body TEXT NOT NULL," +
    " context TEXT, visitor TEXT, is_read INTEGER NOT NULL DEFAULT 0, files TEXT)"
  ).run();
  // A table made by the first version of this form has no "files" column yet.
  try { await db.prepare("ALTER TABLE messages ADD COLUMN files TEXT").run(); } catch (e) { /* already there */ }
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.DB) {
      return json(500, { error: "The database is not connected to this site (binding DB is missing)" });
    }

    // only this site's own pages may send messages
    const origin = request.headers.get("Origin");
    if (origin && new URL(origin).host !== new URL(request.url).host) {
      return json(403, { error: "forbidden" });
    }
    const declared = parseInt(request.headers.get("Content-Length") || "", 10);
    if (declared && declared > MAX_TOTAL + 100000) {
      return json(413, { error: "The attachments are too big (25 MB in total at most)." });
    }

    // The form sends multipart form data (so files can come along); plain JSON works too.
    let data = {}, files = [];
    const type = request.headers.get("Content-Type") || "";
    try {
      if (type.includes("multipart/form-data")) {
        const form = await request.formData();
        for (const k of ["topic", "name", "email", "plotter", "body", "context", "website"]) {
          data[k] = form.get(k) || "";
        }
        files = form.getAll("files").filter((f) => f && typeof f !== "string" && f.size > 0);
      } else {
        data = await request.json();
      }
    } catch (e) {
      return json(400, { error: "bad request" });
    }

    // Spam trap: a field people never see. Bots fill it in; pretend it worked.
    if (data.website) return json(200, { ok: true });

    const topic = TOPICS.includes(data.topic) ? data.topic : "Other";
    const name = clean(data.name, LIMITS.name);
    const email = clean(data.email, LIMITS.email);
    const plotter = clean(data.plotter, LIMITS.plotter);
    const body = clean(data.body, LIMITS.body, true);
    const context = clean(data.context, LIMITS.context);

    if (body.length < 3) return json(400, { error: "Please write a message." });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json(400, { error: "That email address doesn't look right." });
    }

    // Check the attachments before saving anything.
    if (files.length > MAX_FILES) return json(400, { error: `Please attach ${MAX_FILES} files at most.` });
    const total = files.reduce((n, f) => n + f.size, 0);
    if (total > MAX_TOTAL) return json(413, { error: "The attachments are too big (25 MB in total at most)." });
    for (const f of files) {
      if (!ATTACH_EXT.test(f.name || "")) {
        return json(415, { error: `"${clean(f.name, 80)}" isn't a file type the form takes. ` +
          "Documents, pictures, plot files and .zip archives are fine (zip up drivers and programs)." });
      }
    }
    if (files.length && !env.MY_BUCKET) {
      return json(500, { error: "File storage is not connected (binding MY_BUCKET is missing)." });
    }

    await ensureMessagesTable(env.DB);

    // Flood limit per visitor. The IP address itself is never stored, only a one-way
    // hash of it, so repeat senders can be counted without keeping their address.
    const ip = request.headers.get("CF-Connecting-IP") || "";
    const visitor = (await sha256Hex("plotter-messages:" + ip)).slice(0, 16);
    const recent = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE visitor = ? AND created > datetime('now', '-1 hour')"
    ).bind(visitor).first();
    if (recent && recent.n >= PER_HOUR) {
      return json(429, { error: "Thanks! You've sent several messages already. Please try again in an hour." });
    }

    const res = await env.DB.prepare(
      "INSERT INTO messages (topic, name, email, plotter, body, context, visitor) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(topic, name, email, plotter, body, context, visitor).run();
    const id = res && res.meta && res.meta.last_row_id;

    if (files.length) {
      const saved = [];
      const used = new Set();
      for (const f of files) {
        let key = "messages/" + id + "/" + safeName(f.name);
        for (let n = 2; used.has(key); n++) key = key.replace(/(\.[^.\/]*)?$/, "_" + n + "$1");
        used.add(key);
        await env.MY_BUCKET.put(key, await f.arrayBuffer(), {
          httpMetadata: { contentType: "application/octet-stream" },
        });
        saved.push({ key, name: clean(f.name, 255), size: f.size });
      }
      await env.DB.prepare("UPDATE messages SET files = ? WHERE id = ?")
        .bind(JSON.stringify(saved), id).run();
    }

    return json(200, { ok: true, files: files.length });
  } catch (e) {
    return json(500, { error: "Could not save the message. Please try again later." });
  }
}