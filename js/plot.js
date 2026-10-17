// ── plot.js ───────────────────────────────────────────────────────
// The Plot button: sends what Download would save to the plot queue
// (/admin/api/plot), where the Raspberry Pi picks it up and plots it.
// Only the site owner sees it: it appears only when /admin/api/plot answers,
// which needs the Cloudflare Access sign-in used for the admin pages.

(function () {
  // Site plotter -> the name the Pi knows it by.
  const PI_NAMES = { designjet750: "750c", hp7585b: "7585b" };
  const LABELS   = { "750c": "750C", "7585b": "7585B" };

  const btn = document.getElementById("btnPlot");
  const out = document.getElementById("plotStatus");
  const dl  = document.getElementById("btnDownload");
  const sel = document.getElementById("plotterSelect");
  if (!btn || !dl || !sel) return;

  let signedIn = false, busy = false;

  function say(text, cls) {
    out.textContent = text || "";
    out.className = "plot-status" + (cls ? " " + cls : "");
  }

  // UTC "YYYY-MM-DD HH:MM:SS" from the database -> seconds ago
  function secondsSince(s) {
    const t = Date.parse(String(s || "").replace(" ", "T") + "Z");
    return isNaN(t) ? Infinity : (Date.now() - t) / 1000;
  }

  function refresh() {
    const target = PI_NAMES[sel.value];
    btn.hidden = !(signedIn && target);
    btn.disabled = busy || dl.disabled;
    if (target) btn.textContent = "🖨 Plot on " + LABELS[target];
  }

  async function check() {
    try {
      const r = await fetch("/admin/api/plot", { cache: "no-store", redirect: "manual" });
      signedIn = r.ok && (r.headers.get("Content-Type") || "").includes("json");
    } catch (e) { signedIn = false; }
    refresh();
  }

  async function poll(id) {
    const started = Date.now();
    while (Date.now() - started < 60 * 60 * 1000) {        // give up watching after an hour
      await new Promise((ok) => setTimeout(ok, 3000));
      let j;
      try {
        const r = await fetch("/admin/api/plot?id=" + id, { cache: "no-store" });
        if (!r.ok) continue;
        j = await r.json();
      } catch (e) { continue; }
      const job = j.job, piAway = secondsSince(j.piSeen) > 60;
      if (job.status === "queued") {
        say(piAway ? "Waiting: the Pi hasn't checked in for a while (is it on?)" : "Queued…", piAway ? "warn" : "");
      } else if (job.status === "sending") {
        say("Plotting…");
      } else if (job.status === "done") {
        say("Sent to the plotter ✓", "ok"); return;
      } else if (job.status === "failed") {
        say("Failed: " + (job.message || "unknown error"), "err"); return;
      } else if (job.status === "cancelled") {
        say("Cancelled"); return;
      }
    }
    say("Still not finished; check the admin page");
  }

  btn.addEventListener("click", async () => {
    const target = PI_NAMES[sel.value];
    if (!target || typeof buildOutput !== "function") return;
    const o = buildOutput();
    if (!o) return;
    if (!confirm("Plot " + o.fileName + " on the " + LABELS[target] + "?")) return;
    busy = true; refresh(); say("Sending…");
    try {
      const r = await fetch("/admin/api/plot", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plotter: target, name: o.fileName, text: o.content }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { say("Couldn't queue it: " + (j.error || r.status), "err"); return; }
      say("Queued…");
      await poll(j.id);
    } catch (e) {
      say("Couldn't queue it: " + e.message, "err");
    } finally {
      busy = false; refresh();
    }
  });

  sel.addEventListener("change", () => { say(""); refresh(); });
  new MutationObserver(refresh).observe(dl, { attributes: true, attributeFilter: ["disabled"] });
  check();
})();