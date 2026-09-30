/**
 * The dangerous direction here is a FALSE alarm, not a missed one.
 *
 * Telling a Premium user they are about to face 600 manual downloads would
 * teach them that this screen lies, and the screen also carries the disk-space
 * and game-version warnings that are worth reading. So most of these tests are
 * about staying quiet: on an unreadable state, an unfamiliar state shape, a
 * missing field, and a plan that needs no downloads at all.
 */
import { afterEach, describe, expect, it } from "vitest";

// eslint-disable-next-line import/no-relative-packages
import { __testNexusAccount } from "../../../test/stubs/vortex-api";
import {
  countNexusDownloads,
  describeNexusAccount,
  readNexusAccount,
} from "./checkNexusAccount";
import type { InstallPlan } from "../../types/installPlan";

afterEach(() => {
  delete __testNexusAccount.isLoggedIn;
  delete __testNexusAccount.isPremium;
});

const stateWith = (nexus: unknown): never =>
  ({ getState: () => ({ persistent: { nexus } }) }) as never;

const planWith = (kinds: readonly string[]): InstallPlan =>
  ({
    modResolutions: kinds.map((kind, i) => ({
      compareKey: `k${i}`,
      name: `Mod ${i}`,
      sourceKind: "nexus",
      decision: { kind },
    })),
  }) as unknown as InstallPlan;

describe("readNexusAccount", () => {
  it("reads Premium", () => {
    expect(readNexusAccount(stateWith({ userInfo: { isPremium: true } }))).toEqual(
      { kind: "premium" },
    );
  });

  it("reads a free account", () => {
    expect(
      readNexusAccount(stateWith({ userInfo: { isPremium: false } })),
    ).toEqual({ kind: "free" });
  });

  it("calls it logged out only when the Nexus slice exists and has no user", () => {
    expect(readNexusAccount(stateWith({}))).toEqual({ kind: "logged-out" });
    expect(readNexusAccount(stateWith({ userInfo: null }))).toEqual({
      kind: "logged-out",
    });
  });

  it("says unknown when there is no Nexus slice at all", () => {
    // An unfamiliar state shape is not evidence of being logged out. Claiming
    // it is would produce a sign-in warning for a signed-in user.
    const noSlice = { getState: () => ({ persistent: {} }) } as never;
    expect(readNexusAccount(noSlice).kind).toBe("unknown");
  });

  it("says unknown when the account status field is missing or not a boolean", () => {
    expect(readNexusAccount(stateWith({ userInfo: {} })).kind).toBe("unknown");
    expect(
      readNexusAccount(stateWith({ userInfo: { isPremium: "yes" } })).kind,
    ).toBe("unknown");
  });

  it("says unknown when state cannot be read at all", () => {
    const broken = {
      getState: () => {
        throw new Error("no state");
      },
    } as never;
    expect(readNexusAccount(broken).kind).toBe("unknown");
  });
});

describe("readNexusAccount via Vortex's own selectors", () => {
  // These are the PRIMARY source — Vortex's published accessors — so they are
  // what actually runs on a real install. The state-path tests above cover the
  // fallback for a Vortex build that does not expose them.

  it("prefers the selector over the state path", () => {
    __testNexusAccount.isPremium = true;
    // State says the opposite. The selector is the defining source and wins;
    // if it did not, our inference about Vortex's internals would silently
    // override Vortex's own answer.
    expect(
      readNexusAccount(stateWith({ userInfo: { isPremium: false } })),
    ).toEqual({ kind: "premium" });
  });

  it("reads a free account from the selector", () => {
    __testNexusAccount.isPremium = false;
    expect(readNexusAccount(stateWith({}))).toEqual({ kind: "free" });
  });

  it("reports logged out when the selector says not logged in", () => {
    __testNexusAccount.isLoggedIn = false;
    __testNexusAccount.isPremium = false;
    expect(readNexusAccount(stateWith({ userInfo: {} }))).toEqual({
      kind: "logged-out",
    });
  });

  it("does not treat a logged-in signal as an answer about Premium", () => {
    // isLoggedIn === true says nothing about membership; without isPremium
    // there is still no answer, and the state path has to supply it.
    __testNexusAccount.isLoggedIn = true;
    expect(
      readNexusAccount(stateWith({ userInfo: { isPremium: true } })),
    ).toEqual({ kind: "premium" });
    expect(readNexusAccount(stateWith({ userInfo: {} })).kind).toBe("unknown");
  });

  it("falls through to the state path when the selectors do not answer", () => {
    // Both unset — a Vortex build without these selectors at all.
    expect(
      readNexusAccount(stateWith({ userInfo: { isPremium: false } })),
    ).toEqual({ kind: "free" });
  });
});

describe("countNexusDownloads", () => {
  it("counts only decisions that hit the network", () => {
    // The trap this exists to avoid: willInstallSilently also counts bundled
    // and already-downloaded archives, which need no account at all.
    const plan = planWith([
      "nexus-download",
      "nexus-download",
      "nexus-use-local-download",
      "nexus-already-installed",
      "external-use-bundled",
    ]);
    expect(countNexusDownloads(plan)).toBe(2);
  });

  it("is zero for a collection that downloads nothing", () => {
    expect(countNexusDownloads(planWith(["external-use-bundled"]))).toBe(0);
  });
});

describe("describeNexusAccount", () => {
  it("says nothing to a Premium account", () => {
    expect(describeNexusAccount({ kind: "premium" }, 954)).toEqual([]);
  });

  it("says nothing when it could not tell", () => {
    expect(
      describeNexusAccount({ kind: "unknown", why: "whatever" }, 954),
    ).toEqual([]);
  });

  it("says nothing when there is nothing to download", () => {
    // Premium is irrelevant to installing archives already on disk.
    expect(describeNexusAccount({ kind: "free" }, 0)).toEqual([]);
    expect(describeNexusAccount({ kind: "logged-out" }, 0)).toEqual([]);
  });

  it("states Premium as a requirement, and why it is one", () => {
    const said = describeNexusAccount({ kind: "free" }, 954).join(" ");
    expect(said).toMatch(/954 mods/);
    expect(said).toMatch(/Premium is required/);
    expect(said).toMatch(/does not have it/);
    // The requirement is justified, not just asserted — a rule with a
    // checkable reason survives being argued with.
    expect(said).toMatch(/download files directly/);
    expect(said).toMatch(/Only available to premium users/);
  });

  it("escalates for a big collection but not a small one", () => {
    const many = describeNexusAccount({ kind: "free" }, 954).join(" ");
    const few = describeNexusAccount({ kind: "free" }, 3).join(" ");
    expect(many).toMatch(/runs unattended/);
    expect(few).not.toMatch(/runs unattended/);
    // And a single mod reads as one, not "1 mods".
    expect(describeNexusAccount({ kind: "free" }, 1).join(" ")).toMatch(
      /1 mod\b/,
    );
  });

  it("tells a logged-out user to sign in, and does not mention Premium", () => {
    const said = describeNexusAccount({ kind: "logged-out" }, 12).join(" ");
    expect(said).toMatch(/not signed in/);
    expect(said).toMatch(/12 mods/);
    // Premium is the wrong advice for someone who has not logged in yet.
    expect(said).not.toMatch(/Premium/);
  });
});

describe("downloadAccountCause", () => {
  const api = (state: unknown) => ({ getState: () => state }) as never;

  it("names a free account from Vortex's premium notification when the account itself is unreadable", async () => {
    const { downloadAccountCause } = await import("./checkNexusAccount");
    const state = {
      session: { notifications: { notifications: [{ type: "error", message: "Only available to premium users" }] } },
    };
    expect(downloadAccountCause(api(state))).toBe("free");
  });

  it("is undefined when nothing points at the account", async () => {
    const { downloadAccountCause } = await import("./checkNexusAccount");
    expect(downloadAccountCause(api({ session: { notifications: { notifications: [] } } }))).toBeUndefined();
  });
});
