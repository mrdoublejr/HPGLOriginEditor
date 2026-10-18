// ── pens.js ───────────────────────────────────────────────────────
// Which pens a plot uses, and leaving some of them out.
//
// penUsage(text)          -> { pens: [1, 2, 5], counts: {1: 812, 2: 40, 5: 9} }
// filterPens(text, skip)  -> { text, warnings }   skip = Set of pen numbers to leave out
//
// Leaving a pen out keeps every move (so the other pens still land in exactly the
// same places) but nothing is drawn while that pen is selected:
//   PD under a skipped pen          -> PU (the pen travels up instead)
//   CI, EA, ER, EW, RA, RR, WG, LB  -> dropped (circles, boxes, wedges, fills, text)
//   AA, AR, AT, RT, BR, BZ          -> kept; with the pen up they only move it
// Label text is read whole, so letters inside a label are never taken for commands.

const PEN_DRAW_ALWAYS = new Set(["CI", "EA", "ER", "EW", "RA", "RR", "WG", "LB"]);
const PEN_DRAW_IF_DOWN = new Set(["AA", "AR", "AT", "RT", "BR", "BZ", "PA", "PR"]);

// Splits HP-GL into commands, keeping everything (spacing, escapes) so it can be put back.
function penTokens(text) {
  const out = [];
  let i = 0, term = "\x03";
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === "\x1b") {                                   // device-control escape: ESC . x [digits;] [:]
      const m = /^\x1b\.?.[0-9;]*:?/.exec(text.slice(i, i + 40));
      const len = m ? m[0].length : 1;
      out.push({ raw: text.slice(i, i + len) }); i += len; continue;
    }
    if (/[A-Za-z]/.test(ch) && i + 1 < n && /[A-Za-z]/.test(text[i + 1])) {
      const op = text.slice(i, i + 2).toUpperCase();
      let j = i + 2;
      if (op === "LB" || op === "BL" || op === "WD") {  // text up to the label terminator
        const k = text.indexOf(term, j);
        j = k < 0 ? n : k + 1;
      } else if (op === "DT") {                          // new label terminator
        if (j < n && text[j] !== ";") { term = text[j]; j++; } else term = "\x03";
        if (text[j] === ";") j++;
      } else if (op === "SM") {                          // symbol mode: one character (or none)
        if (j < n && text[j] !== ";") j++;
        if (text[j] === ";") j++;
      } else {
        while (j < n && !/[A-Za-z;\x1b]/.test(text[j])) j++;
        if (text[j] === ";") j++;
      }
      out.push({ op, raw: text.slice(i, j), args: text.slice(i + 2, j).replace(/;$/, "") });
      i = j; continue;
    }
    // anything else (spacing, stray characters) goes through as it is
    let j = i + 1;
    while (j < n && !/[A-Za-z\x1b]/.test(text[j])) j++;
    out.push({ raw: text.slice(i, j) }); i = j;
  }
  return out;
}

function penUsage(text) {
  const counts = {};
  let pen = 1, down = false;
  const add = () => { counts[pen] = (counts[pen] || 0) + 1; };
  for (const t of penTokens(text)) {
    if (!t.op) continue;
    const hasXY = /\d/.test(t.args);
    switch (t.op) {
      case "IN": pen = 1; down = false; break;
      case "SP": pen = parseInt(t.args, 10) || 0; break;
      case "PU": down = false; break;
      case "PD": down = true; if (hasXY) add(); break;
      default:
        if (PEN_DRAW_ALWAYS.has(t.op)) add();
        else if (PEN_DRAW_IF_DOWN.has(t.op) && down && hasXY) add();
    }
  }
  const pens = Object.keys(counts).map(Number).filter((p) => p > 0).sort((a, b) => a - b);
  return { pens, counts };
}

function filterPens(text, skip) {
  if (!skip || !skip.size) return { text, warnings: [] };
  const out = [], warnings = new Set();
  let pen = 1, down = false, outDown = false;
  for (const t of penTokens(text)) {
    if (!t.op) { out.push(t.raw); continue; }
    const off = skip.has(pen);
    switch (t.op) {
      case "IN": pen = 1; down = false; outDown = false; out.push(t.raw); continue;
      case "SP": {
        pen = parseInt(t.args, 10) || 0;
        out.push(t.raw);
        const nowOff = skip.has(pen);
        if (nowOff && outDown) { out.push("PU;"); outDown = false; }          // stop drawing
        else if (!nowOff && down && !outDown) { out.push("PD;"); outDown = true; } // carry on drawing
        continue;
      }
      case "PU": down = false; outDown = false; out.push(t.raw); continue;
      case "PD":
        down = true;
        if (off) { out.push("PU" + t.raw.slice(2)); outDown = false; }
        else { out.push(t.raw); outDown = true; }
        continue;
      case "PE":
        if (off) warnings.add("encoded polylines (PE) of a left-out pen are still drawn");
        out.push(t.raw); continue;
      case "SM":
        if (off && t.args) warnings.add("symbols (SM) of a left-out pen are still drawn");
        out.push(t.raw); continue;
      default:
        if (off && PEN_DRAW_ALWAYS.has(t.op)) continue;                        // leave it out
        out.push(t.raw);
    }
  }
  return { text: out.join(""), warnings: [...warnings] };
}

if (typeof module !== "undefined") module.exports = { penUsage, filterPens, penTokens };
