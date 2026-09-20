const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const sourceDistDir = path.join(repoRoot, "dist");

const appData = process.env.APPDATA;
if (!appData) {
  console.error("APPDATA env var is not set; cannot resolve Vortex plugin path.");
  process.exit(1);
}

const targetDir = path.join(appData, "Vortex", "plugins", "vortex-event-horizon");

function copyRecursiveSync(src, dest) {
  if (!fs.existsSync(src)) return;

  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyRecursiveSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Delete files under `destRoot` that `srcRoot` no longer produces.
 *
 * Without this the deploy is copy-only, so a renamed or deleted module lingers
 * in the plugin folder forever. That is how a May build left MO2 modules,
 * pluginsTxt.js and ComingSoonPage.js on disk long after their sources were
 * removed — inert, because nothing imported them, but indistinguishable from
 * live code when you are trying to work out what is actually running.
 *
 * Only prunes inside the directories this script owns (dist/, assets/), never
 * the plugin root, so anything Vortex or the user puts beside them survives.
 */
function pruneRemovedSync(srcRoot, destRoot) {
  if (!fs.existsSync(destRoot)) return 0;
  let pruned = 0;
  for (const entry of fs.readdirSync(destRoot, { withFileTypes: true })) {
    const destPath = path.join(destRoot, entry.name);
    const srcPath = path.join(srcRoot, entry.name);
    if (entry.isDirectory()) {
      pruned += pruneRemovedSync(srcPath, destPath);
      // Drop the directory too once whatever justified it is gone.
      if (!fs.existsSync(srcPath) && fs.readdirSync(destPath).length === 0) {
        fs.rmdirSync(destPath);
      }
    } else if (!fs.existsSync(srcPath)) {
      fs.unlinkSync(destPath);
      pruned += 1;
    }
  }
  return pruned;
}

/**
 * Refuse to deploy compiled output older than the sources that made it.
 *
 * This script COPIES dist/; it has never built it. That is deliberate — a
 * deploy after a build you already ran should not spend another minute on
 * tsc — and it is also how a deploy silently ships the previous build.
 *
 * It happened, and nothing caught it: info.json still read the right version,
 * so the deployed copy reported 0.2.7; the smoke test passed, because it only
 * proves the extension LOADS, not that it contains any particular change.
 * The change was simply not there, and the only way to find out was to notice
 * a log line missing a field it should have had.
 *
 * So the check is a timestamp, which is exactly strong enough for the job: a
 * source file newer than every emitted .js means tsc has not run since it was
 * edited. It refuses rather than building on its own, because a deploy that
 * quietly compiles is a deploy that can quietly compile something you were
 * mid-edit on.
 */
function newestMtime(dir, filter) {
  if (!fs.existsSync(dir)) return { ms: 0, file: undefined };
  let best = { ms: 0, file: undefined };
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = newestMtime(full, filter);
      if (inner.ms > best.ms) best = inner;
    } else if (filter(entry.name)) {
      const ms = fs.statSync(full).mtimeMs;
      if (ms > best.ms) best = { ms, file: full };
    }
  }
  return best;
}

const newestSource = newestMtime(
  path.join(repoRoot, "src"),
  (name) => /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name),
);
const newestBuilt = newestMtime(sourceDistDir, (name) => name.endsWith(".js"));
if (newestSource.ms > newestBuilt.ms) {
  const rel = (f) => (f === undefined ? "(none)" : path.relative(repoRoot, f));
  console.error(
    [
      "",
      "✖ dist/ is older than src/ — this would deploy the PREVIOUS build.",
      `  newest source : ${rel(newestSource.file)}`,
      `  newest output : ${rel(newestBuilt.file)}`,
      "",
      "  Run `npm run build` first. Nothing was copied.",
      "",
      "  Why this refuses instead of building: the version in info.json and a",
      "  passing smoke test both look identical either way, so a stale deploy",
      "  is invisible until something behaves like the old code.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(`Deploying to ${targetDir} ...`);

copyRecursiveSync(sourceDistDir, path.join(targetDir, "dist"));
const prunedDist = pruneRemovedSync(sourceDistDir, path.join(targetDir, "dist"));

// Ship the static asset folder verbatim. Currently it carries the
// monochrome sidebar icon SVG sprite (loaded via util.installIconSet);
// future runtime assets (READMEs, fallback images, sample data, ...)
// can drop in here without touching the deploy script.
let prunedAssets = 0;
const sourceAssetsDir = path.join(repoRoot, "assets");
if (fs.existsSync(sourceAssetsDir)) {
  copyRecursiveSync(sourceAssetsDir, path.join(targetDir, "assets"));
  prunedAssets = pruneRemovedSync(sourceAssetsDir, path.join(targetDir, "assets"));
}

for (const file of ["index.js", "info.json"]) {
  const src = path.join(repoRoot, file);
  if (fs.existsSync(src)) {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(src, path.join(targetDir, file));
  } else {
    console.warn(`Skipping missing file: ${file}`);
  }
}

const prunedTotal = prunedDist + prunedAssets;
console.log(
  prunedTotal > 0
    ? `Done. Pruned ${prunedTotal} stale file(s) whose source no longer exists.`
    : "Done.",
);
