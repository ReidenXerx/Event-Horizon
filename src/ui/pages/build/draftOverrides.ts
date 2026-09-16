/**
 * Which per-mod decisions a restored build draft opens with.
 *
 * ─── WHY THE CONFIG WINS ───────────────────────────────────────────────
 * The form writes every per-mod decision to the collection's config as the
 * curator makes it (persistOverrides.ts), so the config is the newer record by
 * construction and a draft's copy can only be the same or older. Restoring used
 * to lay the draft's copy OVER the config, so anything taken out of the config
 * after the draft was saved came back at the next build.
 *
 * It did, on 2026-09-16: the owner decided three published Nexus mods should
 * stop being bundled (RobCo patches in Ivy, Race Compatibility and its Patch Hub
 * in Meridia), their bundling entries were removed from the configs, and the
 * next Ivy build restored RobCo's entry from a draft saved that morning and
 * shipped it bundled again — to Nexus, the thing the change was for. The Meridia
 * draft on disk still held both of its entries.
 *
 * ─── WHICH CONFIG ──────────────────────────────────────────────────────
 * The build context loads the config of the DEFAULT collection (the one built
 * most recently for the game), which is not necessarily the draft's collection.
 * Its entries are used only when the draft is for that collection; otherwise the
 * draft's own collection's config is read. A draft for a collection that has no
 * config yet keeps its own copy: there is nothing newer to prefer.
 */

import * as path from "path";

import type { ExternalModConfigEntry } from "../../../core/manifest/collectionConfig";
import { slugify } from "./engine";

type Overrides = Record<string, ExternalModConfigEntry>;

export type RestoredOverrides = {
  overrides: Overrides;
  /** Where they came from, for the log. */
  source: "context config" | "draft's collection config" | "draft";
  /** Draft entries that were not taken because the config says otherwise. */
  ignoredDraftEntries: string[];
};

export async function overridesForRestoredDraft(args: {
  /** The collection name the draft was saved under. */
  draftName: string | undefined;
  draftOverrides: Overrides | undefined;
  /** The config the build context loaded, and its entries. */
  contextConfigPath: string;
  contextOverrides: Overrides;
  /** A collection's config entries, or undefined when it has no config file. */
  readConfigOverrides: (slug: string) => Promise<Overrides | undefined>;
}): Promise<RestoredOverrides> {
  const draft = args.draftOverrides ?? {};
  const contextSlug = path.basename(args.contextConfigPath).replace(/\.json$/i, "");
  const draftSlug = args.draftName !== undefined && args.draftName.trim() !== "" ? slugify(args.draftName) : contextSlug;

  if (draftSlug === contextSlug) {
    return {
      overrides: { ...args.contextOverrides },
      source: "context config",
      ignoredDraftEntries: differing(draft, args.contextOverrides),
    };
  }
  const fromDisk = await args.readConfigOverrides(draftSlug);
  if (fromDisk !== undefined) {
    return {
      overrides: { ...fromDisk },
      source: "draft's collection config",
      ignoredDraftEntries: differing(draft, fromDisk),
    };
  }
  return { overrides: { ...draft }, source: "draft", ignoredDraftEntries: [] };
}

/** Draft entries the config does not hold, or holds differently. */
function differing(draft: Overrides, config: Overrides): string[] {
  return Object.keys(draft).filter((id) => JSON.stringify(draft[id]) !== JSON.stringify(config[id]));
}
