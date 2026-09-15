/**
 * Clearing prompts that are wrong to answer while the driver is running.
 *
 * "The mod X contains multiple plugins" offers [Enable all]. During a
 * collection install that is not noise, it is the WRONG answer: the collection
 * records which plugins the curator had enabled and the driver applies exactly
 * that at the end. A user clicking through them turns on plugins the curator
 * deliberately left off — and every file still verifies afterwards, so nothing
 * downstream can catch it.
 *
 * The risk in the other direction is dismissing something that mattered, so
 * the match stays narrow and everything unrecognised is left alone.
 */
import { describe, expect, it, vi } from "vitest";

import {
  DRIVEN_INSTALL_NOISE,
  dismissNoisyNotifications,
  isNoisyDuringInstall,
  selectNoisyNotificationIds,
} from "./quietNotifications";

const state = (ids: unknown[]): unknown => ({
  session: { notifications: { notifications: ids.map((id) => ({ id })) } },
});

describe("isNoisyDuringInstall", () => {
  it("matches Vortex's multi-plugin prompt", () => {
    expect(isNoisyDuringInstall("multiple-plugins-SCOURGE")).toBe(true);
  });

  it("matches the deploy prompt", () => {
    // The id as Vortex 1.x sends it (read from its app.asar).
    expect(isNoisyDuringInstall("deployment-necessary")).toBe(true);
  });

  it("leaves everything else alone", () => {
    // Narrow on purpose. An error, a download failure or an update prompt is
    // not ours to hide, and hiding one would be worse than the wall of
    // prompts this exists to clear.
    for (const id of [
      "error-something",
      "download-failed-12",
      "loot-info",
      "update-available",
      "mod-installed-99",
      // Neighbours of the ids we clear, which are not ours: a deployment that
      // cannot run is an error, and the others report what already happened.
      "deployment-not-possible",
      "deployment-method-unavailable",
      "mods-deployed",
      "dependency-installation-canceled",
      // A summary with nothing to answer, so hiding it cannot prevent a wrong
      // result. It was on the list once, on a wrong reading of what it offers.
      "bulk-warnings-7Kq2",
    ]) {
      expect(isNoisyDuringInstall(id)).toBe(false);
    }
  });

  it("requires a prefix match, not a substring", () => {
    // "…multiple-plugins-…" buried inside another id is a different
    // notification and not ours to touch.
    expect(isNoisyDuringInstall("x-multiple-plugins-y")).toBe(false);
  });

  it("survives a non-string id", () => {
    for (const id of [undefined, null, 7, {}]) {
      expect(isNoisyDuringInstall(id)).toBe(false);
    }
  });

  it("carries exactly these prefixes, and every addition needs an argument", () => {
    // Guards against this quietly becoming a general notification filter.
    expect(DRIVEN_INSTALL_NOISE).toEqual(["multiple-plugins-", "deployment-necessary"]);
  });
});

describe("selectNoisyNotificationIds", () => {
  it("finds them in Vortex's session state", () => {
    expect(
      selectNoisyNotificationIds(
        state(["multiple-plugins-a", "error-b", "multiple-plugins-c"]),
      ),
    ).toEqual(["multiple-plugins-a", "multiple-plugins-c"]);
  });

  it("returns nothing rather than throwing on a shape it does not know", () => {
    // A wrong answer here would be silent, and it runs inside an install that
    // is otherwise fine.
    for (const s of [undefined, null, {}, { session: {} }, state([])]) {
      expect(selectNoisyNotificationIds(s)).toEqual([]);
    }
    expect(
      selectNoisyNotificationIds({
        session: { notifications: { notifications: "not an array" } },
      }),
    ).toEqual([]);
  });

  it("skips entries with no id", () => {
    expect(selectNoisyNotificationIds(state([undefined, "multiple-plugins-a"]))).toEqual(
      ["multiple-plugins-a"],
    );
  });
});

describe("dismissNoisyNotifications", () => {
  it("dismisses each match once and reports the count", () => {
    const dismissNotification = vi.fn();
    const api = {
      getState: () => state(["multiple-plugins-a", "keep-me", "multiple-plugins-b"]),
      dismissNotification,
    } as never;
    expect(dismissNoisyNotifications(api)).toBe(2);
    expect(dismissNotification).toHaveBeenCalledTimes(2);
    expect(dismissNotification).not.toHaveBeenCalledWith("keep-me");
  });

  it("does nothing when Vortex offers no dismiss function", () => {
    // The API declares it optional; an older Vortex must not break the run.
    const api = { getState: () => state(["multiple-plugins-a"]) } as never;
    expect(dismissNoisyNotifications(api)).toBe(0);
  });

  it("never throws, whatever the state does", () => {
    // Cosmetic work on someone else's UI must not be able to fail an install.
    const api = {
      getState: () => {
        throw new Error("no store");
      },
      dismissNotification: vi.fn(),
    } as never;
    expect(dismissNoisyNotifications(api)).toBe(0);
  });

  it("survives a dismiss that throws part-way", () => {
    const api = {
      getState: () => state(["multiple-plugins-a", "multiple-plugins-b"]),
      dismissNotification: () => {
        throw new Error("gone already");
      },
    } as never;
    expect(dismissNoisyNotifications(api)).toBe(0);
  });
});
