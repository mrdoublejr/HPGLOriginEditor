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

// Splits HPGL into commands: [{op, args}]. A command's numbers may run over several
// lines (many CAD files wrap long PD lists), so a new line does NOT end a command; the
// next two-letter mnemonic does. Label text (LB) runs to the label terminator
// (ETX, character 3, unless DT changed it), so letters and ";" inside it are kept.
function hpglCommands(text) {
  const out = [];
  let i = 0, term = "\x03";
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (!/[A-Za-z]/.test(ch)) { i++; continue; }
    if (i + 1 >= n || !/[A-Za-z]/.test(text[i + 1])) { i++; continue; }
    const op = text.substr(i, 2).toUpperCase();
    i += 2;
    if (op === "LB") {
      let j = text.indexOf(term, i);
      if (j < 0) j = n;
      out.push({ op, args: text.slice(i, j) });
      i = j + 1;
      continue;
    }
    if (op === "DT") {                     // DTx sets the label terminator; DT; resets it
      const c = text[i];
      term = (c === undefined || c === ";" || c === "\r" || c === "\n") ? "\x03" : c;
      out.push({ op, args: c && c !== ";" ? c : "" });
      i += (c && c !== ";") ? 1 : 0;
      continue;
    }
    let j = i;
    while (j < n && text[j] !== ";" && !/[A-Za-z]/.test(text[j])) j++;
    out.push({ op, args: text.slice(i, j) });
    i = j;
  }
  return out;
}

// Reads HPGL into paths that remember which pen drew them: [{pen, pts:[[x,y],...]}].
// Understands IN, SP, PU, PD, PA, PR, and labels: LB text with SI/SR size, DI/DR
// direction, CP moves and DT terminator. The labels are returned on the array as
// .labels: [{pen, x, y, w, h, ux, uy, text}] (x, y = start of the baseline, w/h =
// character width/height in plotter units, ux/uy = text direction). Used only for
// drawing the preview.
function parsePenPaths(text) {
  const out = [];
  const labels = [];
  out.labels = labels;
  const CM = 400;                                  // plotter units per cm
  let pen = 1, down = false, abs = true, x = 0, y = 0, cur = null;
  let cw = 0.19 * CM, chh = 0.27 * CM;             // character size (HP's usual default)
  let ux = 1, uy = 0;                              // label direction
  const num = (a) => (a.match(/[-+]?(?:\d+\.?\d*|\.\d+)/g) || []).map(Number);
  for (const { op, args } of hpglCommands(text)) {
    if (op === "IN") { pen = 1; down = false; abs = true; cur = null; cw = 0.19 * CM; chh = 0.27 * CM; ux = 1; uy = 0; continue; }
    if (op === "SP") { pen = parseInt(args, 10) || 0; cur = null; continue; }
    if (op === "SI" || op === "SR") {
      const v = num(args);
      if (op === "SI" && v.length >= 2) { cw = Math.abs(v[0]) * CM; chh = Math.abs(v[1]) * CM; }
      else { cw = 0.19 * CM; chh = 0.27 * CM; }    // SR depends on P1/P2: shown at the usual size
      continue;
    }
    if (op === "DI" || op === "DR") {
      const v = num(args);
      const len = v.length >= 2 ? Math.hypot(v[0], v[1]) : 0;
      if (len > 0) { ux = v[0] / len; uy = v[1] / len; } else { ux = 1; uy = 0; }
      continue;
    }
    if (op === "CP") {
      const v = num(args);
      const sp = v[0] || 0, ln = v[1] || 0;          // spaces along the text, lines up (+) / down (-)
      x += sp * 1.5 * cw * ux - ln * 2 * chh * uy;
      y += sp * 1.5 * cw * uy + ln * 2 * chh * ux;
      cur = null;
      continue;
    }
    if (op === "LB") {
      let lx = x, ly = y, sx = x, sy = y, line = "";
      const flush = () => {
        if (line && pen > 0) labels.push({ pen, x: lx, y: ly, w: cw, h: chh, ux, uy, text: line });
        lx += line.length * 1.5 * cw * ux; ly += line.length * 1.5 * cw * uy;
        line = "";
      };
      for (const c of args) {
        if (c === "\r") { flush(); lx = sx; ly = sy; }                       // carriage return
        else if (c === "\n") {                                                // line feed
          flush(); sx += 2 * chh * uy; sy -= 2 * chh * ux; lx += 2 * chh * uy; ly -= 2 * chh * ux;
        }
        else if (c >= " ") line += c;
      }
      flush();
      x = lx; y = ly; cur = null;
      continue;
    }
    if (op === "PA" || op === "PR" || op === "PU" || op === "PD") {
      if (op === "PA") abs = true;
      else if (op === "PR") abs = false;
      else { down = (op === "PD"); if (!down) cur = null; }
      const n = num(args);
      for (let k = 0; k + 1 < n.length; k += 2) {
        let nx = n[k], ny = n[k + 1];
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

// ── Repeated ink ──
// Goes through the drawing pen by pen and finds ink laid down on top of ink of the
// same pen: the very same line again (either direction), or a line running along
// one already drawn (the same straight line, at least REPEAT_MIN_OVERLAP of it).
// Returns { count: lines that do this, pieces: [[ax, ay, bx, by, times-before]...] }:
// the parts that go over ink, with how many times that spot was inked before.
// Lines with fractional coordinates are only matched when they are the very same line.
// The result for the last drawing is kept, so zooming and dragging don't redo it.
const REPEAT_MIN_OVERLAP = 40;                    // plotter units (1 mm), as Optimize (OPT_MIN_TRIM)
let repeatCache = { text: null, result: null };

function findRepeats(text) {
  if (repeatCache.text === text) return repeatCache.result;
  const gcd = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a; };
  const lines = new Map();                        // pen + line -> stretches inked so far [{ s, e, d }] sorted
  const exact = new Set();
  const pieces = [];
  let count = 0;
  let penPaths = parsePenPaths(text);
  if (!penPaths.length) penPaths = parsePaths(text).map((pts) => ({ pen: 1, pts }));
  for (const path of penPaths) {
    const pts = path.pts;
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
      if (ax === bx && ay === by) continue;
      const ek = path.pen + ":" + ((ax < bx || (ax === bx && ay < by))
        ? ax + "," + ay + "," + bx + "," + by : bx + "," + by + "," + ax + "," + ay);
      const same = exact.has(ek);
      exact.add(ek);
      // where the line lies: its direction and offset (whole numbers), or the line itself
      let key, ta, tb, per;                       // per = plotter units per step of t
      if (Number.isInteger(ax) && Number.isInteger(ay) && Number.isInteger(bx) && Number.isInteger(by)) {
        let dx = bx - ax, dy = by - ay; const g = gcd(dx, dy); dx /= g; dy /= g;
        if (dx < 0 || (dx === 0 && dy < 0)) { dx = -dx; dy = -dy; }
        key = path.pen + "|" + dx + "," + dy + "," + (dy * ax - dx * ay);
        ta = ax * dx + ay * dy; tb = bx * dx + by * dy; per = 1 / Math.hypot(dx, dy);
      } else {
        key = ek; ta = 0; tb = 1; per = Math.hypot(bx - ax, by - ay);
      }
      if (!lines.has(key)) lines.set(key, []);
      const lo = Math.min(ta, tb), hi = Math.max(ta, tb);
      const over = repeatCover(lines.get(key), lo, hi);   // [[s, e, times-before]...] inside lo..hi
      let len = 0;
      for (const [s0, s1] of over) len += (s1 - s0) * per;
      if (!same && len < REPEAT_MIN_OVERLAP) continue;
      count++;
      const at = (t) => { const f = (t - ta) / (tb - ta); return [ax + (bx - ax) * f, ay + (by - ay) * f]; };
      for (const [s0, s1, d] of over) { const p = at(s0), q = at(s1); pieces.push([p[0], p[1], q[0], q[1], d]); }
    }
  }
  const result = { count, pieces };
  repeatCache = { text, result };
  return result;
}

// One line's inked stretches (sorted, not overlapping, each with how many times it
// was inked). Inks lo..hi once more; returns the parts of lo..hi that were already
// inked, with how many times.
function repeatCover(list, lo, hi) {
  let a = 0, b = list.length;                     // first stretch ending after lo
  while (a < b) { const m = (a + b) >> 1; if (list[m].e <= lo) a = m + 1; else b = m; }
  const over = [], next = [];
  let at = lo, j = a;
  for (; j < list.length && list[j].s < hi; j++) {
    const p = list[j];
    if (p.s < lo) next.push({ s: p.s, e: lo, d: p.d });              // part before lo stays as it was
    else if (p.s > at) next.push({ s: at, e: p.s, d: 1 });           // gap: inked for the first time
    const s0 = Math.max(p.s, lo), s1 = Math.min(p.e, hi);
    over.push([s0, s1, p.d]);
    next.push({ s: s0, e: s1, d: p.d + 1 });
    if (p.e > hi) next.push({ s: hi, e: p.e, d: p.d });              // part after hi stays as it was
    at = s1;
  }
  if (at < hi) next.push({ s: at, e: hi, d: 1 });
  const rest = list.slice(j);                    // (not splice(...next): a huge list would overflow the stack)
  list.length = a;
  for (const n of next) list.push(n);
  for (const r of rest) list.push(r);
  return over;
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

  const xy = pageXY(p, media);             // the plotter's X and Y extents (see core.js)
  const pageW = xy.x * IN_TO_PU;           // plotter X extent
  const pageH = xy.y * IN_TO_PU;           // plotter Y extent

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

  // ── Labels (LB): drawn at the file's own character size and direction ──
  // The plotter draws them with its own stroke font, so the letter shapes here are only
  // close; their place, size and direction match what gets plotted.
  for (const L of (penPaths.labels || [])) {
    const [sx, sy] = toScreen(L.x, L.y, s);
    const [ax, ay] = toScreen(L.x + L.ux, L.y + L.uy, s);      // one unit along the text
    const [bx, by] = toScreen(L.x - L.uy, L.y + L.ux, s);      // one unit "up" from it
    ctx.save();
    ctx.transform(ax - sx, ay - sy, -(bx - sx), -(by - sy), sx, sy);
    ctx.font = `${L.h / 0.72}px Arial, Helvetica, sans-serif`;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = PEN_COLORS[L.pen] || PEN_COLORS[0];
    const mw = ctx.measureText("M").width || L.w;
    const k = L.w / mw;                                        // squeeze letters to the file's width
    for (let i = 0; i < L.text.length; i++) {
      ctx.save();
      ctx.translate(i * 1.5 * L.w, 0);
      ctx.scale(k, 1);
      ctx.fillText(L.text[i], 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }

  // ── Lines drawn more than once (corrected preview only) ──
  // Ink that goes down again on top of ink of the same pen is painted over, wider
  // and redder each time (orange = twice ... deep red = 6 times or more). That's the
  // very same line again, or a line running partly along one already drawn (at least
  // 1 mm of it, the same rule Optimize uses to trim it). They are always counted
  // (main.js shows the count next to Optimize); painted only when Show repeats is on.
  // Found once per drawing at 100% (cached), then painted at the current Size.
  let repeats = 0;
  const paintRepeats = typeof showRepeats === "undefined" || showRepeats;
  if (enableDrag) {
    // The drawing before the drag offset, so dragging doesn't search it again on every move.
    const base = (typeof correctedBaseText !== "undefined" && correctedBaseText && text === correctedText)
      ? correctedBaseText : null;
    const found = findRepeats(base || text);
    const offX = base ? manualOffsetX : 0, offY = base ? manualOffsetY : 0;
    repeats = found.count;
    if (paintRepeats && found.pieces.length) {
      const zt = typeof zoomTransform === "function" ? zoomTransform(text) : null;
      const z = zt ? zt.z : 1, zx = zt ? zt.dx : 0, zy = zt ? zt.dy : 0;
      const at = (x, y) => toScreen((x + offX) * z + zx, (y + offY) * z + zy, s);
      const heat = ["#ff9800", "#ff6d00", "#f4511e", "#e53935", "#c2185b"];   // 2nd, 3rd, 4th, 5th, 6th+ time
      ctx.globalAlpha = 0.85;
      for (const [ax, ay, bx, by, d] of found.pieces) {
        ctx.strokeStyle = heat[Math.min(d - 1, heat.length - 1)];
        ctx.lineWidth = Math.min(12, 2.5 + (d - 1) * 2);
        const [p1x, p1y] = at(ax, ay), [p2x, p2y] = at(bx, by);
        ctx.beginPath(); ctx.moveTo(p1x, p1y); ctx.lineTo(p2x, p2y); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();
  if (enableDrag) window.__repeatCount = repeats;    // shown next to Optimize (main.js showOptimizeNote)

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
  drawDimensions(ctx, page, media, turned, !!p.xAlongFeed);

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
function drawDimensions(ctx, page, media, turned, xAlongFeed) {
  // Length = along the paper feed, Width = across it; the axis letter is the plotter's.
  const lengthTag = `Length (${xAlongFeed ? "X" : "Y"})  ${inches(media.along)} in`;
  const widthTag  = `Width (${xAlongFeed ? "Y" : "X"})  ${inches(media.across)} in`;
  const xTag = xAlongFeed ? lengthTag : widthTag, yTag = xAlongFeed ? widthTag : lengthTag;
  const bottomTag = turned ? yTag : xTag;             // horizontal side
  const sideTag   = turned ? xTag : yTag;             // vertical side
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