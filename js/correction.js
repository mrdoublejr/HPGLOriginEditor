// ── correction.js ─────────────────────────────────────────────────
// Transforms raw HPGL coordinates for a specific plotter's origin and page.

function correctHPGL(text, plotterKey, modeKey, mediaKey, rotateDeg) {
  const p = PLOTTERS[plotterKey];
  const mode = p.modes[modeKey];
  const media = p.media[mediaKey];

  const inIdx = text.indexOf("IN;");
  const preamble = inIdx > 0 ? text.slice(0, inIdx) : "";
  const body = inIdx > 0 ? text.slice(inIdx) : text;

  const coords = body.match(/-?\d+[,\s]+-?\d+/g);
  if (!coords) throw new Error("No coordinates found in file");

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const parsed = [];
  for (const m of coords) {
    const [x, y] = m.split(/[,\s]+/).map(Number);
    if (isNaN(x) || isNaN(y)) continue;
    parsed.push([x, y]);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;

  const pageW = media.across * IN_TO_PU;
  const pageH = media.along  * IN_TO_PU;

  // Target bbox-center in the plotter's coordinate system
  let targetCx, targetCy;
  switch (mode.origin) {
    case "center":            targetCx = 0;            targetCy = 0;             break;
    case "center-x-bottom-y": targetCx = 0;            targetCy = pageH / 2;     break;
    case "bottom-left":       targetCx = pageW / 2;    targetCy = pageH / 2;     break;
    case "top-left":          targetCx = pageW / 2;    targetCy = pageH / 2;     break;
    default:                  targetCx = 0;            targetCy = 0;
  }

  const rad = rotateDeg * Math.PI / 180;
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);

  function transform(x, y) {
    let px = x - cx;
    let py = y - cy;

    const rx = px * cosR - py * sinR;
    const ry = px * sinR + py * cosR;

    px = rx + targetCx;
    py = ry + targetCy;

    // HP-GL/2 top-left origin: Y is measured downward from the top.
    // Source files use Y measured upward from the bottom. Flip Y once.
    if (mode.origin === "top-left") {
      py = pageH - py;
    }

    return [Math.round(px), Math.round(py)];
  }

  let i = 0;
  let negativeClamped = 0;
  let result = body.replace(/-?\d+[,\s]+-?\d+/g, () => {
    const [x, y] = parsed[i++];
    let [nx, ny] = transform(x, y);

    if (!mode.allowNegative) {
      if (nx < 0) { nx = 0; negativeClamped++; }
      if (ny < 0) { ny = 0; negativeClamped++; }
    }

    return `${nx},${ny}`;
  });

  result = result.replace(/SP[0-9]*;\s*$/, "").trimEnd() + "\n";
  return { text: preamble + result, negativeClamped };
}

// ── Manual offset (applied on top of corrected output) ───────────
function applyManualOffset(text) {
  if (!text) return text;
  if (manualOffsetX === 0 && manualOffsetY === 0) return text;
  return text.replace(/-?\d+[,\s]+-?\d+/g, (m) => {
    const [x, y] = m.split(/[,\s]+/).map(Number);
    return `${x + manualOffsetX},${y + manualOffsetY}`;
  });
}