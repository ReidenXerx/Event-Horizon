import { describe, expect, it } from "vitest";

import { buildOutputFileName, packageFormatOf } from "./packageFileName";

describe("buildOutputFileName", () => {
  it("writes .ehcoll when no format is given, as every build before the question did", () => {
    // The Doctor finds packages by this name, and it passes no format.
    expect(buildOutputFileName("Ivy's Panties", "1.0.26")).toBe("ivy-s-panties-1.0.26.ehcoll");
  });

  it("writes the format the curator picked, and only the extension changes", () => {
    expect(buildOutputFileName("Ivy's Panties", "1.0.26", "zip")).toBe("ivy-s-panties-1.0.26.zip");
    expect(buildOutputFileName("Ivy's Panties", "1.0.26", "ehcoll")).toBe("ivy-s-panties-1.0.26.ehcoll");
  });
});

describe("packageFormatOf", () => {
  it("reads the format from the name, whatever its case", () => {
    expect(packageFormatOf("ivy-1.0.0.EHCOLL")).toBe("ehcoll");
    expect(packageFormatOf("ivy-1.0.0.Zip")).toBe("zip");
  });

  it("says nothing about a name that is neither", () => {
    expect(packageFormatOf("ivy-1.0.0.7z")).toBeUndefined();
    expect(packageFormatOf("notes.txt")).toBeUndefined();
    // What the packager writes before the finished file takes the real name.
    expect(packageFormatOf("ivy-1.0.0.ehcoll.partial")).toBeUndefined();
  });
});
