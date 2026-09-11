import { describe, expect, it } from "vitest";

import { describeRequirementCell, requirementCellCategory, type ModRequirementReport } from "./requirements";

const satisfied = { source: "nexus" as const, status: "satisfied" as const, name: "SKSE64", nexusModId: 30379, satisfiedBy: ["skse"] };
const missing = { source: "nexus" as const, status: "missing" as const, name: "Gone", nexusModId: 1, gameDomain: "skyrimspecialedition", satisfiedBy: [] };

describe("a Requirements list Nexus cut short", () => {
  it("is 'incomplete', not 'ok', when everything that came back is met", () => {
    const r: ModRequirementReport = { modId: "m", truncatedBy: 4, unfetched: false, requirements: [satisfied] };
    expect(requirementCellCategory(r)).toBe("incomplete");
    expect(describeRequirementCell(r)).toBe("incomplete");
  });

  it("still leads with what is missing, and says the list is incomplete", () => {
    const r: ModRequirementReport = { modId: "m", truncatedBy: 4, unfetched: false, requirements: [satisfied, missing] };
    expect(requirementCellCategory(r)).toBe("missing");
    expect(describeRequirementCell(r)).toBe("1 missing · incomplete");
  });

  it("is 'ok' only when the list is whole", () => {
    const r: ModRequirementReport = { modId: "m", truncatedBy: 0, unfetched: false, requirements: [satisfied] };
    expect(requirementCellCategory(r)).toBe("ok");
    expect(describeRequirementCell(r)).toBe("ok");
  });
});
