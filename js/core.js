// ── core.js ───────────────────────────────────────────────────────
// Shared state, DOM references, geometry helpers, HPGL parsing.

// ── Constants ────────────────────────────────────────────────────
const IN_TO_PU = 25.4 * 40;         // 1016 PU per inch
const PU_PER_MM = IN_TO_PU / 25.4;  // 40 PU per mm
const ZOOM_MIN = 0.10;
const ZOOM_MAX = 10.00;
const ZOOM_STEP_BTN = 0.01;
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

// ── Bounding box ─────────────────────────────────────────────────
function getBBox(text) {
  const inIdx = text.indexOf("IN;");
  if (inIdx > 0) text = text.slice(inIdx);
  const matches = text.match(/-?\d+[,\s]+-?\d+/g);
  if (!matches) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const m of matches) {
    const [x, y] = m.split(/[,\s]+/).map(Number);
    if (isNaN(x) || isNaN(y)) continue;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (minX === Infinity) return null;
  return { minX, maxX, minY, maxY, spanX: maxX - minX, spanY: maxY - minY };
}