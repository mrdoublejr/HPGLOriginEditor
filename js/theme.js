// ── theme.js ──────────────────────────────────────────────────────
// Light / dark mode. Loaded in <head> (not deferred) so the page is drawn in the
// right colours from the start, with no white flash.
//   - first visit: follows the computer's own light/dark setting
//   - the ☾ / ☀ button (top right) switches it, and the choice is remembered
// The plot previews stay white either way: they show paper.
(function () {
  var KEY = "spt-theme";
  function saved() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function save(v) { try { localStorage.setItem(KEY, v); } catch (e) { /* private window: just don't remember */ } }
  function systemDark() { return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches); }
  function current() { return document.documentElement.getAttribute("data-theme") || "light"; }

  function apply(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    var b = document.getElementById("themeToggle");
    if (b) {
      var dark = theme === "dark";
      b.textContent = dark ? "☀" : "☾";
      b.title = dark ? "Switch to light mode" : "Switch to dark mode";
      b.setAttribute("aria-label", b.title);
    }
  }

  apply(saved() || (systemDark() ? "dark" : "light"));

  // Follow the computer's setting until the button has been used.
  if (window.matchMedia) {
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    var onChange = function (e) { if (!saved()) apply(e.matches ? "dark" : "light"); };
    if (mq.addEventListener) mq.addEventListener("change", onChange); else if (mq.addListener) mq.addListener(onChange);
  }

  document.addEventListener("DOMContentLoaded", function () {
    var b = document.getElementById("themeToggle");
    if (!b) return;
    apply(current());
    b.addEventListener("click", function () {
      var next = current() === "dark" ? "light" : "dark";
      save(next);
      apply(next);
    });
  });
})();
