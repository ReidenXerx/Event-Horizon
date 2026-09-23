/**
 * ──────────────────────────────────────────────────────────────────────
 * Is the machine itself ready for this collection?
 *
 * Not the mods — those are the collection's own problem and every other part
 * of this tool handles them. This is the layer underneath: the Microsoft
 * runtimes that xEdit, ENB, and every script-extender plugin link against.
 * A player missing the VC++ redistributable installs a collection perfectly,
 * verifies byte-for-byte, and then watches SKSE plugins fail to load with no
 * message that names the cause.
 *
 * `prerequisites.ts` already knew how to INSTALL these. It had no way to ask
 * whether they were there, so the only thing that ever triggered it was
 * Vortex's own 7-Zip failing to unpack — a repair for the tool, never a
 * readiness check for the collection.
 *
 * ─── DETECTION IS A CLAIM, SO IT HAS THREE ANSWERS ─────────────────────
 * `present`, `absent`, and `unknown`. The third is not a rounding error: a
 * registry read can fail because the key is missing (absent) or because the
 * query itself did not work — no `reg.exe`, a Wine prefix that answers
 * strangely, a permissions refusal. Reporting "you are missing VC++" to
 * someone who has it is how a diagnostic gets ignored, and this project's
 * rule is that a false positive costs more than a false negative.
 *
 * So `unknown` is reported as "could not check", never folded into "missing".
 *
 * ─── THE PROBES ARE INJECTED ───────────────────────────────────────────
 * Registry and filesystem access are passed in, because the interesting cases
 * — a key that is missing, a query that throws, a version too old — are
 * exactly the ones that cannot be produced on the machine running the tests.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { PrerequisiteId } from "./prerequisites";

/** What we managed to learn about one runtime. */
export type RuntimeStatus = "present" | "absent" | "unknown";

export type RuntimeFinding = {
  id: PrerequisiteId;
  name: string;
  status: RuntimeStatus;
  /** The version we read, when we could read one. */
  version?: string;
  /** Why the status is what it is — always set for `unknown`. */
  detail?: string;
};

/**
 * Read one registry value. Resolves `undefined` when the key or value does
 * not exist; REJECTS when the query itself failed.
 *
 * The distinction is the whole point: "not installed" and "could not look"
 * must not arrive as the same answer.
 */
export type ReadRegistryValue = (
  hive: string,
  key: string,
  value: string,
) => Promise<string | undefined>;

/** Does this file exist? Used where a runtime has no reliable registry key. */
export type FileExists = (absolutePath: string) => Promise<boolean>;

/** A folder's entries, or `undefined` when it does not exist. Throws when it cannot be read. */
export type ListDirectory = (absolutePath: string) => Promise<string[] | undefined>;

export type DetectRuntimeDeps = {
  readRegistryValue: ReadRegistryValue;
  fileExists: FileExists;
  listDirectory: ListDirectory;
  /** System directory, so the DirectX probe is not hardcoded to C:. */
  systemDir: string;
  /** Where x64 .NET is installed, in the order its app host looks. */
  dotnetRoots: readonly string[];
};

/**
 * .NET Framework's `Release` DWORD, and what it means.
 *
 * Microsoft publishes these as "a value GREATER THAN OR EQUAL to", because a
 * newer Windows build ships a higher number for the same version. Testing for
 * equality against a specific build is the classic way this check goes wrong.
 */
const DOTNET48_MIN_RELEASE = 528040;

/**
 * Where each runtime records itself.
 *
 * Registry paths are the documented ones. The VC++ redistributables write a
 * per-architecture key under the VS14 hive, which is the same place Microsoft's
 * own installers check before deciding they are already current.
 */
async function probeVcRedist(
  deps: DetectRuntimeDeps,
  arch: "x64" | "x86",
  /** Visual Studio's version for this runtime: 14.0 = 2015–2022. */
  vsVersion: "14.0" | "12.0" | "11.0" = "14.0",
): Promise<{ status: RuntimeStatus; version?: string; detail?: string }> {
  /**
   * BOTH registry views, in order, because which one a runtime lands in is
   * not something to reason about — it is something to look at. Measured on
   * a machine carrying all three:
   *
   *   14.0 x64 → native AND WOW6432Node (native is the newer)
   *   14.0 x86 → WOW6432Node only
   *   12.0 x64 → WOW6432Node only      ← "absent" under the old rule
   *   12.0 x86 → WOW6432Node only
   *   11.0 x86 → WOW6432Node only
   *
   * This probe hardcoded native-for-x64, which is right for 14.0 and wrong
   * for 12.0: it would have reported an installed 2013 x64 runtime missing.
   */
  const keys = [
    `SOFTWARE\\Microsoft\\VisualStudio\\${vsVersion}\\VC\\Runtimes\\${arch}`,
    `SOFTWARE\\WOW6432Node\\Microsoft\\VisualStudio\\${vsVersion}\\VC\\Runtimes\\${arch}`,
  ];
  try {
    let key: string | undefined;
    let installed: string | undefined;
    for (const candidate of keys) {
      const value = await deps.readRegistryValue("HKLM", candidate, "Installed");
      if (value !== undefined) {
        key = candidate;
        installed = value;
        break;
      }
    }
    if (installed === undefined || key === undefined) return { status: "absent" };
    // `Installed` is a DWORD; anything other than 1 means a broken or
    // partially-removed install, which is not "present".
    if (Number.parseInt(installed, 10) !== 1) {
      return {
        status: "absent",
        detail: `the registry records it as not installed (Installed=${installed})`,
      };
    }
    const version = await deps.readRegistryValue("HKLM", key, "Version");
    return {
      status: "present",
      ...(version !== undefined ? { version } : {}),
    };
  } catch (err) {
    return {
      status: "unknown",
      detail: `the registry could not be read: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

async function probeDotNet48(
  deps: DetectRuntimeDeps,
): Promise<{ status: RuntimeStatus; version?: string; detail?: string }> {
  try {
    const release = await deps.readRegistryValue(
      "HKLM",
      "SOFTWARE\\Microsoft\\NET Framework Setup\\NDP\\v4\\Full",
      "Release",
    );
    if (release === undefined) return { status: "absent" };
    const n = Number.parseInt(release, 10);
    if (!Number.isFinite(n)) {
      return {
        status: "unknown",
        detail: `the Release value was not a number ("${release}")`,
      };
    }
    // Greater-than-or-equal, deliberately: a newer Windows ships a higher
    // Release for the same .NET version, so equality would report every
    // up-to-date machine as missing it.
    return n >= DOTNET48_MIN_RELEASE
      ? { status: "present", version: `Release ${n}` }
      : {
          status: "absent",
          detail: `.NET Framework is present but older than 4.8 (Release ${n})`,
        };
  } catch (err) {
    return {
      status: "unknown",
      detail: `the registry could not be read: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/**
 * ─── ASK THE FOLDER THE .NET HOST READS, NOT THE INSTALLER'S NOTE ─────
 * This used to read a `Version` value under
 * `HKLM\SOFTWARE\dotnet\Setup\InstalledVersions\x64\sharedfx\Microsoft.WindowsDesktop.App`.
 * No such value exists: the installer records each version as a value NAME
 * (`8.0.31` = 1), and writes them into the 32-bit registry view, which the
 * 64-bit `reg.exe` does not read. So the probe said "absent" everywhere. On
 * the curator's machine, with 8.0.31 installed, the Doctor reported .NET 8
 * missing and offered to install it.
 *
 * The .NET host resolves a framework by folder,
 * `<root>\shared\Microsoft.WindowsDesktop.App\<version>`, so that folder is
 * the answer to "will a .NET 8 tool start". A prerelease build does not count:
 * a released app does not roll forward onto one.
 */
async function probeDotNetDesktop8(
  deps: DetectRuntimeDeps,
): Promise<{ status: RuntimeStatus; version?: string; detail?: string }> {
  const found: string[] = [];
  const unreadable: string[] = [];
  for (const root of deps.dotnetRoots) {
    const folder = `${root}\\shared\\Microsoft.WindowsDesktop.App`;
    try {
      for (const entry of (await deps.listDirectory(folder)) ?? []) {
        if (/^8\.\d+\.\d+$/.test(entry)) found.push(entry);
      }
    } catch (err) {
      unreadable.push(`${folder}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (found.length > 0) {
    const newest = found.sort(compareVersions)[found.length - 1]!;
    return { status: "present", version: newest };
  }
  // One folder that could not be read is not proof the runtime is missing.
  if (unreadable.length > 0) {
    return { status: "unknown", detail: `could not read ${unreadable.join("; ")}` };
  }
  return { status: "absent" };
}

/** Numeric order for dotted versions: `8.0.31` after `8.0.8`. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function probeDirectX9(
  deps: DetectRuntimeDeps,
): Promise<{ status: RuntimeStatus; detail?: string }> {
  // No registry key worth trusting; the redistributable's job is to drop these
  // DLLs, so their presence IS the answer. d3dx9_43 is the last of the line
  // and the one ENB and older tools link against.
  try {
    const there = await deps.fileExists(`${deps.systemDir}\\d3dx9_43.dll`);
    return there ? { status: "present" } : { status: "absent" };
  } catch (err) {
    return {
      status: "unknown",
      detail: `could not check ${deps.systemDir}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/** Human names, kept beside the probes so a finding can stand alone. */
const NAMES: Record<PrerequisiteId, string> = {
  "vcredist-x64": "Visual C++ v14 Redistributable (x64, covers 2015–2022)",
  "vcredist-x86": "Visual C++ v14 Redistributable (x86, covers 2015–2022)",
  "vcredist2013-x64": "Visual C++ 2013 Redistributable (x64)",
  "vcredist2013-x86": "Visual C++ 2013 Redistributable (x86)",
  "vcredist2012-x86": "Visual C++ 2012 Redistributable (x86)",
  dotnet48: ".NET Framework 4.8",
  "dotnet8-desktop-x64": ".NET 8 Desktop Runtime (x64)",
  directx9: "DirectX 9 runtime (d3dx9)",
};

/**
 * Check the runtimes a modded Bethesda game actually needs.
 *
 * Ordered by how often each is the real cause, matching the catalogue: the
 * VC++ redistributables first, because they are what xEdit, ENB and most
 * script-extender plugins link against.
 */
export async function detectRuntimes(
  deps: DetectRuntimeDeps,
  /**
   * ─── WHAT IS WORTH REPORTING IS NARROWER THAN WHAT IS DETECTABLE ─────
   * The two VC++ redistributables are the catalogue's only `recommended`
   * entries and the ones xEdit, ENB and script-extender plugins link against.
   * .NET Framework 4.8 is here because it is a real requirement for several
   * modding tools — it ships with Windows 10 1903+ and 11, so it is almost
   * always present, and that is fine: a check that passes silently costs
   * nothing.
   *
   * `dotnet8-desktop-x64` and `directx9` are deliberately NOT in the default
   * set. Both are `recommended: false`, most Bethesda setups never need them,
   * and reporting them absent on every machine would be a readiness check
   * crying wolf — which is how the whole report gets ignored on the day one
   * of these actually is the cause. They stay detectable for a caller that
   * has reason to ask.
   */
  which: readonly PrerequisiteId[] = [
    "vcredist-x64",
    "vcredist-x86",
    "dotnet48",
  ],
): Promise<RuntimeFinding[]> {
  const out: RuntimeFinding[] = [];
  for (const id of which) {
    const probe =
      id === "vcredist-x64"
        ? await probeVcRedist(deps, "x64")
        : id === "vcredist-x86"
          ? await probeVcRedist(deps, "x86")
            : id === "vcredist2013-x64"
            ? await probeVcRedist(deps, "x64", "12.0")
            : id === "vcredist2013-x86"
              ? await probeVcRedist(deps, "x86", "12.0")
              : id === "vcredist2012-x86"
                ? await probeVcRedist(deps, "x86", "11.0")
                : id === "dotnet48"
                  ? await probeDotNet48(deps)
                  : id === "dotnet8-desktop-x64"
                    ? await probeDotNetDesktop8(deps)
                    : await probeDirectX9(deps);
    out.push({ id, name: NAMES[id], ...probe });
  }
  return out;
}

/**
 * What to tell the player, or `undefined` when there is nothing worth saying.
 *
 * Silent when everything is present — a readiness check that speaks on a ready
 * machine is a readiness check people stop reading.
 *
 * "Missing" and "could not check" are separate paragraphs on purpose. They ask
 * for different things: one is a download, the other is a reason to look at
 * the log if something misbehaves later.
 */
export function describeRuntimeFindings(
  findings: readonly RuntimeFinding[],
): string[] | undefined {
  const absent = findings.filter((f) => f.status === "absent");
  const unknown = findings.filter((f) => f.status === "unknown");
  if (absent.length === 0 && unknown.length === 0) return undefined;

  const lines: string[] = [];
  if (absent.length > 0) {
    lines.push(
      `${absent.length} system runtime(s) this collection needs are not ` +
        `installed: ${absent.map((f) => f.name).join(", ")}. Mods themselves ` +
        `will install fine without them — what breaks is xEdit, ENB and the ` +
        `script-extender plugins, usually with no message that names the ` +
        `cause.`,
    );
    for (const f of absent) {
      if (f.detail !== undefined) lines.push(`  - ${f.name}: ${f.detail}`);
    }
  }
  if (unknown.length > 0) {
    lines.push(
      `${unknown.length} could not be checked (${unknown
        .map((f) => f.name)
        .join(", ")}). That is not the same as missing — it means the check ` +
        `itself did not work, which is normal under Wine/Proton. If something ` +
        `misbehaves later, these are worth ruling out by hand.`,
    );
  }
  return lines;
}
