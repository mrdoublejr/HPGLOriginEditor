// A plot's "fingerprint": SHA-256 of its bytes with all whitespace (spaces, tabs, line breaks)
// removed. This MUST stay identical to plotFingerprint() in functions/upload.js, because the
// admin page compares library files against the fingerprints stored by the upload function.
// (No onRequest handler here, so this file is not a web address.)
export async function plotFingerprint(data) {
  const src = new Uint8Array(data);
  const keep = new Uint8Array(src.length);
  let n = 0;
  for (let i = 0; i < src.length; i++) {
    const b = src[i];
    if (b === 32 || (b >= 9 && b <= 13)) continue;
    keep[n++] = b;
  }
  const h = await crypto.subtle.digest("SHA-256", keep.slice(0, n));
  return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
