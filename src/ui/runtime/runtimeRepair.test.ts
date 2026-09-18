/**
 * ──────────────────────────────────────────────────────────────────────
 * Who gets interrupted before an install, and who does not.
 *
 * The failure this whole path exists for is silent: a player without the VC++
 * runtime installs a collection perfectly, every file verifies, and then a
 * script-extender plugin never loads. A tester's Fallout 4 body physics is
 * what raised it — the bodies are there, the physics is not, and nothing is
 * printed anywhere a player would look.
 *
 * The opposite failure is just as real and much easier to ship: a preview
 * that cries wolf before every install until people learn to click past it.
 * These tests pin the line between the two.
 * ──────────────────────────────────────────────────────────────────────
 */
import { describe, expect, it } from "vitest";

import {
  missingRuntimeIds,
  runtimesToOfferBeforeInstall,
} from "./runtimeRepair";
import {
  PREREQUISITES,
  RECOMMENDED_RUNTIME_IDS,
  type PrerequisiteId,
} from "../../core/runtime/prerequisites";
import type { RuntimeFinding } from "../../core/runtime/detectRuntimes";

const finding = (
  id: PrerequisiteId,
  status: RuntimeFinding["status"],
): RuntimeFinding => ({ id, name: id, status });

describe("what the install preview offers to install", () => {
  it("offers a missing recommended runtime", () => {
    const out = runtimesToOfferBeforeInstall(
      [finding("vcredist-x64", "absent")],
      RECOMMENDED_RUNTIME_IDS,
    );
    expect(out.map((f) => f.id)).toEqual(["vcredist-x64"]);
  });

  it("never offers one it could not check", () => {
    /**
     * `unknown` means the probe itself failed — no reg.exe, a Wine prefix
     * answering strangely, a refusal. Downloading and executing an installer
     * on the strength of a check that did not run is the wrong direction, and
     * this project's rule is that a false positive costs more than a false
     * negative.
     */
    expect(
      runtimesToOfferBeforeInstall(
        [finding("vcredist-x64", "unknown")],
        RECOMMENDED_RUNTIME_IDS,
      ),
    ).toEqual([]);
  });

  it("says nothing about a runtime that is present", () => {
    expect(
      runtimesToOfferBeforeInstall(
        [finding("vcredist-x64", "present")],
        RECOMMENDED_RUNTIME_IDS,
      ),
    ).toEqual([]);
  });

  it("does not nag about the older VC++ runtimes before every install", () => {
    /**
     * 2013 and 2012 are real link-by-name dependencies for SOME plugins and
     * absent on most healthy machines. Warning about them on every install is
     * how a warning screen teaches people to skip it. They stay detected and
     * surface in the Doctor, where someone has asked.
     */
    const out = runtimesToOfferBeforeInstall(
      [
        finding("vcredist2013-x64", "absent"),
        finding("vcredist2012-x86", "absent"),
        finding("directx9", "absent"),
        finding("dotnet8-desktop-x64", "absent"),
      ],
      RECOMMENDED_RUNTIME_IDS,
    );
    expect(out).toEqual([]);
  });

  it("keeps the recommended set derived from the catalogue, not re-listed", () => {
    // One decision in one place: adding a runtime and deciding whether it
    // nags must not be two separate edits that can drift apart.
    const fromCatalogue = PREREQUISITES.filter((p) => p.recommended).map((p) => p.id);
    expect([...RECOMMENDED_RUNTIME_IDS].sort()).toEqual(fromCatalogue.sort());
    // And it is not empty, or every test above would pass vacuously.
    expect(RECOMMENDED_RUNTIME_IDS.size).toBeGreaterThan(0);
  });
});

describe("what the Doctor offers to install", () => {
  it("offers every absent runtime, including the old ones", () => {
    // The Doctor is asked; the preview interrupts. Different bars.
    expect(
      missingRuntimeIds([
        finding("vcredist-x64", "absent"),
        finding("vcredist2013-x64", "absent"),
        finding("dotnet48", "present"),
        finding("directx9", "unknown"),
      ]),
    ).toEqual(["vcredist-x64", "vcredist2013-x64"]);
  });
});
