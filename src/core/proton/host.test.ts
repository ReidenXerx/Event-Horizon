/**
 * What Wine tells a process about the Linux side, read into plain facts. The
 * shapes are Wine's own (dlls/ntdll/unix/env.c): the home and the prefix arrive
 * as NT paths through Z:, the host's HOME and XDG_* renamed WINE_HOST_*.
 */
import * as path from "path";

import { describe, expect, it } from "vitest";

import { linuxPathOf, linuxPathThroughRoot, reachLinuxPath, readWineHost, vortexLinuxPath } from "./host";

describe("readWineHost", () => {
  it("reads the Linux home, Vortex's own prefix and XDG_CONFIG_HOME from what Wine puts in the environment", () => {
    expect(
      readWineHost({
        WINEHOMEDIR: "\\??\\Z:\\home\\deck",
        WINECONFIGDIR: "\\??\\Z:\\home\\deck\\.local\\share\\Steam\\steamapps\\compatdata\\2977443913\\pfx",
        WINE_HOST_XDG_CONFIG_HOME: "/home/deck/.config",
      }),
    ).toEqual({
      unixRoot: "Z:\\",
      homes: ["/home/deck"],
      xdgConfigHome: "/home/deck/.config",
      vortexPrefix: "/home/deck/.local/share/Steam/steamapps/compatdata/2977443913/pfx",
    });
  });

  it("does not translate a drive other than Z:, and ignores a Windows HOME", () => {
    expect(linuxPathOf("\\??\\X:\\Games")).toBeUndefined();
    expect(linuxPathOf("Z:\\")).toBe("/");
    expect(readWineHost({ HOME: "C:\\users\\steamuser", WINE_HOST_HOME: "/home/deck" }).homes).toEqual(["/home/deck"]);
  });
});

describe("Linux paths through the Z: drive", () => {
  const host = { unixRoot: "Z:\\", homes: [], vortexPrefix: "/home/deck/Vortex/pfx" };

  it("reaches a Linux path through Z:, and reads one back — no other drive", () => {
    expect(reachLinuxPath(host, "/home/deck/Games")).toBe(path.join("Z:\\", "home", "deck", "Games"));
    expect(linuxPathThroughRoot(host, "Z:\\home\\deck\\Games")).toBe("/home/deck/Games");
    expect(linuxPathThroughRoot(host, "X:\\Games")).toBeUndefined();
  });

  it("maps Vortex's own C: into its prefix's drive_c, and nothing else", () => {
    expect(vortexLinuxPath(host, "C:\\users\\steamuser\\Documents")).toBe("/home/deck/Vortex/pfx/drive_c/users/steamuser/Documents");
    expect(vortexLinuxPath(host, "D:\\Games")).toBeUndefined();
    expect(vortexLinuxPath({ unixRoot: "Z:\\", homes: [] }, "C:\\users")).toBeUndefined();
  });
});
