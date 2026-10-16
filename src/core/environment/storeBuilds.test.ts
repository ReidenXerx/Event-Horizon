import { describe, expect, it } from "vitest";

import { storeTwinsOf } from "./storeBuilds";

describe("store twin builds", () => {
  it("names both stores' numbers for Skyrim's last release, however it is spelled", () => {
    expect(storeTwinsOf("skyrimse", "1.6.1179")).toEqual(["1.6.1170.0", "1.6.1179.0"]);
    expect(storeTwinsOf("skyrimse", "1.6.1170.0")).toEqual(["1.6.1170.0", "1.6.1179.0"]);
  });

  it("has none for any other version or game", () => {
    expect(storeTwinsOf("skyrimse", "1.6.640.0")).toEqual([]);
    expect(storeTwinsOf("fallout4", "1.6.1170.0")).toEqual([]);
    expect(storeTwinsOf("skyrimse", "unknown")).toEqual([]);
  });
});
