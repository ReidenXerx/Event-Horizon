/**
 * loadOrder.reapply (Fallout-collection, 2026-11-17): the Doctor's "Re-apply
 * curator's order" for an agent. What is tested is the verb's own part: it
 * runs the Doctor's re-apply (never a second writer), says nothing moved on a
 * dry run, and reports a refusal instead of claiming success.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const look = vi.hoisted(() => ({ value: undefined as unknown, after: undefined as unknown, outcome: undefined as unknown, calls: 0 }));

vi.mock("../doctor/loadOrderWatcher", () => ({
  assessActiveOrder: vi.fn(async () => {
    look.calls += 1;
    return look.calls > 1 && look.after !== undefined ? look.after : look.value;
  }),
  reapplyCuratorOrder: vi.fn(async () => look.outcome),
}));

import { reapplyCuratorOrder } from "../doctor/loadOrderWatcher";
import { VERBS } from "./verbs";

const receipt = { packageName: "Ivy", packageVersion: "1.0.61", vortexProfileName: "Ivy's Hard Reset" };
const drifted = {
  kind: "assessed",
  receipt,
  status: { kind: "drifted", owned: 1091, extra: 240, drift: { missing: [], extra: [], compared: 1091, misordered: [{ name: "A.esp", expectedAfter: "Z.esm" }, { name: "B.esp", expectedAfter: "A.esp" }] } },
};
const matches = { kind: "assessed", receipt, status: { kind: "matches", owned: 1091, extra: 240 } };
const stable = { loadOrder: {} };
const api = { getState: () => stable } as never;
const run = (body: Record<string, unknown>) => VERBS["loadOrder.reapply"]!.run(api, body);

beforeEach(() => {
  look.calls = 0;
  look.after = undefined;
  vi.mocked(reapplyCuratorOrder).mockClear();
});

describe("loadOrder.reapply", () => {
  it("a dry run reports the drift and moves nothing", async () => {
    look.value = drifted;
    const r = (await run({ dryRun: true })) as Record<string, unknown>;
    expect(r).toMatchObject({ status: "drifted", misordered: ["A.esp", "B.esp"], reapplied: false });
    expect(reapplyCuratorOrder).not.toHaveBeenCalled();
  });

  it("runs the Doctor's re-apply and checks the order matches afterwards", async () => {
    look.value = drifted;
    look.after = matches;
    look.outcome = { kind: "done", summary: "21 plugins back in place" };
    const r = (await run({})) as Record<string, unknown>;
    expect(reapplyCuratorOrder).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ reapplied: true, after: "matches", verified: { matches: true } });
  }, 20_000);

  it("a refusal is an error, not a success", async () => {
    look.value = drifted;
    look.outcome = { kind: "blocked", reason: "An install is running." };
    await expect(run({})).rejects.toMatchObject({ code: "reapply-blocked" });
  });

  it("an order no collection owns is said plainly", async () => {
    look.value = { kind: "nothing", reason: "other-profile", elsewhere: ["Ivy 1.0.61 in \"Old\""] };
    await expect(run({})).rejects.toMatchObject({ code: "no-collection-order" });
  });
});
