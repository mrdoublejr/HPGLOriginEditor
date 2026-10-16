// Email notifications for the site owner (new contact messages, new uploaded plots).
// Sent through Resend (resend.com, free plan: 3,000 emails a month, 100 a day).
// Cloudflare's own Email Sending needs the Workers Paid plan.
//
// Every email:
//   - subject starts with "[PlotterCorrector]"
//   - comes from "PlotterCorrector <NOTIFY_FROM>"
//   - carries the header  X-PlotterCorrector: message | plot
// so a mail filter can move them all into their own folder.
//
// Needs these on the Pages project (Settings > Variables and Secrets). If any is missing,
// nothing is sent and the site carries on as normal:
//   NOTIFY_TO       where to send them (your own email address)
//   NOTIFY_FROM     sender on your domain verified at Resend, e.g. notify@spikepenplottertools.com
//   RESEND_API_KEY  the API key from Resend                        (add as a Secret)

const TAG = "[PlotterCorrector]";

export function notifyReady(env) {
  return !!(env.NOTIFY_TO && env.NOTIFY_FROM && env.RESEND_API_KEY);
}

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// kind: "message" | "plot" | "test"; lines: [label, value] pairs; link: admin page URL;
// replyTo: the visitor's email, so pressing Reply in your mail answers them directly
export async function notify(env, { kind, subject, lines, body, link, replyTo }) {
  if (!notifyReady(env)) return { sent: false, reason: "not set up" };
  const rows = (lines || []).filter(([, v]) => v !== undefined && v !== null && v !== "");
  const text = rows.map(([k, v]) => `${k}: ${v}`).join("\n") +
    (body ? "\n\n" + body : "") + (link ? "\n\nOpen: " + link : "") +
    "\n\n-- \nSent by the PlotterCorrector site.";
  const html =
    `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.45">` +
    `<table style="border-collapse:collapse">` +
    rows.map(([k, v]) => `<tr><td style="color:#666;padding:2px 12px 2px 0;vertical-align:top">${esc(k)}</td>` +
      `<td style="padding:2px 0">${esc(v)}</td></tr>`).join("") + `</table>` +
    (body ? `<p style="white-space:pre-wrap;border-left:3px solid #ccd;padding-left:10px">${esc(body)}</p>` : "") +
    (link ? `<p><a href="${esc(link)}">Open the admin page</a></p>` : "") +
    `<p style="color:#999;font-size:12px">Sent by the PlotterCorrector site.</p></div>`;

  const mail = {
    from: `PlotterCorrector <${env.NOTIFY_FROM}>`,
    to: [env.NOTIFY_TO],
    subject: `${TAG} ${subject}`.slice(0, 200),
    text, html,
    headers: { "X-PlotterCorrector": kind },
  };
  if (replyTo && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyTo)) mail.reply_to = replyTo;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(mail),
  });
  let detail = "";
  try { detail = JSON.stringify(await res.json()); } catch (e) { /* no body */ }
  if (!res.ok) console.log("PlotterCorrector notify failed:", res.status, detail);
  return { sent: res.ok, status: res.status, detail };
}

// Run a notification in the background so the visitor never waits for it, and so a
// failed email can never break saving a message or a plot.
export function notifyLater(context, payload) {
  const job = notify(context.env, payload).catch((e) => console.log("PlotterCorrector notify error:", e));
  if (typeof context.waitUntil === "function") context.waitUntil(job);
  return job;
}