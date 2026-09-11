// Golden fingerprints for the rendered screens.
//
//   node scripts/ui/fingerprint-screens.mjs check  [shotsDir] [goldenFile]
//   node scripts/ui/fingerprint-screens.mjs accept [shotsDir] [goldenFile]
//
// The render harness proves every screen still renders; the screenshots prove
// what it looks like — but only to a person who opens them. The tick column
// that took a third of every selectable table shipped with the primitives
// overhaul and sat there until somebody photographed one table. This is the
// comparison step: each PNG is decoded, reduced to a small greyscale grid, and
// compared with the committed fingerprint. A screen whose grid moved past the
// tolerance is named, and `accept` rewrites the fingerprints once the change
// has been looked at.
//
// No dependencies: PNG is zlib + a per-row filter, and Node ships zlib.
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

const [mode = "check", shotsDir = ".scratch-render/shots", goldenFile = "src/ui/__render__/golden-fingerprints.json"] =
  process.argv.slice(2);

const GRID = 24;
/** Mean absolute difference per cell (0-255) above which a screen is "changed". */
const TOLERANCE = 6;

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("latin1", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0) throw new Error(`unsupported PNG (depth ${bitDepth}, interlace ${interlace})`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (channels === undefined) throw new Error(`unsupported colour type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  let at = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[at];
    at += 1;
    const line = Buffer.from(raw.subarray(at, at + stride));
    at += stride;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = v & 0xff;
    }
    line.copy(out, y * stride);
    prev = line;
  }
  return { width, height, channels, pixels: out };
}

/** GRID×GRID mean greyscale of the image, row-major, 0-255. */
function fingerprint(png) {
  const { width, height, channels, pixels } = png;
  const cells = new Array(GRID * GRID).fill(0);
  const counts = new Array(GRID * GRID).fill(0);
  for (let y = 0; y < height; y += 1) {
    const gy = Math.min(GRID - 1, Math.floor((y * GRID) / height));
    for (let x = 0; x < width; x += 1) {
      const gx = Math.min(GRID - 1, Math.floor((x * GRID) / width));
      const i = (y * width + x) * channels;
      const grey = channels >= 3 ? (pixels[i] * 299 + pixels[i + 1] * 587 + pixels[i + 2] * 114) / 1000 : pixels[i];
      cells[gy * GRID + gx] += grey;
      counts[gy * GRID + gx] += 1;
    }
  }
  return cells.map((sum, i) => Math.round(sum / Math.max(1, counts[i])));
}

function meanAbsDiff(a, b) {
  if (a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

const files = fs
  .readdirSync(shotsDir)
  .filter((f) => f.endsWith(".png"))
  .sort();
if (files.length === 0) {
  console.error(`No screenshots in ${shotsDir}; run \`npm run ui:shots\` first.`);
  process.exit(2);
}

const current = {};
for (const f of files) {
  const name = path.basename(f, ".png");
  try {
    current[name] = fingerprint(decodePng(fs.readFileSync(path.join(shotsDir, f))));
  } catch (err) {
    console.error(`${name}: could not decode — ${err.message}`);
    process.exit(2);
  }
}

if (mode === "accept") {
  fs.writeFileSync(goldenFile, JSON.stringify({ grid: GRID, tolerance: TOLERANCE, screens: current }, null, 0) + "\n");
  console.log(`Accepted ${Object.keys(current).length} fingerprint(s) into ${goldenFile}`);
  process.exit(0);
}

if (!fs.existsSync(goldenFile)) {
  console.error(`No golden file at ${goldenFile}. Run \`npm run ui:accept\` after looking at the screenshots.`);
  process.exit(2);
}
const golden = JSON.parse(fs.readFileSync(goldenFile, "utf8"));
const changed = [];
const added = [];
const removed = [];
for (const [name, fp] of Object.entries(current)) {
  const g = golden.screens[name];
  if (g === undefined) {
    added.push(name);
    continue;
  }
  const d = meanAbsDiff(fp, g);
  if (d > (golden.tolerance ?? TOLERANCE)) changed.push(`${name} (${d.toFixed(1)})`);
}
for (const name of Object.keys(golden.screens)) if (current[name] === undefined) removed.push(name);

if (changed.length === 0 && added.length === 0 && removed.length === 0) {
  console.log(`All ${files.length} screens match their fingerprints.`);
  process.exit(0);
}
if (changed.length > 0) console.log(`CHANGED (look at the PNG, then \`npm run ui:accept\`):\n  ${changed.join("\n  ")}`);
if (added.length > 0) console.log(`NEW (no fingerprint yet):\n  ${added.join("\n  ")}`);
if (removed.length > 0) console.log(`GONE (fingerprint without a screen):\n  ${removed.join("\n  ")}`);
process.exit(changed.length > 0 || removed.length > 0 ? 1 : 0);
