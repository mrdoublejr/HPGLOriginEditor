// Cloudflare Pages Function: POST /upload
// Saves a visitor's original plot file in the R2 bucket bound to this site as MY_BUCKET,
// and records every distinct plot in the D1 database bound as DB (table "uploads", see schema.sql).
// The database decides what counts as a duplicate, so files in the bucket keep readable names
// like  00007-steam-boat.plt  (a running number plus the visitor's file name).

const MAX_BYTES = 5 * 1024 * 1024;                       // biggest file accepted (5 MB)
const ALLOWED_EXT = /\.(hpgl|plt|hpg|txt)$/i;
// must contain at least one HPGL-looking command near the start
const LOOKS_LIKE_HPGL = /(?:^|[;\n\r\x1b])\s*(?:IN|SP|PU|PD|PA|PR|LT|VS)/i;

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function sha256Hex(buf) {
  const h = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// A file's "fingerprint": a SHA-256 of its content with all whitespace (spaces, tabs,
// line breaks) removed. So the same plot saved with different line endings or spacing
// gets the same fingerprint.
async function plotFingerprint(data) {
  const src = new Uint8Array(data);
  const keep = new Uint8Array(src.length);
  let n = 0;
  for (let i = 0; i < src.length; i++) {
    const b = src[i];
    if (b === 32 || (b >= 9 && b <= 13)) continue;
    keep[n++] = b;
  }
  return await sha256Hex(keep.slice(0, n));
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.MY_BUCKET) {
      return json(500, { error: "The R2 bucket is not connected to this site (binding MY_BUCKET is missing)" });
    }
    if (!env.DB) {
      return json(500, { error: "The database is not connected to this site (binding DB is missing)" });
    }

    // only this site's own pages may upload (browsers always send Origin on a POST)
    const origin = request.headers.get("Origin");
    if (origin && new URL(origin).host !== new URL(request.url).host) {
      return json(403, { error: "forbidden" });
    }

    // quick size check before reading the body (allow a little for the form wrapper)
    const declared = parseInt(request.headers.get("Content-Length") || "", 10);
    if (declared && declared > MAX_BYTES + 65536) {
      return json(413, { error: "file too large" });
    }

    const form = await request.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") return json(400, { error: "No file uploaded" });
    if (file.size === 0) return json(400, { error: "empty file" });
    if (file.size > MAX_BYTES) return json(413, { error: "file too large" });

    // check the file type on the visitor's own file name, then clean the name so it can't
    // contain folders or odd characters (a name made only of non-English letters, like
    // "龙.plt", becomes "upload.plt")
    const original = String(file.name || "");
    const extMatch = original.match(ALLOWED_EXT);
    if (!extMatch) return json(415, { error: "file type not accepted" });
    const ext = extMatch[0].toLowerCase();
    let base = original.slice(0, original.length - ext.length)
      .replace(/[^A-Za-z0-9._-]+/g, "_").replace(/\.{2,}/g, "_").replace(/^[._-]+/, "");
    base = base.slice(0, 70) || "upload";
    const name = base + ext;
    // the visitor's exact file name (just the file part, no control characters), kept in
    // the database so a stored plot can be given its real name again later
    const exactName = original.split(/[\\/]/).pop().replace(/[\x00-\x1f\x7f]/g, "").slice(0, 255);

    // must look like a text plot file
    const data = await file.arrayBuffer();
    const bytes = new Uint8Array(data);
    if (bytes.indexOf(0) !== -1) return json(415, { error: "does not look like a plot file" });
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 200000));
    if (!LOOKS_LIKE_HPGL.test(head)) return json(415, { error: "does not look like a plot file" });

    // ask the database whether we have seen this plot before
    const fingerprint = await plotFingerprint(data);
    const now = new Date().toISOString();

    const added = await env.DB.prepare(
      "INSERT OR IGNORE INTO uploads (fingerprint, original_name, original_filename, size, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(fingerprint, name, exactName, data.byteLength, now, now).run();

    if (!added.meta.changes) {
      // already known: just count it
      await env.DB.prepare(
        "UPDATE uploads SET times_seen = times_seen + 1, last_seen = ? WHERE fingerprint = ?"
      ).bind(now, fingerprint).run();
      return json(200, { success: true, status: "duplicate" });
    }

    // new plot: name the file after its database number, then store it
    const id = added.meta.last_row_id;
    const key = String(id).padStart(5, "0") + "-" + name;
    try {
      await env.DB.prepare("UPDATE uploads SET object_key = ? WHERE id = ?").bind(key, id).run();
      await env.MY_BUCKET.put(key, data, {
        httpMetadata: { contentType: "text/plain" },
        customMetadata: { originalName: name, received: now },
      });
    } catch (err) {
      // storing failed, so forget the database row (the plot can be sent again later)
      await env.DB.prepare("DELETE FROM uploads WHERE id = ?").bind(id).run();
      throw err;
    }
    return json(200, { success: true, status: "ok", filename: key });
  } catch (error) {
    return json(500, { error: error.message });
  }
}