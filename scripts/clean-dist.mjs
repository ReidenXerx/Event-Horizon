/**
 * Delete `dist/` before every build.
 *
 * ─── THE BUG THIS EXISTS TO PREVENT ─────────────────────────────────────────
 * `tsc` writes output; it never removes output whose source is gone. So a
 * renamed or deleted module leaves its `.js` behind forever, and most of the
 * time that is harmless clutter — the file is inert because nothing imports
 * it.
 *
 * Once it is not harmless. `src/core/paths.ts` became `src/core/paths/` (a
 * directory with an `index.ts` barrel), and the stale `dist/core/paths.js`
 * survived. Node resolves `require("../paths")` to the FILE before the
 * DIRECTORY, so every `import { toPosix } from "../paths"` in the whole
 * project silently bound to the old module — which has none of those exports.
 * The extension shipped, and the curator got:
 *
 *     Couldn't read meridia-panties-1.0.10.ehcoll, so there is nothing to
 *     compare against: (0 , paths_1.toPosix) is not a function
 *
 * Nothing caught it. The type-checker only sees `src/`, the test suite runs
 * from `src/` through vitest, and the smoke test loaded the entry point
 * without calling into the graph. The only place the defect existed was the
 * build output, which nothing verified.
 *
 * It had been latent since the rename: every path comparison in the INSTALLER
 * was bound to the same empty module, and it surfaced only when a build-side
 * module started calling one of those helpers.
 *
 * ─── WHY A FULL WIPE RATHER THAN A PRUNE ────────────────────────────────────
 * A prune has to decide whether `dist/x.js` still has a source, and the answer
 * involves `.ts`, `.tsx`, and directories-versus-files — which is the exact
 * distinction that just went wrong. `tsc` takes seconds on this project and
 * reliability is the goal, not build time (NS-1). A clean output directory
 * cannot be stale by construction, and that is worth more than an incremental
 * rebuild.
 *
 * `dist/` is pure `tsc` output — assets are copied separately from `assets/`
 * by the deploy and packaging scripts — so nothing here is anyone's only copy.
 */
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

if (existsSync(dist)) {
  rmSync(dist, { recursive: true, force: true });
  console.log("cleaned dist/ (tsc does not remove output whose source is gone)");
}
