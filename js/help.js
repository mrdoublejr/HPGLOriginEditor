// ── help.js ───────────────────────────────────────────────────────
// The "?" button (top right) switches on help mode. While it is on, pointing at any
// part of the page shows a short, plain explanation of it right next to the pointer
// (on a phone or tablet: tap the part). Nothing gets clicked while help is on, so it
// is safe to explore. Click "?" again, or press Esc, to switch it off.
//
// The explanations are below: one entry per part of the page, first match wins.
(function () {
  const HELP = [
    ["#helpToggle", "Help",
      "You're in help mode. Point at anything on the page to see what it does. Click this button again (or press Esc) when you're done."],
    ["#themeToggle", "Light or dark",
      "Switches the page between light and dark colours. Your plot pictures stay white, like paper."],
    ["#contactLink", "Contact me",
      "Send me a message: a question, a problem, a plotter you'd like added, or manuals and documents to share."],
    ["header", "Spike's Pen Plotter Tools",
      "This page gets plot files ready for old pen plotters: it moves the drawing onto the paper the right way, can convert it for plotters that speak a different language, and lets you download the result."],
    ["#dropZone", "Your plot file",
      "Start here. Drag a plot file (.hpgl or .plt) onto this box, or click it to pick one from your computer."],
    [".sm-open, #sm-btn", "Public plots",
      "Don't have a plot file? Open a collection of ready-made drawings and pick one to try."],
    ["#uploadConsentLabel, #uploadConsent", "Share a copy",
      "When this is ticked, a copy of the file you open is sent to me to help improve the tool. Untick it if you'd rather not share."],
    ["#fileInfo", "About your file",
      "The name and size of the file you opened, and how far its drawing reaches."],
    ["#plotterSelect", "Your plotter",
      "Pick the plotter you'll use. Each one puts the drawing on the paper differently, so this matters."],
    ["#hpglVersion", "Plotter setting",
      "How your plotter understands the file. The usual choice is already picked; change it only if your plotter is set up differently."],
    ["#mediaSelect", "Paper size",
      "The paper you'll load in the plotter. The drawing is placed in the middle of it."],
    ["#plotterInfo", "Plotter details",
      "A quick summary of the chosen plotter: how many pens it holds and how much edge it leaves blank."],
    ["#plotterPicture", "The plotter",
      "A picture of the plotter you picked."],
    ["#previewOriginal", "Your file as it is",
      "How your file looks before any changes, on the paper you picked. The red dashed box is the area the plotter can reach."],
    ["#previewCorrected", "Ready to plot",
      "How it will come out on your plotter. You can drag the drawing to move it, and use the mouse wheel (or pinch) to make it bigger or smaller. Orange or red lines are lines the file draws more than once."],
    ["#btnRotatePlus", "Turn",
      "Turns the drawing a little at a time (an eighth of a turn per click)."],
    ["#btnFlipH", "Mirror sideways",
      "Flips the drawing left to right, like a mirror. Click again to undo."],
    ["#btnFlipV", "Mirror upside down",
      "Flips the drawing top to bottom. Click again to undo."],
    ["#btnZoomFit", "Fit to page",
      "Makes the drawing as big as it can be while still fitting on the paper, and centres it."],
    ["#btnZoomReset", "Original size",
      "Puts the drawing back to its original size."],
    ["#btnZoomOut, #btnZoomIn, #zoomSlider, #zoomPercent", "Size",
      "Makes the drawing smaller or bigger. 100% is the size the file was made at."],
    ["#btnResetOffset, #offsetDisplay", "Position",
      "How far you've dragged the drawing from the middle. “reset” puts it back in the middle."],
    ["#btnRepeats", "Show repeats",
      "Marks in orange and red any lines the file draws more than once, including a line that runs partly along one already drawn. The redder, the more times. It's just a marker on screen: it doesn't change your file."],
    ["#btnOptimize, #optStats", "Optimize",
      "Tidies the drawing so the plotter doesn't draw the same line twice (or go back over part of one) or wander around the paper. The picture stays exactly the same; it just plots quicker. The note beside it says what was saved."],
    ["#btnAllPen1", "All black",
      "Draws every colour in black: handy when only a black pen (or black ink) is loaded. Click again to bring the colours back."],
    ["#penTarget, .pen-target", "Switched-off pens",
      "Choose what happens to a colour you switch off: draw it in black, draw it with another pen, or skip it completely."],
    ["#penChips, #penGroup", "Pens (colours)",
      "One button for each colour in the drawing. Click a colour to switch it off; click again to switch it back on."],
    ["#btnDownload", "Download",
      "Saves the finished file to your computer, ready to send to your plotter."],
    ["#btnPlot, #plotStatus", "Plot",
      "Sends the file straight to the plotter. If Optimize is off and the drawing goes over lines already drawn, it asks first whether to optimize it."],
    ["#status", "Notes",
      "Small notes about the finished file, for example if any part had to be adjusted to fit."],
    ["#contactDialog", "Contact form",
      "Fill this in to send me a message. You can attach manuals, documents, photos or plot files."],
  ];

  let on = false, bubble = null, marked = null, lastFor = null;

  function match(el) {
    if (!el || !el.closest) return null;
    for (const [sel, title, text] of HELP) {
      const hit = el.closest(sel);
      if (hit) return { hit, title, text, sel };
    }
    return null;
  }

  function mark(el) {
    if (marked === el) return;
    if (marked) marked.classList.remove("help-target");
    marked = el;
    if (marked) marked.classList.add("help-target");
  }

  function show(x, y, m) {
    if (!m) { hide(); return; }
    mark(m.hit);
    if (lastFor !== m.sel) {
      bubble.querySelector("b").textContent = m.title;
      bubble.querySelector("span").textContent = m.text;
      lastFor = m.sel;
    }
    bubble.hidden = false;
    // next to the pointer, kept on screen
    const pad = 14, w = bubble.offsetWidth, h = bubble.offsetHeight;
    let left = x + pad, top = y + pad;
    if (left + w > window.innerWidth - 8) left = Math.max(8, x - w - pad);
    if (top + h > window.innerHeight - 8) top = Math.max(8, y - h - pad);
    bubble.style.left = left + "px";
    bubble.style.top = top + "px";
  }

  function hide() { if (bubble) bubble.hidden = true; mark(null); lastFor = null; }

  function setOn(v) {
    on = v;
    document.documentElement.classList.toggle("help-on", on);
    const b = document.getElementById("helpToggle");
    if (b) { b.setAttribute("aria-pressed", on ? "true" : "false"); b.title = on ? "Turn help off" : "Help: point at anything to learn what it does"; }
    if (on) {
      const m = match(b);
      const r = b.getBoundingClientRect();
      show(r.left, r.bottom, m);
    } else hide();
  }

  document.addEventListener("DOMContentLoaded", () => {
    bubble = document.createElement("div");
    bubble.className = "help-bubble";
    bubble.hidden = true;
    bubble.setAttribute("role", "tooltip");
    bubble.innerHTML = "<b></b><span></span>";
    document.body.appendChild(bubble);

    const btn = document.getElementById("helpToggle");
    if (btn) btn.addEventListener("click", (e) => { e.stopPropagation(); setOn(!on); });

    document.addEventListener("mousemove", (e) => {
      if (!on) return;
      show(e.clientX, e.clientY, match(e.target));
    });

    // While help is on, clicks and taps only explain; they don't press anything.
    const stop = (e) => {
      if (!on || (e.target.closest && e.target.closest("#helpToggle"))) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.type === "click") show(e.clientX, e.clientY, match(e.target));
    };
    ["click", "mousedown", "pointerdown", "dblclick", "dragstart", "drop", "change", "input"]
      .forEach((t) => document.addEventListener(t, stop, { capture: true, passive: false }));
    // the page still scrolls, but the mouse wheel doesn't resize the drawing while help is on
    document.addEventListener("wheel", (e) => {
      if (on && e.target.closest && e.target.closest(".preview-box")) { e.preventDefault(); e.stopPropagation(); }
    }, { capture: true, passive: false });
    window.addEventListener("scroll", () => { if (on) hide(); }, { passive: true });

    document.addEventListener("keydown", (e) => { if (on && e.key === "Escape") setOn(false); });
  });
})();
