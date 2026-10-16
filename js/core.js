// ── core.js ───────────────────────────────────────────────────────
// Shared state, DOM references, geometry helpers, HPGL parsing.

// ── Constants ────────────────────────────────────────────────────
const IN_TO_PU = 25.4 * 40;         // 1016 PU per inch
const PU_PER_MM = IN_TO_PU / 25.4;  // 40 PU per mm
const ZOOM_MIN = 0.10;
const ZOOM_MAX = 10.00;
const ZOOM_STEP_BTN = 0.05;
const ROTATE_STEP_DEG = 45;

// ── State ────────────────────────────────────────────────────────
let currentFile = null;
let currentText = null;
let correctedText = null;
let correctedBaseText = null;
let manualOffsetX = 0;
let manualOffsetY = 0;
let lastCanvasScale = 1;
let zoomLevel = 1.0;
let rotationDeg = 0;
let dragState = null;

// ── DOM references ───────────────────────────────────────────────
const loadingMessage = document.getElementById("loadingMessage");
const appContainer   = document.getElementById("appContainer");

let dropZone, fileInput, fileInfo, fileNameEl, fileSizeEl, bboxEl;
let plotterSelect, hpglVersion, mediaSelect, plotterInfo;
let btnDownload, btnResetOffset;
let offsetDisplay, statusEl;
let previewOriginal, previewCorrected;
let zoomPercentEl, zoomSlider, btnZoomIn, btnZoomOut, btnZoomReset;
let btnRotateMinus, btnRotatePlus, btnRotateReset, rotateAngleEl;

// ── Helpers ──────────────────────────────────────────────────────
function getMode() {
  const p = PLOTTERS[plotterSelect.value];
  return p.modes[hpglVersion.value];
}

function describeOrigin(origin) {
  switch (origin) {
    case "center":            return "center origin";
    case "center-x-bottom-y": return "X-centered, Y-bottom";
    case "bottom-left":       return "bottom-left origin";
    case "top-left":          return "top-left origin";
    default:                  return origin;
  }
}

// ── HPGL path parser ─────────────────────────────────────────────
function parsePaths(text) {
  const inIdx = text.indexOf("IN;");
  if (inIdx > 0) text = text.slice(inIdx);

  const paths = [];
  let current = null;
  let penDown = false;
  let px = 0, py = 0;

  for (const tok of text.split(";")) {
    const t = tok.trim();
    if (!t) continue;

    const cmd = t.slice(0, 2).toUpperCase();
    const rest = t.slice(2).trim();
    const nums = rest.split(/[,\s]+/).filter(s => s.length).map(Number);
    const hasCoords = nums.length >= 2 && !isNaN(nums[0]);

    if (cmd === "PU") {
      penDown = false;
      current = null;
      if (hasCoords) { px = nums[0]; py = nums[1]; }
      continue;
    }

    if (cmd === "PD") {
      penDown = true;
      current = [[px, py]];
      paths.push(current);
      if (hasCoords) {
        for (let i = 0; i < nums.length; i += 2) {
          px = nums[i]; py = nums[i + 1];
          current.push([px, py]);
        }
      }
      continue;
    }

    if (cmd === "PA" || cmd === "PR") {
      if (!hasCoords) continue;
      for (let i = 0; i < nums.length; i += 2) {
        let nx, ny;
        if (cmd === "PA") { nx = nums[i]; ny = nums[i + 1]; }
        else              { nx = px + nums[i]; ny = py + nums[i + 1]; }

        if (penDown) {
          if (!current) { current = [[px, py]]; paths.push(current); }
          current.push([nx, ny]);
        }
        px = nx; py = ny;
      }
    }
  }

  return paths;
}

// ── Coordinate pairs ─────────────────────────────────────────────
// HP-GL only puts x,y points in some commands. Everything that moves, turns,
// sizes or clamps a drawing goes through mapPairs(), so label text and the
// numbers of other commands (DI/DR direction, SI/SR size, SC scaling, IP, IW,
// LT, VS, CI radius, arc angles) are never mistaken for points.
//   PA, and PU/PD after PA      every pair is a point ("abs")
//   PR, and PU/PD after PR      every pair is a move from the last point ("rel")
//   EA, RA, AA  /  ER, RR, AR   only the first pair: the far corner or the arc
//                               centre ("abs" / "rel")
//   IW                          the clip window's two corners, kept lower-left first
// IP and SC are left alone: the site works in plotter units, and a file that
// sets IP 0,0,100,100 with SC 0,100,0,100 (1 unit = 1 plotter unit) still plots
// right when only its points move.
const HPGL_CMD = /(LB[^\x03]*\x03?)|([A-Za-z]{2})([^A-Za-z;\x03]*)/g;
const HPGL_NUM = /[-+]?(?:\d+\.?\d*|\.\d+)/g;

// Text before "IN;" (PJL headers, escape codes) is passed through untouched.
function splitPreamble(text) {
  const i = text.indexOf("IN;");
  return i > 0 ? [text.slice(0, i), text.slice(i)] : ["", text];
}

// fn(x, y, kind) returns the new [x, y], or nothing to keep the pair as it is.
function mapPairs(text, fn) {
  const [pre, body] = splitPreamble(text);
  let rel = false;
  return pre + body.replace(HPGL_CMD, (m, label, op, args) => {
    if (label) return label;
    const up = op.toUpperCase();
    let kind, all;
    if (up === "IN" || up === "DF") { rel = false; return m; }
    if (up === "IW") {                  // clip window: two corners in plotter units
      const n = args.match(HPGL_NUM);
      if (!n || n.length < 4) return m;
      const a = fn(+n[0], +n[1], "abs") || [+n[0], +n[1]];
      const b = fn(+n[2], +n[3], "abs") || [+n[2], +n[3]];
      return op + [Math.min(a[0], b[0]), Math.min(a[1], b[1]),
                   Math.max(a[0], b[0]), Math.max(a[1], b[1])].join(",");
    }
    if (up === "PA")      { rel = false; kind = "abs"; all = true; }
    else if (up === "PR") { rel = true;  kind = "rel"; all = true; }
    else if (up === "PU" || up === "PD") { kind = rel ? "rel" : "abs"; all = true; }
    else if (up === "EA" || up === "RA" || up === "AA") { kind = "abs"; all = false; }
    else if (up === "ER" || up === "RR" || up === "AR") { kind = "rel"; all = false; }
    else return m;
    const nums = args.match(HPGL_NUM);
    if (!nums || nums.length < 2) return m;
    const pairs = all ? Math.floor(nums.length / 2) : 1;
    const out = nums.slice();
    for (let p = 0; p < pairs; p++) {
      const r = fn(parseFloat(nums[2 * p]), parseFloat(nums[2 * p + 1]), kind);
      if (r) { out[2 * p] = String(r[0]); out[2 * p + 1] = String(r[1]); }
    }
    let k = 0;
    return op + args.replace(HPGL_NUM, () => out[k++]);
  });
}

// Extent of the drawing: every point the pen visits, or (drawnOnly) only what
// it draws, so a "PU0,0" park at the start or end doesn't count. Arcs, circles
// and rectangles are included by their real outline.
function hpglExtent(text, drawnOnly) {
  const [, body] = splitPreamble(text);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const add = (x, y) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  let rel = false, down = false, x = 0, y = 0;
  body.replace(HPGL_CMD, (m, label, op, args) => {
    if (label) return m;
    const up = op.toUpperCase();
    const n = (args.match(HPGL_NUM) || []).map(Number);
    if (up === "IN" || up === "DF") { rel = false; down = false; return m; }
    if (up === "PA" || up === "PR" || up === "PU" || up === "PD") {
      if (up === "PA") rel = false; else if (up === "PR") rel = true;
      else down = (up === "PD");
      for (let i = 0; i + 1 < n.length; i += 2) {
        const nx = rel ? x + n[i] : n[i], ny = rel ? y + n[i + 1] : n[i + 1];
        if (!drawnOnly) add(nx, ny);
        else if (down) { add(x, y); add(nx, ny); }
        x = nx; y = ny;
      }
    } else if (up === "CI" && n.length) {
      add(x - n[0], y - n[0]); add(x + n[0], y + n[0]);
    } else if ((up === "EA" || up === "RA" || up === "ER" || up === "RR") && n.length >= 2) {
      const r = up[1] === "R";
      add(x, y); add(r ? x + n[0] : n[0], r ? y + n[1] : n[1]);
    } else if ((up === "AA" || up === "AR") && n.length >= 3) {
      const cx = up === "AR" ? x + n[0] : n[0], cy = up === "AR" ? y + n[1] : n[1];
      const rad = Math.hypot(x - cx, y - cy), a0 = Math.atan2(y - cy, x - cx);
      const steps = Math.max(2, Math.ceil(Math.abs(n[2]) / 5));
      let ex = x, ey = y;
      for (let i = 0; i <= steps; i++) {
        const a = a0 + (n[2] * Math.PI / 180) * i / steps;
        ex = cx + rad * Math.cos(a); ey = cy + rad * Math.sin(a);
        if (!drawnOnly || down) add(ex, ey);
      }
      x = ex; y = ey;
    }
    return m;
  });
  if (minX === Infinity) return null;
  return { minX, maxX, minY, maxY, spanX: maxX - minX, spanY: maxY - minY };
}

// ── Bounding box ─────────────────────────────────────────────────
function getBBox(text) {
  const b = hpglExtent(text, false);
  if (!b) return null;
  const r = Math.round;
  return { minX: r(b.minX), maxX: r(b.maxX), minY: r(b.minY), maxY: r(b.maxY),
           spanX: r(b.spanX), spanY: r(b.spanY) };
}

// ── Scaling (IP + SC) ────────────────────────────────────────────
// A file that sets IP p1x,p1y,p2x,p2y and SC xmin,xmax,ymin,ymax gives its
// points in its own units. Everything else on this site works in plotter units,
// so those points are converted here and scaling is switched off ("SC;").
// SC without an IP depends on the plotter's own P1/P2, which isn't known, so
// such files are left as they are and `unresolved` is set.
function resolveScaling(text) {
  const [pre, body] = splitPreamble(text);
  if (!/SC\s*[-+.\d]/i.test(body)) return { text, unresolved: false };
  let ip = null, sc = null, rel = false, unresolved = false;
  const toPU = (x, y) => [
    Math.round(ip[0] + (x - sc[0]) * (ip[2] - ip[0]) / (sc[1] - sc[0])),
    Math.round(ip[1] + (y - sc[2]) * (ip[3] - ip[1]) / (sc[3] - sc[2]))];
  const scaleRel = (x, y) => [
    Math.round(x * (ip[2] - ip[0]) / (sc[1] - sc[0])),
    Math.round(y * (ip[3] - ip[1]) / (sc[3] - sc[2]))];
  const out = body.replace(HPGL_CMD, (m, label, op, args) => {
    if (label) return label;
    const up = op.toUpperCase();
    const n = (args.match(HPGL_NUM) || []).map(Number);
    if (up === "IN" || up === "DF") { ip = null; sc = null; rel = false; return m; }
    if (up === "IP") { ip = n.length >= 4 ? n.slice(0, 4) : null; return m; }
    if (up === "SC") {
      if (n.length < 4) { sc = null; return m; }
      if (!ip || n[1] === n[0] || n[3] === n[2]) { unresolved = true; sc = null; return m; }
      sc = n.slice(0, 4);
      return op;                                         // "SC" with no numbers: scaling off
    }
    if (up === "PA") rel = false; else if (up === "PR") rel = true;
    if (!sc) return m;
    let kind, all;
    if (up === "PA" || up === "PR" || up === "PU" || up === "PD") { kind = rel ? "rel" : "abs"; all = true; }
    else if (up === "EA" || up === "RA" || up === "AA") { kind = "abs"; all = false; }
    else if (up === "ER" || up === "RR" || up === "AR") { kind = "rel"; all = false; }
    else if (up === "CI" && n.length) {                  // radius in X units
      let k = 0;
      return op + args.replace(HPGL_NUM, (v) => k++ === 0
        ? String(Math.round(parseFloat(v) * Math.abs((ip[2] - ip[0]) / (sc[1] - sc[0])))) : v);
    } else return m;
    if (n.length < 2) return m;
    const pairs = all ? Math.floor(n.length / 2) : 1;
    const vals = (args.match(HPGL_NUM) || []).slice();
    for (let p = 0; p < pairs; p++) {
      const r = (kind === "abs" ? toPU : scaleRel)(n[2 * p], n[2 * p + 1]);
      vals[2 * p] = String(r[0]); vals[2 * p + 1] = String(r[1]);
    }
    let k = 0;
    return op + args.replace(HPGL_NUM, () => vals[k++]);
  });
  return { text: pre + out, unresolved };
}