import { defineConfig } from "vitest/config";
import * as path from "node:path";

/**
 * `@nexusmods/vortex-api` ships type declarations only — it has no runtime entry
 * and no "." export condition, because Vortex injects the real module into
 * extension code at load time via its own require hook. Anything importing it is
 * therefore unloadable under vitest and cannot be tested at all without an alias.
 *
 * Aliasing it to a stub is what makes the core modules testable; without this the
 * only testable file in the repo was the one that happened to import nothing from
 * the API. See test/stubs/vortex-api.ts.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@nexusmods/vortex-api": path.resolve(__dirname, "test/stubs/vortex-api.ts"),
    },
  },
  test: {
    // `test/e2e` holds the whole-chain tests: a real staging folder on disk,
    // real hashing, and a real JSON round-trip through the parser the
    // installer uses. They live outside src/ so `tsc` never compiles them
    // into dist/, the same reason the stub does.
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "test/e2e/**/*.e2e.test.ts",
      // The release tooling (scripts/lib) is plain ESM and tested where it lives.
      "scripts/**/*.test.mjs",
    ],
    /**
     * ─── A SUITE THAT FAILS AT RANDOM IS A SUITE NOBODY READS ───────────
     * At vitest's default worker count this suite failed one to three tests
     * per run, a DIFFERENT set every time, every one of them at ~4-5s — the
     * default 5s timeout. All of them pass in isolation, and the full suite
     * passes with the workers capped.
     *
     * The offenders are the tests that do real work rather than fake it:
     * `checkSevenZipHealth` spawns a binary, the e2e tests hash real files in
     * real temp folders, `applyPluginOrder` waits on a sort callback. Those
     * are exactly the tests worth having, and starving them of CPU makes them
     * look broken.
     *
     * Capping workers costs wall-clock and buys a deterministic answer, which
     * is the right trade for a suite whose whole job is to be believed. It is
     * not a mask: every one of those tests still runs, and still fails when
     * the code is wrong — verified by mutation on each fix in this area.
     */
    maxWorkers: 2,
    minWorkers: 1,
  },
});
