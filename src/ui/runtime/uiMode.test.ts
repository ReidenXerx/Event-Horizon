import { describe, expect, it } from "vitest";
import { confirmCuratorAction, setUiMode, CURATOR_CONFIRM_LABEL } from "./uiMode";

// ilhamitaa24, 2026-11-06: a player ran Curator Tools' "Make it work" on Ivy and got a chain of extra mods.
const apiAnswering = (action: string | undefined): { calls: number; api: never } => {
  const box = { calls: 0, api: undefined as never };
  box.api = {
    showDialog: async () => {
      box.calls += 1;
      return { action };
    },
  } as never;
  return box;
};

describe("confirmCuratorAction", () => {
  it("asks in Player mode and runs only on Continue", async () => {
    setUiMode("player");
    const cancel = apiAnswering("Cancel");
    expect(await confirmCuratorAction(cancel.api, "Install things.")).toBe(false);
    expect(cancel.calls).toBe(1);
    const go = apiAnswering(CURATOR_CONFIRM_LABEL);
    expect(await confirmCuratorAction(go.api, "Install things.")).toBe(true);
  });

  it("never asks in Curator mode", async () => {
    setUiMode("curator");
    const box = apiAnswering(undefined);
    expect(await confirmCuratorAction(box.api, "Install things.")).toBe(true);
    expect(box.calls).toBe(0);
    setUiMode("player");
  });

  it("refuses in Player mode when no dialog can be shown", async () => {
    setUiMode("player");
    expect(await confirmCuratorAction({} as never, "Install things.")).toBe(false);
  });
});
