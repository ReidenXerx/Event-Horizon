/**
 * ──────────────────────────────────────────────────────────────────────
 * The pick-time identity check must cover a REMEMBERED answer too.
 *
 * `checkArchiveIdentity` was wired into the file picker, so it covered a
 * fresh pick and nothing else — while the case it exists for is an UPDATE,
 * where the answer is pre-filled from the previous revision and the player
 * picks nothing at all. The row rendered "Picked: <path>" with no verdict,
 * counted toward "All answered", and unblocked Continue untouched.
 *
 * `usableSources` does not close this: it proves path, size and mtime, which
 * is existence, not identity. An author who replaces a download in place with
 * a repack of the same size passes all three.
 *
 * Source-order tests, because what broke was not a computation but where it
 * was wired: the check ran from one of the two ways a row gets an answer.
 * ──────────────────────────────────────────────────────────────────────
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const steps = (): string =>
  readFileSync(new URL("./steps.tsx", import.meta.url), "utf8");
const session = (): string =>
  readFileSync(new URL("./installSession.ts", import.meta.url), "utf8");

describe("a remembered answer is checked like a fresh pick", () => {
  it("runs the check from an effect on the value, not only from the picker", () => {
    const body = steps();
    const effect = body.indexOf("const checkedPath = React.useRef");
    expect(effect, "the value-driven check must exist").toBeGreaterThan(-1);
    // It must be driven by the row's value, which is what a pre-fill sets.
    const after = body.slice(effect, effect + 900);
    expect(after).toContain('value?.kind !== "use-local-file"');
    expect(after).toContain("void checkPickedFile(value.localPath)");
  });

  it("keys the check on the path so a re-render does not re-run it", () => {
    const body = steps();
    expect(body).toContain("if (checkedPath.current === value.localPath) return;");
  });
});

describe("changing a remembered answer forgets it", () => {
  it("forgets the entry when the choice is no longer use-local-file", () => {
    const body = session();
    const at = body.indexOf('if (choice.kind !== "use-local-file")');
    expect(at).toBeGreaterThan(-1);
    // The early return must now forget rather than simply leave.
    expect(body.slice(at, at + 600)).toContain("forgetOneSource");
  });

  it("resolves the bundle BEFORE deciding, or there is nothing to forget from", () => {
    // The bug shape this guards: `return` before the bundle is in hand means
    // the forget cannot be written at all.
    const body = session();
    const bundleAt = body.indexOf("const bundle =\n      this.state.kind === \"decisions\"");
    const branchAt = body.indexOf('if (choice.kind !== "use-local-file")');
    expect(bundleAt).toBeGreaterThan(-1);
    expect(bundleAt).toBeLessThan(branchAt);
  });
});
