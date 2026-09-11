/**
 * The golden-fingerprint check against the regressions it exists to catch.
 *
 * The first version passed every one of these on the real screenshots: a
 * solid dark page, a new button, a green status pill turned red, a block of
 * the screen blanked out — because it averaged a greyscale difference over a
 * whole window that is mostly empty background. The screens here are
 * synthetic but shaped like the real ones: a smooth background gradient (the
 * app's steps by at most 2 between neighbouring pixels), content in the top
 * half, and empty window below it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";

import { afterAll, describe, expect, it } from "vitest";

import { CELL, CELL_TOLERANCE, main } from "./fingerprint-screens.mjs";

const W = 400;

function crc32(buf) {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n += 1) {
    let c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** RGB PNG; row filters cycle 0-4 so the decoder's unfiltering is exercised too. */
function encodePng({ width, height, pixels }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const f = y % 5;
    raw[y * (stride + 1)] = f;
    for (let i = 0; i < stride; i += 1) {
      const x = pixels[y * stride + i];
      const a = i >= 3 ? pixels[y * stride + i - 3] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      const c = i >= 3 && y > 0 ? pixels[(y - 1) * stride + i - 3] : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      raw[y * (stride + 1) + 1 + i] = (x - pred) & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const background = (y) => [13 + Math.floor(y / 150), 7, 24 + Math.floor(y / 200)];

/** A screen: header bar, a "text" line of sharp 2px stripes, a green pill, a panel. */
function screen({ height = 600, contentTo = 300, edit = () => undefined } = {}) {
  const pixels = Buffer.alloc(W * height * 3);
  const set = (x, y, rgb) => {
    const i = (y * W + x) * 3;
    pixels[i] = rgb[0];
    pixels[i + 1] = rgb[1];
    pixels[i + 2] = rgb[2];
  };
  const fill = (x0, y0, w, h, rgb) => {
    for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) set(x, y, typeof rgb === "function" ? rgb(x, y) : rgb);
  };
  for (let y = 0; y < height; y += 1) for (let x = 0; x < W; x += 1) set(x, y, background(y));
  fill(0, 16, W, 40, [60, 40, 120]);
  fill(40, 96, 256, 8, (x) => (x % 4 < 2 ? [220, 220, 230] : background(100)));
  fill(40, 144, 64, 16, [40, 160, 60]);
  fill(40, 200, 320, contentTo - 200, [30, 26, 52]);
  edit({ fill, set });
  return encodePng({ width: W, height, pixels });
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eh-fingerprint-"));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
let seq = 0;

/** A shots dir holding `screens` ({ name: png }) and a golden path next to it. */
function workspace(screens) {
  seq += 1;
  const dir = path.join(tmpRoot, `w${seq}`);
  const shots = path.join(dir, "shots");
  fs.mkdirSync(shots, { recursive: true });
  const write = (set) => {
    for (const f of fs.readdirSync(shots)) fs.rmSync(path.join(shots, f));
    for (const [name, png] of Object.entries(set)) fs.writeFileSync(path.join(shots, `${name}.png`), png);
  };
  write(screens);
  const golden = path.join(dir, "golden.json");
  const run = (...argv) => {
    const lines = [];
    const code = main([...argv, "--shots", shots, "--golden", golden], { log: (m) => lines.push(m), error: (m) => lines.push(m) });
    return { code, out: lines.join("\n") };
  };
  return { write, run, golden };
}

const base = () => ({ home: screen(), tools: screen({ contentTo: 260 }) });

describe("fingerprint-screens check", () => {
  it("passes identical screenshots", () => {
    const w = workspace(base());
    expect(w.run("accept", "--all").code).toBe(0);
    const r = w.run("check");
    expect(r).toEqual({ code: 0, out: "All 2 screens match their fingerprints." });
  });

  it("fails a blank page", () => {
    const w = workspace(base());
    w.run("accept", "--all");
    w.write({ ...base(), tools: screen({ edit: ({ fill }) => fill(0, 0, W, 600, [9, 8, 18]) }) });
    const r = w.run("check");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/tools — .*\n\s+the screenshot is one flat colour \(#090812\) — a blank page/);
  });

  it("fails a new button, and says where it is", () => {
    const w = workspace(base());
    w.run("accept", "--all");
    w.write({ ...base(), home: screen({ edit: ({ fill }) => fill(200, 136, 64, 16, [200, 200, 200]) }) });
    const r = w.run("check");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/home — [\s\S]*cell\(s\) changed colour by up to \d+\/255 \(tolerance 3\), within x 200–264 px, y 136–152 px/);
    expect(r.out).not.toMatch(/tools —/);
  });

  it("fails a green pill that turned red at almost the same brightness", () => {
    // Luma of [40,160,60] is 112.7 and of [255,60,40] 116.0: a greyscale
    // cell moves by 3, inside the tolerance. The colour moves by 215.
    const w = workspace(base());
    w.run("accept", "--all");
    w.write({ ...base(), home: screen({ edit: ({ fill }) => fill(40, 144, 64, 16, [255, 60, 40]) }) });
    const r = w.run("check");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/home — [\s\S]*changed colour by up to 215\/255/);
  });

  it("fails a blanked-out block of the screen", () => {
    const w = workspace(base());
    w.run("accept", "--all");
    w.write({ ...base(), home: screen({ edit: ({ fill }) => fill(40, 200, 160, 80, (x, y) => background(y)) }) });
    const r = w.run("check");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/home — [\s\S]*cell\(s\) changed colour/);
  });

  it("ignores how much empty window is below the content, and fails when the content grows", () => {
    const w = workspace(base());
    w.run("accept", "--all");
    w.write({ ...base(), home: screen({ height: 900 }) });
    expect(w.run("check").code).toBe(0);
    w.write({ ...base(), home: screen({ contentTo: 340 }) });
    const r = w.run("check");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/content height 300 → 340 px/);
  });

  it("fails loudly on a screen with no fingerprint", () => {
    const w = workspace(base());
    w.run("accept", "--all");
    w.write({ ...base(), fresh: screen({ contentTo: 220 }) });
    const r = w.run("check");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/NEW — [^\n]*\n\s+fresh \(400×220 px\)/);
  });

  it("fails loudly on a fingerprint with no screen", () => {
    const w = workspace(base());
    w.run("accept", "--all");
    w.write({ home: screen() });
    const r = w.run("check");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/GONE — [^\n]*\n\s+tools/);
  });

  it("refuses a golden file in the old format and says how to re-baseline", () => {
    const w = workspace(base());
    fs.writeFileSync(w.golden, JSON.stringify({ grid: 24, tolerance: 6, screens: {} }));
    const r = w.run("check");
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/another format.*ui:accept -- --all/);
  });

  it("keeps a cell smaller than a changed label and a tolerance under what one moves", () => {
    // Measured on the real About screen: "0.1.154" → "0.1.155" moved an 8px
    // cell by 7 and a 16px cell by 2.
    expect(CELL).toBeLessThanOrEqual(8);
    expect(CELL_TOLERANCE).toBeLessThan(7);
  });
});

describe("fingerprint-screens accept", () => {
  it("refuses to run without screen names or --all, and writes nothing", () => {
    const w = workspace(base());
    w.run("accept", "--all");
    const before = fs.readFileSync(w.golden);
    w.write({ home: screen({ contentTo: 340 }), tools: screen({ contentTo: 280 }) });
    const r = w.run("accept");
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/Name the screens/);
    expect(fs.readFileSync(w.golden).equals(before)).toBe(true);
  });

  it("re-baselines only the named screens and prints what changed", () => {
    const w = workspace(base());
    w.run("accept", "--all");
    w.write({ home: screen({ contentTo: 340 }), tools: screen({ contentTo: 280 }) });
    const a = w.run("accept", "home");
    expect(a.code).toBe(0);
    expect(a.out).toMatch(/^changed  home: content height 300 → 340 px/m);
    expect(a.out).not.toMatch(/tools/);
    const r = w.run("check");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/tools — /);
    expect(r.out).not.toMatch(/home — /);
  });

  it("refuses to accept a blank screenshot", () => {
    const w = workspace(base());
    w.run("accept", "--all");
    const before = fs.readFileSync(w.golden);
    w.write({ ...base(), home: screen({ edit: ({ fill }) => fill(0, 0, W, 600, [9, 8, 18]) }) });
    const r = w.run("accept", "home");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Refusing to accept a blank screenshot.*home/);
    expect(fs.readFileSync(w.golden).equals(before)).toBe(true);
  });

  it("drops a named screen that no longer exists, and names an unknown one", () => {
    const w = workspace(base());
    w.run("accept", "--all");
    w.write({ home: screen() });
    expect(w.run("accept", "nonsense").code).toBe(2);
    const a = w.run("accept", "tools");
    expect(a.out).toMatch(/^removed  tools$/m);
    expect(w.run("check").code).toBe(0);
  });
});
