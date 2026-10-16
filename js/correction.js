// ── correction.js ─────────────────────────────────────────────────
// Transforms raw HPGL coordinates for a specific plotter's origin and page.

// noClamp: when true, points below 0 are left as they are even in a
// "no negatives" mode; the caller clamps later, after Size and drag offset
// (see outputText() in main.js), so shrinking or moving a plot unclamps it.
function correctHPGL(text, plotterKey, modeKey, mediaKey, rotateDeg, noClamp) {
  const p = PLOTTERS[plotterKey];
  const mode = p.modes[modeKey];
  const media = p.media[mediaKey];

  // Files that scale their own units (IP + SC) are turned into plotter units first.
  const scaled = resolveScaling(text);
  text = scaled.text;

  // Centre on what the pen actually draws; a "PU0,0" park at the start or end
  // would otherwise pull the drawing off centre.
  const box = hpglExtent(text, true) || hpglExtent(text, false);
  if (!box) throw new Error("No coordinates found in file");
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;

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

  // Points (PA, and PU/PD after PA) are moved, turned and placed. Relative moves
  // (PR, and PU/PD after PR) are only turned, and flipped for a top-left origin.
  // Label text and other commands' numbers (DI, SI, SC, CI radius...) stay as they are.
  let negativeClamped = 0;
  let result = mapPairs(text, (x, y, kind) => {
    const rel = kind === "rel";
    let px = rel ? x : x - cx;
    let py = rel ? y : y - cy;

    const rx = px * cosR - py * sinR;
    const ry = px * sinR + py * cosR;
    px = rel ? rx : rx + targetCx;
    py = rel ? ry : ry + targetCy;

    // HP-GL/2 top-left origin: Y is measured downward from the top.
    // Source files use Y measured upward from the bottom. Flip Y once.
    if (mode.origin === "top-left") py = rel ? -py : pageH - py;

    let nx = Math.round(px), ny = Math.round(py);
    if (!rel && !mode.allowNegative && !noClamp) {
      if (nx < 0) { nx = 0; negativeClamped++; }
      if (ny < 0) { ny = 0; negativeClamped++; }
    }
    return [nx, ny];
  });

  result = result.replace(/SP[0-9]*;\s*$/, "").trimEnd() + "\n";
  return { text: result, negativeClamped, scalingUnresolved: scaled.unresolved };
}

// ── Manual offset (applied on top of corrected output) ───────────
function applyManualOffset(text) {
  if (!text) return text;
  if (manualOffsetX === 0 && manualOffsetY === 0) return text;
  return mapPairs(text, (x, y, kind) =>
    kind === "abs" ? [x + manualOffsetX, y + manualOffsetY] : null);
}