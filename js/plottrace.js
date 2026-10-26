// ── plottrace.js ──────────────────────────────────────────────────
// While a plot runs on the 7585B, draws in red over the corrected preview what the pen
// has drawn so far, with the last few lines brighter and a dot where the pen is now.
//
// How it knows: plot.js has the exact text that was sent. The Pi reports every few
// seconds how many bytes have gone down the cable (job.sent). The plotter keeps about
// 1 KB of that in its buffer before drawing it (7585B manual: 1,024-byte I/O buffer by
// default), so the pen is roughly that far behind. Between reports the position moves
// on at the rate the bytes have been going. Approximate, but close: it's a few short
// lines out at most on a busy drawing.
//
// The trace is drawn in the coordinates that were sent, so it shows where the pen
// really is on the paper even if the drawing is dragged or resized afterwards.
// Only the 7585B: the 750C takes the whole file over the network at once.

(function () {
  const LAG = 1100;             // bytes between "sent down the cable" and the pen (1,024 buffer + a little)
  const HEAD = 500;             // bytes of the most recent drawing shown brighter
  const TICK = 250;             // ms between redraws

  let job = null;               // { id, name, segs, total }
  let est = 0;                  // estimated byte position of the pen
  let lastSent = -1, lastAt = 0, rate = 0, finished = false;
  let timer = 0;
  let layer = null;             // { done, head, map, drawn }

  // ── The sent text → pen-down line segments, each with the byte where it ends ──
  // Same commands the preview and the move count understand: IN PU PD PA PR CI AA AR EA ER.
  function segments(text) {
    const x1 = [], y1 = [], x2 = [], y2 = [], end = [];
    const add = (ax, ay, bx, by, at) => { x1.push(ax); y1.push(ay); x2.push(bx); y2.push(by); end.push(at); };
    let x = 0, y = 0, down = false, abs = true, term = "\x03";
    const n = text.length, num = /[-+]?(?:\d+\.?\d*|\.\d+)/g;
    let i = 0;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) { i++; continue; }
      const op = text.substr(i, 2).toUpperCase();
      i += 2;
      if (op === "LB") {                                  // label: skip its text
        const e = text.indexOf(term, i);
        i = e < 0 ? n : e + 1;
        continue;
      }
      if (op === "DT") { if (i < n) term = text[i]; i++; continue; }
      let j = i;
      while (j < n) {
        const d = text.charCodeAt(j);
        if (d === 59 || (d >= 65 && d <= 90) || (d >= 97 && d <= 122)) break;
        j++;
      }
      const vals = [], at = [];
      num.lastIndex = 0;
      const ps = text.slice(i, j);
      let m;
      while ((m = num.exec(ps))) { vals.push(parseFloat(m[0])); at.push(i + m.index + m[0].length); }
      i = j;
      const cmdEnd = j;
      switch (op) {
        case "IN": down = false; abs = true; break;
        case "PU": case "PD": case "PA": case "PR": {
          if (op === "PU") down = false; else if (op === "PD") down = true;
          else abs = (op === "PA");
          for (let k = 0; k + 1 < vals.length; k += 2) {
            const nx = abs ? vals[k] : x + vals[k], ny = abs ? vals[k + 1] : y + vals[k + 1];
            if (down) add(x, y, nx, ny, at[k + 1]);
            x = nx; y = ny;
          }
          break;
        }
        case "CI": {
          if (!vals.length) break;
          const r = Math.abs(vals[0]);
          const pts = arcPoints(x, y, x + r, y, 360);
          for (let k = 1; k < pts.length; k++) add(pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1], cmdEnd);
          break;
        }
        case "AA": case "AR": {
          if (vals.length < 3) break;
          const cx = op === "AA" ? vals[0] : x + vals[0], cy = op === "AA" ? vals[1] : y + vals[1];
          const pts = arcPoints(cx, cy, x, y, vals[2]);
          if (down) for (let k = 1; k < pts.length; k++) add(pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1], cmdEnd);
          const last = pts[pts.length - 1];
          x = last[0]; y = last[1];
          break;
        }
        case "EA": case "ER": {
          if (vals.length < 2) break;
          const ex = op === "EA" ? vals[0] : x + vals[0], ey = op === "EA" ? vals[1] : y + vals[1];
          add(x, y, ex, y, cmdEnd); add(ex, y, ex, ey, cmdEnd);
          add(ex, ey, x, ey, cmdEnd); add(x, ey, x, y, cmdEnd);
          break;
        }
      }
    }
    return { x1, y1, x2, y2, end, count: end.length };
  }

  // Index of the first segment ending after byte b (segments are in byte order).
  function firstAfter(b) {
    const e = job.segs.end;
    let lo = 0, hi = e.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (e[mid] <= b) lo = mid + 1; else hi = mid; }
    return lo;
  }

  // ── Overlay canvases on top of the corrected preview ──
  function makeLayer() {
    const box = document.getElementById("previewCorrected");
    const map = box && box.__map;
    if (!map || !map.canvas.isConnected) return null;
    const cv = map.canvas;
    const k = cv.clientWidth / map.width;                  // the canvas may be shown smaller than drawn
    const bRect = box.getBoundingClientRect(), cRect = cv.getBoundingClientRect();
    const left = cRect.left - bRect.left - box.clientLeft + cv.clientLeft;
    const top  = cRect.top  - bRect.top  - box.clientTop  + cv.clientTop;
    const hiRes = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    const mk = () => {
      const o = document.createElement("canvas");
      o.className = "plot-trace";
      o.style.left = left + "px"; o.style.top = top + "px";
      o.style.width = cv.clientWidth + "px"; o.style.height = cv.clientHeight + "px";
      o.width = Math.round(cv.clientWidth * hiRes); o.height = Math.round(cv.clientHeight * hiRes);
      const ctx = o.getContext("2d");
      ctx.setTransform(hiRes * k, 0, 0, hiRes * k, 0, 0);
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      box.appendChild(o);
      return { o, ctx };
    };
    return { done: mk(), head: mk(), map, drawn: 0 };
  }

  function dropLayer() {
    if (layer) { layer.done.o.remove(); layer.head.o.remove(); }
    layer = null;
  }

  // Is the corrected preview showing the file this job came from?
  function sameFile() {
    if (typeof currentFile === "undefined" || !currentFile || !currentFile.name) return false;
    const base = currentFile.name.replace(/\.[^.]+$/, "");
    return !!base && job.name.startsWith(base);
  }

  function strokeRange(ctx, a, b) {
    const s = job.segs, P = layer.map.toScreen;
    ctx.beginPath();
    for (let k = a; k < b; k++) {
      const [ax, ay] = P(s.x1[k], s.y1[k]), [bx, by] = P(s.x2[k], s.y2[k]);
      ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
    }
    ctx.stroke();
  }

  function draw() {
    if (!job) return;
    if (!sameFile()) { dropLayer(); return; }
    if (!layer || !layer.map.canvas.isConnected) { dropLayer(); layer = makeLayer(); if (!layer) return; }
    const upTo = firstAfter(est);                         // segments [0, upTo) are drawn on the paper
    // what's done: added a piece at a time
    if (upTo > layer.drawn) {
      const c = layer.done.ctx;
      c.strokeStyle = "rgba(220, 30, 30, 0.5)";
      c.lineWidth = 1.3;
      strokeRange(c, layer.drawn, upTo);
      layer.drawn = upTo;
    }
    // the last few lines, brighter, and the pen
    const h = layer.head.ctx, cv = layer.head.o;
    h.save(); h.setTransform(1, 0, 0, 1, 0, 0); h.clearRect(0, 0, cv.width, cv.height); h.restore();
    if (finished || !upTo) return;
    const from = firstAfter(est - HEAD);
    h.strokeStyle = "rgba(255, 0, 0, 0.35)"; h.lineWidth = 7; strokeRange(h, from, upTo);
    h.strokeStyle = "#ff1a1a"; h.lineWidth = 2.6; strokeRange(h, from, upTo);
    const s = job.segs, [px, py] = layer.map.toScreen(s.x2[upTo - 1], s.y2[upTo - 1]);
    const pulse = 4 + 2 * Math.sin(Date.now() / 160);
    h.fillStyle = "rgba(255, 0, 0, 0.25)";
    h.beginPath(); h.arc(px, py, pulse + 5, 0, 2 * Math.PI); h.fill();
    h.fillStyle = "#e00000"; h.strokeStyle = "#fff"; h.lineWidth = 1.5;
    h.beginPath(); h.arc(px, py, 4, 0, 2 * Math.PI); h.fill(); h.stroke();
  }

  function tick() {
    if (!job || finished) return;
    if (lastSent >= 0 && rate > 0) {
      const guess = lastSent - LAG + rate * (Date.now() - lastAt) / 1000;
      est = Math.max(est, Math.min(guess, lastSent));        // never back, never past what was sent
    }
    draw();
  }

  // Redraw from scratch whenever the preview is drawn again (resize, drag, Size...).
  document.addEventListener("spt-corrected-drawn", () => { if (job) { dropLayer(); draw(); } });

  window.plotTrace = {
    // A job starts: text is exactly what was sent. Only the 7585B is traced.
    start(id, plotter, name, text) {
      this.clear();
      if (plotter !== "7585b" || !text || typeof arcPoints !== "function") return;
      job = { id, name: String(name || ""), segs: segments(text) };
      if (!job.segs.count) { job = null; return; }
      est = 0; lastSent = -1; rate = 0; finished = false;
      timer = setInterval(tick, TICK);
    },
    has(id) { return !!job && job.id === id; },
    // A report from the Pi (from the status poll).
    update(j) {
      if (!job || j.id !== job.id || finished) return;
      const sent = +j.sent || 0, now = Date.now();
      if (sent !== lastSent) {
        if (lastSent >= 0 && sent > lastSent) {
          const r = (sent - lastSent) / Math.max(0.5, (now - lastAt) / 1000);
          rate = rate ? rate * 0.5 + r * 0.5 : r;              // smooth it a little
        }
        lastSent = sent; lastAt = now;
        est = Math.max(est, sent - LAG);
      }
    },
    // The job ended: done clears the trace; stopped or failed leaves it showing where the pen got to.
    end(status) {
      if (!job) return;
      clearInterval(timer); timer = 0;
      if (status === "done") { this.clear(); return; }
      finished = true;
      draw();
    },
    clear() {
      clearInterval(timer); timer = 0;
      job = null; finished = false;
      dropLayer();
    },
  };
})();
