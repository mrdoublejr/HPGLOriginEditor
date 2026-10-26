// ── plot.js ───────────────────────────────────────────────────────
// The Plot button: sends what Download would save to the plot queue
// (/admin/api/plot), where the Raspberry Pi picks it up and plots it.
// Only the site owner sees it: it appears only when /admin/api/plot answers,
// which needs the Cloudflare Access sign-in used for the admin pages.
// With Optimize off, it first checks whether the drawing goes over ink already
// there and, if so, offers to optimize it before plotting.
// While a job plots, it shows how far along it is (the Pi reports every few seconds,
// see functions/pi/progress.js) and a Stop button. A job that is still running when
// the page opens is picked up again.

(function () {
  // Site plotter -> the name the Pi knows it by.
  const PI_NAMES = { designjet750: "750c", hp7585b: "7585b" };
  const LABELS   = { "750c": "750C", "7585b": "7585B" };

  const btn = document.getElementById("btnPlot");
  const cutBtn = document.getElementById("btnCutSheet");
  const out = document.getElementById("plotStatus");
  const dl  = document.getElementById("btnDownload");
  const sel = document.getElementById("plotterSelect");
  if (!btn || !dl || !sel) return;

  let signedIn = false, busy = false;

  function say(text, cls) {
    out.textContent = text || "";
    out.className = "plot-status" + (cls ? " " + cls : "");
  }

  // Stop button, shown next to the status while a job is queued or plotting.
  const stopBtn = document.createElement("button");
  stopBtn.type = "button";
  stopBtn.className = "icon-btn plot-stop";
  stopBtn.textContent = "■ Stop";
  stopBtn.hidden = true;
  out.after(stopBtn);
  let watching = 0;                       // id of the job being watched
  stopBtn.addEventListener("click", async () => {
    if (!watching) return;
    if (!confirm("Stop this plot? The plotter finishes the little it already has, then lifts the pen and puts it away.")) return;
    stopBtn.disabled = true;
    try {
      await fetch("/admin/api/plot", { method: "POST", headers: { "Content-Type": "application/json" },
                                       body: JSON.stringify({ action: "stop", id: watching }) });
    } catch (e) { stopBtn.disabled = false; }
  });

  const f = (v) => Number(v).toLocaleString();
  function minutes(sec) {
    if (!isFinite(sec) || sec < 0) return "";
    if (sec < 90) return "under 2 min";
    if (sec < 3600) return Math.round(sec / 60) + " min";
    const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return h + " h " + m + " min";
  }
  // "Plotting… 41% · 31,200 of 76,209 moves · about 18 min left"
  function progressText(job) {
    if (job.moves_total) {
      const done = Math.min(job.moves, job.moves_total);
      const pct = Math.floor(100 * done / job.moves_total);
      let t = `Plotting… ${pct}% · ${f(done)} of ${f(job.moves_total)} moves`;
      if (job.elapsed > 20 && done > 0) {
        const left = job.elapsed * (job.moves_total - done) / done;
        t += ` · about ${minutes(left)} left`;
      }
      if (job.elapsed) t += ` · ${minutes(job.elapsed)} so far`;
      return t;
    }
    if (job.total) return `Plotting… ${Math.floor(100 * job.sent / job.total)}% sent`;
    return "Plotting…";
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
    // Cut sheet: the 750C only, and it needs no file loaded
    if (cutBtn) {
      cutBtn.hidden = !(signedIn && target === "750c");
      cutBtn.disabled = busy;
    }
  }

  async function check() {
    let list = null;
    try {
      const r = await fetch("/admin/api/plot", { cache: "no-store", redirect: "manual" });
      signedIn = r.ok && (r.headers.get("Content-Type") || "").includes("json");
      if (signedIn) list = await r.json();
    } catch (e) { signedIn = false; }
    window.__sptOwner = signedIn;          // main.js leaves the owner's own use out of the activity log
    refresh();
    // a job still waiting or plotting (from before this page was opened): show it again
    const live = list && (list.jobs || []).find((j) => ["queued", "sending", "stopping"].includes(j.status));
    // (the Plot button stays usable: a new job just waits its turn behind this one)
    if (live && !watching) {
      say("Plot " + (live.name || "") + ": checking…");
      await poll(live.id);
    }
  }

  let watchSeq = 0;                       // a newer job takes over the status line from an older one
  async function poll(id) {
    const mine = ++watchSeq;
    watching = id;
    stopBtn.hidden = false; stopBtn.disabled = false;
    try {
      const started = Date.now();
      while (Date.now() - started < 12 * 60 * 60 * 1000) {   // give up watching after 12 hours
        await new Promise((ok) => setTimeout(ok, 3000));
        if (mine !== watchSeq) return;
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
          const quiet = job.progress_at ? secondsSince(job.progress_at) : 0;
          if (quiet > 60) say(progressText(job) + ` · no word from the Pi for ${minutes(quiet)}`, "warn");
          else say(progressText(job));
        } else if (job.status === "stopping") {
          say("Stopping… (the plotter finishes what it already has, then lifts the pen)", "warn");
          stopBtn.disabled = true;
        } else if (job.status === "done") {
          say("Plotted ✓" + (job.elapsed ? " in " + minutes(job.elapsed) : ""), "ok"); return;
        } else if (job.status === "failed") {
          say("Failed: " + (job.message || "unknown error"), "err"); return;
        } else if (job.status === "cancelled") {
          say(job.message ? "Stopped: " + job.message : "Cancelled"); return;
        }
      }
      say("Still not finished; check the Pi");
    } finally {
      if (mine === watchSeq) { watching = 0; stopBtn.hidden = true; }
    }
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

  // Sends a job to the queue and watches it.
  async function sendJob(target, name, text) {
    busy = true; refresh(); say("Sending…");
    try {
      const r = await fetch("/admin/api/plot", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plotter: target, name, text }),
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
  }

  // ✂ Cut sheet (750C): one blank sheet of the selected size, e.g. the largest the
  // 7585B takes. A page with nothing on it may not be fed at all, so it gets four small
  // corner marks at the edges of the plot area (3 mm, pointing inward); with the 750C's
  // Page Format on "Inked area", the sheet comes out at the full size and is cut.
  if (cutBtn) cutBtn.addEventListener("click", async () => {
    if (PI_NAMES[sel.value] !== "750c" || typeof plotAreaPU !== "function") return;
    const mediaName = mediaSelect.value;
    if (!confirm("Cut one blank sheet (" + mediaName + ") on the 750C? It gets small corner marks only.")) return;
    const a = plotAreaPU();
    const t = 3 * 40;                                // 3 mm in plotter units
    const R = Math.round;
    const corner = (x, y, dx, dy) => `PU${R(x + dx * t)},${R(y)};PD${R(x)},${R(y)},${R(x)},${R(y + dy * t)};`;
    const text = "IN;SP1;" +
      corner(a.x1, a.y1, 1, 1) + corner(a.x2, a.y1, -1, 1) +
      corner(a.x2, a.y2, -1, -1) + corner(a.x1, a.y2, 1, -1) +
      "PU;SP0;\n";
    const name = "sheet " + mediaName.replace(/[^\w.×-]+/g, " ").trim() + ".hpgl";
    await sendJob("750c", name, text);
  });

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
    await sendJob(target, o.fileName, o.content);
  });

  sel.addEventListener("change", () => { say(""); refresh(); });
  new MutationObserver(refresh).observe(dl, { attributes: true, attributeFilter: ["disabled"] });
  check();
})();
