// Render every UI screen to HTML, and optionally photograph it.
//
//   npm run ui:render          → .scratch-render/ui/*.html
//   npm run ui:shots           → …and .scratch-render/shots/*.png via headless Edge
//
// The screens come from src/ui/__render__/renderScreens.test.ts, which renders
// the REAL components with data modelled on a real 963-mod collection. This
// is how a UI change gets looked at before it ships: a screen that only ever
// existed as JSX has never been seen.
import { spawnSync } from "node:child_process";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..");
const outDir = path.join(root, ".scratch-render", "ui");
const shotsDir = path.join(root, ".scratch-render", "shots");
const shots = process.argv.includes("--shots");

const render = spawnSync(
  process.execPath,
  [
    path.join(root, "node_modules", "vitest", "vitest.mjs"),
    "run",
    "src/ui/__render__/renderScreens.test.ts",
  ],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, EH_RENDER: "1", EH_RENDER_OUT: outDir },
  },
);
if (render.status !== 0) {
  console.error("Rendering failed; nothing was photographed.");
  process.exit(render.status ?? 1);
}
console.log(`Screens written to ${outDir}`);

if (shots) {
  const shot = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "ui", "screenshot-screens.mjs"), outDir, shotsDir],
    { cwd: root, stdio: "inherit" },
  );
  if (shot.status !== 0) process.exit(shot.status ?? 1);
  console.log(`Screenshots written to ${shotsDir}`);
}
