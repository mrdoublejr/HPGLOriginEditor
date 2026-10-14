// GET /admin/api/file?id=7 : download one stored plot under its export name (Car.plt, Car1.plt ...).
import { libraryNames, exportNames } from "../_names.js";

export async function onRequestGet({ request, env }) {
  if (!env.DB || !env.MY_BUCKET) return new Response("bindings missing", { status: 500 });
  const id = parseInt(new URL(request.url).searchParams.get("id") || "", 10);
  if (!Number.isInteger(id)) return new Response("bad id", { status: 400 });

  const { results } = await env.DB.prepare(
    "SELECT id, object_key, original_name, original_filename FROM uploads ORDER BY id"
  ).all();
  const row = results.find((r) => r.id === id);
  if (!row || !row.object_key) return new Response("not found", { status: 404 });

  const obj = await env.MY_BUCKET.get(row.object_key);
  if (!obj) return new Response("file is missing from the bucket", { status: 404 });

  const name = exportNames(results, await libraryNames(request, env)).get(id);
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return new Response(obj.body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": 'attachment; filename="' + ascii + "\"; filename*=UTF-8''" + encodeURIComponent(name),
      "Cache-Control": "no-store",
    },
  });
}
