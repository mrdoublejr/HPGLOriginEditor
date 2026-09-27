// ── main.js ───────────────────────────────────────────────────────
// Boot, event wiring, dropdown population, and top-level actions.

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
    btnRotateMinus   = document.getElementById("btnRotateMinus");
    btnRotatePlus    = document.getElementById("btnRotatePlus");
    btnRotateReset   = document.getElementById("btnRotateReset");
    rotateAngleEl    = document.getElementById("rotateAngle");

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
    }
  });

  btnZoomIn.addEventListener("click", () => setZoom(zoomLevel + ZOOM_STEP_BTN));
  btnZoomOut.addEventListener("click", () => setZoom(zoomLevel - ZOOM_STEP_BTN));
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

    const delta = e.deltaY < 0 ? ZOOM_STEP_BTN : -ZOOM_STEP_BTN;
    zoomLevel = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoomLevel + delta));
    const pct = Math.round(zoomLevel * 100);
    zoomPercentEl.textContent = pct + "%";
    zoomSlider.value = pct;

    if (!zoomRenderScheduled) {
      zoomRenderScheduled = true;
      requestAnimationFrame(() => {
        zoomRenderScheduled = false;
        renderPreview(correctedText, plotterSelect.value, hpglVersion.value,
                      mediaSelect.value, previewCorrected, true);
      });
    }
  }, { passive: false });

  zoomSlider.addEventListener("input", () => {
    setZoom(parseInt(zoomSlider.value, 10) / 100);
  });

  btnDownload.addEventListener("click", onDownload);

  btnRotateMinus.addEventListener("click", () => {
    rotationDeg -= ROTATE_STEP_DEG;
    updateRotateDisplay();
    runCorrection();
  });
  btnRotatePlus.addEventListener("click", () => {
    rotationDeg += ROTATE_STEP_DEG;
    updateRotateDisplay();
    runCorrection();
  });
  btnRotateReset.addEventListener("click", () => {
    rotationDeg = 0;
    updateRotateDisplay();
    runCorrection();
  });

  window.addEventListener("mousemove", onDragMove);
  window.addEventListener("mouseup", onDragEnd);
}

function loadFile(file) {
  currentFile = file;
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
    updateRotateDisplay();

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

    const result = correctHPGL(currentText, plotterKey, modeKey, mediaKey,
                               rotationDeg);
    correctedBaseText = result.text;
    correctedText = applyManualOffset(correctedBaseText);

    renderPreview(correctedText, plotterKey, modeKey, mediaKey,
                  previewCorrected, true);

    previewCorrected.classList.add("draggable");
    btnDownload.disabled = false;

    const bbox = getBBox(correctedText);
    let msg = `X ${bbox.minX}→${bbox.maxX}  Y ${bbox.minY}→${bbox.maxY}`;
    if (result.negativeClamped > 0) {
      msg += ` · ${result.negativeClamped} clamped to 0 (HP-GL/2)`;
      statusEl.classList.add("warn");
    }
    statusEl.textContent = msg;
  } catch (err) {
    statusEl.textContent = "Error: " + err.message;
    correctedText = null;
    correctedBaseText = null;
    btnDownload.disabled = true;
  }
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
}

function resetManualOffset() {
  manualOffsetX = 0;
  manualOffsetY = 0;
  updateOffsetDisplay();
}

function updateOffsetDisplay() {
  if (manualOffsetX === 0 && manualOffsetY === 0) {
    offsetDisplay.textContent = "X 0, Y 0 plotter units";
  } else {
    const sx = manualOffsetX >= 0 ? "+" : "";
    const sy = manualOffsetY >= 0 ? "+" : "";
    offsetDisplay.textContent =
      `X ${sx}${manualOffsetX}, Y ${sy}${manualOffsetY} plotter units`;
  }
}

function updateRotateDisplay() {
  rotateAngleEl.textContent = rotationDeg + "°";
}

function setZoom(z) {
  zoomLevel = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
  const pct = Math.round(zoomLevel * 100);
  zoomPercentEl.textContent = pct + "%";
  zoomSlider.value = pct;

  if (correctedText) {
    renderPreview(correctedText, plotterSelect.value, hpglVersion.value,
                  mediaSelect.value, previewCorrected, true);
  }
}

function onDownload() {
  if (!correctedText) return;
  const blob = new Blob([correctedText], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const base = currentFile.name.replace(/\.[^.]+$/, "");
  const mode = hpglVersion.value;
  a.download = base + "_FIX_" + mode + ".hpgl";
  a.click();
  URL.revokeObjectURL(a.href);
}