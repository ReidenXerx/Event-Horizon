import * as fs from "fs";

import { describe, expect, it } from "vitest";

import { nodeRuntimeProbeDeps, windowsSystemDir } from "./nodePrereqDeps";

describe("windowsSystemDir", () => {
  it("joins with a real backslash, not a dropped one", () => {
    // The shipped bug: `${WINDIR}\System32` in a template evaluated to
    // "C:\WINDOWSSystem32", a folder that does not exist.
    expect(windowsSystemDir({ SystemRoot: "C:\\WINDOWS" })).toBe("C:\\WINDOWS\\System32");
  });

  it("prefers SystemRoot and falls back to WINDIR", () => {
    expect(windowsSystemDir({ SystemRoot: "D:\\Win", WINDIR: "E:\\Other" })).toBe("D:\\Win\\System32");
    expect(windowsSystemDir({ WINDIR: "E:\\Other" })).toBe("E:\\Other\\System32");
  });

  it("treats a variable that is set but empty as unset", () => {
    // Otherwise path.join("", "System32") is the RELATIVE path "System32".
    expect(windowsSystemDir({ SystemRoot: "", WINDIR: "C:\\WINDOWS" })).toBe("C:\\WINDOWS\\System32");
    expect(windowsSystemDir({ SystemRoot: "  " })).toBe("C:\\Windows\\System32");
  });

  it("has a default when neither is set", () => {
    expect(windowsSystemDir({})).toBe("C:\\Windows\\System32");
  });

  it.runIf(process.platform === "win32")("names a folder that exists on this machine", () => {
    expect(fs.existsSync(windowsSystemDir())).toBe(true);
  });

  it("is what the real probe deps carry", () => {
    expect(nodeRuntimeProbeDeps().systemDir).toBe(windowsSystemDir());
  });
});
