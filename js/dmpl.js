// ── dmpl.js ───────────────────────────────────────────────────────
// Turns the corrected HP-GL into DM/PL for Houston Instrument DM/PL plotters:
// the TRS-80 Multi-Pen Plotter (26-1191), the HiPlot DMP-3, 4, 6 and 7, and the
// single-pen HiPlot DMP-41 and 42.
//
// The corrector does all the positioning in HP-GL plotter units (bottom-left
// origin, the DM/PL home position). This file only translates the finished HP-GL:
//   1 HP-GL unit = 0.025 mm (1016 per inch)  →  1 plotter step = 0.005 in (200 per inch)
//
// Commands sent. All are in the 26-1191 owner's manual (Using the Plotter / Appendix C),
// and Appendix B of Houston Instrument's DM/PL Command Language manual (1984) lists
// every one of them for the DMP-3, 4, 6, 7, 8 and 9, whatever the serial number:
//   ;:  plotter select      H  home (lower left)     A  absolute positioning
//   U / D  pen up / down    x,y  move to coordinate   Pn  new pen (0-6; P0 = stow pen)
//   S text_  character plotting   @  deselect
// Neither the 26-1191 nor the DMP-3..9 has the EC command; they work in 0.005 in steps.
// The DMP-41/42 default to 0.005 in too (DMP-41/42 operation manual), so no EC is sent.
// For the DMP-41/42, the chart format (EH small / EF large) is sent first via the
// "preamble" option, matching the paper size chosen in the corrector.
//
// Text height codes differ (textStyle option):
//   "trs80": Srh  with h a single digit 1-9           (26-1191 owner's manual, Table 7)
//   "dmpl":  Srhh with hh "1 ","1+","2 " ... "5 "      (DM/PL manual 2.6.1, Table 2-4a)
// CC/CA exist on this plotter but take a centre relative to the pen, so arcs,
// circles and rectangles are sent as short line segments instead.
//
// Also: hpglToCbm1520(text, { maxX, maxY }) turns the same HP-GL into a Commodore
// BASIC program for the Commodore 1520 printer plotter (see the end of this file).
//
// Public:  hpglToDmpl(text, { pens, stepsPerInch, maxX, maxY, textStyle,
//                              preamble, clampPens })
//   preamble:  extra commands sent right after ;: (e.g. "EF ")
//   clampPens: false keeps every pen number (single-pen plotters with pen pause)
//          → { text, warnings: [..], segments, outOfRange }

(function () {
  "use strict";

  const HPGL_UNIT_MM = 0.025;           // one HP-GL plotter unit
  const LABEL_TERM_DEFAULT = "\x03";    // ETX
  // HP-GL default character size in cm when SI is not given (assumed: 0.19 wide x 0.27 high)
  const SI_DEFAULT_W = 0.19, SI_DEFAULT_H = 0.27;

  // Character height codes and their heights in inches at 0.005 in steps.
  const TEXT_STYLES = {
    // 26-1191 owner's manual, Table 7. Followed by a space, as in the manual's "S13 TANDY".
    trs80: { codes: ["1 ", "2 ", "3 ", "4 ", "5 ", "6 ", "7 ", "8 ", "9 "],
             sizes: [0.07, 0.105, 0.14, 0.21, 0.28, 0.42, 0.56, 0.85, 1.12] },
    // DM/PL manual 2.6.1 / Table 2-4a: a two-byte field; 1-5 are followed by a space,
    // the "+" sizes are not.
    dmpl:  { codes: ["1 ", "1+", "2 ", "2+", "3 ", "3+", "4 ", "4+", "5 "],
             sizes: [0.07, 0.105, 0.14, 0.21, 0.28, 0.42, 0.56, 0.84, 1.12] },
  };

  // ---------------------------------------------------------------- tokenizer
  function tokenize(src) {
    const out = [];
    const n = src.length;
    let i = 0;
    let labelTerm = LABEL_TERM_DEFAULT;
    const isLetter = c => (c >= "A" && c <= "Z") || (c >= "a" && c <= "z");

    while (i < n) {
      const c = src[i];

      // HP RS-232 device-control sequences: ESC . <letter> [params] [:]
      if (c === "\x1b") {
        i++;
        if (src[i] === ".") {
          i += 2;
          const m = /^[0-9;]*:/.exec(src.slice(i, i + 80));
          if (m) i += m[0].length;
        }
        continue;
      }

      if (!isLetter(c) || i + 1 >= n || !isLetter(src[i + 1])) { i++; continue; }

      const cmd = (c + src[i + 1]).toUpperCase();
      i += 2;

      if (cmd === "LB") {
        const end = src.indexOf(labelTerm, i);
        const stop = end === -1 ? n : end;
        out.push({ cmd, text: src.slice(i, stop) });
        i = stop + 1;
        continue;
      }

      if (cmd === "DT") {
        // The character right after DT becomes the label terminator; "DT;" restores ETX.
        if (i < n && src[i] !== ";") { labelTerm = src[i]; i++; }
        else labelTerm = LABEL_TERM_DEFAULT;
        out.push({ cmd, args: [] });
        continue;
      }

      if (cmd === "CO") {
        // Comment: skip a quoted string if present
        let j = i;
        while (j < n && /\s/.test(src[j])) j++;
        if (src[j] === '"') {
          const end = src.indexOf('"', j + 1);
          i = end === -1 ? n : end + 1;
        }
        continue;
      }

      if (cmd === "PE") {
        const end = src.indexOf(";", i);
        i = end === -1 ? n : end + 1;
        out.push({ cmd, args: [] });
        continue;
      }

      let j = i;
      while (j < n && /[0-9+\-.,\s]/.test(src[j])) j++;
      const args = src.slice(i, j).split(/[\s,]+/)
        .filter(s => s.length).map(Number).filter(Number.isFinite);
      out.push({ cmd, args });
      i = j;
    }
    return out;
  }

  // ---------------------------------------------------------------- HPGL interpreter
  // Produces a list of ops in HP-GL plotter units:
  //   {t:"move"|"draw", x, y}   {t:"pen", n}   {t:"label", x, y, text, h}
  function interpret(tokens, opt, warn) {
    const ops = [{ t: "move", x: 0, y: 0 }];
    let target = ops;
    let poly = null, polyStart = null, polyNeedStart = false;

    let abs = true, down = false;
    let px = 0, py = 0;                 // current position, plotter units
    let ip = null, sc = null;
    let siW = SI_DEFAULT_W, siH = SI_DEFAULT_H;
    const chordDefault = 5;

    const scaling = () => sc !== null && ip !== null;
    const toPlot = (ux, uy) => scaling()
      ? [ip[0] + (ux - sc[0]) * (ip[2] - ip[0]) / (sc[1] - sc[0]),
         ip[1] + (uy - sc[2]) * (ip[3] - ip[1]) / (sc[3] - sc[2])]
      : [ux, uy];
    const toUser = (x, y) => scaling()
      ? [sc[0] + (x - ip[0]) * (sc[1] - sc[0]) / (ip[2] - ip[0]),
         sc[2] + (y - ip[1]) * (sc[3] - sc[2]) / (ip[3] - ip[1])]
      : [x, y];

    function push(t, x, y) {
      if (target === poly && polyNeedStart) { polyStart = [x, y]; polyNeedStart = false; }
      target.push({ t, x, y });
      px = x; py = y;
    }
    const goUser = (ux, uy, drawIt) => { const [x, y] = toPlot(ux, uy); push(drawIt ? "draw" : "move", x, y); };

    function moveList(args) {
      if (args.length % 2) warn("odd", "A pen move had an odd number of coordinates; the last one was ignored.");
      for (let k = 0; k + 1 < args.length; k += 2) {
        let ux = args[k], uy = args[k + 1];
        if (!abs) { const [cx, cy] = toUser(px, py); ux += cx; uy += cy; }
        goUser(ux, uy, down);
      }
    }

    const chordOf = v => (v === undefined ? chordDefault : Math.min(45, Math.max(0.5, Math.abs(v))));

    function arcPoints(cx, cy, r, a0, sweep, chord) {
      const steps = Math.max(1, Math.ceil(Math.abs(sweep) / chord));
      const pts = [];
      for (let k = 1; k <= steps; k++) {
        const a = (a0 + sweep * k / steps) * Math.PI / 180;
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
      return pts;
    }

    function rectangle(args, relative, filled, cmd) {
      if (args.length < 2) return;
      const [x0, y0] = toUser(px, py);
      const x1 = relative ? x0 + args[0] : args[0];
      const y1 = relative ? y0 + args[1] : args[1];
      goUser(x1, y0, true); goUser(x1, y1, true); goUser(x0, y1, true); goUser(x0, y0, true);
      if (filled) warn("fill-" + cmd, `${cmd} (filled rectangle) was drawn as an outline only.`);
    }

    for (const tk of tokens) {
      const a = tk.args || [];
      switch (tk.cmd) {
        case "IN": abs = true; down = false; sc = null; ip = null; siW = SI_DEFAULT_W; siH = SI_DEFAULT_H; break;
        case "DF": abs = true; sc = null; siW = SI_DEFAULT_W; siH = SI_DEFAULT_H; break;
        case "PA": abs = true; moveList(a); break;
        case "PR": abs = false; moveList(a); break;
        case "PU": down = false; moveList(a); break;
        case "PD": down = true; moveList(a); break;

        case "SP": {
          let n = Math.trunc(a[0] ?? 0);
          if (opt.clampPens !== false && n > opt.pens) { warn("pen-" + n, `SP${n} is beyond the ${opt.pens} pens available; pen ${opt.pens} was used.`); n = opt.pens; }
          if (n < 0) n = 0;
          target.push({ t: "pen", n });
          break;
        }

        case "IP":
          if (a.length >= 4) ip = a.slice(0, 4);
          else { ip = null; if (sc) warn("ip-default", "IP without parameters resets P1/P2 to the source plotter's defaults, which this converter can't know; scaling was turned off."); }
          break;

        case "SC":
          if (a.length === 0) sc = null;
          else if (a.length >= 4) {
            sc = a.slice(0, 4);
            if (a.length > 4 && a[4] !== 0) warn("sc-iso", "Isotropic SC scaling isn't supported; it was treated as anisotropic.");
            if (sc[1] === sc[0] || sc[3] === sc[2]) { sc = null; warn("sc-bad", "An SC command had a zero-size range and was ignored."); }
            if (!ip) warn("sc-noip", "SC was used without an IP command. The source plotter's default P1/P2 aren't known, so user units were treated as plotter units. Output scale may be wrong.");
          }
          break;

        case "CI": {
          if (!a.length) break;
          const r = Math.abs(a[0]);
          const start = a[0] < 0 ? 180 : 0;
          const [cx, cy] = toUser(px, py);
          goUser(cx + r * Math.cos(start * Math.PI / 180), cy, false);
          for (const [x, y] of arcPoints(cx, cy, r, start, 360, chordOf(a[1]))) goUser(x, y, true);
          goUser(cx, cy, false);
          break;
        }

        case "AA":
        case "AR": {
          if (a.length < 3) break;
          const [ux, uy] = toUser(px, py);
          const cx = tk.cmd === "AA" ? a[0] : ux + a[0];
          const cy = tk.cmd === "AA" ? a[1] : uy + a[1];
          const r = Math.hypot(ux - cx, uy - cy);
          if (r === 0) break;
          const a0 = Math.atan2(uy - cy, ux - cx) * 180 / Math.PI;
          for (const [x, y] of arcPoints(cx, cy, r, a0, a[2], chordOf(a[3]))) goUser(x, y, down);
          break;
        }

        case "EA": rectangle(a, false, false, "EA"); break;
        case "ER": rectangle(a, true, false, "ER"); break;
        case "RA": rectangle(a, false, true, "RA"); break;
        case "RR": rectangle(a, true, true, "RR"); break;

        case "PM": {
          const m = a[0] ?? 0;
          if (m === 0) {
            poly = [{ t: "move", x: px, y: py }];
            polyStart = [px, py]; polyNeedStart = false;
            target = poly;
          } else if (poly && (m === 1 || m === 2)) {
            if (polyStart) poly.push({ t: "draw", x: polyStart[0], y: polyStart[1] });
            polyNeedStart = true;
            if (m === 2) target = ops;
          }
          break;
        }

        case "EP":
        case "FP":
          if (poly) {
            const sx = px, sy = py;
            for (const op of poly) ops.push({ ...op });
            ops.push({ t: "move", x: sx, y: sy });
          }
          if (tk.cmd === "FP") warn("fp", "FP (fill polygon) was drawn as an outline only.");
          break;

        case "SI":
          if (a.length >= 2) { siW = a[0]; siH = a[1]; } else { siW = SI_DEFAULT_W; siH = SI_DEFAULT_H; }
          break;

        case "LB": {
          let text = tk.text;
          if (/[\r\n]/.test(text)) warn("lb-crlf", "Line breaks inside LB labels were removed; multi-line labels are drawn on one line.");
          text = text.replace(/[\r\n]/g, " ");
          if (text.includes("_")) warn("lb-us", "Underscores in labels were replaced with '-', since '_' ends character plotting.");
          if (text.includes("^")) warn("lb-caret", "Carets in labels were replaced with ' ', since '^' has a handshake meaning inside character plotting.");
          text = text.replace(/_/g, "-").replace(/\^/g, " ").replace(/[^\x20-\x7e]/g, "?");
          if (opt.labels && text.length) target.push({ t: "label", x: px, y: py, text, h: siH });
          else if (!opt.labels && text.length) warn("lb-skip", "LB labels were skipped (Convert LB text is off).");
          // Advance the pen by the label's width (HP-GL character cell is 1.5 x char width).
          push("move", px + text.length * siW * 1.5 * 400, py);
          break;
        }

        case "DT": break;
        case "PE": warn("pe", "PE (polyline encoded) data isn't supported and was skipped."); break;
        case "CT": if ((a[0] ?? 0) === 1) warn("ct", "CT1 (chord-length mode) isn't supported; chord angles were used instead."); break;
        case "LT": warn("lt", "LT line types were ignored. DM/PL's line patterns don't match HP-GL's."); break;
        case "VS": warn("vs", "VS pen speeds were ignored."); break;
        case "DI": case "DR": case "SL": case "SR": case "ES":
          warn("txt-dir", `Label direction, slant and spacing commands (${tk.cmd} and similar) were ignored.`); break;
        case "RO": warn("ro", "RO (rotate coordinate system) was ignored. Use the Rotate 90° option instead."); break;
        case "IW": warn("iw", "IW (input window) was ignored; no clipping was applied."); break;
        default:
          warn("unk-" + tk.cmd, `${tk.cmd} isn't supported and was ignored.`);
      }
    }
    if (target === poly) warn("pm-open", "A polygon (PM0) was never closed with PM2; it wasn't drawn.");
    return ops;
  }

  // ── DM/PL writer ──
  function emit(ops, opt, warn) {
    const factor = HPGL_UNIT_MM / 25.4 * opt.stepsPerInch;   // HP-GL units → plotter steps
    const fx = v => Math.round(v * factor);

    // Character height code nearest to the HP-GL label height (SI is in cm).
    const style = TEXT_STYLES[opt.textStyle] || TEXT_STYLES.trs80;
    function textCode(hcm) {
      const want = hcm / 2.54;
      let best = 0, bestErr = Infinity;
      style.sizes.forEach((sz, k) => {
        const err = Math.abs(Math.log(sz / want));
        if (err < bestErr) { bestErr = err; best = k; }
      });
      return style.codes[best];
    }

    // Leading space: the manual advises sending a character before the first ;:
    // after power-on or RESET.
    const toks = [" ;:" + (opt.preamble || "") + "H A "];
    let state = null, last = null, pen = null, pending = null;
    let segments = 0, outOfRange = false;
    const check = (x, y) => {
      if (x < 0 || y < 0 || x > opt.maxX || y > opt.maxY) outOfRange = true;
    };

    // Send the waiting pen-up move, so travel that leads nowhere is never output.
    function flushMove() {
      if (!pending) return;
      if (!(last && last.x === pending.x && last.y === pending.y)) {
        if (state !== "U") { toks.push("U "); state = "U"; }
        toks.push(`${pending.x},${pending.y},`);
        check(pending.x, pending.y);
        last = pending;
      }
      pending = null;
    }

    for (const op of ops) {
      if (op.t === "pen") {
        if (op.n !== pen) {
          toks.push(`P${op.n},`);
          // The manual says P (except P0) lowers the pen automatically on returning
          // to the last plotting position, so the next move must state U or D.
          state = null;
        }
        pen = op.n;
        continue;
      }
      const x = fx(op.x), y = fx(op.y);

      if (op.t === "move") {
        pending = { x, y };
      } else if (op.t === "draw") {
        flushMove();
        if (state !== "D") { toks.push("D "); state = "D"; }
        if (!(last && last.x === x && last.y === y)) {
          toks.push(`${x},${y},`);
          check(x, y);
          segments++;
        }
        last = { x, y };
      } else if (op.t === "label") {
        pending = { x, y };
        flushMove();
        if (state !== "U") { toks.push("U "); state = "U"; }
        toks.push(`S1${textCode(op.h)}${op.text}_ `);
        state = null; last = null;   // pen state and position after text aren't tracked
      }
    }
    if (state !== "U") toks.push("U ");
    if (pen !== 0) toks.push("P0,");   // stow the pen; the manual says always end with an empty holder
    toks.push("@");                     // deselect

    if (outOfRange) {
      warn("oob", `Some points fall outside the plotter's 0–${opt.maxX} × 0–${opt.maxY} step range; the plotter's soft limits will stop the pen there.`);
    }

    // Short lines, each ending in a delimiter. The plotter takes blocks of up to
    // 256 bytes ended by a CR and answers with a CR when it can take more.
    const lines = [];
    let line = "";
    for (const t of toks) {
      if (line.length + t.length > 72 && line.length) { lines.push(line); line = ""; }
      line += t;
    }
    if (line) lines.push(line);

    return { text: lines.join("\r\n") + "\r\n", segments, outOfRange };
  }

  // ── Commodore 1520 writer ──
  // The 1520 is not sent a command file: a BASIC program drives it through
  // secondary addresses on device 6 (1520 User's Manual, pp. 20-28):
  //   OPEN 1,6,1 then PRINT#1,"M",x,y  move (pen up) to absolute x,y
  //                   PRINT#1,"D",x,y  draw (pen down) to absolute x,y
  //                   PRINT#1,"H"      home (0,0)
  //   OPEN 2,6,2 then PRINT#2,n        pen colour 0 black, 1 blue, 2 green, 3 red
  // Steps are 0.2 mm (manual p. 16), so 1 HP-GL unit (0.025 mm) = 1/8 step.
  // HP-GL pen n becomes colour (n-1) mod 4; SP0 is ignored.
  // The drawing is kept as DATA lines read by a short loop, with each line under
  // 80 characters so it can be typed in on a C64.
  function emitCbm1520(ops, opt, warn) {
    const fx = v => Math.round(v * 0.025 / 0.2);
    const data = [];                      // DATA items as strings
    let last = null, pending = null, colour = null, outOfRange = false, segments = 0;
    const check = (x, y) => { if (x < 0 || y < -opt.maxY || x > opt.maxX || y > opt.maxY) outOfRange = true; };
    function flushMove() {
      if (!pending) return;
      if (!(last && last.x === pending.x && last.y === pending.y)) {
        data.push("M", String(pending.x), String(pending.y));
        check(pending.x, pending.y);
        last = pending;
      }
      pending = null;
    }
    for (const op of ops) {
      if (op.t === "pen") {
        if (op.n === 0) continue;
        const c = (op.n - 1) % 4;
        if (c !== colour) { data.push("C", String(c)); colour = c; }
        continue;
      }
      if (op.t === "label") { warn("cbm-lb", "LB labels were skipped; the 1520 prints text through a separate channel."); continue; }
      const x = fx(op.x), y = fx(op.y);
      if (op.t === "move") pending = { x, y };
      else if (op.t === "draw") {
        flushMove();
        if (!(last && last.x === x && last.y === y)) {
          data.push("D", String(x), String(y));
          check(x, y);
          segments++;
        }
        last = { x, y };
      }
    }
    data.push("E");
    if (outOfRange) warn("oob", `Some points fall outside the 1520's 0–${opt.maxX} × 0–${opt.maxY} step area; it lifts the pen past the edge.`);

    const lines = [
      "10 REM PLOT FOR COMMODORE 1520 (DEVICE 6)",
      "20 OPEN1,6,1:OPEN2,6,2:PRINT#1,\"H\"",
      "30 READ C$:IF C$=\"E\" THEN 70",
      "40 IF C$=\"C\" THEN READ N:PRINT#2,N:GOTO 30",
      "50 READ X,Y:PRINT#1,C$,X,Y:GOTO 30",
      "70 PRINT#1,\"H\":PRINT#2,0:CLOSE2:CLOSE1:END",
    ];
    let n = 100, cur = "";
    for (const item of data) {
      const add = cur ? "," + item : item;
      if ((String(n) + " DATA " + cur + add).length > 78 && cur) {
        lines.push(`${n} DATA ${cur}`); n += 10; cur = item;
      } else cur += add;
    }
    if (cur) lines.push(`${n} DATA ${cur}`);
    if (n > 63999) warn("cbm-lines", "The program needs more line numbers than BASIC allows (63999); the plot is too detailed for the 1520.");
    const text = lines.join("\r\n") + "\r\n";
    if (text.length > 38000) warn("cbm-c64", `The program is about ${Math.round(text.length / 1024)} KB, likely too big for a C64's 38 KB of BASIC memory.`);
    else if (text.length > 3500) warn("cbm-vic", `The program is about ${Math.round(text.length / 1024)} KB; it won't fit an unexpanded VIC-20 (3.5 KB).`);
    return { text, segments, outOfRange };
  }

  window.hpglToCbm1520 = function (text, options) {
    const opt = Object.assign({ maxX: 479, maxY: 998, pens: 99, clampPens: false, labels: true }, options || {});
    const warnings = new Map();
    const warn = (k, m) => { if (!warnings.has(k)) warnings.set(k, m); };
    const ops = interpret(tokenize(text), opt, warn);
    const res = emitCbm1520(ops, opt, warn);
    if (!res.segments) warn("empty", "No drawing commands were found.");
    return { text: res.text, warnings: [...warnings.values()], segments: res.segments, outOfRange: res.outOfRange };
  };

  window.hpglToDmpl = function (text, options) {
    const opt = Object.assign({ pens: 6, stepsPerInch: 200, maxX: 1850, maxY: 1400, labels: true,
                                preamble: "", clampPens: true,
                                textStyle: "trs80" }, options || {});
    const warnings = new Map();
    const warn = (k, m) => { if (!warnings.has(k)) warnings.set(k, m); };
    const ops = interpret(tokenize(text), opt, warn);
    const res = emit(ops, opt, warn);
    if (!res.segments) warn("empty", "No drawing commands were found.");
    return { text: res.text, warnings: [...warnings.values()], segments: res.segments, outOfRange: res.outOfRange };
  };
})();