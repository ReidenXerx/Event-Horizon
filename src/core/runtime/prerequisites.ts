/**
 * ──────────────────────────────────────────────────────────────────────
 * The runtimes Bethesda mods keep asking for, and where to get them.
 *
 * ─── WHY THIS EXISTS ───────────────────────────────────────────────────
 * Script extenders, ENB, xEdit, FOMOD installers with custom C# and half the
 * tooling in this ecosystem link against Microsoft runtimes that are NOT part
 * of a clean Windows install and are almost never part of a Proton prefix. The
 * failure is never "you are missing the Visual C++ runtime" — it is a mod that
 * silently does nothing, an installer that closes instantly, or Vortex's own
 * 7-Zip failing to unpack an archive that is perfectly fine.
 *
 * Users are then asked to diagnose a DLL search failure. Most cannot, and
 * should not have to.
 *
 * ─── EVERY URL HERE WAS VERIFIED, NOT REMEMBERED ───────────────────────
 * Each one was fetched with a ranged GET and confirmed to return HTTP 206 and
 * a PE executable (`MZ` magic) from a Microsoft-owned host. A download link
 * that 404s inside a repair dialog is worse than no repair dialog, because the
 * user concludes the tool is broken rather than the link.
 *
 * ─── EXIT CODES LIE, PARTICULARLY 1638 ─────────────────────────────────
 * Microsoft's redistributables do not return 0 for "fine". 1638 means a NEWER
 * version is already present — a success that reads as a failure, and the
 * single most likely code to see on a machine that has been modded before.
 * Treating it as an error would tell users their working system failed to
 * repair. See {@link classifyExitCode}.
 * ──────────────────────────────────────────────────────────────────────
 */

/** Which runtime, stable across releases so a UI can remember choices. */
export type PrerequisiteId =
  | "vcredist-x64"
  | "vcredist-x86"
  | "vcredist2013-x64"
  | "vcredist2013-x86"
  | "vcredist2012-x86"
  | "dotnet48"
  | "dotnet8-desktop-x64"
  | "directx9";

export interface Prerequisite {
  id: PrerequisiteId;
  /** Shown to the user. */
  name: string;
  /** What actually breaks without it, in the user's terms — not "a runtime". */
  why: string;
  /** Verified official Microsoft URL. */
  url: string;
  /** Approximate download size, so a dialog can be honest before starting. */
  approxBytes: number;
  /** Flags for a non-interactive install. */
  silentArgs: string[];
  /**
   * Recommended by default. Off-by-default entries are ones most people do not
   * need, and a repair that installs 400 MB of things nobody asked for is its
   * own kind of rude.
   */
  recommended: boolean;
  /**
   * Set when this is known to behave badly inside a Wine/Proton prefix. The
   * dialog surfaces it rather than hiding the entry: "known to be unreliable"
   * is information, and a user who wants to try anyway may.
   */
  wineCaveat?: string;
}

/**
 * The catalogue.
 *
 * Ordered by how often it is the actual cause. The VC++ redistributables come
 * first because they are what 7-Zip, xEdit, ENB and most script-extender
 * plugins link against.
 */
export const PREREQUISITES: readonly Prerequisite[] = [
  /**
   * ─── THE CURRENT 14.x PACKAGE IS NOT "2022" ANY MORE ───────────────
   * Microsoft kept the same binary-compatible 14.x ABI and moved the package
   * forward a Visual Studio generation. Measured by downloading both and
   * reading their version resource, 2026-09-18:
   *
   *   aka.ms/vs/17 → 14.44.35211, "Visual C++ 2015-2022 Redistributable"
   *   aka.ms/vs/18 → 14.51.36247, "Visual C++ v14 Redistributable"   ← newer
   *   aka.ms/vs/19 → does not exist (aka.ms falls through to a search page)
   *
   * 18 is also the smaller download (18.7 MB against 25.6 MB for x64), and
   * because every 14.x runtime is binary compatible it satisfies anything
   * built against 2015, 2017, 2019 or 2022. So it is what we ship. The name
   * says "v14" rather than a year for the same reason Microsoft's does: the
   * year was never the thing that mattered.
   */
  {
    id: "vcredist-x64",
    name: "Visual C++ v14 Redistributable (x64, covers 2015–2022)",
    why:
      "Vortex's 7-Zip, xEdit, ENB and most script-extender plugins link " +
      "against this. Without it they either fail to start or fail silently.",
    url: "https://aka.ms/vs/18/release/vc_redist.x64.exe",
    approxBytes: 18_731_856,
    silentArgs: ["/quiet", "/norestart"],
    recommended: true,
  },
  {
    id: "vcredist-x86",
    name: "Visual C++ v14 Redistributable (x86, covers 2015–2022)",
    why:
      "Older 32-bit tools — Fallout 3 / New Vegas era utilities and some " +
      "FOMOD installers — still need the 32-bit runtime.",
    url: "https://aka.ms/vs/18/release/vc_redist.x86.exe",
    approxBytes: 6_941_536,
    silentArgs: ["/quiet", "/norestart"],
    recommended: true,
  },
  /**
   * ─── THE OLDER RUNTIMES ARE NOT SUPERSEDED ─────────────────────────
   * A 2015–2022 redistributable does NOT satisfy a binary built against
   * 2013 or 2012: those link `msvcr120.dll` / `msvcr110.dll` by name, and
   * the 14.x runtime ships neither. Microsoft supports them side by side and
   * a modding machine that has been used for a while accumulates all of
   * them — the curator's own has 2022, 2013 (x64 and x86) and 2012 (x86).
   *
   * Off by default, because most collections never touch a binary this old
   * and 14 MB of installer nobody needs is its own rudeness. The detector
   * still reports them, so the offer appears when one is genuinely absent.
   */
  {
    id: "vcredist2013-x64",
    name: "Visual C++ 2013 Redistributable (x64)",
    why:
      "Some script-extender plugins and older tools link msvcr120.dll by " +
      "name. The 2015–2022 runtime does not contain it, so they fail to load " +
      "with no message naming the cause.",
    url: "https://aka.ms/highdpimfc2013x64enu",
    approxBytes: 7_200_744,
    silentArgs: ["/quiet", "/norestart"],
    recommended: false,
  },
  {
    id: "vcredist2013-x86",
    name: "Visual C++ 2013 Redistributable (x86)",
    why: "The 32-bit half of the same runtime, for older 32-bit modding tools.",
    url: "https://aka.ms/highdpimfc2013x86enu",
    approxBytes: 6_510_136,
    silentArgs: ["/quiet", "/norestart"],
    recommended: false,
  },
  {
    id: "vcredist2012-x86",
    name: "Visual C++ 2012 Redistributable (x86)",
    why:
      "Fallout 3 / New Vegas era utilities and a few FOMOD installers link " +
      "msvcr110.dll. Nothing newer provides it.",
    url:
      "https://download.microsoft.com/download/1/6/B/" +
      "16B06F60-3B20-4FF2-B699-5E9B7962F9AE/VSU_4/vcredist_x86.exe",
    approxBytes: 6_554_576,
    silentArgs: ["/quiet", "/norestart"],
    recommended: false,
  },
  {
    id: "dotnet48",
    name: ".NET Framework 4.8",
    why:
      "Wrye Bash, some FOMOD installers and a number of modding tools are " +
      "built on it. Present on current Windows; almost never in a prefix.",
    url: "https://go.microsoft.com/fwlink/?linkid=2088631",
    approxBytes: 121_300_000,
    silentArgs: ["/q", "/norestart"],
    recommended: false,
    wineCaveat:
      "Notoriously unreliable under Wine. winetricks installs it with special " +
      "handling that a plain silent run does not reproduce, and a failed " +
      "attempt can leave the prefix worse than before. Prefer " +
      "`protontricks <appid> dotnet48` on the Linux side.",
  },
  {
    id: "dotnet8-desktop-x64",
    name: ".NET Desktop Runtime 8 (x64)",
    why: "Newer modding tools and some Vortex extensions target .NET 8.",
    url: "https://aka.ms/dotnet/8.0/windowsdesktop-runtime-win-x64.exe",
    approxBytes: 58_000_000,
    silentArgs: ["/quiet", "/norestart"],
    recommended: false,
  },
  {
    id: "directx9",
    name: "DirectX End-User Runtime (legacy D3DX)",
    why:
      "ENB and older graphics mods need the legacy d3dx9 DLLs, which modern " +
      "Windows does not ship and DirectX 12 does not replace.",
    url:
      "https://download.microsoft.com/download/1/7/1/" +
      "1718CCC4-6315-4D8E-9543-8E28A4E18C4C/dxwebsetup.exe",
    approxBytes: 300_000,
    silentArgs: ["/Q"],
    recommended: false,
    wineCaveat:
      "The web installer needs network access from inside the prefix and " +
      "often stalls there. `protontricks <appid> d3dx9` is more reliable.",
  },
];

/**
 * The ids the install preview is allowed to warn about before an install.
 *
 * Derived from the catalogue rather than re-listed, so adding a runtime and
 * deciding whether it nags are the same decision in the same place. The rest
 * are still detected — they surface in the Doctor, where someone has asked.
 */
export const RECOMMENDED_RUNTIME_IDS: ReadonlySet<PrerequisiteId> = new Set(
  PREREQUISITES.filter((p) => p.recommended).map((p) => p.id),
);

/** What an installer's exit code actually means. */
export type ExitVerdict =
  | { kind: "installed" }
  | { kind: "already-current" }
  | { kind: "needs-reboot" }
  | { kind: "cancelled" }
  | { kind: "failed"; why: string };

/**
 * Microsoft installer exit codes, which are not a simple zero/non-zero.
 *
 * 1638 is the one that matters: "another version of this product is already
 * installed", returned when a NEWER redistributable is present. That is the
 * expected result on any machine that has been modded before, and reporting it
 * as a failure would tell a user with a perfectly good system that the repair
 * did not work.
 */
export function classifyExitCode(code: number): ExitVerdict {
  switch (code) {
    case 0:
      return { kind: "installed" };
    case 1638:
    case 5100:
      // 5100 is the VC++ redistributable's own "a newer version is installed".
      return { kind: "already-current" };
    case 3010:
    case 1641:
      return { kind: "needs-reboot" };
    case 1602:
    case 1223:
      return { kind: "cancelled" };
    case 1603:
      return {
        kind: "failed",
        why:
          "Fatal error during installation (1603). Under Proton this usually " +
          "means the prefix cannot run the installer at all.",
      };
    case 1618:
      return {
        kind: "failed",
        why: "Another installation is already in progress (1618). Wait, then retry.",
      };
    default:
      return { kind: "failed", why: `Installer exited with code ${code}.` };
  }
}

/** True when the verdict means the runtime is present afterwards. */
export function verdictIsGood(v: ExitVerdict): boolean {
  return (
    v.kind === "installed" ||
    v.kind === "already-current" ||
    v.kind === "needs-reboot"
  );
}

/**
 * What to offer, given where we are running.
 *
 * `onWine` does not remove anything — a user who wants to try dotnet48 in a
 * prefix may — it only decides what is preselected. Silently dropping options
 * on Linux would be the same paternalism this feature exists to avoid.
 */
export function planPrerequisites(opts: {
  onWine: boolean;
  /** Preselect everything, e.g. when the extractor is already known broken. */
  aggressive?: boolean;
}): Array<Prerequisite & { preselected: boolean }> {
  return PREREQUISITES.map((p) => ({
    ...p,
    preselected:
      opts.aggressive === true
        ? p.wineCaveat === undefined || !opts.onWine
        : p.recommended && !(opts.onWine && p.wineCaveat !== undefined),
  }));
}
