// GET /pi/file?id=N : the bytes of a job the Pi has taken.
import { jobKey } from "../_plotjobs.js";

export async function onRequestGet({ request, env }) {
  const id = parseInt(new URL(request.url).searchParams.get("id") || "", 10);
  const obj = id ? await env.MY_BUCKET.get(jobKey(id)) : null;
  if (!obj) return new Response("not found", { status: 404 });
  return new Response(obj.body, {
    headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" },
  });
}