import { describe, expect, it } from "vitest";

import { claimSingleInstance, duplicateNotice } from "./singleInstance";

describe("claimSingleInstance", () => {
  it("lets the first copy load and turns the second away, naming the running one", () => {
    const host: Record<string, unknown> = {};
    expect(claimSingleInstance(host, { version: "0.2.12", folder: "Event Horizon" })).toEqual({ kind: "first" });
    expect(claimSingleInstance(host, { version: "0.2.14", folder: "event-horizon-2235" })).toEqual({
      kind: "duplicate",
      running: { version: "0.2.12", folder: "Event Horizon" },
    });
  });

  it("gives each process its own claim", () => {
    const renderer: Record<string, unknown> = {};
    const main: Record<string, unknown> = {};
    expect(claimSingleInstance(renderer, { version: "0.2.15", folder: "a" }).kind).toBe("first");
    expect(claimSingleInstance(main, { version: "0.2.15", folder: "a" }).kind).toBe("first");
  });
});

describe("duplicateNotice", () => {
  it("names both copies and what to do", () => {
    const text = duplicateNotice({ version: "0.2.12", folder: "Event Horizon" }, { version: "0.2.14", folder: "eh" });
    expect(text).toContain("0.2.12");
    expect(text).toContain("0.2.14");
    expect(text).toContain("Extensions page");
  });
});
