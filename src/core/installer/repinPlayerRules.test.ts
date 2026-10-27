/**
 * Vex (Ivy, 2026-10-27): a LOOT rule put WCLI_Vault111.esp and its previs
 * after his own The Labour Exchange; Sort honoured it, and "Re-apply curator's
 * order" put WCLI back above it. The re-pin now keeps the player's own rules.
 */
import { describe, expect, it } from "vitest";

import { repinCuratorOrder } from "./repinPluginOrder";
import { readUserPluginMasters } from "./userPluginMasters";

const CURATOR = ["A.esp", "WCLI_Vault111.esp", "WCLI_Vault111_Previs.esp", "B.esp"];
// After Sort with the rule: Labour moved WCLI later, so the collection's
// slots are no longer in the curator's sequence.
const SORTED = ["A.esp", "B.esp", "Labour.esp", "WCLI_Vault111.esp", "WCLI_Vault111_Previs.esp"];

const stateWith = (userlist: unknown[]): unknown => ({
  session: { plugins: { pluginList: {} } },
  userlist: { plugins: userlist },
});

describe("the re-pin keeps the player's own LOOT rules", () => {
  it("without the rule, re-apply puts WCLI back above the player's plugin (the report)", () => {
    expect(repinCuratorOrder(CURATOR, SORTED, {})).toEqual([
      "A.esp",
      "WCLI_Vault111.esp",
      "Labour.esp",
      "WCLI_Vault111_Previs.esp",
      "B.esp",
    ]);
  });

  it("a collection plugin ruled after the player's: the player's plugin moves up, the curator's order stands", async () => {
    const rules = await readUserPluginMasters(
      stateWith([
        { name: "wcli_vault111.esp", after: ["labour.esp"] },
        { name: "wcli_vault111_previs.esp", after: [{ name: "labour.esp" }] },
      ]),
      CURATOR,
    );
    expect(repinCuratorOrder(CURATOR, SORTED, rules)).toEqual([
      "A.esp",
      "Labour.esp",
      "WCLI_Vault111.esp",
      "WCLI_Vault111_Previs.esp",
      "B.esp",
    ]);
  });

  it("the player's plugin ruled after a collection plugin moves below it", async () => {
    const rules = await readUserPluginMasters(stateWith([{ name: "Labour.esp", after: ["B.esp"] }]), CURATOR);
    const out = repinCuratorOrder(CURATOR, SORTED, rules);
    expect(out.indexOf("Labour.esp")).toBeGreaterThan(out.indexOf("B.esp"));
    expect(out.filter((n) => n !== "Labour.esp")).toEqual(CURATOR);
  });

  it("a rule between two collection plugins is the curator's call, not kept", async () => {
    const rules = await readUserPluginMasters(stateWith([{ name: "A.esp", after: ["B.esp"] }]), CURATOR);
    expect(rules).toEqual({});
  });

  it("does not lift the player's plugin above its own master", () => {
    const rules = { "wcli_vault111.esp": ["Labour.esp"], "labour.esp": ["A.esp"] };
    const order = ["B.esp", "WCLI_Vault111.esp", "A.esp", "Labour.esp"];
    const out = repinCuratorOrder(["B.esp", "WCLI_Vault111.esp", "A.esp"], order, rules);
    expect(out.indexOf("Labour.esp")).toBeGreaterThan(out.indexOf("A.esp"));
  });
});
