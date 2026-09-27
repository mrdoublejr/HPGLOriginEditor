// ── preview.js ────────────────────────────────────────────────────
// Canvas rendering for original and corrected previews.
// Rotation is NOT applied here — corrected coordinates already include it.

function renderPreview(text, plotterKey, modeKey, mediaKey, targetBox,
                       enableDrag) {
  const p = PLOTTERS[plotterKey];
  const mode = p.modes[modeKey];
  const media = p.media[mediaKey];
  const margins = p.margins;
  if (!media || !mode) return;

  const pageW = media.across * IN_TO_PU;
  const pageH = media.along  * IN_TO_PU;

  const targetArea = 333 * 333;  // ~1/3 of a 1000px × 1000px square
  const aspect = pageW / pageH;
  const canvasW = Math.round(Math.sqrt(targetArea * aspect));
  const canvasH = Math.round(Math.sqrt(targetArea / aspect));

  targetBox.innerHTML = "";
  targetBox.style.minHeight = "0";

  const canvas = document.createElement("canvas");
  canvas.width = canvasW;
  canvas.height = canvasH;
  canvas.style.width = "100%";
  canvas.style.height = "auto";
  canvas.style.background = "#fff";
  canvas.style.border = "1px solid #ddd";
  canvas.style.borderRadius = "6px";
  targetBox.appendChild(canvas);



  const ctx = canvas.getContext("2d");

  const origin = mode.origin;
  const isEdge = (origin !== "center");
  const marginPx = isEdge ? 22 : 14;
  const starR    = isEdge ? 10 : 6;
  const starArm  = isEdge ? 15 : 10;

  // Scale so the page fits the canvas. For edge origins, the origin is
  // at (marginPx, marginPx), so the page must fit in the reduced space.
  const usableW = canvasW - (isEdge ? marginPx : 0);
  const usableH = canvasH - (isEdge ? marginPx : 0);
  const baseS = Math.min(usableW / pageW, usableH / pageH);
  const s = baseS * zoomLevel;
  lastCanvasScale = s;

  let ox, oy;
  switch (origin) {
    case "center":            ox = canvasW / 2;       oy = canvasH / 2;       break;
    case "center-x-bottom-y": ox = canvasW / 2;       oy = canvasH - marginPx; break;
    case "bottom-left":       ox = marginPx;          oy = canvasH - marginPx; break;
    case "top-left":          ox = marginPx;          oy = marginPx;         break;
    default:                  ox = canvasW / 2;       oy = canvasH / 2;
  }

  const ySign = (origin === "top-left") ? 1 : -1;

  // ── Page outline ──
  ctx.strokeStyle = "#bbb";
  ctx.lineWidth = 1;
  if (origin === "center") {
    const left   = ox - (pageW / 2) * baseS;
    const right  = ox + (pageW / 2) * baseS;
    const top    = oy - (pageH / 2) * baseS;
    const bottom = oy + (pageH / 2) * baseS;
    ctx.strokeRect(left, top, right - left, bottom - top);
  } else if (origin === "center-x-bottom-y") {
    const left   = ox - (pageW / 2) * baseS;
    const right  = ox + (pageW / 2) * baseS;
    const bottom = oy;
    const top    = oy - pageH * baseS;
    ctx.strokeRect(left, top, right - left, bottom - top);
  } else if (origin === "bottom-left") {
    const left = ox;
    const top = oy - pageH * baseS;
    const right = ox + pageW * baseS;
    const bottom = oy;
    ctx.strokeRect(left, top, right - left, bottom - top);
  } else if (origin === "top-left") {
    const left = ox;
    const top = oy;
    const right = ox + pageW * baseS;
    const bottom = oy + pageH * baseS;
    ctx.strokeRect(left, top, right - left, bottom - top);
  }

  // ── Dashed red margin box ──
  const sidePU  = margins.side  * PU_PER_MM;
  const leadPU  = margins.lead  * PU_PER_MM;
  const trailPU = margins.trail * PU_PER_MM;

  let mrect;
  switch (origin) {
    case "center":
      mrect = { left: -pageW/2 + sidePU, right: pageW/2 - sidePU,
                bottom: -pageH/2 + leadPU, top: pageH/2 - trailPU };
      break;
    case "center-x-bottom-y":
      mrect = { left: -pageW/2 + sidePU, right: pageW/2 - sidePU,
                bottom: leadPU, top: pageH - trailPU };
      break;
    case "bottom-left":
      mrect = { left: sidePU, right: pageW - sidePU,
                bottom: leadPU, top: pageH - trailPU };
      break;
    case "top-left":
      mrect = { left: sidePU, right: pageW - sidePU,
                bottom: pageH - trailPU, top: leadPU };
      break;
  }

  if (mrect) {
    const rx1 = ox + mrect.left  * baseS;
    const rx2 = ox + mrect.right * baseS;
    const ry1 = oy + ySign * mrect.top    * baseS;
    const ry2 = oy + ySign * mrect.bottom * baseS;

    ctx.save();
    ctx.strokeStyle = "#cc2222";
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 5]);
    ctx.strokeRect(Math.min(rx1, rx2), Math.min(ry1, ry2),
                   Math.abs(rx2 - rx1), Math.abs(ry2 - ry1));
    ctx.setLineDash([]);
    ctx.fillStyle = "#cc2222";
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("plot area", Math.min(rx1, rx2) + 4, Math.min(ry1, ry2) + 4);
    ctx.restore();
  }

  // ── Origin guide lines ──
  ctx.strokeStyle = "#f0c0c0";
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, oy); ctx.lineTo(canvasW, oy);
  ctx.moveTo(ox, 0); ctx.lineTo(ox, canvasH);
  ctx.stroke();
  ctx.setLineDash([]);

  // ── Drawing ──
  const paths = parsePaths(text);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, canvasW, canvasH);
  ctx.clip();

  ctx.strokeStyle = "#222";
  ctx.lineWidth = 1;
  for (const path of paths) {
    if (path.length < 2) continue;
    ctx.beginPath();
    for (let i = 0; i < path.length; i++) {
      const [x, y] = path[i];
      const px = ox + x * s;
      const py = oy + ySign * y * s;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  ctx.restore();

  // ── Origin star ──
  ctx.save();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(ox, oy, starR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(ox - starArm, oy); ctx.lineTo(ox + starArm, oy);
  ctx.moveTo(ox, oy - starArm); ctx.lineTo(ox, oy + starArm);
  ctx.stroke();

  ctx.strokeStyle = "#e05252";
  ctx.lineWidth = isEdge ? 2.2 : 1.8;
  ctx.beginPath();
  ctx.arc(ox, oy, starR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(ox - starArm, oy); ctx.lineTo(ox + starArm, oy);
  ctx.moveTo(ox, oy - starArm); ctx.lineTo(ox, oy + starArm);
  ctx.stroke();
  ctx.restore();

  // ── Info label ──
  const info = document.createElement("div");
  info.style.marginTop = "8px";
  info.style.fontSize = "0.8rem";
  info.style.color = "#777";
  info.style.textAlign = "center";
  info.textContent =
    `${media.across} × ${media.along} in · ` +
    `${Math.round(pageW)} × ${Math.round(pageH)} PU · ` +
    `${describeOrigin(origin)} · margins ${margins.side}/${margins.lead}/${margins.trail}mm · ` +
    `plot ${Math.round(zoomLevel * 100)}%`;
  targetBox.appendChild(info);

  if (enableDrag) attachDragHandlers();
}

// ── Drag-to-reposition on the corrected canvas ───────────────────
function attachDragHandlers() {
  const canvas = previewCorrected.querySelector("canvas");
  if (!canvas) return;

  canvas.addEventListener("mousedown", (e) => {
    if (!correctedBaseText) return;
    previewCorrected.classList.add("dragging");
    dragState = {
      startPx: e.clientX,
      startPy: e.clientY,
      startOffsetX: manualOffsetX,
      startOffsetY: manualOffsetY,
    };
    e.preventDefault();
  });
}

function onDragMove(e) {
  if (!dragState) return;

  const dxPx = e.clientX - dragState.startPx;
  const dyPx = e.clientY - dragState.startPy;

  const dxPU = Math.round( dxPx / lastCanvasScale);
  const dyPU = Math.round(
    (hpglVersion.value === "hpgl2" ? dyPx : -dyPx) / lastCanvasScale
  );

  manualOffsetX = dragState.startOffsetX + dxPU;
  manualOffsetY = dragState.startOffsetY + dyPU;
  updateOffsetDisplay();

  correctedText = applyManualOffset(correctedBaseText);
  renderPreview(correctedText, plotterSelect.value, hpglVersion.value,
                mediaSelect.value, previewCorrected, true);
}

function onDragEnd() {
  if (!dragState) return;
  dragState = null;
  previewCorrected.classList.remove("dragging");
}