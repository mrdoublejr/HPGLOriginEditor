// ── config.js ─────────────────────────────────────────────────────
// Loads plotters.json and stores it in the global PLOTTERS object.
// Calls boot() (defined in main.js) once loaded.

let PLOTTERS = {};

fetch("plotters.json")
  .then(r => {
    if (!r.ok) throw new Error("Failed to load plotters.json: " + r.status + " " + r.statusText);
    return r.json();
  })
  .then(data => {
    console.log("Loaded plotters:", Object.keys(data));
    PLOTTERS = data;
    if (typeof boot === "function") boot();
  })
  .catch(err => {
    console.error("Config load failed:", err);
    const lm = document.getElementById("loadingMessage");
    if (lm) {
      lm.textContent = "Error: " + err.message + " (check browser console)";
      lm.style.color = "#b8801a";
    }
  });