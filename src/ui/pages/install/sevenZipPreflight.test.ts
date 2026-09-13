/**
 * The preflight's WIRING, as opposed to its logic.
 *
 * checkSevenZipHealth has its own tests. This covers the part that has burned
 * this project repeatedly: a correct function that nothing calls, or calls in
 * a way that swallows the result. On this codebase alone, a whole ZIP reader
 * was swapped out and 566 tests stayed green because the caller was untested.
 *
 * The properties here are the ones a user would notice:
 *   - a broken 7z produces a visible warning
 *   - a healthy 7z produces SILENCE (a preflight that always speaks is one
 *     people learn to dismiss unread)
 *   - it cannot itself break the install, whatever the host api does
 */
import { describe, expect, it, vi } from "vitest";

import type { types } from "@nexusmods/vortex-api";

import { warnIfSevenZipBroken } from "./engine";

type Notification = {
  id?: string;
  type?: string;
  title?: string;
  message?: string;
  actions?: { title: string; action: () => void }[];
};

const fakeApi = (): {
  api: types.IExtensionApi;
  sent: Notification[];
  dialogs: unknown[][];
} => {
  const sent: Notification[] = [];
  const dialogs: unknown[][] = [];
  const api = {
    sendNotification: (n: Notification) => {
      sent.push(n);
    },
    showDialog: (...args: unknown[]) => {
      dialogs.push(args);
      return Promise.resolve({});
    },
  } as unknown as types.IExtensionApi;
  return { api, sent, dialogs };
};

describe("warnIfSevenZipBroken", () => {
  it("says nothing when 7z is healthy", async () => {
    vi.resetModules();
    vi.doMock("../../../core/installer/checkSevenZipHealth", () => ({
      checkSevenZipHealth: () => Promise.resolve({ kind: "ok" }),
      describeSevenZipHealth: () => undefined,
    }));
    const { warnIfSevenZipBroken: fn } = await import("./engine");
    const { api, sent } = fakeApi();
    await fn(api);
    expect(sent).toEqual([]);
    vi.doUnmock("../../../core/installer/checkSevenZipHealth");
  });

  it("warns, with the reason, when 7z is broken", async () => {
    vi.resetModules();
    vi.doMock("../../../core/installer/checkSevenZipHealth", () => ({
      checkSevenZipHealth: () =>
        Promise.resolve({ kind: "broken", why: "spawn 7z.exe ENOENT" }),
      describeSevenZipHealth: () => ({
        message: "Vortex's archive extractor is not working.",
        steps: ["Run scripts/setup-proton.sh", "Detail: spawn 7z.exe ENOENT"],
      }),
    }));
    const { warnIfSevenZipBroken: fn } = await import("./engine");
    const { api, sent } = fakeApi();
    await fn(api);

    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("warning");
    expect(sent[0].message).toMatch(/not working/);
    vi.doUnmock("../../../core/installer/checkSevenZipHealth");
  });

  it("puts the actual steps behind the action, not just a vague warning", async () => {
    // A warning with no next action is the thing that made the tester's
    // original error useless. The steps have to be reachable.
    vi.resetModules();
    vi.doMock("../../../core/installer/checkSevenZipHealth", () => ({
      checkSevenZipHealth: () =>
        Promise.resolve({ kind: "broken", why: "x" }),
      describeSevenZipHealth: () => ({
        message: "broken",
        steps: ["STEP-ONE", "STEP-TWO"],
      }),
    }));
    const { warnIfSevenZipBroken: fn } = await import("./engine");
    const { api, sent, dialogs } = fakeApi();
    await fn(api);

    const action = sent[0].actions?.[0];
    expect(action?.title).toBeTruthy();
    action?.action();
    const text = JSON.stringify(dialogs);
    expect(text).toContain("STEP-ONE");
    expect(text).toContain("STEP-TWO");
    vi.doUnmock("../../../core/installer/checkSevenZipHealth");
  });

  it("survives an api with no notification support at all", async () => {
    // Older Vortex builds, and our own test doubles, may not implement it.
    // The call sites use `?.` — this proves that is not decorative.
    vi.resetModules();
    vi.doMock("../../../core/installer/checkSevenZipHealth", () => ({
      checkSevenZipHealth: () => Promise.resolve({ kind: "broken", why: "x" }),
      describeSevenZipHealth: () => ({ message: "m", steps: ["s"] }),
    }));
    const { warnIfSevenZipBroken: fn } = await import("./engine");
    await expect(fn({} as types.IExtensionApi)).resolves.toBeUndefined();
    vi.doUnmock("../../../core/installer/checkSevenZipHealth");
  });

  it("never throws even if the health check itself explodes", async () => {
    // The whole point of it being a warning rather than a gate.
    vi.resetModules();
    vi.doMock("../../../core/installer/checkSevenZipHealth", () => ({
      checkSevenZipHealth: () => {
        throw new Error("preflight exploded");
      },
      describeSevenZipHealth: () => undefined,
    }));
    const { warnIfSevenZipBroken: fn } = await import("./engine");
    const { api, sent } = fakeApi();
    await expect(fn(api)).resolves.toBeUndefined();
    expect(sent).toEqual([]);
    vi.doUnmock("../../../core/installer/checkSevenZipHealth");
  });
});

describe("the preflight is actually called", () => {
  it("runs inside runLoadingPipeline, before the plan is built", async () => {
    // Enumerate-and-assert (GP-26): the failure mode of a preflight is that
    // someone deletes the one line that calls it and every test still passes,
    // because its own tests only exercise it directly. Read the real source.
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(
      path.join(__dirname, "engine.ts"),
      "utf8",
    );
    const pipeline = src.slice(
      src.indexOf("export async function runLoadingPipeline"),
    );
    const call = pipeline.indexOf("warnIfSevenZipBroken(api)");
    const plan = pipeline.indexOf("resolveInstallPlan(");
    expect(call).toBeGreaterThan(-1);
    expect(plan).toBeGreaterThan(-1);
    // Warning the user after the plan is built would still be before the
    // install, but it delays the one message that saves them the wait.
    expect(call).toBeLessThan(plan);
  });
});
