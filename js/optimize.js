// ── optimize.js ───────────────────────────────────────────────────
// "Optimize paths": takes out moves that leave no mark of their own, and
// shortens the pen's trips between pieces, without changing what is drawn.
//
//   - a line drawn a second time (either direction)       -> drawn once
//   - a line that runs partly over ink already there      -> only the new part is drawn
//     (the same straight line, e.g. two 3D wireframe faces sharing part of an edge)
//   - a dot on a spot that is already inked               -> dropped
//   - a node in the middle of a straight run (A-B-C)      -> A-C
//   - a pen-up to where the pen already is                -> dropped
//   - the order of the pieces (within one pen)            -> nearest next piece
//
// Only plain absolute moves are touched (PU, PD, PA). Every other command
// (SP, LT, VS, PW, ...) stays exactly where it was, and pieces never move
// across it, so colours still go down in the same order. Files that use
// anything this can't follow (relative moves, arcs, circles, labels,
// scaling...) are passed through unchanged.
//
// Before handing anything back, it checks that the new file inks exactly
// the same lines and dots as the original, pen by pen. If not, it returns
// the original and says so.

// Settings that may sit between pieces (kept in place; pieces never cross them).
// Anything not listed here (PR, arcs, circles, labels, symbols, fills...) means
// the file is passed through untouched.
const OPT_SAFE = new Set(["IN", "DF", "SP", "PU", "PD", "PA", "LT", "VS", "PW", "WU", "PG", "NP",
  "PS", "RO", "IP", "SC", "IW", "IM", "AF", "AH", "CS", "CA", "SS", "SA", "SI", "SR", "SL", "DI",
  "DR", "ES", "DT"]);

// A line that runs over ink already there is only trimmed when at least this much
// of it (plotter units, 40 = 1 mm) is already drawn. Below that, going over it again
// is quicker than the extra pen lift trimming it would cost.
const OPT_MIN_TRIM = 40;

function optimizeHPGL(text) {
  const original = text;
  // Device-control escapes at the very start (ESC.( and the like) are kept as they are.
  let pre = "";
  const first = text.search(/[A-Za-z]{2}/);
  if (first > 0 && text.slice(0, first).includes("\x1b")) { pre = text.slice(0, first); text = text.slice(first); }
  const cmds = [];
  const re = /([A-Za-z]{2})([^;A-Za-z]*);?/g;
  let m, stray = text.replace(re, "").replace(/[;\s]/g, "");
  if (stray) return { text: original, ok: false, reason: "file has codes this can't follow" };
  re.lastIndex = 0;
  while ((m = re.exec(text))) {
    const op = m[1].toUpperCase(), args = m[2].trim();
    if (!OPT_SAFE.has(op)) return { text: original, ok: false, reason: "file uses " + op };
    cmds.push({ op, args, raw: m[0].trim().replace(/;?$/, ";") });
  }

  // Walk the file: moves go into the current block as segments/dots;
  // any other command closes the block and is kept as it is.
  const blocks = [];          // { items: [[ax,ay,bx,by]...] } | { raw }
  let cur = { items: [] }, penDown = false, x = 0, y = 0;
  const flush = () => { if (cur.items.length) blocks.push(cur); cur = { items: [] }; };
  for (const c of cmds) {
    if (c.op === "PU" || c.op === "PD" || c.op === "PA") {
      if (c.op !== "PA") penDown = c.op === "PD";
      if (!c.args) continue;
      const n = c.args.split(/[\s,]+/).filter(Boolean).map(Number);
      if (n.length % 2 || n.some((v) => !Number.isInteger(v)))
        return { text: original, ok: false, reason: "file has non-whole coordinates" };
      for (let i = 0; i < n.length; i += 2) {
        if (penDown) cur.items.push([x, y, n[i], n[i + 1]]);
        x = n[i]; y = n[i + 1];
      }
    } else {
      flush();
      blocks.push({ raw: c.raw });
      if (c.op === "IN" || c.op === "DF") { penDown = false; }
    }
  }
  flush();

  const stats = { dupLines: 0, overlaps: 0, overlapLen: 0, dots: 0, nodes: 0, before: 0, after: 0 };
  let out = [], px = null, py = null;

  for (const b of blocks) {
    if (b.raw) { out.push(b.raw); continue; }
    const before = b.items;
    stats.before += before.length;

    // 1. drop repeated lines, trim lines that run over ink already drawn on the
    //    same straight line, and drop repeated dots and dots on ink.
    //    Each line keeps its direction; whatever is left of it (none, one or two
    //    pieces, or more) is drawn in its original place in the order.
    const seen = new Set(), ends = new Set(), segs = [], dots = [];
    const inked = new Map();                    // line key -> { iv: [[s,e]...] sorted, disjoint; dx, dy, c }
    for (const [ax, ay, bx, by] of before) {
      if (ax === bx && ay === by) continue;
      ends.add(ax + "," + ay); ends.add(bx + "," + by);
    }
    for (const s of before) {
      const [ax, ay, bx, by] = s;
      if (ax === bx && ay === by) {
        const k = ax + "," + ay;
        if (ends.has(k) || seen.has("d" + k)) { stats.dots++; continue; }
        seen.add("d" + k); dots.push(s); continue;
      }
      const { key, dx, dy } = optLineKey(ax, ay, bx, by);
      let line = inked.get(key);
      if (!line) { line = { iv: [], dx, dy, c: dy * ax - dx * ay }; inked.set(key, line); }
      const ta = ax * dx + ay * dy, tb = bx * dx + by * dy;
      const lo = Math.min(ta, tb), hi = Math.max(ta, tb);
      const exact = (ax < bx || (ax === bx && ay < by)) ? [ax, ay, bx, by].join() : [bx, by, ax, ay].join();
      const repeat = seen.has(exact);
      seen.add(exact);
      const gaps = optCover(line.iv, lo, hi);  // the parts not inked yet (and now marks all of it inked)
      if (repeat) { stats.dupLines++; continue; }                      // the very same line again: always dropped
      if (gaps.length === 1 && gaps[0][0] === lo && gaps[0][1] === hi) { segs.push(s); continue; }
      let fresh = 0;
      for (const [g0, g1] of gaps) fresh += g1 - g0;
      const over = (hi - lo - fresh) / Math.sqrt(dx * dx + dy * dy);   // plotter units already inked
      if (over < OPT_MIN_TRIM) { segs.push(s); continue; }              // not worth a pen lift: draw it whole
      stats.overlaps++;
      stats.overlapLen += over;
      if (!gaps.length) continue;                                       // all of it was inked already
      if (ta > tb) gaps.reverse();
      for (const [g0, g1] of gaps) {
        const [s0, s1] = ta < tb ? [g0, g1] : [g1, g0];
        const p = optPointAt(line, s0), q = optPointAt(line, s1);
        segs.push([p[0], p[1], q[0], q[1]]);
      }
    }

    // 2. join segments into paths in their original order
    const paths = [];
    for (const [ax, ay, bx, by] of segs) {
      const p = paths[paths.length - 1];
      if (p) { const n = p.length; if (p[n - 2] === ax && p[n - 1] === ay) { p.push(bx, by); continue; } }
      paths.push([ax, ay, bx, by]);
    }
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
    //    Ends are kept in a grid so big files don't take forever.
    const ordered = [];
    if (paths.length) {
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
    }

    // 5. write it out: PU to the start (unless already there), PD through it
    for (const p of ordered) {
      if (p[0] !== px || p[1] !== py) out.push("PU" + p[0] + "," + p[1] + ";");
      for (let j = 2; j < p.length; j += 2) { out.push("PD" + p[j] + "," + p[j + 1] + ";"); stats.after++; }
      px = p[p.length - 2]; py = p[p.length - 1];
    }
    out.push("PU;");
    px = null; py = null;                       // next block starts with its own PU
  }

  const result = out.join("");
  const t0 = optTravel(text), t1 = optTravel(result);
  stats.liftsBefore = t0.lifts; stats.liftsAfter = t1.lifts;
  stats.travelBefore = t0.travel; stats.travelAfter = t1.travel;

  // Check: same ink, block by block, or give back the original.
  const a = optInk(text), b2 = optInk(result);
  if (!a || !b2 || a.length !== b2.length) return { text: original, ok: false, reason: "check failed" };
  for (let i = 0; i < a.length; i++) if (!optSameInk(a[i], b2[i])) return { text: original, ok: false, reason: "check failed" };
  return { text: pre + result, ok: true, stats };
}

// How many times the pen goes down, and how far it travels with the pen up.
function optTravel(text) {
  let penDown = false, x = 0, y = 0, lifts = 0, travel = 0;
  const re = /([A-Za-z]{2})([^;A-Za-z]*);?/g; let m;
  while ((m = re.exec(text))) {
    const op = m[1].toUpperCase(), args = m[2].trim();
    if (op === "PD" && !penDown) { penDown = true; lifts++; }
    else if (op === "PU") penDown = false;
    else if (op === "IN" || op === "DF") penDown = false;
    if ((op === "PU" || op === "PD" || op === "PA") && args) {
      const n = args.split(/[\s,]+/).filter(Boolean).map(Number);
      for (let i = 0; i < n.length; i += 2) {
        if (!penDown) travel += Math.hypot(n[i] - x, n[i + 1] - y);
        x = n[i]; y = n[i + 1];
      }
    }
  }
  return { lifts, travel: Math.round(travel) };
}

// Ink per block: each straight line as a stretch of an exact integer line,
// overlapping stretches merged; dots kept unless they sit on a stretch.
function optInk(text) {
  const blocks = []; let cur = { lines: new Map(), dots: [] };
  let penDown = false, x = 0, y = 0;
  const re = /([A-Za-z]{2})([^;A-Za-z]*);?/g; let m;
  const close = () => { if (cur.lines.size || cur.dots.length) blocks.push(cur); cur = { lines: new Map(), dots: [] }; };
  while ((m = re.exec(text))) {
    const op = m[1].toUpperCase(), args = m[2].trim();
    if (op === "PU" || op === "PD" || op === "PA") {
      if (op !== "PA") penDown = op === "PD";
      if (!args) continue;
      const n = args.split(/[\s,]+/).filter(Boolean).map(Number);
      for (let i = 0; i < n.length; i += 2) {
        if (penDown) optAdd(cur, x, y, n[i], n[i + 1]);
        x = n[i]; y = n[i + 1];
      }
    } else { close(); if (op === "IN" || op === "DF") penDown = false; }
  }
  close();
  for (const b of blocks) {
    for (const [k, iv] of b.lines) {
      iv.sort((p, q) => p[0] - q[0]);
      const mg = [];
      for (const s of iv) { const l = mg[mg.length - 1]; if (l && s[0] <= l[1]) l[1] = Math.max(l[1], s[1]); else mg.push(s.slice()); }
      b.lines.set(k, mg);
    }
    b.dots = [...new Set(b.dots.filter(([dx, dy]) => !optOnInk(b, dx, dy)).map((d) => d.join()))].sort();
  }
  return blocks;
}

function optGcd(a, b) { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a; }

function optLineKey(ax, ay, bx, by) {
  let dx = bx - ax, dy = by - ay; const g = optGcd(dx, dy); dx /= g; dy /= g;
  if (dx < 0 || (dx === 0 && dy < 0)) { dx = -dx; dy = -dy; }
  const c = dy * ax - dx * ay;                 // same for every point on the line
  return { key: dx + "," + dy + "," + c, dx, dy };
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

// The whole-number point at position t along a line from optLineKey.
// (t = x*dx + y*dy and c = dy*x - dx*y, solved for x and y.)
function optPointAt(line, t) {
  const { dx, dy, c } = line, L = dx * dx + dy * dy;
  return [Math.round((t * dx + c * dy) / L), Math.round((t * dy - c * dx) / L)];
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

if (typeof module !== "undefined") module.exports = { optimizeHPGL };
