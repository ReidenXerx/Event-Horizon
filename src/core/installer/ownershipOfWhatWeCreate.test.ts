/**
 * ──────────────────────────────────────────────────────────────────────
 * A MOD THIS RUN CREATED IS OURS FOR THE REST OF THIS RUN.
 *
 * `ownedByUs` is built ONCE, from the install journal as it stood before the
 * verify pass, and it is what every remaining ownership question in the run is
 * asked of. Four later sites replace an entry's `vortexModId` with one this run
 * created — the repair path's adopt-new-id, the verify loop's alongside
 * install, the 7e retry, and the mirror's own alongside install — and only the
 * LAST of them recorded the new id in the set. Journalling is not the same
 * thing: the journal is re-read on the next run, this set answers this one.
 *
 * What the gap cost, on the two paths that had it:
 *
 *  - Pass 5a2 gates on `ownedByUs.has(theirModId)` before installing the
 *    curator's copy beside the user's. Once the verify loop had replaced the
 *    entry with OUR copy, that lookup missed and 5a2 installed a second copy
 *    of our own mod beside itself — three copies of one mod — and overwrote
 *    `displacedModId` with our first copy's id. Uninstall's documented job is
 *    to switch the displaced mod back on; it would re-enable our own discarded
 *    copy and leave the USER's mod off for good, the only record of it gone.
 *    That is NS-2's harm arriving through the code written to honour NS-2.
 *  - `mirrorOneMod` refuses on `!ownedByUs.has(...)` with "this is your own
 *    copy of the mod, and the curator's version of its archive could not be
 *    obtained on this machine" — said about a mod Event Horizon installed from
 *    the curator's own archive seconds earlier. The mod then shipped the
 *    archive's raw output rather than the curator's reconciled staging folder
 *    (NS-5), with no drift oracle in the receipt, under "Install complete."
 *
 * ─── WHY THIS IS A SOURCE TEST ──────────────────────────────────────────
 * Same fixture debt as `retryFinishing.test.ts` and `alongsideOrdering.test.ts`:
 * reaching these branches behaviourally needs a driver run where a named mod
 * fails its first install, is adopted from the user's pool, fails verification
 * and then succeeds on a second attempt. `fakeVortex` can fail every install
 * or none. Until it can fail one, this pins the property that makes the
 * difference — and, per GP-7, proves each anchor exists before asserting on it,
 * so a rename fails loudly instead of going vacuous.
 * ──────────────────────────────────────────────────────────────────────
 */
import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.join(__dirname, "runInstall.ts"), "utf8");

/**
 * Where `ownedByUs` is built. Everything BELOW this line is the interesting
 * half: the set is seeded from the journal as read at that moment, so the main
 * install loop's own appends — which happen above it — are already in it and
 * need nothing. It is exactly the appends that come after that were the bug.
 */
const setBuiltAt = source.indexOf(
  "const ownedByUs = ownedModIds(journal, liveModIds)",
);

/** Every `await appendJournalEntry(...)` call AFTER the set was built. */
function journalAppendsAfterTheSet(): { call: string; at: number }[] {
  const out: { call: string; at: number }[] = [];
  let i = source.indexOf("await appendJournalEntry(", setBuiltAt);
  while (i >= 0) {
    const end = source.indexOf("});", i);
    if (end < 0) break;
    out.push({ call: source.slice(i, end + 3), at: i });
    i = source.indexOf("await appendJournalEntry(", end);
  }
  return out;
}

describe("ownership of the mods the driver creates mid-run", () => {
  it("has its anchors, so a rename cannot make this file vacuous", () => {
    expect(setBuiltAt).toBeGreaterThan(-1);
    expect(source).toContain("const noteOurs = (vortexModId: string): void =>");
    // Three of the four sites; the fourth (mirror-alongside) has its own test.
    expect(journalAppendsAfterTheSet().length).toBeGreaterThanOrEqual(3);
  });

  it("records every mod it journals as INSTALLED after the set was built", () => {
    /**
     * The pairing is the invariant: journalling `kind: "installed"` says "this
     * run created this mod", and that is exactly the condition for it being
     * ours. An `adopted` entry must NOT be added — the whole point of NS-2 is
     * that a mod we merely took over stays the user's, which is why the one
     * site that journals either kind has to guard on the same test.
     */
    for (const { call, at } of journalAppendsAfterTheSet()) {
      const installs = call.includes('kind: "installed"');
      const conditional = call.includes('? "adopted"');
      if (!installs && !conditional) continue;

      // `noteOurs` sits immediately after every one of them.
      const window = source.slice(at, at + call.length + 500);
      expect(
        window.includes("noteOurs("),
        `a journal append below the ownership set records an install with no ` +
          `ownership record beside it:\n${call.slice(0, 200)}`,
      ).toBe(true);

      if (conditional) {
        expect(window).toContain(
          'if (!entry.fromDecision.endsWith("already-installed"))',
        );
      }
    }
  });

  it("keeps the mirror's alongside install recording ownership", () => {
    // The site that always had it — pinned so a refactor cannot quietly make
    // it the fourth one missing it instead of the first one having it.
    const at = source.indexOf('decision: "mirror-alongside"');
    expect(at).toBeGreaterThan(-1);
    expect(source.slice(at, at + 400)).toMatch(
      /ownedByUs\.add\(ours\.vortexModId\)|noteOurs\(ours\.vortexModId\)/,
    );
  });

  it("counts the retry's mirrors from what happened, not from reaching the call", () => {
    /**
     * `retryMirrored += 1` was unconditional, so `install.retry.finished-mods`
     * reported `mirrored: N` for N mods that had every one of them been
     * skipped — and that log line is the first thing a support conversation
     * reads (GP-8).
     */
    const at = source.indexOf('"install.retry.finished-mods"');
    expect(at).toBeGreaterThan(-1);
    const loop = source.slice(source.indexOf("let retryMirrored = 0;"), at);
    expect(loop).toContain("const skippedBefore = mirrorSkipped.length;");
    expect(loop).toContain("if (mirrorSkipped.length > skippedBefore)");
    expect(source.slice(at, at + 500)).toContain("mirrorSkipped: retryMirrorSkipped");
  });
});
