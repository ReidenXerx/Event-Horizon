// Screenshot every HTML screen the render harness produced.
//
//   EH_RENDER=1 EH_RENDER_OUT=.scratch-render/ui npx vitest run src/ui/__render__/renderScreens.test.ts
//   node scripts/ui/screenshot-screens.mjs .scratch-render/ui .scratch-render/shots [width] [height]
//
// Uses headless Edge (present on every Windows machine); falls back to Chrome.
// Prints one line per screenshot with its byte size, because a run where every
// file has the SAME size is a run that photographed the browser's error page —
// which is exactly what happened the first time this was done by hand, with a
// Git Bash `$PWD` turned into a `file:////c/...` URL.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const [
  inDir = ".scratch-render/ui",
  outDir = ".scratch-render/shots",
  width = "1400",
  height = "2400",
] = process.argv.slice(2);

/**
 * Screens that do not fit in the default window, and the height they need.
 *
 * A screen taller than the window is simply CUT, and the fingerprinter then
 * compares the part that fitted and reports a match — so the bottom of a long
 * screen had no cover at all while looking exactly as covered as everything
 * else. Measured when this was found: the build form is 3,719 px, so its last
 * third — integrity verification, the requirements block, the Build button —
 * was never photographed, and a copy change there produced no diff.
 *
 * ─── WHY THIS IS A LIST AND NOT JUST A BIGGER NUMBER ───────────────────
 * Raising the default to 4600 was the obvious fix and it re-baselined 43 of
 * 52 screens. The app's background is a GRADIENT sized to the viewport, so a
 * taller window shifts it on every screen — `#0f091c` became `#0e0618`
 * everywhere. Accepting 43 diffs to gain cover on 4 destroys the property
 * that makes this harness worth having: that a diff means something changed.
 *
 * So only the screens that need it pay for it. Adding one here re-baselines
 * that screen once, deliberately, and leaves the other 48 pinned. A screen
 * that grows past its height gets cut again — which is what the ceiling
 * report in `fingerprint-screens.mjs check` is for.
 */
const TALL_SCREENS = {
  "build-form": 4600,
  "build-done": 4600,
  "preview-whats-new": 4600,
};

/**
 * `decisions` is deliberately NOT here.
 *
 * It renders one row per mod, so its height is a property of the FIXTURE —
 * 963 mods, tens of thousands of pixels — rather than of the design. Tried at
 * 4600 and at 8000 and it filled both exactly, which is the shape of a page
 * that has no natural end. Its 2400 px shot is a deliberate window onto the
 * top of the list: the header, the filters and the first rows are what the
 * design decisions live in, and a row 800 places down is the same row again.
 */

const BROWSERS = [
  path.join("C:", "Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
  path.join("C:", "Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
  path.join("C:", "Program Files", "Google", "Chrome", "Application", "chrome.exe"),
];
const browser = BROWSERS.find((p) => fs.existsSync(p));
if (browser === undefined) {
  console.error("No headless browser found; looked in:\n  " + BROWSERS.join("\n  "));
  process.exit(2);
}

fs.mkdirSync(outDir, { recursive: true });
const files = fs
  .readdirSync(inDir)
  .filter((f) => f.endsWith(".html"))
  .sort();
if (files.length === 0) {
  console.error(`No .html screens in ${inDir}; run the render harness first.`);
  process.exit(2);
}

const sizes = new Set();
const profiles = [];
for (const f of files) {
  const name = path.basename(f, ".html");
  const out = path.resolve(outDir, `${name}.png`);
  const url = pathToFileURL(path.resolve(inDir, f)).href;
  // A profile dir per screenshot: the previous Edge process still holds the
  // lock on a shared one for a moment after it returns, and the next launch
  // then exits 21 without writing anything.
  const profile = fs.mkdtempSync(path.resolve(outDir, ".edge-profile-"));
  fs.rmSync(out, { force: true });
  try {
    execFileSync(
      browser,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        // Without its own profile and without --no-sandbox, Edge silently wrote
        // nothing (or an error page) from a Git Bash shell. Verified both ways.
        "--no-sandbox",
        `--user-data-dir=${profile}`,
        "--force-device-scale-factor=1",
        `--window-size=${width},${TALL_SCREENS[name] ?? height}`,
        `--screenshot=${out}`,
        url,
      ],
      { stdio: "ignore", timeout: 60_000 },
    );
  } catch {
    // Edge's exit status is noise; the file is the evidence (GP-8).
  }
  // The launcher can return before the browser process has flushed the PNG.
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(out) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  profiles.push(profile);
  if (!fs.existsSync(out)) {
    console.error(`${name}: Edge wrote no screenshot within 15s`);
    process.exit(1);
  }
  const bytes = fs.statSync(out).size;
  sizes.add(bytes);
  console.log(`${name.padEnd(28)} ${String(bytes).padStart(8)} B`);
}
// Edge keeps a profile locked for a moment after the launcher returns, so
// cleanup is best-effort and happens once, at the end.
for (const profile of profiles) {
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    /* left behind under the screenshot dir; harmless */
  }
}
if (files.length > 1 && sizes.size === 1) {
  console.error(
    "Every screenshot has the same size — they are almost certainly the browser's error page, not the UI.",
  );
  process.exit(1);
}
