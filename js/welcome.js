// ── welcome.js ────────────────────────────────────────────────────
// First visit: a welcome message that can't be skipped. It stays until the visitor
// presses the button, then it rolls up into a small button at the top centre of the
// page, so it can be opened again any time. On later visits only that small button
// shows. (Esc and clicking outside the message don't close it.)
// The wording is right here; change it freely.
(function () {
  var KEY = "spt-welcome-seen";
  var BUTTON = "Count me in";
  var PILL = "\u{1F4E3} This tool needs you";            // the small button at the top
  var HTML =
    '<h2 id="welcomeTitle">This tool needs you</h2>' +
    "<p>Getting a vintage plotter to draw what you want shouldn't be a struggle. The whole point of " +
    "this site is to make plotting easier, for every old plotter out there, not just mine.</p>" +
    "<p>I'm one guy with a few old HP plotters and a lot of curiosity. I honestly don't know what " +
    "I'm doing half the time, and this site will have problems.</p>" +
    "<p>Vintage plotters only stay alive if people share what works. If you own one of these " +
    "machines, please try your files, tell me what happens, and send suggestions, corrections and " +
    "manuals through <b>Contact</b>.</p>" +
    "<p>Nothing here comes with a guarantee. If it breaks something, wastes paper or misbehaves, " +
    "that's on the honour system, not a promise. Use it at your own risk.</p>";

  var dialog, pill, busy = false;
  var calm = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function seen() { try { return localStorage.getItem(KEY) === "1"; } catch (e) { return false; } }
  function remember() { try { localStorage.setItem(KEY, "1"); } catch (e) { /* private window: shows again next time */ } }

  // Moves/shrinks the message between its own place and the small button's place.
  function flight(fromPill) {
    var d = dialog.getBoundingClientRect(), p = pill.getBoundingClientRect();
    var dx = (p.left + p.width / 2) - (d.left + d.width / 2);
    var dy = (p.top + p.height / 2) - (d.top + d.height / 2);
    var sx = p.width / d.width, sy = p.height / d.height;
    var small = { transform: "translate(" + dx + "px," + dy + "px) scale(" + sx + "," + sy + ")", opacity: 0.2 };
    var full = { transform: "none", opacity: 1 };
    return dialog.animate(fromPill ? [small, full] : [full, small],
                          { duration: calm ? 1 : 520, easing: "cubic-bezier(.5,0,.2,1)" });
  }

  function open(fromPill) {
    if (busy) return;
    busy = true;
    if (dialog.showModal) dialog.showModal(); else dialog.setAttribute("open", "");
    dialog.querySelector("#welcomeOk").focus();
    if (fromPill && dialog.animate) flight(true).onfinish = function () { busy = false; };
    else busy = false;
  }

  function rollUp() {
    if (busy) return;
    busy = true;
    remember();
    pill.hidden = false;
    var done = function () {
      dialog.close();
      busy = false;
      pill.classList.remove("landed"); void pill.offsetWidth; pill.classList.add("landed");
    };
    if (dialog.animate) flight(false).onfinish = done; else done();
  }

  document.addEventListener("DOMContentLoaded", function () {
    // the small button, top centre, as the first thing in the header
    pill = document.createElement("button");
    pill.type = "button";
    pill.className = "welcome-pill";
    pill.textContent = PILL;
    pill.title = "Read the welcome message again";
    pill.hidden = !seen();
    var header = document.querySelector("header");
    var row = document.createElement("div");
    row.className = "welcome-pill-row";
    row.appendChild(pill);
    if (header) header.insertBefore(row, header.firstChild); else document.body.insertBefore(row, document.body.firstChild);

    dialog = document.createElement("dialog");
    dialog.className = "welcome-dialog";
    dialog.setAttribute("aria-labelledby", "welcomeTitle");
    dialog.innerHTML = HTML + '<div class="welcome-actions"><button type="button" class="btn-primary" id="welcomeOk"></button></div>';
    dialog.querySelector("#welcomeOk").textContent = BUTTON;
    document.body.appendChild(dialog);

    dialog.addEventListener("cancel", function (e) { e.preventDefault(); });   // Esc does nothing
    dialog.querySelector("#welcomeOk").addEventListener("click", rollUp);
    pill.addEventListener("click", function () { open(true); });

    if (!seen()) open(false);
  });
})();
