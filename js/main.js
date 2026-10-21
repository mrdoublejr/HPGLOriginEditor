// ── main.js ───────────────────────────────────────────────────────
// Boot, event wiring, dropdown population, and top-level actions.

// Highest zoom allowed, as a multiple (50 = 5000%). Raise it if you need more.
const ZOOM_LIMIT = 50;

// Flip state (mirror the corrected drawing). Reset every time a file is loaded.
let btnFlipH = null, btnFlipV = null;
let btnRepeats = null, btnOptimize = null, optStatsEl = null;
let showRepeats = true;        // orange/red marks on repeated lines (corrected preview)
let optimizeOn = false;        // run optimizeHPGL on the corrected drawing
let lastOptimize = null;       // result of the last optimize run, for the note
let optCache = { key: null, result: null };
let skipPens = new Set();      // pens unticked with the pen chips
let penTarget = "1";           // where switched-off pens draw: a pen number, or "off" for not at all
let usedPens = [];             // pens the loaded drawing actually uses
let lastPenWarnings = [];      // things leaving pens out could not take away
let correctedFullBase = null;  // corrected drawing with every pen, before pens are left out
let fullBoxCache = { key: null, box: null };
let penChipsEl = null, penGroupEl = null, penTargetEl = null;
let flipH = false, flipV = false;

// Consent checkbox — controls whether the file gets uploaded to R2.
let uploadConsent = null;

// How many coordinates the last output clamped to 0 (shown in the status line).
let lastNegativeClamped = 0;
let lastScalingUnresolved = false;   // file uses SC without IP (see resolveScaling)
let lastPensMerged = 0;           // pen changes turned into pen 1 for a one-pen plotter
let alertsEl = null;              // the box of important notes above the corrected preview
let shownAlerts = "";            // what it showed last time, so it only flashes for something new
let lastRotationCleared = 0;     // the file's own RO rotation, set back to 0 (see correctHPGL)

function boot() {
  try {
    loadingMessage.style.display = "none";
    appContainer.style.display = "grid";

    dropZone         = document.getElementById("dropZone");
    fileInput        = document.getElementById("fileInput");
    fileInfo         = document.getElementById("fileInfo");
    fileNameEl       = document.getElementById("fileName");
    fileSizeEl       = document.getElementById("fileSize");
    bboxEl           = document.getElementById("bbox");
    plotterSelect    = document.getElementById("plotterSelect");
    hpglVersion      = document.getElementById("hpglVersion");
    mediaSelect      = document.getElementById("mediaSelect");
    plotterInfo      = document.getElementById("plotterInfo");
    btnDownload      = document.getElementById("btnDownload");
    btnResetOffset   = document.getElementById("btnResetOffset");
    offsetDisplay    = document.getElementById("offsetDisplay");
    statusEl         = document.getElementById("status");
    alertsEl         = document.getElementById("alerts");
    alertsEl.addEventListener("animationend", () => alertsEl.classList.remove("flash"));  // done flashing: stay lit
    previewOriginal  = document.getElementById("previewOriginal");
    previewCorrected = document.getElementById("previewCorrected");
    zoomPercentEl    = document.getElementById("zoomPercent");
    zoomSlider       = document.getElementById("zoomSlider");
    btnZoomIn        = document.getElementById("btnZoomIn");
    btnZoomOut       = document.getElementById("btnZoomOut");
    btnZoomReset     = document.getElementById("btnZoomReset");
    btnRotatePlus    = document.getElementById("btnRotatePlus");
    btnFlipH         = document.getElementById("btnFlipH");
    btnRepeats       = document.getElementById("btnRepeats");
    btnOptimize      = document.getElementById("btnOptimize");
    optStatsEl       = document.getElementById("optStats");
    penChipsEl       = document.getElementById("penChips");
    penGroupEl       = document.getElementById("penGroup");
    penTargetEl      = document.getElementById("penTarget");
    penTargetEl.addEventListener("change", () => { penTarget = penTargetEl.value; runCorrection(); });
    document.getElementById("btnAllPen1").addEventListener("click", () => {
      // Toggle: every pen's lines to pen 1 (black, for a colour plotter loaded with black
      // only), or back to every pen plotting in its own colour.
      if (allToPen1()) skipPens = new Set();
      else { penTarget = "1"; skipPens = new Set(usedPens.filter((n) => n !== 1)); }
      runCorrection();
    });
    btnFlipV         = document.getElementById("btnFlipV");
    uploadConsent    = document.getElementById("uploadConsent");

    // let the size slider reach the new zoom limit
    zoomSlider.max = Math.round(ZOOM_LIMIT * 100);

    plotterSelect.innerHTML = Object.entries(PLOTTERS)
      .map(([key, p]) => `<option value="${key}">${p.name}</option>`)
      .join("");

    wireEvents();
    populateForPlotter(plotterSelect.value);
  } catch (err) {
    console.error("boot() error:", err);
    if (loadingMessage) {
      loadingMessage.style.display = "block";
      loadingMessage.textContent = "Boot error: " + err.message;
      loadingMessage.style.color = "#b8801a";
    }
  }
}

function wireEvents() {
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });
  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("dragover");
  });
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    const file = e.dataTransfer.files[0];
    if (file) loadFile(file);
  });
  fileInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) loadFile(file);
  });

  plotterSelect.addEventListener("change", () => {
    populateForPlotter(plotterSelect.value);
    runCorrection();
    // log the plotter picked, once the visitor settles on one (not every step through the list)
    clearTimeout(plotterLogTimer);
    plotterLogTimer = setTimeout(() => logEvent("plotter", { file: currentFile ? currentFile.name : "" }), 2000);
  });

  hpglVersion.addEventListener("change", () => {
    updatePlotterInfo();
    resetManualOffset();
    renderOriginalPreview();
    runCorrection();
  });

  mediaSelect.addEventListener("change", () => {
    resetManualOffset();
    renderOriginalPreview();
    runCorrection();
  });

  btnResetOffset.addEventListener("click", () => {
    resetManualOffset();
    if (correctedBaseText) {
      correctedText = applyManualOffset(correctedBaseText);
      renderPreview(correctedText, plotterSelect.value, hpglVersion.value,
                    mediaSelect.value, previewCorrected, true);
      refreshStatus();
    }
  });

  // Each click / wheel tick multiplies the zoom (instead of adding to it), so
  // getting from 100% to a few thousand % takes a handful of steps.
  btnZoomIn.addEventListener("click", () => setZoom(zoomLevel * (1 + ZOOM_STEP_BTN)));
  btnZoomOut.addEventListener("click", () => setZoom(zoomLevel / (1 + ZOOM_STEP_BTN)));
  btnZoomReset.addEventListener("click", () => setZoom(1.0));
  const btnZoomFit = document.getElementById("btnZoomFit");
  if (btnZoomFit) btnZoomFit.addEventListener("click", scaleToFit);

  // Wheel-to-zoom. Scoped to the whole previewCorrected box, not just the
  // <canvas> element itself — the canvas doesn't fill 100% of the box
  // (there's padding and the info-line text below it), so during a real
  // scroll gesture the cursor drifts on and off the canvas by a pixel or
  // two, which made preventDefault() get skipped for some events mid-
  // gesture and the browser fall through to a normal page scroll for
  // those. Checking against the whole box instead of the canvas element
  // means you have to move off the box entirely to get normal scrolling
  // back.
  //
  // The actual redraw is deferred to the next animation frame rather than
  // done inline on every wheel tick, since a full canvas redraw on every
  // single event is expensive and can itself make some browsers (Firefox
  // especially) decide the page isn't responding fast enough and hand the
  // rest of a gesture off to native async scrolling.
  let zoomRenderScheduled = false;
  previewCorrected.addEventListener("wheel", (e) => {
    if (!correctedText) return;

    e.preventDefault();

    const next = e.deltaY < 0
      ? zoomLevel * (1 + ZOOM_STEP_BTN)
      : zoomLevel / (1 + ZOOM_STEP_BTN);
    zoomLevel = Math.max(ZOOM_MIN, Math.min(ZOOM_LIMIT, next));
    const pct = Math.round(zoomLevel * 100);
    zoomPercentEl.textContent = pct + "%";
    zoomSlider.value = pct;

    if (!zoomRenderScheduled) {
      zoomRenderScheduled = true;
      requestAnimationFrame(() => {
        zoomRenderScheduled = false;
        renderPreview(correctedText, plotterSelect.value, hpglVersion.value,
                      mediaSelect.value, previewCorrected, true);
        refreshStatus();
      });
    }
  }, { passive: false });

  zoomSlider.addEventListener("input", () => {
    setZoom(parseInt(zoomSlider.value, 10) / 100);
  });

  btnDownload.addEventListener("click", onDownload);

  btnRotatePlus.addEventListener("click", () => {
    // Clockwise as seen on the preview (and on the paper), as the ↻ button says.
    // correctHPGL turns by +angle anticlockwise in plotter units, and every preview
    // layout (turned or not, top-left or not) shows it the same way round, so step back.
    rotationDeg = (rotationDeg - ROTATE_STEP_DEG + 360) % 360;
    runCorrection();
  });
  btnRepeats.addEventListener("click", () => {
    showRepeats = !showRepeats;
    btnRepeats.setAttribute("aria-pressed", showRepeats ? "true" : "false");
    if (correctedText) renderPreview(correctedText, plotterSelect.value, hpglVersion.value,
                                     mediaSelect.value, previewCorrected, true);
  });
  btnOptimize.addEventListener("click", () => {
    optimizeOn = !optimizeOn;
    btnOptimize.setAttribute("aria-pressed", optimizeOn ? "true" : "false");
    runCorrection();
  });
  btnFlipH.addEventListener("click", () => {
    flipH = !flipH;
    updateFlipButtons();
    runCorrection();
  });
  btnFlipV.addEventListener("click", () => {
    flipV = !flipV;
    updateFlipButtons();
    runCorrection();
  });

  window.addEventListener("mousemove", onDragMove);
  window.addEventListener("mouseup", onDragEnd);
}

function loadFile(file) {
  currentFile = file;

  // Did this file come from the public plot library? If so, skip the
  // upload entirely. Also reset the flag so the next user-upload behaves
  // normally.
  const cameFromLibrary = window.__isPublicPlot === true;
  window.__isPublicPlot = false;

  // Only upload if the user has the "save a copy" box checked AND the
  // file didn't come from our own public library.
  if (uploadConsent && uploadConsent.checked && !cameFromLibrary) {
    uploadToR2(file);
  }
  logEvent("open", { file: file.name, size: file.size, src: cameFromLibrary ? "library" : "upload" });

  const reader = new FileReader();
  reader.onload = (e) => {
    currentText = e.target.result;
    fileNameEl.textContent = file.name;
    fileSizeEl.textContent = (file.size / 1024).toFixed(1) + " KB";
    const bbox = getBBox(currentText);
    bboxEl.textContent = bbox
      ? `X: ${bbox.minX} → ${bbox.maxX}   Y: ${bbox.minY} → ${bbox.maxY}`
      : "No coordinates found";
    fileInfo.style.display = "block";

    correctedText = null;
    correctedBaseText = null;
    correctedFullBase = null;
    skipPens = new Set();
    btnDownload.disabled = true;
    statusEl.textContent = "";
    statusEl.classList.remove("warn");
    showAlerts([]);                              // new file: its notes flash again even if they match
    resetManualOffset();
    zoomLevel = 1.0;
    zoomPercentEl.textContent = "100%";
    zoomSlider.value = 100;
    rotationDeg = 0;
    flipH = false;
    flipV = false;
    updateFlipButtons();
    // Optimize starts off for every new file, so its repeated lines show first
    // (otherwise they'd be removed before you ever saw them).
    optimizeOn = false;
    btnOptimize.setAttribute("aria-pressed", "false");

    renderOriginalPreview();
    runCorrection();
  };
  reader.readAsText(file);
}

function renderOriginalPreview() {
  if (!currentText || !mediaSelect.value) return;
  renderPreview(currentText, plotterSelect.value, hpglVersion.value,
                mediaSelect.value, previewOriginal, false);
}

function runCorrection() {
  if (!currentText) return;
  statusEl.textContent = "";
  statusEl.classList.remove("warn");

  try {
    const plotterKey = plotterSelect.value;
    const modeKey    = hpglVersion.value;
    const mediaKey   = mediaSelect.value;

    // Clamping to 0 for "no negatives" modes happens at output time, after
    // Size and drag offset, so it reflects what will actually be downloaded.
    const result = correctHPGL(currentText, plotterKey, modeKey, mediaKey,
                               rotationDeg, true);
    lastScalingUnresolved = !!result.scalingUnresolved;
    lastRotationCleared = result.rotationCleared || 0;
    correctedFullBase = (flipH || flipV)
      ? flipHPGL(result.text, flipH, flipV)
      : result.text;

    // Pens: show a chip for each pen the drawing uses, leave out the unticked ones,
    // then (one-pen plotters) turn the rest into pen 1. Positions come from the whole
    // drawing, so single-colour plots still line up with each other on paper.
    usedPens = typeof penUsage === "function" ? penUsage(correctedFullBase).pens : [];
    for (const n of [...skipPens]) if (!usedPens.includes(n)) skipPens.delete(n);
    if (penTarget === "off" && skipPens.size && skipPens.size >= usedPens.length) skipPens.clear(); // never leave out every pen
    renderPenChips();
    let penText = correctedFullBase;
    lastPenWarnings = [];
    if (skipPens.size) {
      if (penTarget === "off") {                       // leave the unticked pens out
        const f = filterPens(penText, skipPens);
        penText = f.text; lastPenWarnings = f.warnings;
      } else {                                         // send them to another pen
        penText = remapPens(penText, skipPens, +penTarget).text;
      }
    }
    const merged = mergeToPen1(penText, plotterKey);
    lastPensMerged = merged.merged;
    correctedBaseText = merged.text;
    // Optimize after flipping; offset, size and clamping are applied later, at output.
    // The result is kept so redrawing the same drawing doesn't run it again.
    lastOptimize = null;
    if (optimizeOn && typeof optimizeHPGL === "function") {
      if (optCache.key !== correctedBaseText) {
        optCache = { key: correctedBaseText, result: optimizeHPGL(correctedBaseText) };
      }
      lastOptimize = optCache.result;
      correctedBaseText = lastOptimize.text;
    }
    correctedText = applyManualOffset(correctedBaseText);

    renderPreview(correctedText, plotterKey, modeKey, mediaKey,
                  previewCorrected, true);
    showOptimizeNote();                          // after drawing: it uses the repeat count

    previewCorrected.classList.add("draggable");
    btnDownload.disabled = false;

    refreshStatus();
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
    showAlerts([]);
    correctedText = null;
    correctedBaseText = null;
    btnDownload.disabled = true;
  }
}

// ── What gets downloaded ────────────────────────────────────────
// Size (zoom) scales the drawing about its own centre, so it grows and shrinks
// in place on every plotter. The preview draws zoomedText(correctedText) and the
// downloaded file uses the same text, so they always match. At 100% the file is
// correctedText unchanged.
function outputText() {
  if (!correctedText) return null;
  let out = zoomedText(correctedText);
  lastNegativeClamped = 0;
  // Plotters with a converter (DM/PL, C64 BASIC, CGP-115) cut lines at the paper
  // edge during conversion instead, so the drawing keeps its shape.
  if (!getMode().allowNegative && !OUTPUT_FORMATS[getMode().output]) {
    // Same rule the correction used to apply: any coordinate below 0 becomes 0.
    out = mapPairs(out, (x, y, kind) => {
      if (kind !== "abs") return null;                  // relative moves: leave
      if (x < 0) { x = 0; lastNegativeClamped++; }
      if (y < 0) { y = 0; lastNegativeClamped++; }
      return [x, y];
    });
  }
  return out;
}

// Bounding box of what the pen actually draws (pen-down lines only). Pen-up
// moves, like the "PU;PA0,0;" many files end with to park the pen, are left
// out, so they don't pull the centre away from the drawing.
function drawnBBox(text) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const path of parsePenPaths(text)) {
    for (const [x, y] of path.pts) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (minX === Infinity) return getBBox(text);       // nothing drawn: fall back
  return { minX, maxX, minY, maxY, spanX: maxX - minX, spanY: maxY - minY };
}

// correctedText at the current Size, scaled about the centre of the drawing.
// Box of the whole corrected drawing, every pen included (before any are left out),
// so Size and Fit to page treat each single-colour plot the same way.
function fullDrawingBox() {
  const base = correctedFullBase || correctedBaseText;
  if (!base) return null;
  if (fullBoxCache.key !== base) fullBoxCache = { key: base, box: drawnBBox(base) };
  return fullBoxCache.box;
}

function zoomedText(text) {
  const t = zoomTransform(text);
  if (!t) return text;
  return shiftPairs(applyZoom(text, t.z), t.dx, t.dy);
}

// How zoomedText moves a point: (x, y) -> (x·z + dx, y·z + dy), give or take rounding.
// null at 100%. The preview uses it to paint repeated lines found at 100%.
function zoomTransform(text) {
  if (!text || Math.abs(zoomLevel - 1) < 1e-9) return null;
  const fb = (text === correctedText && correctedFullBase) ? fullDrawingBox() : null;
  const b = fb ? { minX: fb.minX + manualOffsetX, maxX: fb.maxX + manualOffsetX,
                   minY: fb.minY + manualOffsetY, maxY: fb.maxY + manualOffsetY }
               : drawnBBox(text);
  if (!b) return { z: zoomLevel, dx: 0, dy: 0 };
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  return { z: zoomLevel, dx: Math.round(cx * (1 - zoomLevel)), dy: Math.round(cy * (1 - zoomLevel)) };
}

// Moves absolute HP-GL coordinate pairs by (dx, dy). Label text, sizes, radii,
// angles and relative moves (PR, AR, ER, RR) are left alone.
function shiftPairs(text, dx, dy) {
  if (!text || (dx === 0 && dy === 0)) return text;
  return mapPairs(text, (x, y, kind) =>
    kind === "abs" ? [Math.round(x + dx), Math.round(y + dy)] : null);
}

// The selected plotter's plot area (inside the margins), in plotter units.
// Same layout as the dashed red box in the preview.
function plotAreaPU() {
  const p = PLOTTERS[plotterSelect.value];
  const media = p.media[mediaSelect.value];
  const origin = getMode().origin;
  const xy = pageXY(p, media);                 // the plotter's X and Y extents (see core.js)
  const W = xy.x * IN_TO_PU, H = xy.y * IN_TO_PU;
  const side = p.margins.side * PU_PER_MM, lead = p.margins.lead * PU_PER_MM,
        trail = p.margins.trail * PU_PER_MM;
  switch (origin) {
    case "center":
      return { x1: -W / 2 + side, x2: W / 2 - side, y1: -H / 2 + lead, y2: H / 2 - trail };
    case "center-x-bottom-y":
      return { x1: -W / 2 + side, x2: W / 2 - side, y1: lead, y2: H - trail };
    default:
      return { x1: side, x2: W - side, y1: lead, y2: H - trail };
  }
}

// Fit: centre the drawing in the plot area and set Size so it just fills it.
function scaleToFit() {
  if (!correctedBaseText) return;
  const b = fullDrawingBox();
  if (!b) return;
  const a = plotAreaPU();
  const z = Math.min((a.x2 - a.x1) / Math.max(1, b.spanX),
                     (a.y2 - a.y1) / Math.max(1, b.spanY)) * 0.98;   // 1% clear each side
  manualOffsetX = Math.round((a.x1 + a.x2) / 2 - (b.minX + b.maxX) / 2);
  manualOffsetY = Math.round((a.y1 + a.y2) / 2 - (b.minY + b.maxY) / 2);
  updateOffsetDisplay();
  correctedText = applyManualOffset(correctedBaseText);
  setZoom(z);
}

// Scales HP-GL about the plotter origin (0,0): points and relative moves are
// scaled, and so is a CI radius. Arc angles, label text and the numbers of other
// commands (DI, SI, SC...) are left alone.
function applyZoom(text, z) {
  if (!text || Math.abs(z - 1) < 1e-9) return text;
  const fmt = (v) => Math.round(v * z);
  const scaled = mapPairs(text, (x, y) => [fmt(x), fmt(y)]);
  const [pre, body] = splitPreamble(scaled);
  return pre + body.replace(HPGL_CMD, (m, label, op, args) => {
    if (label || op.toUpperCase() !== "CI") return m;
    let k = 0;                                          // radius only, not the chord
    return op + args.replace(HPGL_NUM, (n) => (k++ === 0 ? String(fmt(parseFloat(n))) : n));
  });
}

// Status line under the corrected preview. Describes the file that the
// Download button will save (Size and drag offset included).
function refreshStatus() {
  const out = outputText();
  if (!out) return;
  statusEl.classList.remove("warn");
  statusEl.title = "";

  const alerts = [];              // important: shown in the flashing box, not just the grey line
  const bbox = getBBox(out);
  let msg = bbox
    ? `X ${bbox.minX}→${bbox.maxX}  Y ${bbox.minY}→${bbox.maxY}`
    : "No coordinates";
  if (lastNegativeClamped > 0) {
    alerts.push(`${lastNegativeClamped} point${lastNegativeClamped !== 1 ? "s" : ""} below 0 clamped to 0 (${OUTPUT_FORMATS[getMode().output]?.name || "HP-GL/2"}): parts of the drawing may be squashed against the edge`);
  }
  if ((flipH || flipV) && FLIP_UNSUPPORTED.test(correctedBaseText)) {
    alerts.push("Arcs, circles and some other shapes were not flipped: they will plot in the wrong place");
  }

  if (lastRotationCleared) {
    alerts.push(`The file's own ${lastRotationCleared}° turn (RO${lastRotationCleared}) was removed: it plots exactly as shown here. Use Orient to turn it.`);
  }
  if (skipPens.size) {
    const list = [...skipPens].sort((a, b) => a - b).join(", ");
    msg += penTarget === "off"
      ? ` · pen${skipPens.size !== 1 ? "s" : ""} ${list} skipped`
      : ` · pen${skipPens.size !== 1 ? "s" : ""} ${list} drawn ${penTarget === "1" ? "in black" : "with pen " + penTarget}`;
  }
  if (lastPenWarnings.length) {
    alerts.push(...lastPenWarnings);
  }
  if (lastPensMerged) {
    msg += ` · ${lastPensMerged} pen change${lastPensMerged !== 1 ? "s" : ""} set to pen 1 (one-pen plotter)`;
  }

  // How much work the plotter has: pen-down moves and pen drops, and with Optimize on,
  // what they were before it. Size and drag don't change these, so they're counted on
  // the drawing before them (and kept, so dragging doesn't count again).
  const mc = moveCounts(correctedBaseText);
  if (mc) {
    const f = (v) => v.toLocaleString();
    const was = optimizeOn && lastOptimize && lastOptimize.ok ? moveCounts(optCache.key) : null;
    // Only the moves go on the line (room is short); the rest is in the hover text.
    msg += ` · ${f(mc.moves)} pen-down moves` + (was ? ` (was ${f(was.moves)})` : "");
    const left = was ? (window.__repeatCount || 0) : 0;   // only when Optimize actually ran
    statusEl.title = (statusEl.title ? statusEl.title + "\n\n" : "") +
      "Pen-down moves: every drawing step the plotter makes with the pen down.\n" +
      `Pen drops: ${f(mc.drops)}` + (was ? ` (was ${f(was.drops)})` : "") +
      ": how many times the pen is put down on the paper (and lifted again)." +
      (left ? `\nStill over ink: ${f(left)} (orange on the preview). Optimize keeps these on purpose: ` +
              "under 1 mm of overlap (quicker to draw again than to lift the pen), " +
              "or another pen drew over them in between." : "");
  }

  if (lastScalingUnresolved) {
    alerts.push("The file uses SC scaling without IP, so the plotter's own P1/P2 decide its size: check the position before plotting");
  }

  // DM/PL or C64 BASIC plotters: convert now so any problems show before downloading.
  const fmt = OUTPUT_FORMATS[getMode().output];
  if (fmt) {
    const conv = fmt.convert(out);
    msg += ` · ${fmt.name} ${conv.text.length} bytes`;
    if (conv.clipped) {
      alerts.push(`${conv.clipped} line${conv.clipped !== 1 ? "s" : ""} cut off at the paper edge`);
    }
    if (conv.warnings.length) {
      const w = conv.warnings;
      alerts.push(...w.slice(0, 4).map((t) => fmt.name + ": " + t));
      if (w.length > 4) alerts.push(`${w.length - 4} more ${fmt.name} note${w.length - 4 !== 1 ? "s" : ""} (hover the grey line under the buttons)`);
      statusEl.title = w.join("\n");
    }
  }
  statusEl.textContent = msg;
  showAlerts(alerts);
}

// Counts the plotter's work in a drawing: pen-down moves (each coordinate pair drawn
// with the pen down, and each arc or circle) and pen drops (each time the pen goes
// down after being up). The last few results are kept, keyed by the text.
const moveCountCache = new Map();
function moveCounts(text) {
  if (!text) return null;
  if (moveCountCache.has(text)) return moveCountCache.get(text);
  let down = false, moves = 0, drops = 0;
  for (const { op, args } of hpglCommands(text)) {
    if (op === "IN" || op === "DF") { down = false; continue; }
    if (op === "PU") { down = false; }
    else if (op === "PD") { if (!down) drops++; down = true; }
    if (op === "PU" || op === "PD" || op === "PA" || op === "PR") {
      if (down) moves += Math.floor((args.match(/[-+]?(?:\d+\.?\d*|\.\d+)/g) || []).length / 2);
    } else if (op === "CI" || op === "AA" || op === "AR") {
      if (op === "CI" || down) moves++;            // CI always draws; arcs only with the pen down
      if (op === "CI") drops++;
    }
  }
  const r = { moves, drops };
  if (moveCountCache.size > 6) moveCountCache.delete(moveCountCache.keys().next().value);
  moveCountCache.set(text, r);
  return r;
}

// The notes box above the corrected preview. It flashes a few times whenever a note
// appears that wasn't there before, then stays lit (amber) as long as the note applies.
function showAlerts(list) {
  if (!alertsEl) return;
  const key = list.join("\n");
  alertsEl.hidden = !list.length;
  alertsEl.textContent = "";
  for (const t of list) {
    const p = document.createElement("div");
    p.className = "alert-line";
    p.textContent = "\u26A0 " + t;
    alertsEl.appendChild(p);
  }
  if (list.length && key !== shownAlerts) {
    alertsEl.classList.remove("flash");
    void alertsEl.offsetWidth;                        // restart the animation
    alertsEl.classList.add("flash");
  }
  shownAlerts = key;
}

function populateForPlotter(plotterKey) {
  const p = PLOTTERS[plotterKey];

  hpglVersion.innerHTML = Object.entries(p.modes)
    .map(([key, m]) => `<option value="${key}">${m.label}</option>`)
    .join("");
  hpglVersion.value = p.defaultMode;
  hpglVersion.disabled = (Object.keys(p.modes).length === 1);

  mediaSelect.innerHTML = Object.keys(p.media)
    .map(m => `<option value="${m}">${m}</option>`)
    .join("");
  mediaSelect.value = p.defaultMedia;

  updatePlotterInfo();
  resetManualOffset();

  renderOriginalPreview();
}

function updatePlotterInfo() {
  const p = PLOTTERS[plotterSelect.value];
  const mode = getMode();
  plotterInfo.textContent =
    `${p.pens} pen${p.pens !== 1 ? 's' : ''} · ${describeOrigin(mode.origin)} · ` +
    `${mode.allowNegative ? "negatives allowed" : "no negatives"} · ` +
    `margin ${p.margins.side}/${p.margins.lead}mm`;
  const fmt = OUTPUT_FORMATS[mode.output];
  if (fmt) plotterInfo.textContent += ` · output ${fmt.name}`;
  // Single-pen DM/PL plotters (DMP-41/42) ignore pen changes unless Pen Pause is
  // turned on at the control panel; then they stop for a manual pen swap.
  if (mode.penPause) plotterInfo.textContent += " · colour changes need Pen Pause on";
  btnDownload.textContent = fmt ? `Download ${fmt.name}` : "Download HPGL";
  showPlotterPicture(p);
}

// ── Plotter picture ──────────────────────────────────────────────
// A plotter's optional "picture" in plotters.json is either an image (.jpg,
// .png, .gif, .webp, .svg) shown as is, or an HP-GL file (.hpgl, .hpg, .plt)
// drawn as a little plot. "pictureCaption" is shown under it (e.g. a photo
// credit). Plotters without a picture hide the box.
const PICTURE_PLOT_EXT = /\.(hpgl|hpg|plt|hgl)$/i;
const pictureTextCache = {};
let pictureRequest = 0;

function showPlotterPicture(p) {
  const fig = document.getElementById("plotterPicture");
  const img = document.getElementById("plotterPictureImg");
  const canvas = document.getElementById("plotterPictureCanvas");
  const caption = document.getElementById("plotterPictureCaption");
  if (!fig) return;
  const src = p.picture;
  const request = ++pictureRequest;
  if (!src) { fig.hidden = true; return; }

  caption.textContent = p.pictureCaption || p.name;
  fig.hidden = false;

  if (!PICTURE_PLOT_EXT.test(src)) {
    canvas.hidden = true;
    img.hidden = false;
    img.alt = p.name;
    img.onerror = () => { if (request === pictureRequest) fig.hidden = true; };
    img.src = encodeURI(src);
    return;
  }

  img.hidden = true;
  canvas.hidden = false;
  const draw = (text) => { if (request === pictureRequest) drawPicturePlot(canvas, text); };
  if (pictureTextCache[src]) { draw(pictureTextCache[src]); return; }
  fetch(encodeURI(src))
    .then(r => { if (!r.ok) throw new Error(r.status); return r.text(); })
    .then(text => { pictureTextCache[src] = text; draw(text); })
    .catch(() => { if (request === pictureRequest) fig.hidden = true; });
}

// Draws an HP-GL file's pen-down paths, fitted to the canvas, y up.
function drawPicturePlot(canvas, text) {
  const paths = parsePaths(text);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const path of paths) for (const [x, y] of path) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const cssW = canvas.parentElement.clientWidth || 300;
  const spanX = Math.max(1, maxX - minX), spanY = Math.max(1, maxY - minY);
  const pad = 8;
  const cssH = Math.min(220, Math.round((cssW - 2 * pad) * spanY / spanX) + 2 * pad);
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = cssW + "px";
  canvas.style.height = cssH + "px";
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  if (!paths.length) return;
  const sc = Math.min((cssW - 2 * pad) / spanX, (cssH - 2 * pad) / spanY);
  const ox = (cssW - spanX * sc) / 2, oy = (cssH - spanY * sc) / 2;
  ctx.strokeStyle = "#2a4fa0";
  ctx.lineWidth = 0.8;
  ctx.lineJoin = ctx.lineCap = "round";
  ctx.beginPath();
  for (const path of paths) {
    path.forEach(([x, y], i) => {
      const sx = ox + (x - minX) * sc, sy = cssH - oy - (y - minY) * sc;
      if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
    });
  }
  ctx.stroke();
}

// Plotters that don't take HP-GL. A mode's "output" key picks one of these;
// modes without one download the corrected HP-GL unchanged.
const OUTPUT_FORMATS = {
  dmpl:     { name: "DM/PL",      ext: ".dmpl", convert: (t) => convertToDmpl(t) },
  c64basic: { name: "C64 BASIC",  ext: ".bas",  convert: (t) => convertToCbm1520(t) },
  cgp115:   { name: "CGP-115",    ext: ".cgp",  convert: (t) => convertToCgp115(t) },
  tek4663:  { name: "Tek 4663",   ext: ".tek",  convert: (t) => convertToTek4663(t) },
  apple410: { name: "Apple 410",  ext: ".plt",  convert: (t) => convertToApple410(t) },
  hi80:     { name: "Epson HI-80", ext: ".plt", convert: (t) => convertToHi80(t) },
};

// Radio Shack CGP-115: a plain command stream, 0.2 mm steps like the 1520.
// Apple 410 Color Plotter: SP sets the paper size (media.sp), units are 0.1 mm.
// The page's "along" side is the plotter's X axis (paper feed).
function convertToApple410(text) {
  const p = PLOTTERS[plotterSelect.value];
  const media = p.media[mediaSelect.value];
  const W = media.across * IN_TO_PU, H = media.along * IN_TO_PU;
  return hpglToApple410(text, {
    sp: media.sp,
    pageHeight: H,
    clip: { x0: 0, x1: W, y0: 0, y1: H },
  });
}

// Epson HI-80 (plotter mode 1): 0.1 mm units from the bottom-left corner of the
// effective drawing area. Lines are cut at that area's edge (manual Table 3-1).
function convertToHi80(text) {
  const p = PLOTTERS[plotterSelect.value];
  const media = p.media[mediaSelect.value];
  return hpglToHi80(text, {
    clip: { x0: 0, x1: media.across * IN_TO_PU, y0: 0, y1: media.along * IN_TO_PU },
  });
}

// Tektronix 4663: explicit serial commands in millimetres. Lines are cut at the
// edge of the selected page (its plot area from the manual's Table 1-6).
function convertToTek4663(text) {
  const p = PLOTTERS[plotterSelect.value];
  const media = p.media[mediaSelect.value];
  return hpglToTek4663(text, {
    pens: p.pens,
    clip: { x0: 0, x1: media.across * IN_TO_PU, y0: 0, y1: media.along * IN_TO_PU },
  });
}

function convertToCgp115(text) {
  const p = PLOTTERS[plotterSelect.value];
  const mode = getMode();
  const media = p.media[mediaSelect.value];
  const spi = mode.stepsPerInch || 127;
  const maxX = Math.round(media.across * spi) - 1;
  return hpglToCgp115(text, {
    maxX,
    maxY: Math.round(media.along * spi) - 1,
    // Roll paper: cut at the left and right edges only (0.2 mm = 8 HP-GL units).
    clip: { x0: 0, x1: maxX * 8, y0: -Infinity, y1: Infinity },
  });
}

// Commodore 1520: a BASIC program for a C64/VIC-20. The step range comes from
// the selected media (plot area) size at the mode's steps per inch (0.2 mm steps).
function convertToCbm1520(text) {
  const p = PLOTTERS[plotterSelect.value];
  const mode = getMode();
  const media = p.media[mediaSelect.value];
  const spi = mode.stepsPerInch || 127;
  const maxX = Math.round(media.across * spi) - 1;
  return hpglToCbm1520(text, {
    maxX,
    maxY: Math.round(media.along * spi) - 1,
    // Roll paper: cut at the left and right edges and the 1520's ±998 step Y range.
    clip: { x0: 0, x1: maxX * 8, y0: -998 * 8, y1: 998 * 8 },
  });
}

// Converts the corrected HP-GL for a plotter whose mode says output: "dmpl".
// The plotter's step range comes from the selected media (plot area) size.
function convertToDmpl(text) {
  const p = PLOTTERS[plotterSelect.value];
  const mode = getMode();
  const media = p.media[mediaSelect.value];
  const spi = mode.stepsPerInch || 200;
  const maxX = Math.round(media.across * spi);
  const maxY = Math.round(media.along * spi);
  return hpglToDmpl(text, {
    pens: p.pens,
    stepsPerInch: spi,
    maxX,
    maxY,
    // Cut at the edges of the plot area (HP-GL units = steps × 1016 / steps-per-inch).
    clip: { x0: 0, x1: maxX * IN_TO_PU / spi, y0: 0, y1: maxY * IN_TO_PU / spi },
    textStyle: mode.textStyle || "trs80",
    preamble: media.chart ? media.chart + " " : "",   // e.g. "EF" (large chart) for the DMP-41/42
    clampPens: !mode.penPause,
  });
}

function resetManualOffset() {
  manualOffsetX = 0;
  manualOffsetY = 0;
  updateOffsetDisplay();
}

function updateOffsetDisplay() {
  if (manualOffsetX === 0 && manualOffsetY === 0) {
    offsetDisplay.textContent = "X 0, Y 0";
  } else {
    const sx = manualOffsetX >= 0 ? "+" : "";
    const sy = manualOffsetY >= 0 ? "+" : "";
    offsetDisplay.textContent =
      `X ${sx}${manualOffsetX}, Y ${sy}${manualOffsetY}`;
  }
}

// True when every pen the drawing uses is going to pen 1.
function allToPen1() {
  return penTarget === "1" && usedPens.length > 1 && usedPens.every((n) => n === 1 || skipPens.has(n));
}

// One chip per pen the drawing uses. Ticked = plotted; click to leave a pen out.
// Hidden when the drawing uses only one pen.
function renderPenChips() {
  if (!penChipsEl || !penGroupEl) return;
  penGroupEl.hidden = usedPens.length < 2;

  // "Unticked pens go to": every pen this plotter has (at least the ones the file uses), or leave out
  if (penTargetEl) {
    const pl = PLOTTERS[plotterSelect.value];
    // pens that draw: 1..pens, or 1..pens-1 when pen 0 is a real (white) pen, as on the 750C
    const most = Math.max((pl.pens || 1) - (pl.pen0 ? 1 : 0), 1);           // only pens this plotter has
    const opts = [];
    opts.push(`<option value="1">black (pen 1)</option>`);
    for (let n = 2; n <= most; n++) opts.push(`<option value="${n}">pen ${n}</option>`);
    opts.push(`<option value="off">nothing (skip them)</option>`);
    penTargetEl.innerHTML = opts.join("");
    if (penTarget !== "off" && +penTarget > most) penTarget = "1";
    penTargetEl.value = penTarget;
  }

  const allBtn = document.getElementById("btnAllPen1");
  if (allBtn) {
    const on = allToPen1();
    allBtn.setAttribute("aria-pressed", on ? "true" : "false");
    allBtn.title = on ? "Every pen draws in black: click to give each pen its own colour again"
                      : "Draw every pen in black";
  }

  penChipsEl.textContent = "";
  for (const n of usedPens) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pen-chip";
    const on = !skipPens.has(n);
    const goes = !on && penTarget !== "off" ? +penTarget : null;      // redirected to this pen
    b.setAttribute("aria-pressed", on ? "true" : "false");
    if (goes) b.classList.add("moved");
    const where = penTarget === "off" ? "skip it" : penTarget === "1" ? "draw it in black" : "draw it with pen " + penTarget;
    b.title = on ? `Pen ${n} is on: click to switch it off (${where})`
                 : goes ? `Pen ${n} is off and draws ${goes === 1 ? "in black" : "with pen " + goes}: click to switch it back on`
                        : `Pen ${n} is off and skipped: click to switch it back on`;
    const dot = document.createElement("span");
    dot.className = "pen-dot";
    dot.style.background = PEN_COLORS[goes || n] || PEN_COLORS[0];
    b.appendChild(dot);
    b.appendChild(document.createTextNode(goes ? `${n}→${goes}` : String(n)));
    b.addEventListener("click", () => {
      if (skipPens.has(n)) skipPens.delete(n);
      else if (penTarget !== "off" || skipPens.size < usedPens.length - 1) skipPens.add(n);  // never leave out every pen
      runCorrection();
    });
    penChipsEl.appendChild(b);
  }
}

// With Optimize off: what switching it on would take out of the drawing as it is now,
// or null when it's on already, would change nothing, or can't work on this file.
// Runs the optimizer itself (once; the result is kept for when Optimize is switched on),
// so the numbers are exactly what Optimize would do. Used by the Plot button (plot.js).
function pendingOptimize() {
  if (optimizeOn || !correctedBaseText || typeof optimizeHPGL !== "function") return null;
  if (optCache.key !== correctedBaseText) {
    optCache = { key: correctedBaseText, result: optimizeHPGL(correctedBaseText) };
  }
  const r = optCache.result;
  if (!r.ok) return null;
  const lines = r.stats.dupLines + r.stats.overlaps;
  return lines ? { lines, stats: r.stats } : null;
}

// The note next to the Optimize button: what it took out, or why it left the file alone.
function showOptimizeNote() {
  if (!optStatsEl) return;
  optStatsEl.classList.remove("warn", "nudge");
  btnOptimize.classList.remove("nudge");
  const o = lastOptimize;
  if (!o) {
    // Optimize is off: if the file draws lines more than once, say so, and pulse
    // the note and the Optimize button until it's switched on.
    const n = optimizeOn ? 0 : (window.__repeatCount || 0);
    optStatsEl.textContent = n
      ? `${n.toLocaleString()} line${n === 1 ? " goes" : "s go"} over ink already drawn: Optimize can take that out`
      : "";
    optStatsEl.title = n ? "Lines drawn twice, or running partly along a line already drawn (1 mm or more). " +
                           "Show repeats paints them orange/red on the preview. Optimize draws that ink once." : "";
    optStatsEl.classList.toggle("nudge", !!n);
    btnOptimize.classList.toggle("nudge", !!n);
    return;
  }
  if (!o.ok) {
    optStatsEl.textContent = "not optimized: " + o.reason;
    optStatsEl.title = "The file is used exactly as it is.";
    optStatsEl.classList.add("warn");
    return;
  }
  const t = o.stats, f = (v) => v.toLocaleString();
  const cut = t.dupLines + t.overlaps + t.dots + t.nodes;
  const travel = t.travelBefore ? Math.round(100 * (1 - t.travelAfter / t.travelBefore)) : 0;
  optStatsEl.textContent = cut || travel > 0
    ? `${f(cut)} moves removed · pen-up travel ${travel >= 0 ? "−" : "+"}${Math.abs(travel)}%`
    : "nothing to remove";
  optStatsEl.title =
    `${f(t.dupLines)} repeated lines, ${f(t.dots)} dots on ink, ${f(t.nodes)} extra nodes on straight lines\n` +
    (t.overlaps ? `${f(t.overlaps)} lines trimmed where they ran over ink already drawn ` +
                  `(${(t.overlapLen / IN_TO_PU).toFixed(1)} in of ink not drawn twice)\n` : "") +
    (t.spDropped ? `${f(t.spDropped)} pen and line-type commands left out (they repeated the one already set)\n` : "") +
    `pen-down lines ${f(t.before)} → ${f(t.after)}\n` +
    `pen lifts ${f(t.liftsBefore)} → ${f(t.liftsAfter)}\n` +
    `pen-up travel ${f(Math.round(t.travelBefore / 400))} → ${f(Math.round(t.travelAfter / 400))} in\n` +
    `Checked: draws exactly the same lines as the original.`;
}

function updateFlipButtons() {
  btnFlipH.setAttribute("aria-pressed", flipH ? "true" : "false");
  btnFlipV.setAttribute("aria-pressed", flipV ? "true" : "false");
}

// ---- flip ----------------------------------------------------------
// Mirrors the drawing about the centre of its own bounding box, so it stays
// where it is on the page. Works on the lines (PA / PR / PU / PD). Relative
// moves (PR) are rewritten as absolute (PA) moves so the mirror stays exact.
// Arcs, circles, rectangles, labels and encoded polylines are NOT flipped.
const FLIP_CMD = /(^|[;\n\r])(\s*)(PA|PR|PU|PD)([^;\n\r]*)/gi;
const FLIP_UNSUPPORTED = /(^|[;\n\r])\s*(AA|AR|CI|EA|ER|EW|RA|RR|WG|PE)/i;

function flipPairs(args) {
  const n = args.match(/[-+]?(?:\d+\.?\d*|\.\d+)/g) || [];
  const out = [];
  for (let i = 0; i + 1 < n.length; i += 2) {
    out.push([parseFloat(n[i]), parseFloat(n[i + 1])]);
  }
  return out;
}

function flipHPGL(text, doH, doV) {
  let rel = false, cx = 0, cy = 0;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;

  // pass 1: bounding box of every point the file visits
  text.replace(FLIP_CMD, (m, pre, ws, op, args) => {
    const up = op.toUpperCase();
    if (up === "PA") rel = false; else if (up === "PR") rel = true;
    for (const [px, py] of flipPairs(args)) {
      const nx = rel ? cx + px : px, ny = rel ? cy + py : py;
      cx = nx; cy = ny;
      if (nx < minX) minX = nx; if (nx > maxX) maxX = nx;
      if (ny < minY) minY = ny; if (ny > maxY) maxY = ny;
    }
    return m;
  });
  if (minX === Infinity) return text;

  // pass 2: rewrite the coordinates
  const fmt = (v) => String(Math.round(v * 1000) / 1000);
  rel = false; cx = 0; cy = 0;
  return text.replace(FLIP_CMD, (m, pre, ws, op, args) => {
    const up = op.toUpperCase();
    if (up === "PA") rel = false; else if (up === "PR") rel = true;
    const outOp = (up === "PR") ? "PA" : op;
    const pts = flipPairs(args);
    if (!pts.length) return pre + ws + outOp + args;
    const coords = [];
    for (const [px, py] of pts) {
      const nx = rel ? cx + px : px, ny = rel ? cy + py : py;
      cx = nx; cy = ny;
      coords.push(fmt(doH ? minX + maxX - nx : nx),
                  fmt(doV ? minY + maxY - ny : ny));
    }
    return pre + ws + outOp + coords.join(",");
  });
}
// ---- end flip ------------------------------------------------------

function setZoom(z) {
  zoomLevel = Math.max(ZOOM_MIN, Math.min(ZOOM_LIMIT, z));
  const pct = Math.round(zoomLevel * 100);
  zoomPercentEl.textContent = pct + "%";
  zoomSlider.value = pct;

  if (correctedText) {
    renderPreview(correctedText, plotterSelect.value, hpglVersion.value,
                  mediaSelect.value, previewCorrected, true);
    refreshStatus();
  }
}

// What Download saves (and what the Plot button sends): the corrected file at the
// current Size and offset, converted for plotters that don't take HP-GL.
function buildOutput() {
  if (!correctedText) return null;
  const base = currentFile.name.replace(/\.[^.]+$/, "");
  const mode = hpglVersion.value;

  let content = outputText();
  const kept = usedPens.filter((n) => !skipPens.has(n));
  const moved = [...skipPens].sort((a, b) => a - b);
  const penTag = !skipPens.size ? ""
    : penTarget === "off" ? "_PENS-" + kept.join("-")              // e.g. _PENS-1-3: only pens 1 and 3
    : "_PENS-" + moved.join("-") + "-TO-" + penTarget;             // e.g. _PENS-2-5-TO-1
  let fileName = base + penTag + "_CORRECTED_" + mode + ".hpgl";
  const fmt = OUTPUT_FORMATS[getMode().output];
  if (fmt) {
    content = fmt.convert(content).text;
    fileName = base + penTag + "_CORRECTED_" + mode + fmt.ext;
  }
  return { content, fileName };
}

function onDownload() {
  const out = buildOutput();
  if (!out) return;
  const blob = new Blob([out.content], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = out.fileName;
  a.click();
  URL.revokeObjectURL(a.href);
  registerMadeFile(new TextEncoder().encode(out.content), out.fileName);
  logEvent("download", { file: out.fileName, media: selectedText(mediaSelect) });
}

// ── Activity log ─────────────────────────────────────────────────
// Sends a line to /log: which file was opened or downloaded and which plotter is picked.
// Only names, sizes and settings, never the file. "visit" is a random id for this browser
// tab, so one visit's lines group together. The site owner's own use (signed in) is left out.
let plotterLogTimer = null;
const visitId = (() => {
  const make = () => Math.random().toString(36).slice(2, 12);
  try {
    let v = sessionStorage.getItem("spt-visit");
    if (!v) { v = make(); sessionStorage.setItem("spt-visit", v); }
    return v;
  } catch (e) { return make(); }
})();
function selectedText(sel) {
  return sel && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex].text : "";
}
function logEvent(ev, extra) {
  if (window.__sptOwner) return;
  try {
    const body = Object.assign({ ev, visit: visitId,
                                 plotter: selectedText(plotterSelect), mode: selectedText(hpglVersion) }, extra);
    fetch("/log", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body) }).catch(() => {});
  } catch (e) { /* best effort: never get in the way */ }
}

// ── "Made by this site" fingerprints ─────────────────────────────
// Every file the site hands out is fingerprinted (SHA-256 of its bytes with all
// spacing removed: the same recipe functions/upload.js uses) and the fingerprint
// is sent to /made. Only the fingerprint and file name are sent, never the file.
// If that file is ever uploaded again, the admin page marks it "made by this site",
// so corrected or stripped copies don't pass for originals.
async function registerMadeFile(bytes, name) {
  try {
    const keep = bytes.filter((b) => !(b === 32 || (b >= 9 && b <= 13)));
    const h = await crypto.subtle.digest("SHA-256", keep);
    const fp = Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join("");
    await fetch("/made", { method: "POST", headers: { "Content-Type": "application/json" },
                           body: JSON.stringify({ fp, name }) });
  } catch (e) { /* best effort: never get in the way of a download */ }
}

// ── R2 upload ───────────────────────────────────────────────────
// Sends the raw HPGL file to the Cloudflare Pages Function at
// /upload so it gets stored in the `uploadedplotfiles` R2 bucket.
// Only called when the user's consent checkbox is checked.
async function uploadToR2(file) {
  try {
    const formData = new FormData();
    formData.append("file", file);

    const response = await fetch("/upload", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      console.warn("R2 upload failed:", response.status, response.statusText);
      return;
    }

    const data = await response.json();
    console.log("R2 upload OK →", data.filename || data.status);
  } catch (err) {
    // Never interrupt the user's flow over a backup upload.
    console.warn("R2 upload error:", err);
  }
}