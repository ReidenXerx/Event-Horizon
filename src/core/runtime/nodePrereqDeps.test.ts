import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { dotnetRootsX64, listDirectory, nodeRuntimeProbeDeps, windowsSystemDir } from "./nodePrereqDeps";

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

describe("dotnetRootsX64", () => {
  it("looks where the app host looks, in its order", () => {
    expect(
      dotnetRootsX64({ DOTNET_ROOT_X64: "D:\\a", DOTNET_ROOT: "D:\\b", ProgramW6432: "C:\\Program Files" }),
    ).toEqual(["D:\\a", "D:\\b", "C:\\Program Files\\dotnet"]);
  });

  it("uses the 64-bit Program Files even from a 32-bit process", () => {
    expect(
      dotnetRootsX64({ ProgramW6432: "C:\\Program Files", ProgramFiles: "C:\\Program Files (x86)" }),
    ).toEqual(["C:\\Program Files\\dotnet"]);
  });

  it("ignores blank variables and has a default", () => {
    expect(dotnetRootsX64({ DOTNET_ROOT: " " })).toEqual(["C:\\Program Files\\dotnet"]);
  });

  it("is what the real probe deps carry", () => {
    expect(nodeRuntimeProbeDeps().dotnetRoots).toEqual(dotnetRootsX64());
  });
});

describe("listDirectory", () => {
  it("tells 'not there' from 'could not read'", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-listdir-"));
    try {
      fs.writeFileSync(path.join(dir, "8.0.31"), "");
      expect(await listDirectory(dir)).toEqual(["8.0.31"]);
      // Missing is an answer: the runtime is not there.
      expect(await listDirectory(path.join(dir, "absent"))).toBeUndefined();
      // A file where a folder should be is a failure, which must not read as "absent".
      await expect(listDirectory(path.join(dir, "8.0.31"))).rejects.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
