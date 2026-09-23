/**
 * ──────────────────────────────────────────────────────────────────────
 * The three answers, and why the third one has to exist.
 *
 * Every case here is one the machine running these tests cannot produce: a
 * missing key, a registry that refuses, a .NET release too old, a partially
 * removed runtime. The probes are injected precisely so those are reachable —
 * a detection layer tested only against the developer's own healthy machine
 * has tested the one outcome that cannot fail.
 * ──────────────────────────────────────────────────────────────────────
 */
import { describe, expect, it } from "vitest";

import {
  describeRuntimeFindings,
  detectRuntimes,
  type DetectRuntimeDeps,
} from "./detectRuntimes";
import type { PrerequisiteId } from "./prerequisites";

/** A registry that answers from a plain map; anything absent is `undefined`. */
const deps = (over: {
  registry?: Record<string, string>;
  throwOn?: string;
  files?: string[];
  /** Folder -> entries. A folder not listed does not exist. */
  dirs?: Record<string, string[]>;
  throwOnDir?: string;
  dotnetRoots?: string[];
}): DetectRuntimeDeps => ({
  readRegistryValue: async (hive, key, value) => {
    const at = `${hive}\\${key}\\${value}`;
    if (over.throwOn !== undefined && at.includes(over.throwOn)) {
      throw new Error("access denied");
    }
    return over.registry?.[at];
  },
  fileExists: async (p) => (over.files ?? []).includes(p),
  listDirectory: async (p) => {
    if (over.throwOnDir !== undefined && p.includes(over.throwOnDir)) {
      throw new Error("EPERM: operation not permitted");
    }
    return over.dirs?.[p];
  },
  systemDir: "C:\\Windows\\System32",
  dotnetRoots: over.dotnetRoots ?? ["C:\\Program Files\\dotnet"],
});

const DESKTOP = "C:\\Program Files\\dotnet\\shared\\Microsoft.WindowsDesktop.App";

const VC64 =
  "HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64";
const NDP = "HKLM\\SOFTWARE\\Microsoft\\NET Framework Setup\\NDP\\v4\\Full";

const only = async (d: DetectRuntimeDeps, id: PrerequisiteId) =>
  (await detectRuntimes(d, [id]))[0]!;

describe("the VC++ redistributables", () => {
  it("reads present, with its version", async () => {
    const f = await only(
      deps({
        registry: {
          [`${VC64}\\Installed`]: "1",
          [`${VC64}\\Version`]: "v14.38.33130",
        },
      }),
      "vcredist-x64",
    );
    expect(f.status).toBe("present");
    expect(f.version).toBe("v14.38.33130");
  });

  it("reads absent when the key is not there", async () => {
    const f = await only(deps({}), "vcredist-x64");
    expect(f.status).toBe("absent");
  });

  it("treats Installed=0 as absent, not present", async () => {
    // A partially removed runtime leaves the key behind with a zero. Reading
    // "the key exists" as "it is installed" would report a broken machine as
    // healthy — which is the direction that costs a support conversation.
    const f = await only(
      deps({ registry: { [`${VC64}\\Installed`]: "0" } }),
      "vcredist-x64",
    );
    expect(f.status).toBe("absent");
    expect(f.detail).toMatch(/Installed=0/);
  });

  it("reads UNKNOWN — never absent — when the registry refuses", async () => {
    /**
     * The distinction the whole module exists for. Under Wine, or with a
     * locked-down policy, the query fails; telling that user they are missing
     * VC++ when they are not is how a diagnostic gets ignored.
     */
    const f = await only(deps({ throwOn: "Runtimes" }), "vcredist-x64");
    expect(f.status).toBe("unknown");
    expect(f.detail).toMatch(/could not be read/);
  });

  it("looks under the 32-bit view for x86", async () => {
    // The x86 runtime registers under WOW6432Node on a 64-bit Windows.
    // Probing the same path as x64 would report it missing on every machine.
    const f = await only(
      deps({
        registry: {
          "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x86\\Installed":
            "1",
        },
      }),
      "vcredist-x86",
    );
    expect(f.status).toBe("present");
  });
});

describe(".NET Framework", () => {
  it("accepts a Release NEWER than 4.8's baseline", async () => {
    /**
     * Microsoft publishes these as "greater than or equal to", because a
     * newer Windows ships a higher Release for the same .NET version.
     * Comparing for equality against one build is the classic way this check
     * reports every up-to-date machine as missing it.
     */
    const f = await only(
      deps({ registry: { [`${NDP}\\Release`]: "533320" } }),
      "dotnet48",
    );
    expect(f.status).toBe("present");
  });

  it("accepts the baseline exactly", async () => {
    const f = await only(
      deps({ registry: { [`${NDP}\\Release`]: "528040" } }),
      "dotnet48",
    );
    expect(f.status).toBe("present");
  });

  it("reports an older .NET as absent, and says it is old rather than missing", async () => {
    const f = await only(
      deps({ registry: { [`${NDP}\\Release`]: "461808" } }),
      "dotnet48",
    );
    expect(f.status).toBe("absent");
    expect(f.detail).toMatch(/older than 4\.8/);
  });

  it("reports a non-numeric Release as unknown", async () => {
    const f = await only(
      deps({ registry: { [`${NDP}\\Release`]: "garbage" } }),
      "dotnet48",
    );
    expect(f.status).toBe("unknown");
  });
});

describe(".NET Desktop Runtime 8", () => {
  it("is present when the host's own framework folder holds an 8.x", async () => {
    // The real listing on the curator's machine, which the old registry probe
    // called "absent": every major from 6 to 10 side by side.
    const f = await only(
      deps({ dirs: { [DESKTOP]: ["10.0.12", "10.0.8", "10.0.9", "6.0.36", "7.0.20", "8.0.31", "9.0.20"] } }),
      "dotnet8-desktop-x64",
    );
    expect(f.status).toBe("present");
    expect(f.version).toBe("8.0.31");
  });

  it("reports the newest 8.x in numeric order, not string order", async () => {
    const f = await only(deps({ dirs: { [DESKTOP]: ["8.0.8", "8.0.31", "8.0.11"] } }), "dotnet8-desktop-x64");
    expect(f.version).toBe("8.0.31");
  });

  it("is absent when only other majors are installed", async () => {
    // .NET 9 and 10 do not run a .NET 8 app without a roll-forward setting.
    const f = await only(deps({ dirs: { [DESKTOP]: ["9.0.20", "10.0.12"] } }), "dotnet8-desktop-x64");
    expect(f.status).toBe("absent");
  });

  it("does not count a prerelease build", async () => {
    const f = await only(deps({ dirs: { [DESKTOP]: ["8.0.0-rc.2.23479.6"] } }), "dotnet8-desktop-x64");
    expect(f.status).toBe("absent");
  });

  it("is absent when .NET was never installed there", async () => {
    const f = await only(deps({}), "dotnet8-desktop-x64");
    expect(f.status).toBe("absent");
  });

  it("finds it under a DOTNET_ROOT as well as the global install", async () => {
    const f = await only(
      deps({
        dotnetRoots: ["D:\\sdk\\dotnet", "C:\\Program Files\\dotnet"],
        dirs: { [DESKTOP]: ["8.0.31"] },
      }),
      "dotnet8-desktop-x64",
    );
    expect(f.status).toBe("present");
  });

  it("says it could not check, not absent, when a folder cannot be read", async () => {
    const f = await only(deps({ throwOnDir: "WindowsDesktop" }), "dotnet8-desktop-x64");
    expect(f.status).toBe("unknown");
    expect(f.detail).toMatch(/EPERM/);
  });

  it("lets a readable folder that HAS it win over one that could not be read", async () => {
    const f = await only(
      deps({
        dotnetRoots: ["D:\\locked\\dotnet", "C:\\Program Files\\dotnet"],
        throwOnDir: "D:\\locked",
        dirs: { [DESKTOP]: ["8.0.31"] },
      }),
      "dotnet8-desktop-x64",
    );
    expect(f.status).toBe("present");
  });
});

describe("what the player is told", () => {
  it("says nothing at all when everything is present", async () => {
    // A readiness check that speaks on a ready machine is one people stop
    // reading, and then it is worth nothing on the day it matters.
    const findings = await detectRuntimes(
      deps({
        registry: {
          [`${VC64}\\Installed`]: "1",
          "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x86\\Installed":
            "1",
          [`${NDP}\\Release`]: "533320",
        },
      }),
    );
    expect(findings.every((f) => f.status === "present")).toBe(true);
    expect(describeRuntimeFindings(findings)).toBeUndefined();
  });

  it("keeps 'missing' and 'could not check' in separate sentences", async () => {
    // They ask for different things: one is a download, the other is a reason
    // to look at the log later. Merging them would tell a Wine user to
    // install something they may well already have.
    const findings = await detectRuntimes(deps({ throwOn: "NET Framework" }));
    const lines = describeRuntimeFindings(findings)!;
    const said = lines.join(" ");
    expect(said).toMatch(/are not installed/);
    expect(said).toMatch(/could not be checked/);
    expect(said).toMatch(/not the same as missing/);
  });

  it("names what breaks, not the runtime", async () => {
    // "Missing vcredist" means nothing to a player. "xEdit, ENB and the
    // script-extender plugins" is the sentence they can act on.
    const findings = await detectRuntimes(deps({}), ["vcredist-x64"]);
    const said = describeRuntimeFindings(findings)!.join(" ");
    expect(said).toMatch(/script-extender/);
    expect(said).toMatch(/Mods themselves will install fine/);
  });
});

describe("the older VC++ runtimes, which are not superseded", () => {
  /**
   * A 2015-2022 redistributable does not satisfy a binary that links
   * msvcr120.dll or msvcr110.dll by name - Microsoft ships them side by side,
   * and the curator's own machine carries 2022, 2013 (x64+x86) and 2012 (x86).
   */
  const NATIVE = (ver: string, arch: string): string =>
    `HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\${ver}\\VC\\Runtimes\\${arch}`;
  const WOW = (ver: string, arch: string): string =>
    `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\VisualStudio\\${ver}\\VC\\Runtimes\\${arch}`;

  it("finds the 2013 x64 runtime under the WOW node, where it actually lives", async () => {
    /**
     * The measured shape, and the reason the probe now tries both views:
     * 12.0 x64 registers ONLY under WOW6432Node. The old probe looked at the
     * native view for x64 and would have called an installed runtime missing.
     */
    const f = await only(
      deps({
        registry: {
          [`${WOW("12.0", "x64")}\\Installed`]: "1",
          [`${WOW("12.0", "x64")}\\Version`]: "v12.0.40664.00",
        },
      }),
      "vcredist2013-x64",
    );
    expect(f.status).toBe("present");
    expect(f.version).toBe("v12.0.40664.00");
  });

  it("finds the 2012 x86 runtime", async () => {
    const f = await only(
      deps({ registry: { [`${WOW("11.0", "x86")}\\Installed`]: "1" } }),
      "vcredist2012-x86",
    );
    expect(f.status).toBe("present");
  });

  it("does not mistake a 2022 runtime for a 2013 one", async () => {
    // The whole point: having 14.x says nothing about 12.x.
    const f = await only(
      deps({ registry: { [`${NATIVE("14.0", "x64")}\\Installed`]: "1" } }),
      "vcredist2013-x64",
    );
    expect(f.status).toBe("absent");
  });

  it("still prefers the native view when a runtime is in both", async () => {
    // 14.0 x64 registers in both, and the native key carries the newer
    // version. Reading the stale one would report an out-of-date runtime.
    const f = await only(
      deps({
        registry: {
          [`${NATIVE("14.0", "x64")}\\Installed`]: "1",
          [`${NATIVE("14.0", "x64")}\\Version`]: "v14.51.36247.00",
          [`${WOW("14.0", "x64")}\\Installed`]: "1",
          [`${WOW("14.0", "x64")}\\Version`]: "v14.44.35211.00",
        },
      }),
      "vcredist-x64",
    );
    expect(f.version).toBe("v14.51.36247.00");
  });

  it("reports a registry that refuses as unknown, not missing", async () => {
    const f = await only(deps({ throwOn: "VisualStudio\\12.0" }), "vcredist2013-x86");
    expect(f.status).toBe("unknown");
    expect(f.detail).toMatch(/could not be read/);
  });
});
