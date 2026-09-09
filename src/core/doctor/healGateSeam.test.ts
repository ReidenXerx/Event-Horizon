/**
 * ──────────────────────────────────────────────────────────────────────
 * THE SEAM THE UNIT TESTS BOTH STEPPED OVER.
 *
 * `healingBlockedReason` had six unit tests and all six passed, because every
 * one of them built the argument by hand: `{ kind: "installing" }`,
 * `{ kind: "pick" }`, `{}`, `{ kind: 42 }`. The real caller passed something
 * none of them modelled — the install session's SNAPSHOT, `{ state, errorSeq }`
 * — whose `kind` is one level down.
 *
 * The parameter was `{ kind?: unknown }`, so the snapshot satisfied it, the
 * cast at the call site removed the last objection, and the function returned
 * "Cannot tell whether an install is running, so healing is paused." on every
 * render. All seven repairs in the Doctor were disabled from the day that line
 * was written, on a machine with nothing installing.
 *
 * A fixture built by hand tests the case that cannot fail (GP-4). This one is
 * built from the ACTUAL producer, so the two sides of the seam are checked
 * against each other rather than against an author's memory of each other.
 * ──────────────────────────────────────────────────────────────────────
 */
import * as fs from "fs";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { healingBlockedReason } from "./health";
import { initialWizardState } from "../../ui/pages/install/state";

describe("the Doctor is not blocked when nothing is installing", () => {
  it("lets healing run against the session's own resting state", () => {
    /**
     * `initialWizardState` is what `InstallSession` holds until a user picks a
     * package — the state the Doctor sees on a machine that has just opened
     * Vortex, which is exactly when someone repairs a collection.
     */
    expect(healingBlockedReason(initialWizardState)).toBeUndefined();
  });

  it("still pauses for a state that IS an install", () => {
    // The guard has to keep working, or this fix trades a dead feature for a
    // corrupted one: two writers in the same pipeline at once.
    expect(healingBlockedReason({ kind: "installing" })).toBeDefined();
  });

  it("refuses the SNAPSHOT, which is the shape that was passed by mistake", () => {
    /**
     * Belt and braces at runtime for what the type now forbids at compile
     * time. If someone reintroduces a cast, this still fails — and it fails
     * saying the healing is blocked, which is the symptom a curator reported.
     */
    const snapshot = { state: initialWizardState, errorSeq: 0 };
    expect(
      healingBlockedReason(snapshot as unknown as { kind: unknown }),
    ).toBeDefined();
  });
});

/**
 * The type is the real guard — passing the snapshot is now a compile error
 * ("Property 'kind' is missing in type 'InstallSessionSnapshot'"), verified by
 * putting the bug back and watching tsc reject it.
 *
 * A cast would silence that again, which is precisely how it was silenced the
 * first time. So this reads the call site: cheap, and aimed at the exact
 * regression rather than at the function, which was never wrong.
 */
describe("the Doctor's call site keeps its shape", () => {
  const page = fs.readFileSync(
    path.join(__dirname, "..", "..", "ui", "pages", "doctor", "DoctorPage.tsx"),
    "utf8",
  );

  it("reaches the wizard state instead of handing over the snapshot", () => {
    expect(page).toContain("getInstallSession().getSnapshot().state");
  });

  it("does not cast the snapshot back into something that compiles", () => {
    /**
     * Matched on the CALL, not on the words. The first version of this
     * asserted the file did not contain "getSnapshot() as" — and failed
     * immediately, on the comment three lines above the fix, which quotes the
     * old broken line verbatim. A source-text assertion reads prose too, and
     * prose about a bug looks exactly like the bug.
     */
    expect(page).not.toContain("getInstallSession().getSnapshot() as");
    expect(page).not.toContain("getInstallSession().getSnapshot())");
  });
});
