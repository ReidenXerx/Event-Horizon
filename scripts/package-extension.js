/**
 * Build the release .zip that gets uploaded to Nexus as a Vortex extension.
 *
 * ─── WHY A SCRIPT AND NOT "JUST ZIP THE FOLDER" ────────────────────────
 * Vortex reads `info.json` from the ARCHIVE ROOT. Zipping the project folder
 * produces `<project-folder>/info.json` one level down, and Vortex then
 * refuses the extension with a message about a missing manifest — the single
 * most common way this upload goes wrong, and it costs a review round trip to
 * find out. This script writes the four things the extension actually consists
 * of, at the root, and nothing else.
 *
 * ─── WHY IT HAND-ROLLS THE ZIP ─────────────────────────────────────────
 * The project has zero runtime dependencies and already owns a native ZIP
 * READER (src/core/manifest/readZip.ts) precisely so it does not have to shell
 * out to 7-Zip. This is the symmetric writer: `zlib.deflateRawSync` plus the
 * same local-header / central-directory / EOCD structure the reader parses.
 * Shelling out to Compress-Archive would work on the maintainer's Windows box
 * and nowhere else.
 *
 * Usage:  node scripts/package-extension.js
 * Output: release/event-horizon-<version>.zip
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const repoRoot = path.resolve(__dirname, "..");

/** Exactly what the deploy script installs — see scripts/deploy-to-vortex.js. */
const ROOT_FILES = ["index.js", "info.json"];
const ROOT_DIRS = ["dist", "assets"];

// ── collect ────────────────────────────────────────────────────────────
/** @returns {{name: string, abs: string}[]} archive-relative name → source path */
function collect() {
  const out = [];
  for (const f of ROOT_FILES) {
    const abs = path.join(repoRoot, f);
    if (!fs.existsSync(abs)) {
      throw new Error(
        `${f} is missing. Run "npm run build" first — the extension cannot ` +
          `load without it.`,
      );
    }
    out.push({ name: f, abs });
  }
  for (const d of ROOT_DIRS) {
    const root = path.join(repoRoot, d);
    if (!fs.existsSync(root)) continue;
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walk(abs);
        // Forward slashes: the ZIP spec says so, and a backslash entry name is
        // the other classic way an archive reads as corrupt on another OS.
        else out.push({ name: path.relative(repoRoot, abs).split(path.sep).join("/"), abs });
      }
    };
    walk(root);
  }
  return out;
}

// ── zip ────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) {
    c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  }
  return (c ^ -1) >>> 0;
}

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const raw = fs.readFileSync(entry.abs);
    const sum = crc32(raw);
    // Deflate, except when it would make the entry bigger — already-compressed
    // payloads (png, woff) inflate slightly under deflate.
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const stored = deflated.length >= raw.length;
    const data = stored ? raw : deflated;
    const method = stored ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cd, eocd]);
}

// ── run ────────────────────────────────────────────────────────────────
const info = JSON.parse(fs.readFileSync(path.join(repoRoot, "info.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

// The version Vortex shows comes from info.json; package.json is the one
// developers bump out of habit. Shipping them out of step means the extension
// browser advertises a version the code does not claim.
if (info.version !== pkg.version) {
  throw new Error(
    `Version mismatch: info.json says ${info.version}, package.json says ` +
      `${pkg.version}. Vortex shows info.json's, so they must agree.`,
  );
}

const entries = collect();

/**
 * ─── REFUSE A SHADOWED LAYOUT ───────────────────────────────────────────────
 * Node resolves `require("./x")` to `x.js` BEFORE `x/index.js`. So if a build
 * ever contains both, every import of that name silently binds to the file and
 * the directory's exports vanish — no error, no warning, just functions that
 * are `undefined` at call time.
 *
 * It happened: `src/core/paths.ts` became `src/core/paths/`, `tsc` left the old
 * `dist/core/paths.js` behind, and alpha.122, .123 and .124 all shipped both.
 * Testers got "(0 , paths_1.toPosix) is not a function" from a build where the
 * type-checker was clean and 2,100 tests passed, because both only ever looked
 * at `src/`.
 *
 * `prebuild` now wipes `dist/`, so this cannot arise — which is exactly why the
 * check belongs here too. The cheap fix removes the cause; this one removes the
 * possibility of shipping it, and packaging is the last gate before a stranger
 * installs the result.
 */
const packagedNames = new Set(entries.map((e) => e.name.replace(/\\/g, "/")));
const shadowed = [...packagedNames]
  .filter((name) => name.endsWith(".js") && !name.endsWith("/index.js"))
  .filter((name) => {
    const asDir = `${name.slice(0, -".js".length)}/index.js`;
    return packagedNames.has(asDir);
  });
if (shadowed.length > 0) {
  throw new Error(
    `Refusing to package: ${shadowed.length} module(s) exist as BOTH a file ` +
      `and a directory, and Node resolves the file first — every import of ` +
      `them would bind to the stale one and its exports would be undefined ` +
      `at call time:\n` +
      shadowed.map((n) => `  ${n}  shadows  ${n.slice(0, -3)}/index.js`).join("\n") +
      `\nRun a clean build (npm run build wipes dist/) and package again.`,
  );
}

const zip = buildZip(entries);

const outDir = path.join(repoRoot, "release");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `event-horizon-${info.version}.zip`);
fs.writeFileSync(outFile, zip);

const totalBytes = entries.reduce((n, e) => n + fs.statSync(e.abs).size, 0);
console.log(`Packaged ${entries.length} files (${(totalBytes / 1048576).toFixed(1)} MB raw)`);
console.log(`  → ${path.relative(repoRoot, outFile)}  (${(zip.length / 1048576).toFixed(1)} MB)`);
console.log(`  info.json is at the archive root, which is where Vortex looks.`);
