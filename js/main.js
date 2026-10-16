// ── main.js ───────────────────────────────────────────────────────
// Boot, event wiring, dropdown population, and top-level actions.

// Highest zoom allowed, as a multiple (50 = 5000%). Raise it if you need more.
const ZOOM_LIMIT = 50;

// Flip state (mirror the corrected drawing). Reset every time a file is loaded.
let btnFlipH = null, btnFlipV = null;
let flipH = false, flipV = false;

// Consent checkbox — controls whether the file gets uploaded to R2.
let uploadConsent = null;

// How many coordinates the last output clamped to 0 (shown in the status line).
let lastNegativeClamped = 0;

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
    previewOriginal  = document.getElementById("previewOriginal");
    previewCorrected = document.getElementById("previewCorrected");
    zoomPercentEl    = document.getElementById("zoomPercent");
    zoomSlider       = document.getElementById("zoomSlider");
    btnZoomIn        = document.getElementById("btnZoomIn");
    btnZoomOut       = document.getElementById("btnZoomOut");
    btnZoomReset     = document.getElementById("btnZoomReset");
    btnRotatePlus    = document.getElementById("btnRotatePlus");
    btnFlipH         = document.getElementById("btnFlipH");
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
    rotationDeg = (rotationDeg + ROTATE_STEP_DEG) % 360;
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
    btnDownload.disabled = true;
    statusEl.textContent = "";
    statusEl.classList.remove("warn");
    resetManualOffset();
    zoomLevel = 1.0;
    zoomPercentEl.textContent = "100%";
    zoomSlider.value = 100;
    rotationDeg = 0;
    flipH = false;
    flipV = false;
    updateFlipButtons();

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
    correctedBaseText = (flipH || flipV)
      ? flipHPGL(result.text, flipH, flipV)
      : result.text;
    correctedText = applyManualOffset(correctedBaseText);

    renderPreview(correctedText, plotterKey, modeKey, mediaKey,
                  previewCorrected, true);

    previewCorrected.classList.add("draggable");
    btnDownload.disabled = false;

    refreshStatus();
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
    correctedText = null;
    correctedBaseText = null;
    btnDownload.disabled = true;
  }
}

// ── What gets downloaded ────────────────────────────────────────
// The preview draws correctedText at the Size (zoom) setting, scaled about the
// plotter origin. The downloaded file is scaled the same way, so it matches the
// preview exactly. At 100% the file is correctedText unchanged.
function outputText() {
  if (!correctedText) return null;
  let out = applyZoom(correctedText, zoomLevel);
  lastNegativeClamped = 0;
  // Plotters with a converter (DM/PL, C64 BASIC, CGP-115) cut lines at the paper
  // edge during conversion instead, so the drawing keeps its shape.
  if (!getMode().allowNegative && !OUTPUT_FORMATS[getMode().output]) {
    // Same rule the correction used to apply: any coordinate below 0 becomes 0.
    out = out.replace(/-?\d+[,\s]+-?\d+/g, (m) => {
      let [x, y] = m.split(/[,\s]+/).map(Number);
      if (x < 0) { x = 0; lastNegativeClamped++; }
      if (y < 0) { y = 0; lastNegativeClamped++; }
      return `${x},${y}`;
    });
  }
  return out;
}

// Scales HP-GL about the plotter origin (0,0). Coordinate pairs are scaled;
// a CI radius is scaled; arc angles (the odd number after an AA/AR pair) and
// label text are left alone.
function applyZoom(text, z) {
  if (!text || Math.abs(z - 1) < 1e-9) return text;
  const fmt = (v) => String(Math.round(v * z));
  return text.replace(/(LB[^\x03]*\x03?)|([A-Za-z]{2})([^A-Za-z;\x03]*)/g,
    (m, label, op, args) => {
      if (label) return label;                          // label text: untouched
      const up = op.toUpperCase();
      if (up === "CI") {                                // radius [,chord]
        return op + args.replace(/-?\d+(?:\.\d+)?/, (r) => fmt(parseFloat(r)));
      }
      if (up === "SI" || up === "SR" || up === "DI" || up === "DR" ||
          up === "SP" || up === "LT" || up === "VS" || up === "CT") {
        return m;                                       // not coordinates
      }
      // Scale numbers two at a time (x,y); a lone trailing number (arc angle,
      // chord) is left as it is.
      const nums = args.match(/-?\d+(?:\.\d+)?/g);
      if (!nums || nums.length < 2) return m;
      let k = 0;
      const pairCount = Math.floor(nums.length / 2) * 2;
      return op + args.replace(/-?\d+(?:\.\d+)?/g, (n) =>
        (k++ < pairCount) ? fmt(parseFloat(n)) : n);
    });
}

// Status line under the corrected preview. Describes the file that the
// Download button will save (Size and drag offset included).
function refreshStatus() {
  const out = outputText();
  if (!out) return;
  statusEl.classList.remove("warn");
  statusEl.title = "";

  const bbox = getBBox(out);
  let msg = bbox
    ? `X ${bbox.minX}→${bbox.maxX}  Y ${bbox.minY}→${bbox.maxY}`
    : "No coordinates";
  if (lastNegativeClamped > 0) {
    msg += ` · ${lastNegativeClamped} clamped to 0 (${OUTPUT_FORMATS[getMode().output]?.name || "HP-GL/2"})`;
    statusEl.classList.add("warn");
  }
  if ((flipH || flipV) && FLIP_UNSUPPORTED.test(correctedBaseText)) {
    msg += " · arcs/circles/other shapes not flipped";
    statusEl.classList.add("warn");
  }

  // DM/PL or C64 BASIC plotters: convert now so any problems show before downloading.
  const fmt = OUTPUT_FORMATS[getMode().output];
  if (fmt) {
    const conv = fmt.convert(out);
    msg += ` · ${fmt.name} ${conv.text.length} bytes`;
    if (conv.clipped) {
      msg += ` · ${conv.clipped} line${conv.clipped !== 1 ? "s" : ""} cut at paper edge`;
      statusEl.classList.add("warn");
    }
    if (conv.warnings.length) {
      msg += ` · ${conv.warnings.length} ${fmt.name} note${conv.warnings.length !== 1 ? "s" : ""} (hover)`;
      statusEl.title = conv.warnings.join("\n");
      statusEl.classList.add("warn");
    }
  }
  statusEl.textContent = msg;
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
}

// Plotters that don't take HP-GL. A mode's "output" key picks one of these;
// modes without one download the corrected HP-GL unchanged.
const OUTPUT_FORMATS = {
  dmpl:     { name: "DM/PL",      ext: ".dmpl", convert: (t) => convertToDmpl(t) },
  c64basic: { name: "C64 BASIC",  ext: ".bas",  convert: (t) => convertToCbm1520(t) },
  cgp115:   { name: "CGP-115",    ext: ".cgp",  convert: (t) => convertToCgp115(t) },
};

// Radio Shack CGP-115: a plain command stream, 0.2 mm steps like the 1520.
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

function onDownload() {
  if (!correctedText) return;
  const base = currentFile.name.replace(/\.[^.]+$/, "");
  const mode = hpglVersion.value;

  let content = outputText();
  let fileName = base + "_FIX_" + mode + ".hpgl";
  const fmt = OUTPUT_FORMATS[getMode().output];
  if (fmt) {
    content = fmt.convert(content).text;
    fileName = base + "_FIX_" + mode + fmt.ext;
  }

  const blob = new Blob([content], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(a.href);
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