/**
 * ──────────────────────────────────────────────────────────────────────
 * The bundled prefetch must not start before the profile switch finishes.
 *
 * A tester's install died at the second step. Their log:
 *
 *   22:12:44  bundled-prefetch.primed {requested: 13}
 *   22:12:44  install.profile.resolved {mode: "created"}
 *   22:13:25  extract.ok    311 MB in  41s
 *   22:13:47  bundled-prefetch.dispose        <- the run ended here, 63s in
 *   22:16:34  extract.ok  2,577 MB in 177s    (still finishing after)
 *   22:16:46  extract.ok  4,890 MB in 242s
 *
 * "Profile switch did not complete within 64s. Check Vortex's notifications
 * for a stuck deployment." There was none. Vortex was purging a profile
 * holding ~1,100 deployed mods while we pointed 7.7 GB of concurrent archive
 * extraction at the same disk, and then timed out the thing we were starving.
 *
 * Asserted against the SOURCE because the ordering is what matters and it is
 * invisible in behaviour until a machine is slow enough — which is the
 * machine we cannot test on.
 * ──────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from "fs";
import { join } from "path";

import { describe, expect, it } from "vitest";

const src = readFileSync(join(__dirname, "runInstall.ts"), "utf8");

describe("bundled prefetch ordering", () => {
  it("primes AFTER the profile has been resolved and switched", () => {
    const prime = src.indexOf("bundledPool.prime(prefetchEntries)");
    const switched = src.indexOf("await switchToProfile(");

    expect(prime, "the prefetch is never primed").toBeGreaterThan(0);
    expect(switched, "the profile is never switched").toBeGreaterThan(0);
    expect(
      prime,
      "priming before the switch starves the purge the switch is waiting on",
    ).toBeGreaterThan(switched);
  });

  it("still primes before the install loop, which is what it exists for", () => {
    // The other half: moving it too late would make the pool pointless, and
    // every bundled mod would extract inline on the cold path.
    const prime = src.indexOf("bundledPool.prime(prefetchEntries)");
    const loop = src.indexOf('reportProgress(\n        "installing-mods"');
    expect(prime).toBeGreaterThan(0);
    if (loop > 0) expect(prime).toBeLessThan(loop);
  });
});
