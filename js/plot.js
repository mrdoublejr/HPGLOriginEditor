// ── plot.js ───────────────────────────────────────────────────────
// The Plot button: sends what Download would save to the plot queue
// (/admin/api/plot), where the Raspberry Pi picks it up and plots it.
// Only the site owner sees it: it appears only when /admin/api/plot answers,
// which needs the Cloudflare Access sign-in used for the admin pages.
// With Optimize off, it first checks whether the drawing goes over ink already
// there and, if so, offers to optimize it before plotting.

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
    window.__sptOwner = signedIn;          // main.js leaves the owner's own use out of the activity log
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

  // Optimize is off and the drawing goes over ink already there: ask before plotting.
  // Resolves "optimize", "asis" or "cancel".
  let dlg = null;
  function askRepeats(name, label, rep) {
    if (!dlg) {
      dlg = document.createElement("dialog");
      dlg.className = "plot-dialog";
      dlg.setAttribute("aria-labelledby", "plotDlgTitle");
      dlg.innerHTML =
        '<form method="dialog">' +
          '<h2 id="plotDlgTitle"></h2>' +
          '<p class="pd-text"></p>' +
          '<p class="pd-more"></p>' +
          '<div class="pd-actions">' +
            '<button value="cancel" class="icon-btn">Cancel</button>' +
            '<button value="asis" class="icon-btn">Plot as it is</button>' +
            '<button value="optimize" class="btn-primary" autofocus>Optimize, then plot</button>' +
          '</div>' +
        '</form>';
      document.body.appendChild(dlg);
    }
    const n = rep.lines, s = rep.stats, f = (v) => v.toLocaleString();
    dlg.querySelector("h2").textContent = "Plot " + name + " on the " + label + "?";
    dlg.querySelector(".pd-text").textContent =
      `Optimize is off, and ${f(n)} line${n === 1 ? " goes" : "s go"} over ink already drawn. ` +
      `The pen would go over ${n === 1 ? "it" : "them"} again, which takes longer and puts extra ink on the paper.`;
    const parts = [];
    if (s.dupLines) parts.push(`${f(s.dupLines)} drawn twice`);
    if (s.overlaps) parts.push(`${f(s.overlaps)} partly over another line`);
    dlg.querySelector(".pd-more").textContent =
      `${parts.join(", ")} · Optimize: pen-down lines ${f(s.before)} → ${f(s.after)}, ` +
      `pen lifts ${f(s.liftsBefore)} → ${f(s.liftsAfter)}. Checked: it draws exactly the same picture.`;
    dlg.returnValue = "cancel";
    return new Promise((ok) => {
      dlg.addEventListener("close", () => ok(dlg.returnValue || "cancel"), { once: true });
      dlg.showModal();
    });
  }

  btn.addEventListener("click", async () => {
    const target = PI_NAMES[sel.value];
    if (!target || typeof buildOutput !== "function") return;
    let o = buildOutput();
    if (!o) return;
    // Optimize off: check what it would take out (this can take a second or two on a big file).
    let rep = null;
    if (typeof pendingOptimize === "function") {
      say("Checking for repeated lines…");
      await new Promise((ok) => setTimeout(ok, 30));          // let that show before the check runs
      try { rep = pendingOptimize(); } catch (e) { rep = null; }
      say("");
    }
    if (rep) {
      const choice = await askRepeats(o.fileName, LABELS[target], rep);
      if (choice === "cancel") return;
      if (choice === "optimize") {
        document.getElementById("btnOptimize").click();       // switches it on and redraws the preview
        if (typeof lastOptimize === "undefined" || !lastOptimize || !lastOptimize.ok) {
          say("Optimize couldn't run on this file; nothing was sent", "err"); return;
        }
        o = buildOutput();
        if (!o) return;
      }
    } else if (!confirm("Plot " + o.fileName + " on the " + LABELS[target] + "?")) return;
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
