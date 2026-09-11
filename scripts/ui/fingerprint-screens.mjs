// Golden fingerprints for the rendered screens.
//
//   node scripts/ui/fingerprint-screens.mjs check                       [--shots dir] [--golden file]
//   node scripts/ui/fingerprint-screens.mjs accept <screen> [<screen>…] [--shots dir] [--golden file]
//   node scripts/ui/fingerprint-screens.mjs accept --all                [--shots dir] [--golden file]
//
// The render harness proves every screen still renders; the screenshots prove
// what it looks like — but only to a person who opens them. The tick column
// that took a third of every selectable table shipped with the primitives
// overhaul and sat there until somebody photographed one table. This is the
// comparison step: each PNG is decoded, the empty background below the
// content is cropped, and what is left is reduced to a grid of CELL×CELL-pixel
// colour means and compared with the committed fingerprint.
//
// The first version averaged the difference over a 24×24 greyscale grid of
// the whole 1400×2400 window, and that average could not see a screen break:
// a solid dark page passed for two curator screens, a new 300×60 button and a
// green→red status pill passed, and a 600×300 block blanked out passed. A mean
// over a page that is mostly empty background divides every local change by
// the empty half. So a screen now fails on ANY cell whose colour moved past
// CELL_TOLERANCE, on a change in content height, and on a blank page — and the
// report says where on the screen the change is.
//
// Calibrated 2026-09-11 on the real shots:
//  - two full `npm run ui:shots` runs gave byte-identical PNGs, 34 of 34, so
//    render noise is zero here and the tolerance is only a margin;
//  - the smallest real change tried, "0.1.154" → "0.1.155" on About (715
//    pixels in an 8-pixel-high strip), moves an 8px cell by up to 7 and a
//    16px cell by only 2 — hence 8px cells and a tolerance of 3;
//  - the app's background below the content is a gradient whose neighbouring
//    pixels differ by at most 2, while every piece of UI has steps far above
//    that, so the content ends at the last row with a step above EDGE.
//
// A screen with no golden is a failure, not a note, and a golden with no
// screen is one too. `accept` takes the names of the screens that were looked
// at; re-baselining everything takes an explicit --all, and every accepted
// screen is printed with what changed.
//
// No dependencies: PNG is zlib + a per-row filter, and Node ships zlib.
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { fileURLToPath } from "node:url";

export const FORMAT = 2;
/** Cell edge in pixels. Small enough that one changed digit moves a cell past the tolerance. */
export const CELL = 8;
/** Largest change of one cell's mean on any of R, G, B (0-255) that still matches. */
export const CELL_TOLERANCE = 3;
/** A step between neighbouring pixels above this is content, not background gradient. */
export const EDGE = 4;
/** Per-channel slack when comparing the background colour itself. */
export const BACKGROUND_TOLERANCE = 2;

export function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
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
  if (raw.length < height * (stride + 1)) throw new Error(`truncated image data (${raw.length} bytes for ${width}×${height})`);
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

/** Byte offsets of R, G, B within one pixel. Grey images repeat the one channel. */
function rgbOffsets(channels) {
  return channels >= 3 ? [0, 1, 2] : [0, 0, 0];
}

/**
 * Height of the content: the image minus the trailing rows that hold only
 * background — rows with no step above EDGE to their left neighbour or to the
 * row below. The window is 2400 px tall and most screens end near 800; the
 * crop keeps a change in the page's length visible as a height change, and
 * keeps the committed grid to the part of the screen that has something in
 * it. Height 0 means there is no content at all: a blank page.
 */
export function contentBounds(png) {
  const { width, height, channels, pixels } = png;
  const offsets = rgbOffsets(channels);
  const last = (height - 1) * width * channels;
  const background = offsets.map((o) => pixels[last + o]);
  const stride = width * channels;
  let y = height - 1;
  for (; y >= 0; y -= 1) {
    const row = y * stride;
    let content = false;
    for (let x = 0; x < width && !content; x += 1) {
      const i = row + x * channels;
      for (const o of offsets) {
        const v = pixels[i + o];
        // Left neighbour, and the row BELOW: the last row of an element is the
        // one that steps down into the background, so it counts as content.
        if ((x > 0 && Math.abs(v - pixels[i - channels + o]) > EDGE) || (y < height - 1 && Math.abs(v - pixels[i + stride + o]) > EDGE)) {
          content = true;
          break;
        }
      }
    }
    if (content) break;
  }
  return { height: y + 1, background };
}

/** { width, height (content), background [r,g,b], cells: Uint8Array of R,G,B means per CELL×CELL cell, row-major }. */
export function fingerprint(png) {
  const { width, channels, pixels } = png;
  const { height, background } = contentBounds(png);
  const [r, g, b] = rgbOffsets(channels);
  const cols = Math.ceil(width / CELL);
  const rows = Math.ceil(height / CELL);
  const sums = new Float64Array(cols * rows * 3);
  const counts = new Uint32Array(cols * rows);
  for (let y = 0; y < height; y += 1) {
    const rowCell = Math.floor(y / CELL) * cols;
    const row = y * width * channels;
    for (let x = 0; x < width; x += 1) {
      const cell = rowCell + Math.floor(x / CELL);
      const i = row + x * channels;
      sums[cell * 3] += pixels[i + r];
      sums[cell * 3 + 1] += pixels[i + g];
      sums[cell * 3 + 2] += pixels[i + b];
      counts[cell] += 1;
    }
  }
  const cells = new Uint8Array(cols * rows * 3);
  for (let c = 0; c < cols * rows; c += 1) {
    for (let k = 0; k < 3; k += 1) cells[c * 3 + k] = Math.round(sums[c * 3 + k] / counts[c]);
  }
  return { width, height, background, cells };
}

const hex = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;

/**
 * Why `current` does not match `golden`, one reason per line; empty when it
 * matches. Each reason says what moved and where, so the report alone points
 * at the part of the PNG to look at.
 */
export function compare(current, golden) {
  const reasons = [];
  if (current.height === 0) reasons.push(`the screenshot is one flat colour (${hex(current.background)}) — a blank page, not a screen`);
  if (current.width !== golden.width) reasons.push(`width ${golden.width} → ${current.width} px`);
  if (current.height !== golden.height) reasons.push(`content height ${golden.height} → ${current.height} px`);
  const bg = Math.max(...[0, 1, 2].map((k) => Math.abs(current.background[k] - golden.background[k])));
  if (bg > BACKGROUND_TOLERANCE) reasons.push(`background ${hex(golden.background)} → ${hex(current.background)}`);
  if (current.width === golden.width && current.height > 0 && golden.height > 0) {
    const cols = Math.ceil(current.width / CELL);
    // Partial bottom cells average different pixel counts when the heights
    // differ, so only whole rows common to both are compared then.
    const rows =
      current.height === golden.height
        ? Math.ceil(current.height / CELL)
        : Math.floor(Math.min(current.height, golden.height) / CELL);
    let changed = 0;
    let max = 0;
    let x0 = Infinity;
    let x1 = -1;
    let y0 = Infinity;
    let y1 = -1;
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const at = (row * cols + col) * 3;
        const d = Math.max(
          Math.abs(current.cells[at] - golden.cells[at]),
          Math.abs(current.cells[at + 1] - golden.cells[at + 1]),
          Math.abs(current.cells[at + 2] - golden.cells[at + 2]),
        );
        if (d > max) max = d;
        if (d > CELL_TOLERANCE) {
          changed += 1;
          x0 = Math.min(x0, col);
          x1 = Math.max(x1, col);
          y0 = Math.min(y0, row);
          y1 = Math.max(y1, row);
        }
      }
    }
    if (changed > 0) {
      reasons.push(
        `${changed} ${CELL}px cell(s) changed colour by up to ${max}/255 (tolerance ${CELL_TOLERANCE}), ` +
          `within x ${x0 * CELL}–${Math.min(current.width, (x1 + 1) * CELL)} px, y ${y0 * CELL}–${(y1 + 1) * CELL} px`,
      );
    }
  }
  return reasons;
}

export function serialise(fp) {
  return {
    width: fp.width,
    height: fp.height,
    background: hex(fp.background),
    cells: zlib.deflateSync(Buffer.from(fp.cells), { level: 9 }).toString("base64"),
  };
}

export function deserialise(name, entry) {
  const cells = new Uint8Array(zlib.inflateSync(Buffer.from(String(entry.cells), "base64")));
  const expected = Math.ceil(entry.width / CELL) * Math.ceil(entry.height / CELL) * 3;
  if (cells.length !== expected) throw new Error(`golden for ${name} holds ${cells.length} cell bytes, ${entry.width}×${entry.height} needs ${expected}`);
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(entry.background));
  if (m === null) throw new Error(`golden for ${name} has no background colour`);
  return { width: entry.width, height: entry.height, background: [1, 2, 3].map((k) => parseInt(m[k], 16)), cells };
}

class CliError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function parseCli(argv) {
  const [mode, ...rest] = argv;
  const opts = { mode, shots: ".scratch-render/shots", golden: "src/ui/__render__/golden-fingerprints.json", all: false, names: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === "--shots" || a === "--golden") {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("--")) throw new CliError(`${a} needs a value`, 2);
      opts[a.slice(2)] = v;
      i += 1;
    } else if (a === "--all") opts.all = true;
    else if (a.startsWith("--")) throw new CliError(`unknown option ${a}`, 2);
    else opts.names.push(a);
  }
  if (mode !== "check" && mode !== "accept") throw new CliError(`usage: fingerprint-screens.mjs check|accept [<screen>…] [--all] [--shots dir] [--golden file]`, 2);
  if (mode === "check" && (opts.names.length > 0 || opts.all)) throw new CliError("check compares every screen; it takes no screen names", 2);
  return opts;
}

function readShots(dir) {
  if (!fs.existsSync(dir)) throw new CliError(`No screenshots directory ${dir}; run \`npm run ui:shots\` first.`, 2);
  const shots = new Map();
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".png")).sort()) {
    const name = path.basename(f, ".png");
    try {
      shots.set(name, fingerprint(decodePng(fs.readFileSync(path.join(dir, f)))));
    } catch (err) {
      throw new CliError(`${name}: could not decode ${path.join(dir, f)} — ${err.message}`, 2);
    }
  }
  if (shots.size === 0) throw new CliError(`No screenshots in ${dir}; run \`npm run ui:shots\` first.`, 2);
  return shots;
}

/** Map name → { raw (the committed entry), fp }; undefined when there is no file. */
function readGolden(file, { tolerateForeign }) {
  if (!fs.existsSync(file)) return undefined;
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  if (json.format !== FORMAT || json.cell !== CELL) {
    if (tolerateForeign) return new Map();
    throw new CliError(
      `${file} holds fingerprints in another format (format ${json.format ?? 1}, cell ${json.cell ?? "none"}); ` +
        `this script compares format ${FORMAT} with ${CELL}px cells. Look at the screenshots, then \`npm run ui:accept -- --all\`.`,
      2,
    );
  }
  const golden = new Map();
  for (const [name, raw] of Object.entries(json.screens ?? {})) golden.set(name, { raw, fp: deserialise(name, raw) });
  return golden;
}

function writeGolden(file, entries) {
  const names = [...entries.keys()].sort();
  const lines = names.map((n) => `    ${JSON.stringify(n)}: ${JSON.stringify(entries.get(n))}`);
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, `{\n  "format": ${FORMAT},\n  "cell": ${CELL},\n  "screens": {\n${lines.join(",\n")}\n  }\n}\n`);
}

function check(opts, out) {
  const shots = readShots(opts.shots);
  const golden = readGolden(opts.golden, { tolerateForeign: false });
  if (golden === undefined) throw new CliError(`No golden file at ${opts.golden}. Look at the screenshots, then \`npm run ui:accept -- --all\`.`, 2);
  const changed = [];
  const added = [];
  for (const [name, fp] of shots) {
    const g = golden.get(name);
    if (g === undefined) {
      added.push(`${name} (${fp.width}×${fp.height} px${fp.height === 0 ? ", and BLANK: one flat colour" : ""})`);
      continue;
    }
    const reasons = compare(fp, g.fp);
    if (reasons.length > 0) changed.push(`${name} — ${path.join(opts.shots, `${name}.png`)}\n      ${reasons.join("\n      ")}`);
  }
  const removed = [...golden.keys()].filter((n) => !shots.has(n));
  if (changed.length === 0 && added.length === 0 && removed.length === 0) {
    out.log(`All ${shots.size} screens match their fingerprints.`);
    return 0;
  }
  if (changed.length > 0) out.log(`CHANGED — look at each PNG, then \`npm run ui:accept -- <screen>\`:\n  ${changed.join("\n  ")}`);
  if (added.length > 0) out.log(`NEW — a screen with no fingerprint; look at it, then \`npm run ui:accept -- <screen>\`:\n  ${added.join("\n  ")}`);
  if (removed.length > 0) out.log(`GONE — a fingerprint with no screenshot; if the screen was removed on purpose, \`npm run ui:accept -- <screen>\` drops it:\n  ${removed.join("\n  ")}`);
  out.log(`${shots.size - changed.length - added.length} of ${shots.size} screens match; ${changed.length} changed, ${added.length} new, ${removed.length} gone.`);
  return 1;
}

function accept(opts, out) {
  if (!opts.all && opts.names.length === 0) {
    throw new CliError(
      "Name the screens you looked at — `npm run ui:accept -- <screen> [<screen>…]` — or pass --all to re-baseline every screen. `npm run ui:check` lists what changed.",
      2,
    );
  }
  const shots = readShots(opts.shots);
  const golden = readGolden(opts.golden, { tolerateForeign: opts.all }) ?? new Map();
  const targets = opts.all ? [...new Set([...shots.keys(), ...golden.keys()])].sort() : [...new Set(opts.names)];
  const unknown = targets.filter((n) => !shots.has(n) && !golden.has(n));
  if (unknown.length > 0) throw new CliError(`No screenshot and no fingerprint named: ${unknown.join(", ")}. Nothing was written.`, 2);
  const blank = targets.filter((n) => shots.get(n)?.height === 0);
  if (blank.length > 0) throw new CliError(`Refusing to accept a blank screenshot (one flat colour): ${blank.join(", ")}. Nothing was written.`, 1);

  const next = new Map([...golden].map(([n, g]) => [n, g.raw]));
  const lines = [];
  let unchanged = 0;
  for (const name of targets) {
    const fp = shots.get(name);
    const g = golden.get(name);
    if (fp === undefined) {
      next.delete(name);
      lines.push(`removed  ${name}`);
      continue;
    }
    if (g === undefined) {
      next.set(name, serialise(fp));
      lines.push(`new      ${name}: ${fp.width}×${fp.height} px`);
      continue;
    }
    const reasons = compare(fp, g.fp);
    if (reasons.length === 0) {
      unchanged += 1; // the committed entry is kept byte for byte
      if (!opts.all) lines.push(`same     ${name}: already matched its fingerprint`);
      continue;
    }
    next.set(name, serialise(fp));
    lines.push(`changed  ${name}: ${reasons.join("; ")}`);
  }
  writeGolden(opts.golden, next);
  for (const l of lines) out.log(l);
  out.log(`Wrote ${next.size} fingerprint(s) to ${opts.golden}${opts.all ? ` (${unchanged} unchanged)` : ""}.`);
  return 0;
}

export function main(argv, out = { log: (m) => console.log(m), error: (m) => console.error(m) }) {
  try {
    const opts = parseCli(argv);
    return opts.mode === "accept" ? accept(opts, out) : check(opts, out);
  } catch (err) {
    if (err instanceof CliError) {
      out.error(err.message);
      return err.code;
    }
    throw err;
  }
}

const invoked = process.argv[1] !== undefined && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (invoked) process.exitCode = main(process.argv.slice(2));
