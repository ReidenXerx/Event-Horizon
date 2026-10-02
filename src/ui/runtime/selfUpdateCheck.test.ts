import { describe, expect, it } from "vitest";

import { isNewer, selfUpdateFindings } from "./selfUpdateCheck";

const listed = [{ modId: "2235", version: "0.2.30" }, { modId: 99, version: "1.0.0" }];

describe("Event Horizon notices when Vortex will never update it (a player 22 releases behind, 2026-10-02)", () => {
  it("a hand-installed copy behind Nexus is told so", () => {
    const f = selfUpdateFindings({ k1: { name: "Event Horizon", version: "0.2.8", path: "plugins/eh" } }, listed, "0.2.8");
    expect(f).toEqual([{ kind: "manual-install-behind", installed: "0.2.8", latest: "0.2.30" }]);
  });

  it("a copy Vortex installed from its list (mod id recorded) is left to Vortex", () => {
    const f = selfUpdateFindings({ k1: { name: "Event Horizon", version: "0.2.8", modId: 2235 } }, listed, "0.2.8");
    expect(f).toEqual([]);
  });

  it("a hand-installed copy that is current says nothing", () => {
    expect(selfUpdateFindings({ k1: { name: "Event Horizon", version: "0.2.30" } }, listed, "0.2.30")).toEqual([]);
  });

  it("two installed copies are named", () => {
    const f = selfUpdateFindings(
      {
        a: { name: "Event Horizon", version: "0.2.8", path: "plugins/old" },
        b: { name: "Event Horizon", version: "0.2.30", path: "plugins/vortex-event-horizon", modId: 2235 },
      },
      listed,
      "0.2.30",
    );
    expect(f).toEqual([
      { kind: "duplicates", copies: [{ version: "0.2.8", path: "plugins/old" }, { version: "0.2.30", path: "plugins/vortex-event-horizon" }] },
    ]);
  });

  it("compares versions as numbers: 0.2.30 is newer than 0.2.8 and 0.2.3", () => {
    expect(isNewer("0.2.30", "0.2.8")).toBe(true);
    expect(isNewer("0.2.30", "0.2.3")).toBe(true);
    expect(isNewer("0.2.8", "0.2.30")).toBe(false);
    expect(isNewer("0.2.30", "0.2.30")).toBe(false);
  });
});
