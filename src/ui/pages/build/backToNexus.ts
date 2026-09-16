/**
 * "Use the Nexus download": take a Nexus mod the curator had marked external
 * back to being an ordinary Nexus mod (owner request 2026-09-16, while cleaning
 * Meridia: "if I changed my mind to use the mainstream version").
 *
 * The one-way street it closes: the availability panel's "Treat as external"
 * sets `treatAsExternal`, and so does answering "ship my copy" for a Nexus mod,
 * but nothing on the form could undo either. The only way back was editing the
 * collection's config by hand, with Vortex closed.
 *
 * ─── WHAT IT CHANGES ───────────────────────────────────────────────────
 * `treatAsExternal` and `bundled` go false, and nothing else. Bundling a Nexus
 * mod that is not external is refused by the build ("Only external (non-Nexus)
 * mods can be bundled"), so the two go together. A bundle chosen as the answer
 * to "your staging differs from the archive" is cleared with it, which makes
 * the build ask that question again rather than silently ship a verdict about
 * how to deliver a mod that is no longer delivered that way. A mirror or
 * declare answer is a valid answer for a Nexus mod and stays. The link and
 * instructions stay too: they are unused while the mod downloads from Nexus,
 * and switching back to external later finds them where they were.
 *
 * ─── WHY IT ASKS NEXUS FIRST ───────────────────────────────────────────
 * A mod is usually marked external because its file left Nexus. Switching it
 * back blind would move the failure to the user's install. So the file is
 * looked up first: gone means no switch, with the reason and the next step.
 * A lookup that cannot answer is not a problem (the same rule as the
 * availability panel): it switches, and says the check before building will
 * catch a missing file.
 */

import {
  checkNexusAvailability,
  type AvailabilityFinding,
  type NexusFileLike,
} from "../../../core/build/nexusAvailability";
import { nexusCompareKey } from "../../../core/identity/compareKey";
import type { ExternalModConfigEntry } from "../../../core/manifest/collectionConfig";
import { isNexusMod } from "./engine";
import type { BuildContext } from "./engine";

type Mod = BuildContext["mods"][number];

export const BACK_TO_NEXUS_PATCH: Partial<ExternalModConfigEntry> = {
  treatAsExternal: false,
  bundled: false,
};

export type BackToNexusVerdict =
  | { kind: "switch"; note?: string }
  | { kind: "refuse"; why: string };

/** Whether the row offers the action: a Nexus mod the curator made external. */
export function canGoBackToNexus(mod: Mod, override: ExternalModConfigEntry | undefined): boolean {
  return isNexusMod(mod) && override?.treatAsExternal === true;
}

/**
 * The rows of the external-mods table.
 *
 * The context's list is fixed when the form opens and includes the Nexus mods
 * marked external then; a mod switched back must leave the table the moment
 * it is switched, the same way a newly marked one appears.
 */
export function visibleExternalRows(
  contextExternal: readonly Mod[],
  mods: readonly Mod[],
  overrides: Readonly<Record<string, ExternalModConfigEntry>>,
): Mod[] {
  const byId = new Map<string, Mod>();
  for (const m of contextExternal) {
    if (isNexusMod(m) && overrides[m.id]?.treatAsExternal !== true) continue;
    byId.set(m.id, m);
  }
  for (const m of mods) {
    if (overrides[m.id]?.treatAsExternal === true) byId.set(m.id, m);
  }
  return [...byId.values()];
}

/** What to do, given what Nexus said about the mod's file. */
export function backToNexusVerdict(finding: AvailabilityFinding | undefined): BackToNexusVerdict {
  switch (finding?.status) {
    case "available":
      return { kind: "switch" };
    case "old-version":
      return {
        kind: "switch",
        note: "Nexus lists this file under old versions: it downloads today, and the author may archive it later.",
      };
    case "file-missing":
      return {
        kind: "refuse",
        why:
          "Nexus no longer offers the file this mod was installed from" +
          (finding.replacement !== undefined
            ? `; the page has ${finding.replacement.name ?? "a newer file"}${
                finding.replacement.version !== undefined ? ` ${finding.replacement.version}` : ""
              }.`
            : ".") +
          " Update the mod in Vortex to a file Nexus has, then press this again.",
      };
    case "mod-missing":
      return {
        kind: "refuse",
        why: "This mod's Nexus page is gone, hidden or under moderation, so it can only ship as external.",
      };
    default:
      return {
        kind: "switch",
        note: "Nexus could not be asked about this file. Check availability before building to catch a missing one.",
      };
  }
}

/** Look the mod's file up on Nexus and decide. Never rejects. */
export async function checkBackToNexus(args: {
  mod: Mod;
  getModFiles: ((modId: number) => Promise<readonly NexusFileLike[]>) | undefined;
}): Promise<BackToNexusVerdict> {
  const { mod } = args;
  if (!isNexusMod(mod)) {
    return { kind: "refuse", why: "Vortex has no Nexus page and file recorded for this mod." };
  }
  if (args.getModFiles === undefined) return backToNexusVerdict(undefined);
  const modId = Number(mod.nexusModId);
  const fileId = Number(mod.nexusFileId);
  try {
    const report = await checkNexusAvailability(
      [{ compareKey: nexusCompareKey(modId, fileId), name: mod.name, modId, fileId }],
      { getModFiles: args.getModFiles },
    );
    return backToNexusVerdict(report.findings[0]);
  } catch {
    return backToNexusVerdict(undefined);
  }
}
