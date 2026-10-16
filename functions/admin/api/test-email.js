// POST /admin/api/test-email : sends one test notification and reports what happened,
// so the email setup can be checked from the admin page. Protected by ../_middleware.js.
import { notify, notifyReady } from "../../_notify.js";

function json(status, obj) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export async function onRequestPost({ request, env }) {
  if (!notifyReady(env)) {
    const missing = ["NOTIFY_TO", "NOTIFY_FROM", "RESEND_API_KEY"].filter((k) => !env[k]);
    return json(200, { sent: false, reason: "Missing on the Pages project: " + missing.join(", ") });
  }
  try {
    const r = await notify(env, {
      kind: "test",
      subject: "Test email",
      lines: [["What", "A test from the admin Messages page"], ["Sent", new Date().toISOString()]],
      body: "If this landed in your Spike's Pen Plotter Tools folder, notifications are working.",
      link: new URL("/admin/messages.html", request.url).href,
    });
    return json(200, r.sent ? { sent: true, to: env.NOTIFY_TO }
                            : { sent: false, reason: `Resend answered ${r.status}: ${r.detail}` });
  } catch (e) {
    return json(200, { sent: false, reason: String(e && e.message || e) });
  }
}