// Shared helpers for the admin pages: what a stored plot should be called when you take it
// out of the bucket. This file has no onRequest handler, so it is not a web address itself.

const PLOT_EXT = /\.(hpgl|plt|hpg|txt)$/i;

// Names of the plot files listed in publicPlotLibrary/index.json, as written (just the file name).
export async function libraryFileNames(request, env) {
  const out = [];
  try {
    const r = await env.ASSETS.fetch(new URL("/publicPlotLibrary/index.json", request.url));
    if (!r.ok) return out;
    const seen = new Set();
    const walk = (v) => {
      if (typeof v === "string") {
        const base = v.split("/").pop();
        let name = base;
        try { name = decodeURIComponent(base); } catch (e) { /* keep as is */ }
        if (PLOT_EXT.test(name) && !seen.has(name)) { seen.add(name); out.push(name); }
      } else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(await r.json());
  } catch (e) { /* no library list: treat as empty */ }
  return out;
}

// The same names, lowercase, as a Set (for "is this name taken?" checks).
export async function libraryNames(request, env) {
  return new Set((await libraryFileNames(request, env)).map((n) => n.toLowerCase()));
}

// The visitor's own file name, made safe for a Windows/Mac/Linux folder.
export function cleanExportName(row) {
  let raw = row.original_filename || row.original_name || "";
  if (!raw && row.object_key) raw = row.object_key.replace(/^\d+-/, "");
  raw = raw.replace(/[\x00-\x1f\x7f<>:"\/\\|?*]/g, "").replace(/^[\s.]+|[\s.]+$/g, "");
  const m = raw.match(/(\.[A-Za-z0-9]{1,5})$/);
  let ext = m ? m[1].toLowerCase() : ".plt";
  let base = m ? raw.slice(0, raw.length - m[1].length) : raw;
  base = base.replace(/[\s.]+$/g, "") || "plot";
  return base + ext;
}

// One unique name per stored plot, oldest first. A name that is already taken (by the library
// or by an earlier upload) gets 1, 2, 3 ... added:  Car.plt, Car1.plt, Car2.plt
export function exportNames(rows, library) {
  const taken = new Set(library);
  const names = new Map();
  const sorted = rows.slice().sort((a, b) => a.id - b.id);
  for (const row of sorted) {
    const clean = cleanExportName(row);
    const dot = clean.lastIndexOf(".");
    const base = clean.slice(0, dot), ext = clean.slice(dot);
    let name = clean, n = 0;
    while (taken.has(name.toLowerCase())) { n++; name = base + n + ext; }
    taken.add(name.toLowerCase());
    names.set(row.id, name);
  }
  return names;
}
