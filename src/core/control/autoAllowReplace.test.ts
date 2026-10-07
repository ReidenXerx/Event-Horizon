/**
 * Owner, 2026-10-07 (Meridia update run through the control channel): an
 * opt-in setting so replacing an installed mod with an agent's install does
 * not need a click per mod. ONLY that question; every other one still asks.
 */
import * as fs from "fs";
import * as path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prefs = vi.hoisted(() => ({ autoAllowReplace: false }));
vi.mock("../preferences", () => ({
  loadPreferences: () => ({
    controlChannel: { enabled: true, askFirst: true, autoAllowReplace: prefs.autoAllowReplace },
    shownOnce: {},
  }),
}));

import { askOwner } from "./ownerConsent";

const api = () => {
  const asked: string[] = [];
  return {
    asked,
    api: {
      showDialog: async (_type: string, title: string) => {
        asked.push(title);
        return { action: "Allow" };
      },
    } as never,
  };
};

const replace = { action: "replace an installed mod in every profile", kind: "replace-install" as const, lines: ["Mod A"], consequence: "x" };
const remove = { action: "remove 1 mod", lines: ["Mod A"], consequence: "x" };

beforeEach(() => {
  prefs.autoAllowReplace = false;
});

describe("auto-allow replace installs", () => {
  it("asks for a replace install by default", async () => {
    const a = api();
    expect(await askOwner(a.api, replace)).toEqual({ asked: true });
    expect(a.asked).toHaveLength(1);
  });

  it("goes ahead without asking once the owner turns it on", async () => {
    prefs.autoAllowReplace = true;
    const a = api();
    expect(await askOwner(a.api, replace)).toEqual({ asked: false });
    expect(a.asked).toHaveLength(0);
  });

  it("still asks for everything else: removing, purging, moving", async () => {
    prefs.autoAllowReplace = true;
    const a = api();
    await askOwner(a.api, remove);
    expect(a.asked).toEqual(["An agent wants to remove 1 mod"]);
  });

  it("is a question only the replace-install verb marks, and no verb can switch it on", () => {
    const verbs = fs.readFileSync(path.join(__dirname, "verbs.ts"), "utf8");
    expect(verbs.match(/kind: "replace-install"/g)).toHaveLength(1);
    expect(verbs).not.toMatch(/setAgentAutoAllowReplace|autoAllowReplace/);
  });
});
