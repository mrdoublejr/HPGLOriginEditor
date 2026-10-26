// ── optimize.js ───────────────────────────────────────────────────
// Two buttons share this file:
//
// "Optimize": takes out moves that leave no mark of their own, and shortens the
// pen's trips between pieces, without changing what is drawn.
//   - a line drawn a second time (either direction)       -> drawn once
//   - a line that runs partly over ink already there      -> only the new part is drawn
//     (the same straight line, e.g. two 3D wireframe faces sharing part of an edge)
//   - a dot on a spot that is already inked               -> dropped
//   - a node in the middle of a straight run (A-B-C)      -> A-C
//   - a pen-up to where the pen already is                -> dropped
//   - a pen, line type, width or speed command that repeats the one already set -> dropped
//   - the order of the pieces (within one pen)            -> nearest next piece
//
// "Smooth curves": a run of short moves that follows a circle (within OPT_ARC_TOL)
// becomes one arc (AA), and a closed ring of them one circle (CI). A run that follows
// a straight line (a "staircase" of 1-unit steps, within the same tolerance) becomes
// one straight move. Files exported from drawing programs often draw every curve as
// dozens of tiny straight moves, and every slanted line as a staircase.
//
// Lines (PU, PD, PA, PR) are read into absolute, whole plotter units (relative
// moves added up, decimals rounded). Every other command stays where it was and
// pieces never move across it, so colours still go down in the same order. Commands
// that draw where the pen is (arcs AA/AR, circles CI, labels LB, rectangles and
// wedges RA/RR/EA/ER/EW/WG, ticks XT/YT ...) get the pen put back exactly where it
// was in the original, up or down as it was, before them.
// A line already drawn with the same pen earlier in the file is left out, unless
// another pen has drawn over it since. Files with things this can't follow
// (polygon mode, encoded polylines, symbol mode, their own scaling) are left alone.
//
// Before handing anything back, it checks that the new file inks exactly the same
// lines and dots as the original, pen by pen (and line type by line type), and that
// every arc, circle, label ... is still there, in the same order, at the same spot.
// If not, it returns the original and says so.

// A line that runs over ink already there is only trimmed when at least this much
// of it (plotter units, 40 = 1 mm) is already drawn. Below that, going over it again
// is quicker than the extra pen lift trimming it would cost.
const OPT_MIN_TRIM = 40;

// Smooth curves: every point of the original must lie within OPT_ARC_TOL of the arc or
// straight line that replaces it (plotter units, 4 = 0.1 mm), and the arc may bulge at most OPT_ARC_BULGE away from
// each original straight piece (12 = 0.3 mm), so a real polygon (an octagon, a
// hexagon nut) stays a polygon. An arc needs at least OPT_ARC_MIN moves.
const OPT_ARC_TOL = 4;
const OPT_ARC_BULGE = 12;
const OPT_ARC_MIN = 3;
const OPT_ARC_STEP = 30;                       // largest turn (degrees) between two points of one arc
const OPT_LINE_MAX = 400;                      // most moves looked at for one straightened line
const OPT_LINE_TURN = 100;                     // most the path may turn in total (degrees) within one straightened line

// Commands that only change settings: kept in place, nothing to do with where the pen is.
const OPT_SETTINGS = new Set(["IN", "DF", "SP", "LT", "VS", "PW", "WU", "PG", "NP", "PS", "RO",
  "IP", "IW", "IM", "AF", "AH", "CS", "CA", "SS", "SA", "SI", "SR", "SL", "DI", "DR", "ES", "DT",
  "LO", "CT", "FT", "PT", "TL", "CV", "BP", "QL", "MC", "PC", "NR", "TR", "MG", "KY", "LA", "CR",
  "BL", "DS", "DL", "OA", "OC", "OD", "OE", "OF", "OH", "OI", "OO", "OP", "OS", "OW", "OT", "OL",
  "AP", "GC", "GM", "SM", "SC",
  // 7580B/7585B/7586B (Interfacing and Programming Manual 07580-90034): acceleration, character
  // sets, digitize clear, cutter, pen force, pen groups, user fills; SG picks a pen group;
  // FR (frame advance) and PG (page) start fresh paper
  "AS", "CC", "CM", "DC", "EC", "FS", "GP", "IV", "UF", "SG", "FR"]);
// Commands that draw (or do something) where the pen is: the pen goes back there first.
const OPT_AT_PEN = new Set(["AA", "AR", "CI", "RA", "RR", "EA", "ER", "EW", "WG", "XT", "YT",
  "LB", "CP", "UC", "PB"]);
// ... and of those, the ones after which the pen is somewhere this can't work out.
const OPT_LOSES_PEN = new Set(["LB", "CP", "UC", "PB", "IN", "FR", "PG"]);
// Things the optimizer can't follow: the file is left as it is.
const OPT_REFUSE = { PM: "polygon mode (PM)", PE: "encoded polylines (PE)", EP: "polygon mode (EP)",
  FP: "polygon mode (FP)", RF: "fill patterns (RF)", DP: "digitizing (DP)" };

// Splits HP-GL into commands. A label (LB) runs to its terminator (ETX, or what DT set).
function optTokens(text) {
  const out = [];
  let i = 0, term = "\x03";
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (!/[A-Za-z]/.test(ch) || i + 1 >= n || !/[A-Za-z]/.test(text[i + 1])) { i++; continue; }
    const op = text.substr(i, 2).toUpperCase();
    i += 2;
    if (op === "LB") {
      let j = text.indexOf(term, i);
      if (j < 0) j = n;
      out.push({ op, args: text.slice(i, j), raw: "LB" + text.slice(i, j) + term });
      i = j + 1;
      continue;
    }
    if (op === "DT") {
      const c = text[i];
      const has = c !== undefined && c !== ";" && c !== "\r" && c !== "\n";
      term = has ? c : "\x03";
      out.push({ op, args: has ? c : "", raw: "DT" + (has ? c : "") + ";" });
      i += has ? 1 : 0;
      continue;
    }
    let j = i;
    while (j < n && text[j] !== ";" && !/[A-Za-z]/.test(text[j])) j++;
    const args = text.slice(i, j).trim();
    out.push({ op, args, raw: op + args + ";" });
    i = j;
  }
  return out;
}

const optNums = (a) => (String(a).match(/[-+]?(?:\d+\.?\d*|\.\d+)/g) || []).map(Number);

// The pen an SP command picks ("SP;" is pen 0, put the pen away).
function optPenNumber(args) {
  const n = parseInt(args, 10);
  return Number.isFinite(n) ? n : 0;
}

// Reads a file into one list, in order:
//   { seg: [ax, ay, bx, by], style }      a pen-down line (a dot if both ends match)
//   { raw, op, args, at, after }          any other command; at = { x, y, down, known }
//                                         (where the pen was), after = { x, y, known }
// plus how often the pen goes down (lifts) and how far it travels up (travel).
// Settings that repeat the value already set are flagged { redundant: true }.
// Returns { items, lifts, travel, hasPR } or { refuse: "reason" }.
function optRead(text) {
  const cmds = optTokens(text);
  const items = [];
  let abs = true, down = false, x = 0, y = 0, known = true, hasPR = false;
  let pen = null, lt = "", pw = "", page = 0;
  let lifts = 0, travel = 0;
  const set = {};
  // what a line is drawn with: the sheet (FR/PG start a new one), pen, line type, width
  const style = () => page + "|" + pen + "|" + lt + "|" + pw;
  const R = Math.round;
  // the next pen command after command i lifts the pen (PU before any PD/PA/PR)
  const liftsNext = (i) => {
    for (let k = i + 1; k < cmds.length; k++) {
      const op = cmds[k].op;
      if (op === "PU") return true;
      if (op === "PD" || op === "PA" || op === "PR") return false;
    }
    return true;
  };
  for (let ci = 0; ci < cmds.length; ci++) {
    const { op, args, raw } = cmds[ci];
    if (op === "PU" || op === "PD" || op === "PA" || op === "PR") {
      if (op === "PA") abs = true;
      else if (op === "PR") { abs = false; hasPR = true; }
      else {
        const d = op === "PD";
        if (d && !down) lifts++;
        down = d;
      }
      const n = optNums(args);
      if (n.length % 2) return { refuse: "a move with an odd number of coordinates" };
      for (let k = 0; k < n.length; k += 2) {
        const nx = abs ? n[k] : x + n[k], ny = abs ? n[k + 1] : y + n[k + 1];
        if (down) {
          if (!known) return { refuse: "a line drawn on from the end of a label" };
          items.push({ seg: [R(x), R(y), R(nx), R(ny)], style: style() });
        } else if (known) {
          travel += Math.hypot(nx - x, ny - y);
        }
        x = nx; y = ny; known = true;
      }
      continue;
    }
    if (OPT_REFUSE[op]) return { refuse: OPT_REFUSE[op] };
    if (op === "SM" && args) return { refuse: "symbol mode (SM)" };
    if (op === "SC" && args) return { refuse: "its own scaling (SC)" };
    const atPen = OPT_AT_PEN.has(op);
    if (!atPen && !OPT_SETTINGS.has(op)) return { refuse: "text that isn't HP-GL (" + op + ")" };
    const item = { raw, op, args, at: { x: R(x), y: R(y), down, known } };
    if (op === "SP" || op === "LT" || op === "PW" || op === "VS") {
      // the same value again changes nothing (SP: only when the pen is up or goes up
      // next, so it doesn't matter whether SP lifts the pen)
      const v = op === "SP" ? String(optPenNumber(args)) : args.replace(/\s+/g, "");
      if (set[op] === v && (op !== "SP" || !down || liftsNext(ci))) item.redundant = true;
      set[op] = v;
    }
    // where the pen ends up
    if (op === "AA" || op === "AR") {
      const v = optNums(args);
      if (v.length >= 3 && known) {
        const cx = op === "AR" ? x + v[0] : v[0], cy = op === "AR" ? y + v[1] : v[1];
        const r = Math.hypot(x - cx, y - cy), a = Math.atan2(y - cy, x - cx) + v[2] * Math.PI / 180;
        x = cx + r * Math.cos(a); y = cy + r * Math.sin(a);
      }
    }
    if (OPT_LOSES_PEN.has(op)) known = false;
    if (op === "IN" || op === "DF") {
      down = false; abs = true; lt = ""; pw = "";
      delete set.LT; delete set.PW; delete set.VS;
      if (op === "IN") { pen = null; delete set.SP; }
    } else if (op === "SP") pen = optPenNumber(args);
    else if (op === "SG") { pen = "G" + args; delete set.SP; }   // a pen group: the next SP is a real change
    else if (op === "FR" || op === "PG") page++;
    else if (op === "LT") lt = args;
    else if (op === "PW") pw = args;
    item.after = { x: R(x), y: R(y), known };
    items.push(item);
  }
  return { items, lifts, travel: Math.round(travel), hasPR };
}

function optimizeHPGL(text, opts) {
  opts = opts || {};
  const tidy = opts.optimize !== false;          // the Optimize button
  const smooth = !!opts.smooth;                  // the Smooth curves button
  if (tidy && smooth) {
    // Both: Optimize first (with its exact ink check), then smooth what it made.
    const a = optimizeHPGL(text, { optimize: true });
    if (!a.ok) return a;
    const b = optimizeHPGL(a.text, { optimize: false, smooth: true });
    if (!b.ok) return a;
    const s = Object.assign({}, a.stats);
    s.after = b.stats.after; s.arcs = b.stats.arcs; s.circles = b.stats.circles; s.arcMoves = b.stats.arcMoves;
    s.straight = b.stats.straight; s.straightMoves = b.stats.straightMoves;
    s.liftsAfter = b.stats.liftsAfter; s.travelAfter = b.stats.travelAfter;
    return { text: b.text, ok: true, stats: s };
  }
  const original = text;
  // Device-control escapes at the very start (ESC.( and the like) are kept as they are.
  let pre = "";
  const first = text.search(/[A-Za-z]{2}/);
  if (first > 0 && text.slice(0, first).includes("\x1b")) { pre = text.slice(0, first); text = text.slice(first); }
  if (text.includes("\x1b")) return { text: original, ok: false, reason: "file has device-control codes in it" };

  const read = optRead(text);
  if (read.refuse) return { text: original, ok: false, reason: "file uses " + read.refuse };

  // Blocks: runs of lines between other commands (a repeated setting doesn't count
  // when tidying, so files with "LT;SP1;" before every line still form one block).
  const blocks = [];                             // { items: [[ax,ay,bx,by]...], style } | { cmd }
  let cur = null;
  const stats = { dupLines: 0, overlaps: 0, overlapLen: 0, dots: 0, nodes: 0, before: 0, after: 0,
                  spDropped: 0, arcs: 0, circles: 0, arcMoves: 0, straight: 0, straightMoves: 0 };
  for (const it of read.items) {
    if (it.seg) {
      if (!cur || cur.style !== it.style) { cur = { items: [], style: it.style }; blocks.push(cur); }
      cur.items.push(it.seg);
      continue;
    }
    if (tidy && it.redundant) { stats.spDropped++; continue; }
    blocks.push({ cmd: it });
    cur = null;
  }

  let out = [], px = null, py = null, penIsDown = false, needPA = read.hasPR;

  // Ink laid down so far, for the whole file: line key -> style -> { iv: [[s,e]...] sorted,
  // not overlapping }. A line is only left out when the same pen (and line type) has
  // already drawn it and no other pen has gone over it since, so colours still end
  // up on top in the same order.
  const inkLines = new Map();
  const seenExact = new Map();                  // style -> Set of lines drawn (exact ends)

  for (const b of blocks) {
    if (b.cmd) {
      const c = b.cmd;
      if (OPT_AT_PEN.has(c.op) && c.at.known) {
        // put the pen back where it was in the original, up or down as it was
        if (needPA) { out.push("PA;"); needPA = false; }
        if (px !== c.at.x || py !== c.at.y) { out.push("PU" + c.at.x + "," + c.at.y + ";"); penIsDown = false; }
        if (c.at.down && !penIsDown) out.push("PD;");
        else if (!c.at.down && penIsDown) out.push("PU;");
        penIsDown = c.at.down;
      }
      out.push(c.raw);
      if (c.op === "IN" || c.op === "DF") { penIsDown = false; needPA = false; }
      // A setting doesn't move the pen: it stays where this output left it (not where the
      // original had it, as pen-up moves of the original aren't copied). A command drawn
      // where the pen is leaves it where the original's did.
      if (OPT_AT_PEN.has(c.op)) {
        if (c.after.known) { px = c.after.x; py = c.after.y; } else { px = null; py = null; }
      } else if (OPT_LOSES_PEN.has(c.op)) { px = null; py = null; }
      continue;
    }
    const before = b.items;
    stats.before += before.length;
    let paths;

    if (tidy) {
      // 1. drop repeated lines, trim lines that run over ink already drawn on the
      //    same straight line, and drop repeated dots and dots on ink.
      //    Each line keeps its direction; whatever is left of it (none, one or two
      //    pieces, or more) is drawn in its original place in the order.
      if (!seenExact.has(b.style)) seenExact.set(b.style, new Set());
      const seen = seenExact.get(b.style), ends = new Set(), dotSeen = new Set(), segs = [], dots = [];
      for (const [ax, ay, bx, by] of before) {
        if (ax === bx && ay === by) continue;
        ends.add(ax + "," + ay); ends.add(bx + "," + by);
      }
      // what this line draws is now on top: other pens' ink there no longer counts
      const drawn = (key, s0, s1) => {
        for (const [st, line] of inkLines.get(key)) if (st !== b.style) optUncover(line.iv, s0, s1);
      };
      for (const s of before) {
        const [ax, ay, bx, by] = s;
        if (ax === bx && ay === by) {
          const k = ax + "," + ay;
          if (ends.has(k) || dotSeen.has(k)) { stats.dots++; continue; }
          dotSeen.add(k); dots.push(s); continue;
        }
        const { key, dx, dy } = optLineKey(ax, ay, bx, by);
        if (!inkLines.has(key)) inkLines.set(key, new Map());
        const styles = inkLines.get(key);
        let line = styles.get(b.style);
        if (!line) { line = { iv: [], dx, dy, c: dy * ax - dx * ay }; styles.set(b.style, line); }
        const ta = ax * dx + ay * dy, tb = bx * dx + by * dy;
        const lo = Math.min(ta, tb), hi = Math.max(ta, tb);
        const exact = (ax < bx || (ax === bx && ay < by)) ? [ax, ay, bx, by].join() : [bx, by, ax, ay].join();
        const drawnBefore = seen.has(exact);
        seen.add(exact);
        const gaps = optCover(line.iv, lo, hi);  // the parts not inked yet (and now marks all of it inked)
        if (drawnBefore && !gaps.length) { stats.dupLines++; continue; } // the very same line again: always dropped
        if (gaps.length === 1 && gaps[0][0] === lo && gaps[0][1] === hi) { segs.push(s); drawn(key, lo, hi); continue; }
        let fresh = 0;
        for (const [g0, g1] of gaps) fresh += g1 - g0;
        const over = (hi - lo - fresh) / Math.sqrt(dx * dx + dy * dy);   // plotter units already inked
        if (over < OPT_MIN_TRIM) { segs.push(s); drawn(key, lo, hi); continue; } // not worth a pen lift: draw it whole
        stats.overlaps++;
        stats.overlapLen += over;
        if (!gaps.length) continue;                                       // all of it was inked already
        for (const [g0, g1] of gaps) drawn(key, g0, g1);
        if (ta > tb) gaps.reverse();
        for (const [g0, g1] of gaps) {
          const [s0, s1] = ta < tb ? [g0, g1] : [g1, g0];
          const p = optPointAt(line, s0), q = optPointAt(line, s1);
          segs.push([p[0], p[1], q[0], q[1]]);
        }
      }

      // 2. join segments into paths in their original order
      paths = optJoin(segs);
      for (const [ax, ay] of dots) paths.push([ax, ay, ax, ay]);

      // 3. take out middle nodes of straight runs
      for (let i = 0; i < paths.length; i++) {
        const p = paths[i];
        if (p.length <= 4) continue;
        const q = [p[0], p[1]];
        for (let j = 2; j < p.length - 2; j += 2) {
          const ax = q[q.length - 2], ay = q[q.length - 1], bx = p[j], by = p[j + 1], cx = p[j + 2], cy = p[j + 3];
          const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
          const dot = (bx - ax) * (cx - bx) + (by - ay) * (cy - by);
          if (cross === 0 && dot > 0) { stats.nodes++; continue; }
          q.push(bx, by);
        }
        q.push(p[p.length - 2], p[p.length - 1]);
        paths[i] = q;
      }

      // 4. order: always go to the nearest unplotted piece next (either end).
      paths = optOrder(paths, px, py);
    } else {
      paths = optJoin(before);                   // Smooth curves only: same pieces, same order
    }

    // 5. write it out: PU to the start (unless already there), PD through it,
    //    with arcs and circles in place of runs of short moves when smoothing.
    if (needPA) { out.push("PA;"); needPA = false; }
    for (const p of paths) {
      const pieces = smooth ? optFitArcs(p, stats) : null;
      if (pieces && pieces.circle) {
        const c = pieces.circle;
        out.push("PU" + c.cx + "," + c.cy + ";", "CI" + c.r + ";");
        penIsDown = false; px = c.cx; py = c.cy;
        stats.after++;
        continue;
      }
      if (p[0] !== px || p[1] !== py) { out.push("PU" + p[0] + "," + p[1] + ";"); penIsDown = false; }
      if (!pieces) {
        for (let j = 2; j < p.length; j += 2) { out.push("PD" + p[j] + "," + p[j + 1] + ";"); stats.after++; }
      } else {
        for (const pc of pieces) {
          if (pc.arc) {
            if (!penIsDown) out.push("PD;");
            out.push("AA" + pc.cx + "," + pc.cy + "," + optAngle(pc.sweep) + ";");
          } else {
            out.push("PD" + pc.x + "," + pc.y + ";");
          }
          penIsDown = true;
          stats.after++;
        }
      }
      penIsDown = true;
      px = p[p.length - 2]; py = p[p.length - 1];
    }
    out.push("PU;");
    penIsDown = false;
  }

  const result = out.join("");
  const t1 = optRead(result);
  if (t1.refuse) return { text: original, ok: false, reason: "check failed" };
  stats.liftsBefore = read.lifts; stats.liftsAfter = t1.lifts;
  stats.travelBefore = read.travel; stats.travelAfter = t1.travel;

  // Check: every arc, circle, label ... is still there, in the same order, at the same
  // spot; and (unless curves were smoothed, which changes lines on purpose) each pen
  // inks exactly the same lines and dots as in the original. Otherwise give back the original.
  const atPen = (r) => r.items.filter((it) => it.raw && OPT_AT_PEN.has(it.op))
    .map((it) => it.raw + "@" + (it.at.known ? it.at.x + "," + it.at.y + (it.at.down ? "v" : "^") : "?"));
  const a0 = atPen(read), a1 = atPen(t1);
  let k = 0;
  for (const s of a1) {
    if (k < a0.length && s === a0[k]) k++;
    else if (!(smooth && /^(AA|CI)/.test(s))) return { text: original, ok: false, reason: "check failed" };
  }                                                // (arcs and circles made by smoothing are extra)
  if (k !== a0.length) return { text: original, ok: false, reason: "check failed" };
  if (!smooth || !(stats.arcs + stats.circles + stats.straight)) {
    const ia = optInk(read), ib = optInk(t1);
    if (ia.size !== ib.size) return { text: original, ok: false, reason: "check failed" };
    for (const [st, ink] of ia) {
      if (!ib.has(st) || !optSameInk(ink, ib.get(st))) return { text: original, ok: false, reason: "check failed" };
    }
  }
  return { text: pre + result, ok: true, stats };
}

// Joins line pieces that follow on from each other into paths [x0,y0,x1,y1,...].
function optJoin(segs) {
  const paths = [];
  for (const [ax, ay, bx, by] of segs) {
    const p = paths[paths.length - 1];
    if (p && !(ax === bx && ay === by) && !(p.length === 4 && p[0] === p[2] && p[1] === p[3])) {
      const n = p.length;
      if (p[n - 2] === ax && p[n - 1] === ay) { p.push(bx, by); continue; }
    }
    paths.push([ax, ay, bx, by]);
  }
  return paths;
}

// Puts paths in the order that always goes to the nearest unplotted piece next
// (from either end, so a path may be turned round). Ends are kept in a grid so big
// files don't take forever.
function optOrder(paths, px, py) {
  const ordered = [];
  if (!paths.length) return ordered;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of paths) for (let j = 0; j < p.length; j += 2) {
    if (p[j] < minX) minX = p[j]; if (p[j] > maxX) maxX = p[j];
    if (p[j + 1] < minY) minY = p[j + 1]; if (p[j + 1] > maxY) maxY = p[j + 1];
  }
  const cell = Math.max(1, Math.ceil(Math.max(maxX - minX, maxY - minY) / Math.max(1, Math.sqrt(paths.length))));
  const cols = Math.floor((maxX - minX) / cell) + 1, rows = Math.floor((maxY - minY) / cell) + 1;
  const grid = new Map();
  const put = (x, y, v) => { const k = Math.floor((y - minY) / cell) * cols + Math.floor((x - minX) / cell); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(v); };
  paths.forEach((p, i) => { put(p[0], p[1], i * 2); put(p[p.length - 2], p[p.length - 1], i * 2 + 1); });
  const used = new Uint8Array(paths.length);
  let cx0 = px === null ? paths[0][0] : px, cy0 = py === null ? paths[0][1] : py;
  for (let k = 0; k < paths.length; k++) {
    const gx = Math.min(cols - 1, Math.max(0, Math.floor((cx0 - minX) / cell)));
    const gy = Math.min(rows - 1, Math.max(0, Math.floor((cy0 - minY) / cell)));
    let best = -1, bestD = Infinity;
    for (let r = 0; r <= Math.max(cols, rows); r++) {
      if (best >= 0 && (r - 1) * cell > Math.sqrt(bestD)) break;
      for (let yy = gy - r; yy <= gy + r; yy++) {
        if (yy < 0 || yy >= rows) continue;
        for (let xx = gx - r; xx <= gx + r; xx++) {
          if (xx < 0 || xx >= cols) continue;
          if (Math.max(Math.abs(xx - gx), Math.abs(yy - gy)) !== r) continue;
          const list = grid.get(yy * cols + xx); if (!list) continue;
          for (const v of list) {
            const i = v >> 1; if (used[i]) continue;
            const p = paths[i], e = v & 1 ? p.length - 2 : 0;
            const d = (p[e] - cx0) ** 2 + (p[e + 1] - cy0) ** 2;
            if (d < bestD || (d === bestD && v < best)) { bestD = d; best = v; }
          }
        }
      }
    }
    const i = best >> 1; used[i] = 1;
    let p = paths[i];
    if (best & 1) { const r = []; for (let j = p.length - 2; j >= 0; j -= 2) r.push(p[j], p[j + 1]); p = r; }
    ordered.push(p);
    cx0 = p[p.length - 2]; cy0 = p[p.length - 1];
  }
  return ordered;
}

// ── Smooth curves ───────────────────────────────────────────────────
// Splits a path [x0,y0,x1,y1,...] into straight moves {x, y} and arcs {arc, cx, cy,
// sweep, x, y} (sweep in degrees, + = anticlockwise, as HP-GL's AA). Returns null when
// nothing in it is worth turning into an arc, or { circle: {cx, cy, r} } when the whole
// path is one closed circle.
function optFitArcs(p, stats) {
  const n = p.length / 2 - 1;                    // moves in the path
  if (n < 2) return null;
  const P = (k) => [p[2 * k], p[2 * k + 1]];
  const closed = p[0] === p[p.length - 2] && p[1] === p[p.length - 1];

  // a closed ring of moves on one circle: a single CI
  if (closed && n >= 6) {
    const c = optCircleFit(P, 0, n, true);
    if (c) { stats.circles++; stats.arcMoves += n; return { circle: { cx: c.cx, cy: c.cy, r: c.r } }; }
  }

  const pieces = [];
  let i = 0, any = false;
  while (i < n) {
    // the longest straight move from here that every point in between stays close to
    let line = i + 1;
    for (let j = i + 2; j <= n && j - i <= OPT_LINE_MAX; j++) {
      if (!optStraightRun(P, i, j)) break;
      line = j;
    }
    // Never let a straightened line run back over the piece just drawn: a tiny closed
    // shape (a box a few units across) would otherwise collapse into one line drawn
    // there and back. Those points stay as they were.
    if (line > i + 1 && pieces.length && optRetraces(pieces[pieces.length - 1], P(i - 1 >= 0 ? i - 1 : 0), P(i), P(line), i)) {
      line = i + 1;
    }
    let best = null;
    if (i + OPT_ARC_MIN <= n) {
      let c = optCircleFit(P, i, i + OPT_ARC_MIN, false);
      if (c) {
        best = { j: i + OPT_ARC_MIN, c };
        for (let j = i + OPT_ARC_MIN + 1; j <= n; j++) {
          c = optCircleFit(P, i, j, false);
          if (!c) break;
          best = { j, c };
        }
      }
    }
    if (line > i + 1 && (!best || line > best.j)) {   // a tie goes to the arc: keeps small circles round
      const [x, y] = P(line);                    // a staircase (or wobble) drawn as one line
      pieces.push({ x, y, from: P(i) });
      stats.straight++; stats.straightMoves += line - i;
      i = line; any = true;
    } else if (best) {
      const [ex, ey] = P(best.j);
      pieces.push({ arc: true, cx: best.c.cx, cy: best.c.cy, sweep: best.c.sweep, x: ex, y: ey });
      stats.arcs++; stats.arcMoves += best.j - i;
      i = best.j; any = true;
    } else {
      const [x, y] = P(i + 1);
      pieces.push({ x, y, from: P(i) });
      i++;
    }
  }
  return any ? pieces : null;
}

// Would a straight move from b to c go back over the line piece just drawn (ending
// at b), in the opposite direction? prev is that piece; a is where it started when
// it's a plain line (for arcs, the point before b).
function optRetraces(prev, a, b, c, i) {
  if (prev.arc) return false;
  const start = prev.from || a;
  const ux = b[0] - start[0], uy = b[1] - start[1], vx = c[0] - b[0], vy = c[1] - b[1];
  if (ux * vx + uy * vy >= 0) return false;      // carries on forward or turns: fine
  const L = Math.hypot(ux, uy);
  if (!L) return false;
  return Math.abs(ux * (start[1] - c[1]) - (start[0] - c[0]) * uy) / L <= OPT_ARC_TOL; // lies on it
}

// Points i..j of a path can be drawn as one straight move from point i to point j:
// every point in between lies within OPT_ARC_TOL of that line (measured to the line
// itself, ends included, so a run that turns back on itself doesn't count).
function optStraightRun(P, i, j) {
  const [ax, ay] = P(i), [bx, by] = P(j);
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  if (!L) return false;
  let lastT = 0, turned = 0;
  for (let k = i + 1; k < j; k++) {
    const [x, y] = P(k);
    const t = ((x - ax) * dx + (y - ay) * dy) / L;
    if (t < 0 || t > 1) return false;
    if (t < lastT - OPT_ARC_TOL / Math.sqrt(L)) return false;   // keeps moving forward along the line
    lastT = Math.max(lastT, t);
    // A staircase zig-zags (turns left, then right); a U-turn (a thin rectangle drawn as
    // a thick line) turns the same way twice. Only zig-zags are straightened.
    const [px, py] = P(k - 1), [nx, ny] = P(k + 1);
    let a1 = Math.atan2(ny - y, nx - x) - Math.atan2(y - py, x - px);
    if (a1 > Math.PI) a1 -= 2 * Math.PI; else if (a1 <= -Math.PI) a1 += 2 * Math.PI;
    turned += a1;
    if (Math.abs(turned) > OPT_LINE_TURN * Math.PI / 180) return false;
    if (Math.abs(dx * (ay - y) - (ax - x) * dy) / Math.sqrt(L) > OPT_ARC_TOL) return false;
  }
  return true;
}

// Fits one circle through the points i..j of a path and checks it is good enough
// to draw them as one arc (or, with whole, one full circle). The centre is rounded
// to whole plotter units and the radius taken from the first point, as the plotter
// does. Returns { cx, cy, r, sweep } or null.
function optCircleFit(P, i, j, whole) {
  const m = (i + j) >> 1;
  const [ax, ay] = P(i), [bx, by] = whole ? P(i + Math.round((j - i) / 3)) : P(m),
        [qx, qy] = whole ? P(i + Math.round(2 * (j - i) / 3)) : P(j);
  const d = 2 * (ax * (by - qy) + bx * (qy - ay) + qx * (ay - by));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, q2 = qx * qx + qy * qy;
  const cx = Math.round((a2 * (by - qy) + b2 * (qy - ay) + q2 * (ay - by)) / d);
  const cy = Math.round((a2 * (qx - bx) + b2 * (ax - qx) + q2 * (bx - ax)) / d);
  const r = Math.hypot(ax - cx, ay - cy);
  if (r < 2 || r > 200000) return null;
  let sweep = 0, dir = 0;
  let [px0, py0] = P(i);
  for (let k = i + 1; k <= j; k++) {
    const [x, y] = P(k);
    if (Math.abs(Math.hypot(x - cx, y - cy) - r) > OPT_ARC_TOL) return null;
    let t = Math.atan2(y - cy, x - cx) - Math.atan2(py0 - cy, px0 - cx);
    if (t > Math.PI) t -= 2 * Math.PI; else if (t <= -Math.PI) t += 2 * Math.PI;
    const s = Math.sign(t);
    if (!s || (dir && s !== dir)) return null;   // all turning the same way round
    dir = s;
    const td = Math.abs(t) * 180 / Math.PI;
    if (td > OPT_ARC_STEP) return null;
    if (r * (1 - Math.cos(Math.abs(t) / 2)) > OPT_ARC_BULGE) return null; // a real corner, not a curve
    sweep += t;
    px0 = x; py0 = y;
  }
  const deg = sweep * 180 / Math.PI;
  if (whole) {
    if (Math.abs(Math.abs(deg) - 360) > 1) return null;
    return { cx, cy, r: Math.round(r), sweep: deg };
  }
  if (Math.abs(deg) >= 359) return null;
  // where the plotter will end the arc (sweep written with 2 decimals) must be within
  // the tolerance of the real end point
  const sw = Number(optAngle(deg));
  const a = Math.atan2(ay - cy, ax - cx) + sw * Math.PI / 180;
  const [ex, ey] = P(j);
  if (Math.hypot(cx + r * Math.cos(a) - ex, cy + r * Math.sin(a) - ey) > OPT_ARC_TOL) return null;
  return { cx, cy, r, sweep: deg };
}

// An arc's sweep as written: degrees with at most 2 decimals.
function optAngle(deg) {
  return String(Math.round(deg * 100) / 100);
}

// ── Ink (for the check) ─────────────────────────────────────────────
// Ink per pen: for each pen (with its line type and width), every straight line as a
// stretch of an exact integer line, overlapping stretches merged; dots kept unless
// they sit on a stretch of the same pen. Takes optRead's result. Returns a Map:
// style -> { lines, dots }.
function optInk(read) {
  const inks = new Map();
  for (const it of read.items) {
    if (!it.seg) continue;
    if (!inks.has(it.style)) inks.set(it.style, { lines: new Map(), dots: [] });
    optAdd(inks.get(it.style), ...it.seg);
  }
  for (const b of inks.values()) {
    for (const [k, iv] of b.lines) {
      iv.sort((p, q) => p[0] - q[0]);
      const mg = [];
      for (const s of iv) { const l = mg[mg.length - 1]; if (l && s[0] <= l[1]) l[1] = Math.max(l[1], s[1]); else mg.push(s.slice()); }
      b.lines.set(k, mg);
    }
    b.dots = [...new Set(b.dots.filter(([dx, dy]) => !optOnInk(b, dx, dy)).map((d) => d.join()))].sort();
  }
  for (const [st, b] of inks) if (!b.lines.size && !b.dots.length) inks.delete(st);
  return inks;
}

// The stretch lo..hi of one straight line is about to be drawn. iv holds the
// stretches already inked on that line (sorted, not overlapping). Returns the
// parts of lo..hi not inked yet, and adds lo..hi to iv.
function optCover(iv, lo, hi) {
  let a = 0, b = iv.length;                    // first stretch that ends at or after lo
  while (a < b) { const m = (a + b) >> 1; if (iv[m][1] < lo) a = m + 1; else b = m; }
  const gaps = [];
  let at = lo, j = a, s = lo, e = hi;
  for (; j < iv.length && iv[j][0] <= hi; j++) {
    if (iv[j][0] > at) gaps.push([at, iv[j][0]]);
    if (iv[j][1] > at) at = iv[j][1];
    if (iv[j][0] < s) s = iv[j][0];
    if (iv[j][1] > e) e = iv[j][1];
  }
  if (at < hi) gaps.push([at, hi]);
  iv.splice(a, j - a, [s, e]);
  return gaps;
}

// Takes lo..hi out of a line's inked stretches (another pen has drawn over it).
function optUncover(iv, lo, hi) {
  if (!iv.length || hi <= lo) return;
  const keep = [];
  for (const [s, e] of iv) {
    if (e <= lo || s >= hi) { keep.push([s, e]); continue; }
    if (s < lo) keep.push([s, lo]);
    if (e > hi) keep.push([hi, e]);
  }
  iv.length = 0;
  for (const v of keep) iv.push(v);
}

// The whole-number point at position t along a line from optLineKey.
// (t = x*dx + y*dy and c = dy*x - dx*y, solved for x and y.)
function optPointAt(line, t) {
  const { dx, dy, c } = line, L = dx * dx + dy * dy;
  return [Math.round((t * dx + c * dy) / L), Math.round((t * dy - c * dx) / L)];
}

function optGcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a; }

function optLineKey(ax, ay, bx, by) {
  let dx = bx - ax, dy = by - ay; const g = optGcd(dx, dy); dx /= g; dy /= g;
  if (dx < 0 || (dx === 0 && dy < 0)) { dx = -dx; dy = -dy; }
  const c = dy * ax - dx * ay;                 // same for every point on the line
  return { key: dx + "," + dy + "," + c, dx, dy };
}

function optAdd(b, ax, ay, bx, by) {
  if (ax === bx && ay === by) { b.dots.push([ax, ay]); return; }
  const { key, dx, dy } = optLineKey(ax, ay, bx, by);
  const t1 = ax * dx + ay * dy, t2 = bx * dx + by * dy;
  if (!b.lines.has(key)) b.lines.set(key, []);
  b.lines.get(key).push([Math.min(t1, t2), Math.max(t1, t2)]);
}

function optOnInk(b, x, y) {
  if (!b.keys) b.keys = [...b.lines].map(([k, iv]) => [...k.split(",").map(Number), iv]);
  for (const [dx, dy, c, iv] of b.keys) {
    if (dy * x - dx * y !== c) continue;
    const t = x * dx + y * dy;
    if (iv.some(([s, e]) => t >= s && t <= e)) return true;
  }
  return false;
}

function optSameInk(a, b) {
  if (a.lines.size !== b.lines.size || a.dots.join("|") !== b.dots.join("|")) return false;
  for (const [k, iv] of a.lines) {
    const jv = b.lines.get(k);
    if (!jv || jv.length !== iv.length) return false;
    for (let i = 0; i < iv.length; i++) if (iv[i][0] !== jv[i][0] || iv[i][1] !== jv[i][1]) return false;
  }
  return true;
}

if (typeof module !== "undefined") module.exports = { optimizeHPGL, optRead, optFitArcs };
