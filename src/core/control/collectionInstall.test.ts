/**
 * collection.install (owner, 2026-11-17): an agent runs the install page's own
 * session with nobody at the screen. What is tested here is the part that is
 * NOT the page's: who presses what at each start gate, which of the player's
 * mods are carried, and that a person at the screen still gets every dialog.
 */
import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { agentAnswer, ownModsToCarry } from "./collectionInstall";
import type { AgentAsk, AgentAskKind } from "../../ui/pages/install/installSession";
import { wizardReducer, type WizardState } from "../../ui/pages/install/state";

const ask = (kind: AgentAskKind, actions: string[]): AgentAsk => ({ kind, title: "t", text: "x", actions });
const off = { allowOverBudget: false };

describe("the agent's answer at each start gate", () => {
  it("takes the fix the dialog itself offers, and goes on", () => {
    expect(agentAnswer(ask("auto-deploy", ["Leave it on", "Turn it off"]), off)).toEqual({ label: "Turn it off", stops: false });
    expect(agentAnswer(ask("auto-sort", ["Leave it on", "Turn it off"]), off)).toEqual({ label: "Turn it off", stops: false });
    expect(agentAnswer(ask("clean-plan", ["Cancel", "Move them aside"]), off)).toEqual({ label: "Move them aside", stops: false });
  });

  it("stops wherever the machine cannot take the install", () => {
    for (const kind of ["extractor-broken", "environment-blocked", "active-game-changed", "clean-failed", "no-deployment-method"] as const) {
      expect(agentAnswer(ask(kind, ["Close"]), off)).toEqual({ label: "Close", stops: true });
    }
    expect(agentAnswer(ask("auto-sort-still-on", ["Cancel", "Install anyway"]), off)).toEqual({ label: "Cancel", stops: true });
    // A check that could not run is a person's call, never an agent's.
    expect(agentAnswer(ask("environment-check-crashed", ["Cancel", "Install anyway"]), off)).toEqual({ label: "Cancel", stops: true });
  });

  it("goes over the plugin limit only when the caller said so", () => {
    expect(agentAnswer(ask("plugin-budget", ["Cancel", "Install anyway"]), off)).toEqual({ label: "Cancel", stops: true });
    expect(agentAnswer(ask("plugin-budget", ["Cancel", "Install anyway"]), { allowOverBudget: true })).toEqual({ label: "Install anyway", stops: false });
  });

  it("an offer with no second button is a stop, never a press of nothing", () => {
    expect(agentAnswer(ask("auto-deploy", ["Close"]), off).stops).toBe(true);
  });
});

describe("the player's own mods carried into the fresh profile", () => {
  const plan = {
    modResolutions: [
      { decision: { kind: "nexus-use-existing", existingModId: "ivy-a" } },
      { decision: { kind: "nexus-download" } },
    ],
  } as never;
  const pool = {
    "ivy-a": { attributes: { name: "Ivy A" } },
    mine: { attributes: { customFileName: "My Patch" } },
    "mine-off": { attributes: { name: "Off" } },
  };

  it("carries what is on in that profile, in the pool, and not the collection's", () => {
    const carry = ownModsToCarry({
      plan,
      pool,
      modState: { "ivy-a": { enabled: true }, mine: { enabled: true }, "mine-off": { enabled: false }, gone: { enabled: true } },
    });
    expect(carry).toEqual([{ vortexModId: "mine", name: "My Patch" }]);
  });

  it("the reducer puts them on the preview as carried, keeping any kept-off offers", () => {
    const preview = {
      kind: "preview",
      bundle: { previousRevision: { keepOff: [{ compareKey: "k", name: "K", keep: true }], refused: [], carry: [] } },
    } as unknown as WizardState;
    const next = wizardReducer(preview, { type: "agent-carry", carry: [{ vortexModId: "mine", name: "My Patch" }], previousEnabledPlugins: ["mine.esp"] });
    const prev = (next as { bundle: { previousRevision: unknown } }).bundle.previousRevision;
    expect(prev).toEqual({
      keepOff: [{ compareKey: "k", name: "K", keep: true }],
      refused: [],
      carry: [{ vortexModId: "mine", name: "My Patch", carry: true }],
      previousEnabledPlugins: ["mine.esp"],
    });
    // Nowhere but the preview.
    const other = { kind: "pick" } as WizardState;
    expect(wizardReducer(other, { type: "agent-carry", carry: [] })).toBe(other);
  });
});

describe("the session: a person at the screen still gets every dialog", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../ui/pages/install/installSession.ts"), "utf8");

  it("ask() shows Vortex's dialog whenever no agent is set", () => {
    expect(src).toContain("if (agent === undefined) return api.showDialog?.(type, title, content, actions);");
  });

  it("every start-gate question goes through ask(), one kind each", () => {
    const kinds = [...src.matchAll(/this\.ask\(api, "([a-z-]+)"/g)].map((m) => m[1]);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds.sort()).toEqual(
      [
        "active-game-changed",
        "auto-deploy",
        "auto-sort",
        "auto-sort-still-on",
        "clean-failed",
        "clean-plan",
        "environment-blocked",
        "environment-check-crashed",
        "extractor-broken",
        "no-deployment-method",
        "plugin-budget",
      ].sort(),
    );
  });
});

describe("an older copy of a collection mod is not the player's own", () => {
  it("is left behind when the collection installs another file of its Nexus page", () => {
    const carry = ownModsToCarry({
      plan: { modResolutions: [] } as never,
      pool: {
        "tacticool-0.23.30": { attributes: { name: "Tacticool", modId: 12345, source: "nexus" } },
        mine: { attributes: { name: "Mine", modId: 999, source: "nexus" } },
        local: { attributes: { name: "Local", modId: 12345, source: "website" } },
      },
      modState: { "tacticool-0.23.30": { enabled: true }, mine: { enabled: true }, local: { enabled: true } },
      collectionNexusModIds: new Set(["12345"]),
    });
    expect(carry.map((c) => c.vortexModId)).toEqual(["local", "mine"]);
  });
});
