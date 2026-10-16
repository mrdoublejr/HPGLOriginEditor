// ── contact.js ────────────────────────────────────────────────────
// The "Contact / request a plotter" form. Sends the message to /message
// (functions/message.js), which saves it for the admin Messages page.
(function () {
  const link = document.getElementById("contactLink");
  const dlg = document.getElementById("contactDialog");
  if (!link || !dlg) return;
  const form = document.getElementById("contactForm");
  const topic = document.getElementById("cTopic");
  const plotterRow = document.getElementById("cPlotterRow");
  const statusEl = document.getElementById("cStatus");
  const sendBtn = document.getElementById("cSend");

  // The plotter field only matters for plotter requests.
  function syncTopic() { plotterRow.hidden = topic.value !== "Request a plotter"; }
  topic.addEventListener("change", syncTopic);

  // Settings the visitor has selected right now: handy for "something isn't working".
  function siteContext() {
    try {
      const p = PLOTTERS[document.getElementById("plotterSelect").value];
      const parts = [p ? p.name : ""];
      const media = document.getElementById("mediaSelect").value;
      if (media) parts.push(media);
      if (typeof currentFile !== "undefined" && currentFile) parts.push("file " + currentFile.name);
      if (typeof zoomLevel !== "undefined") parts.push("size " + Math.round(zoomLevel * 100) + "%");
      return parts.filter(Boolean).join(" · ");
    } catch (e) { return ""; }
  }

  link.addEventListener("click", (e) => {
    e.preventDefault();
    statusEl.textContent = "";
    statusEl.className = "c-status";
    sendBtn.disabled = false;
    form.hidden = false;
    syncTopic();
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute("open", "");
  });
  document.getElementById("cClose").addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });   // click outside

  const filesInput = document.getElementById("cFiles");
  const filesInfo = document.getElementById("cFilesInfo");
  const FILES_HINT = filesInfo.textContent;
  const MAX_FILES = 5, MAX_TOTAL = 25 * 1024 * 1024;
  const mb = (n) => (n / 1048576).toFixed(n < 1048576 ? 2 : 1) + " MB";
  function checkFiles() {
    const list = Array.from(filesInput.files || []);
    const total = list.reduce((n, f) => n + f.size, 0);
    if (list.length > MAX_FILES) return `Please pick ${MAX_FILES} files at most.`;
    if (total > MAX_TOTAL) return `That's ${mb(total)}; the limit is 25 MB in total.`;
    return "";
  }
  filesInput.addEventListener("change", () => {
    const list = Array.from(filesInput.files || []);
    const problem = checkFiles();
    filesInfo.textContent = problem || (list.length
      ? `${list.length} file${list.length > 1 ? "s" : ""}, ${mb(list.reduce((n, f) => n + f.size, 0))}`
      : FILES_HINT);
    filesInfo.classList.toggle("err", !!problem);
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = {
      topic: topic.value,
      plotter: plotterRow.hidden ? "" : document.getElementById("cPlotter").value,
      body: document.getElementById("cBody").value,
      name: document.getElementById("cName").value,
      email: document.getElementById("cEmail").value,
      website: document.getElementById("cWebsite").value,      // spam trap, stays empty
      context: siteContext(),
    };
    if (data.body.trim().length < 3) {
      statusEl.className = "c-status err";
      statusEl.textContent = "Please write a message.";
      return;
    }
    const fileProblem = checkFiles();
    if (fileProblem) {
      statusEl.className = "c-status err";
      statusEl.textContent = fileProblem;
      return;
    }
    // Sent as form data so the files can come along.
    const fd = new FormData();
    for (const [k, v] of Object.entries(data)) fd.append(k, v);
    const picked = Array.from(filesInput.files || []);
    for (const f of picked) fd.append("files", f, f.name);

    sendBtn.disabled = true;
    statusEl.className = "c-status";
    statusEl.textContent = picked.length ? "Sending (uploading files)…" : "Sending…";
    try {
      const r = await fetch("message", { method: "POST", body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Could not send the message.");
      form.reset();
      filesInfo.textContent = FILES_HINT;
      filesInfo.classList.remove("err");
      form.hidden = true;
      statusEl.className = "c-status ok";
      statusEl.textContent = "Thanks! Your message was sent" +
        (picked.length ? ` with ${picked.length} file${picked.length > 1 ? "s" : ""}.` : ".") +
        (data.email ? " I'll reply by email." : "");
    } catch (err) {
      sendBtn.disabled = false;
      statusEl.className = "c-status err";
      statusEl.textContent = err.message;
    }
  });
})();