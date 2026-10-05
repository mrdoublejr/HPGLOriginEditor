// Scans the samples/ folder and writes samples/index.json so every plot file is listed.
// Run from the project folder:   node build-samples-index.js
// Existing titles/plotter/paper/notes you typed into index.json are kept.
const fs = require("fs"), path = require("path");
const dir = [
  path.join(__dirname, "samples"),
  path.join(__dirname, "..", "samples"),
  path.join(process.cwd(), "samples"),
].find(d => fs.existsSync(d));
if (!dir) { console.error("Could not find a samples folder next to this script."); process.exit(1); }
const out = path.join(dir, "index.json");
const EXT = /\.(hpgl|plt|hpg)$/i;

let old = {};
try { for (const s of JSON.parse(fs.readFileSync(out, "utf8")).samples || []) old[s.file] = s; } catch (e) {}

const samples = fs.readdirSync(dir)
  .filter(f => EXT.test(f))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  .map(f => {
    const file = "samples/" + f;
    return Object.assign({ file }, old[file] || {}, { size: fs.statSync(path.join(dir, f)).size });
  });

fs.writeFileSync(out, JSON.stringify({ samples }, null, 2) + "\n");
console.log("Wrote " + samples.length + " plot(s) to samples/index.json");