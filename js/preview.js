// ── preview.js ────────────────────────────────────────────────────
// Canvas rendering for original and corrected previews.
// Rotation of the plot itself is NOT applied here — corrected coordinates already include it.
// The VIEW always puts the page's long side left-to-right, so the whole page fits
// a wide, short preview box without squashing:
//   - most plotters: plotter Y ("Length") is the long side, so the view is turned
//     90° clockwise (plotter X runs down the screen, plotter Y across it);
//   - plotters whose X ("Width") is the long side (e.g. the TRS-80 26-1191,
//     9¼ in X by 7 in Y) are shown unturned: X across the screen, Y up it.

// Pen colours for the preview (pen 1 stays dark like before; SP0 / unknown pens too).
const PEN_COLORS = ["#222", "#222", "#c0392b", "#1e7a46", "#1f5fa8",
                    "#8e44ad", "#d68910", "#7f8c8d", "#2c3e50"];

// Reads HPGL into paths that remember which pen drew them: [{pen, pts:[[x,y],...]}].
// Understands IN, SP, PU, PD, PA, PR. Used only for drawing the preview.
function parsePenPaths(text) {
  const out = [];
  let pen = 1, down = false, abs = true, x = 0, y = 0, cur = null;
  for (let c of text.split(/[;\n\r]+/)) {
    c = c.trim();
    if (c.length < 2) continue;
    const op = c.slice(0, 2).toUpperCase();
    const args = c.slice(2);
    if (op === "IN") { pen = 1; down = false; abs = true; cur = null; continue; }
    if (op === "SP") { pen = parseInt(args, 10) || 0; cur = null; continue; }
    if (op === "PA" || op === "PR" || op === "PU" || op === "PD") {
      if (op === "PA") abs = true;
      else if (op === "PR") abs = false;
      else { down = (op === "PD"); if (!down) cur = null; }
      const n = args.match(/-?\d+(\.\d+)?/g) || [];
      for (let k = 0; k + 1 < n.length; k += 2) {
        let nx = parseFloat(n[k]), ny = parseFloat(n[k + 1]);
        if (!abs) { nx += x; ny += y; }
        if (down && pen > 0) {
          if (!cur) { cur = { pen, pts: [[x, y]] }; out.push(cur); }
          cur.pts.push([nx, ny]);
        } else {
          cur = null;
        }
        x = nx; y = ny;
      }
    }
  }
  return out;
}

// Which way plotter +Y points on screen (−1 = right, +1 = left). Set by renderPreview
// and used by the drag code below.
// Inch values for labels: at most 2 decimals (some plot areas are exact unit counts, e.g. 3.77953 in).
const inches = (v) => String(Math.round(v * 100) / 100);

let lastYSign = -1;
// Whether the last view was turned 90° clockwise (see the note at the top). Used by the drag code.
let lastTurned = true;

function renderPreview(text, plotterKey, modeKey, mediaKey, targetBox,
                       enableDrag) {
  const p = PLOTTERS[plotterKey];
  const mode = p.modes[modeKey];
  const media = p.media[mediaKey];
  const margins = p.margins;
  if (!media || !mode) return;

  // Remember what was drawn so the box can be redrawn when the window is resized.
  targetBox.__previewArgs = [text, plotterKey, modeKey, mediaKey, targetBox, enableDrag];
  watchPreviewBox(targetBox);

  const pageW = media.across * IN_TO_PU;   // plotter X extent  ("Width")
  const pageH = media.along  * IN_TO_PU;   // plotter Y extent  ("Length")

  // Turn the view only when plotter Y is the long side, so the long side always runs across.
  const turned = pageH >= pageW;
  lastTurned = turned;
  const dispW = turned ? pageH : pageW;    // page width on screen, in plotter units
  const dispH = turned ? pageW : pageH;    // page height on screen, in plotter units

  const origin = mode.origin;
  const isEdge = (origin !== "center");
  const starR    = isEdge ? 10 : 6;
  const starArm  = isEdge ? 15 : 10;

  // Plotter +Y points down the page in "top-left" mode, up it in every other mode.
  const ySign = (origin === "top-left") ? 1 : -1;
  lastYSign = ySign;

  // ── Page rectangle in plotter units (x = across, y = along) ──
  let xa, xb, ya, yb;
  switch (origin) {
    case "center":            xa = -pageW / 2; xb = pageW / 2; ya = -pageH / 2; yb = pageH / 2; break;
    case "center-x-bottom-y": xa = -pageW / 2; xb = pageW / 2; ya = 0;          yb = pageH;     break;
    default:                  xa = 0;          xb = pageW;     ya = 0;          yb = pageH;     break;
  }

  // ── Canvas size: use the real size of the box, so text stays readable ──
  // Room around the page: origin star on the edges, dimension labels bottom/right.
  const padL = isEdge ? 20 : 12, padT = 22;
  const padR = 30, padB = 26;

  targetBox.innerHTML = "";
  targetBox.style.minHeight = "0";
  const shownZoom = enableDrag ? zoomLevel : 1;     // Size applies to the corrected preview only
  // One-line summary, drawn inside the canvas (top strip) so no height is lost below it.
  const infoFull =
    `${inches(media.across)} × ${inches(media.along)} in · ${Math.round(pageW)} × ${Math.round(pageH)} PU · ` +
    `${describeOrigin(origin)} · margins ${margins.side}/${margins.lead}/${margins.trail}mm · ` +
    `plot ${Math.round(shownZoom * 100)}%`;
  const infoShort =
    `${inches(media.across)} × ${inches(media.along)} in · ${describeOrigin(origin)} · plot ${Math.round(shownZoom * 100)}%`;

  let availW = targetBox.clientWidth;
  let availH = targetBox.clientHeight - 2;
  if (availW < 80 || availH < 60) { availW = 420; availH = 300; }
  targetBox.__previewSize = [targetBox.clientWidth, targetBox.clientHeight];

  // The page as shown is dispW wide and dispH tall.
  const aspect = dispW / dispH;
  let innerW = Math.min(availW - padL - padR, (availH - padT - padB) * aspect);
  innerW = Math.max(innerW, 60);
  const innerH = innerW / aspect;
  // If the box is bigger than the page needs, the canvas still runs edge to edge.
  const slackX = Math.max(0, availW - (innerW + padL + padR));
  const slackY = Math.max(0, availH - (innerH + padT + padB));
  // Any spare room is split evenly, so the page sits in the middle of the box.
  const left = padL + slackX / 2;
  const top  = padT + slackY / 2;
  const canvasW = Math.round(innerW + padL + padR + slackX);
  const canvasH = Math.round(innerH + padT + padB + slackY);

  const canvas = document.createElement("canvas");
  canvas.style.width = canvasW + "px";
  canvas.style.height = canvasH + "px";
  canvas.style.background = "#fff";
  canvas.style.border = "1px solid #ddd";
  canvas.style.borderRadius = "6px";
  targetBox.appendChild(canvas);

  // Crisper drawing on high-density screens. All layout maths below is in CSS pixels.
  const hiRes = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  canvas.width = Math.round(canvasW * hiRes);
  canvas.height = Math.round(canvasH * hiRes);

  const ctx = canvas.getContext("2d");
  ctx.scale(hiRes, hiRes);

  // ── Plotter units → screen pixels ──
  //   turned view:   plotter X → down the screen,  plotter Y → right (left in "top-left" mode)
  //   unturned view: plotter X → right,            plotter Y → up (down in "top-left" mode)
  const baseS = Math.min(innerW / dispW, innerH / dispH);
  // Size (zoom) is already applied to the corrected drawing (zoomedText scales it
  // about its own centre), so everything here is drawn at the page scale.
  const s = baseS;
  lastCanvasScale = s;

  // Screen position of the plotter origin (0,0)
  let ox, oy;
  if (turned) {
    ox = (ySign < 0) ? left - baseS * ya : left + baseS * yb;
    oy = top - baseS * xa;
  } else {
    ox = left - baseS * xa;
    oy = (ySign < 0) ? top + baseS * yb : top - baseS * ya;
  }
  // Plotter point (x, y) → screen [px, py]
  const toScreen = (x, y, sc) => turned
    ? [ox + sc * (-ySign) * y, oy + sc * x]
    : [ox + sc * x,            oy + sc * ySign * y];
  // Rectangle (in plotter units) → screen rectangle {left, top, w, h}
  const scrRect = (x1, x2, y1, y2, sc) => {
    const [ax, ay] = toScreen(x1, y1, sc), [bx, by] = toScreen(x2, y2, sc);
    const l = Math.min(ax, bx), r = Math.max(ax, bx);
    const t = Math.min(ay, by), b = Math.max(ay, by);
    return { left: l, top: t, w: r - l, h: b - t };
  };

  // ── Page outline ──
  const page = scrRect(xa, xb, ya, yb, baseS);
  ctx.strokeStyle = "#bbb";
  ctx.lineWidth = 1;
  ctx.strokeRect(page.left, page.top, page.w, page.h);

  // ── Dashed red margin box ──
  const sidePU  = margins.side  * PU_PER_MM;
  const leadPU  = margins.lead  * PU_PER_MM;
  const trailPU = margins.trail * PU_PER_MM;

  // side margins are along X (page width); lead/trail margins are along Y (page length)
  let mx1, mx2, my1, my2;
  switch (origin) {
    case "center":
      mx1 = -pageW/2 + sidePU; mx2 = pageW/2 - sidePU;
      my1 = -pageH/2 + leadPU; my2 = pageH/2 - trailPU;
      break;
    case "center-x-bottom-y":
      mx1 = -pageW/2 + sidePU; mx2 = pageW/2 - sidePU;
      my1 = leadPU;            my2 = pageH - trailPU;
      break;
    default: // bottom-left, top-left
      mx1 = sidePU; mx2 = pageW - sidePU;
      my1 = leadPU; my2 = pageH - trailPU;
  }

  {
    const m = scrRect(mx1, mx2, my1, my2, baseS);
    ctx.save();
    ctx.strokeStyle = "#cc2222";
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 5]);
    ctx.strokeRect(m.left, m.top, m.w, m.h);
    ctx.setLineDash([]);
    ctx.fillStyle = "#cc2222";
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("plot area", m.left + 4, m.top + 4);
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

  // ── Drawing (one colour per pen) ──
  const drawText = enableDrag ? zoomedText(text) : text;
  let penPaths = parsePenPaths(drawText);
  if (penPaths.length === 0) {
    // my reader found nothing: fall back to the original single-colour reader
    penPaths = parsePaths(drawText).map(pts => ({ pen: 1, pts }));
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, canvasW, canvasH);
  ctx.clip();

  ctx.lineWidth = 1;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const path of penPaths) {
    const pts = path.pts;
    if (pts.length < 2) continue;
    ctx.strokeStyle = PEN_COLORS[path.pen] || PEN_COLORS[0];
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const [x, y] = pts[i];
      const [px, py] = toScreen(x, y, s);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  // ── Lines drawn more than once (corrected preview only) ──
  // Every repeat of the same line (same pen, either direction) is painted over it,
  // wider and redder each time (orange = twice ... deep red = 6 times or more).
  let repeats = 0;
  if (enableDrag && (typeof showRepeats === "undefined" || showRepeats)) {
    const seen = new Map();
    const heat = ["#ff9800", "#ff6d00", "#f4511e", "#e53935", "#c2185b"];   // 2nd, 3rd, 4th, 5th, 6th+ time
    for (const path of penPaths) {
      const pts = path.pts;
      for (let i = 1; i < pts.length; i++) {
        const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
        if (ax === bx && ay === by) continue;
        const k = path.pen + ":" + ((ax < bx || (ax === bx && ay < by))
          ? ax + "," + ay + "," + bx + "," + by : bx + "," + by + "," + ax + "," + ay);
        const n = (seen.get(k) || 0) + 1;
        seen.set(k, n);
        if (n < 2) continue;
        repeats++;
        ctx.strokeStyle = heat[Math.min(n - 2, heat.length - 1)];
        ctx.globalAlpha = 0.85;
        ctx.lineWidth = Math.min(12, 2.5 + (n - 2) * 2);
        const [p1x, p1y] = toScreen(ax, ay, s), [p2x, p2y] = toScreen(bx, by, s);
        ctx.beginPath(); ctx.moveTo(p1x, p1y); ctx.lineTo(p2x, p2y); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();

  if (repeats) {
    ctx.save();
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    const note = `orange/red: ${repeats.toLocaleString()} repeat${repeats === 1 ? "" : "s"} of lines already drawn`;
    const nx = page.left + 4, ny = page.top + page.h - 4;
    ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
    ctx.fillRect(nx - 2, ny - 14, ctx.measureText(note).width + 4, 15);
    ctx.fillStyle = "#d26a00";
    ctx.fillText(note, nx, ny);
    ctx.restore();
  }

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

  // ── Dimension labels: the long side along the bottom, the short side down the right ──
  drawDimensions(ctx, page, media, turned);

  ctx.save();
  ctx.font = "11px system-ui, sans-serif";
  ctx.fillStyle = "#777";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const infoText = (ctx.measureText(infoFull).width <= canvasW - 150) ? infoFull : infoShort;
  ctx.fillText(infoText, canvasW / 2, 11);
  ctx.restore();

  if (enableDrag) attachDragHandlers();
}

// Draws the two dimension lines with arrowheads and labels around the page rectangle.
function drawDimensions(ctx, page, media, turned) {
  const lengthTag = `Length (Y)  ${inches(media.along)} in`;
  const widthTag  = `Width (X)  ${inches(media.across)} in`;
  const bottomTag = turned ? lengthTag : widthTag;    // horizontal side
  const sideTag   = turned ? widthTag  : lengthTag;   // vertical side
  const right = page.left + page.w, bottom = page.top + page.h;
  const col = "#666";
  ctx.save();
  ctx.strokeStyle = col;
  ctx.fillStyle = col;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.font = "600 11px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const arrow = (x, y, dx, dy) => {           // small filled arrowhead at (x,y) pointing (dx,dy)
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - dx * 7 + dy * 3, y - dy * 7 + dx * 3);
    ctx.lineTo(x - dx * 7 - dy * 3, y - dy * 7 - dx * 3);
    ctx.closePath();
    ctx.fill();
  };
  const tag = (label, cx, cy, rotate) => {     // label on a white patch so the line doesn't run through it
    ctx.save();
    ctx.translate(cx, cy);
    if (rotate) ctx.rotate(-Math.PI / 2);
    const w = ctx.measureText(label).width + 10;
    ctx.fillStyle = "#fff";
    ctx.fillRect(-w / 2, -8, w, 16);
    ctx.fillStyle = "#333";
    ctx.fillText(label, 0, 0);
    ctx.restore();
  };

  // Horizontal side, below the page
  const yy = bottom + 15;
  ctx.beginPath();
  ctx.moveTo(page.left, bottom + 3); ctx.lineTo(page.left, yy + 4);
  ctx.moveTo(right, bottom + 3);     ctx.lineTo(right, yy + 4);
  ctx.moveTo(page.left, yy);         ctx.lineTo(right, yy);
  ctx.stroke();
  arrow(page.left, yy, -1, 0);
  arrow(right, yy, 1, 0);
  tag(bottomTag, page.left + page.w / 2, yy, false);

  // Vertical side, right of the page, text reads bottom-to-top
  const xx = right + 20;
  ctx.beginPath();
  ctx.moveTo(right + 3, page.top);   ctx.lineTo(xx + 4, page.top);
  ctx.moveTo(right + 3, bottom);     ctx.lineTo(xx + 4, bottom);
  ctx.moveTo(xx, page.top);          ctx.lineTo(xx, bottom);
  ctx.stroke();
  arrow(xx, page.top, 0, -1);
  arrow(xx, bottom, 0, 1);
  tag(sideTag, xx, page.top + page.h / 2, true);

  ctx.restore();
}

// Redraw a preview when its box changes size (window resized, file info lines
// appearing, etc.) — the canvas is now drawn at the box's real pixel size.
function watchPreviewBox(box) {
  if (box.__watched || typeof ResizeObserver === "undefined") return;
  box.__watched = true;
  let timer = null;
  new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const last = box.__previewSize, args = box.__previewArgs;
      if (!args || !last) return;
      if (Math.abs(box.clientWidth - last[0]) < 2 && Math.abs(box.clientHeight - last[1]) < 2) return;
      renderPreview(...args);
    }, 80);
  }).observe(box);
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

  // Phones and tablets: one finger drags the drawing, two fingers pinch to zoom.
  // touch-action: none stops the browser from scrolling the page instead.
  canvas.style.touchAction = "none";
  canvas.addEventListener("touchstart", onTouchStart, { passive: false });
  canvas.addEventListener("touchmove", onTouchMove, { passive: false });
  canvas.addEventListener("touchend", onTouchEnd);
  canvas.addEventListener("touchcancel", onTouchEnd);
}

// Screen pixels moved → plotter units moved (same mapping as the mouse drag).
function pxToPU(dxPx, dyPx) {
  const dx = Math.round((lastTurned ? dyPx : dxPx) / lastCanvasScale);
  const dy = lastTurned
    ? Math.round((-lastYSign * dxPx) / lastCanvasScale)
    : Math.round((lastYSign * dyPx) / lastCanvasScale);
  return [dx, dy];
}

// ── Touch: drag and pinch-zoom on the corrected canvas ───────────
let touchState = null;
let touchRenderScheduled = false;

function touchInfo(touches) {
  const a = touches[0], b = touches[1];
  if (!b) return { n: 1, x: a.clientX, y: a.clientY, dist: 0 };
  return { n: 2, x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2,
           dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) };
}

// (Re)start the gesture from the fingers now on the screen, so adding or
// lifting a finger doesn't make the drawing jump.
function beginTouch(touches) {
  const t = touchInfo(touches);
  touchState = { start: t, offX: manualOffsetX, offY: manualOffsetY, zoom: zoomLevel };
}

function onTouchStart(e) {
  if (!correctedBaseText) return;
  e.preventDefault();
  previewCorrected.classList.add("dragging");
  beginTouch(e.touches);
}

function onTouchMove(e) {
  if (!touchState) return;
  e.preventDefault();
  const t = touchInfo(e.touches);
  if (t.n !== touchState.start.n) { beginTouch(e.touches); return; }

  // Move: follows one finger, or the middle point between two fingers.
  const [dxPU, dyPU] = pxToPU(t.x - touchState.start.x, t.y - touchState.start.y);
  manualOffsetX = touchState.offX + dxPU;
  manualOffsetY = touchState.offY + dyPU;
  updateOffsetDisplay();
  correctedText = applyManualOffset(correctedBaseText);

  // Pinch: Size changes with the distance between the two fingers.
  if (t.n === 2 && touchState.start.dist > 10) {
    const z = touchState.zoom * t.dist / touchState.start.dist;
    zoomLevel = Math.max(ZOOM_MIN, Math.min(ZOOM_LIMIT, z));
    const pct = Math.round(zoomLevel * 100);
    zoomPercentEl.textContent = pct + "%";
    zoomSlider.value = pct;
  }

  if (!touchRenderScheduled) {
    touchRenderScheduled = true;
    requestAnimationFrame(() => {
      touchRenderScheduled = false;
      renderPreview(correctedText, plotterSelect.value, hpglVersion.value,
                    mediaSelect.value, previewCorrected, true);
    });
  }
}

function onTouchEnd(e) {
  if (!touchState) return;
  if (e.touches && e.touches.length > 0) { beginTouch(e.touches); return; }
  touchState = null;
  previewCorrected.classList.remove("dragging");
  if (typeof refreshStatus === "function") refreshStatus();
}

function onDragMove(e) {
  if (!dragState) return;

  const dxPx = e.clientX - dragState.startPx;
  const dyPx = e.clientY - dragState.startPy;

  // Turned view: screen-down is plotter X, screen-right is plotter Y (screen-left in "top-left" mode).
  // Unturned view: screen-right is plotter X, screen-up is plotter Y (screen-down in "top-left" mode).
  const [dxPU, dyPU] = pxToPU(dxPx, dyPx);

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
  if (typeof refreshStatus === "function") refreshStatus();   // status describes the new position
}