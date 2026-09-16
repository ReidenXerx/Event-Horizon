/**
 * What a Nexus collection page says an Event Horizon collection contains.
 *
 * A package goes to Nexus in two parts that say different things on purpose:
 *
 *   - the FILE carries `collection.json` with no mods (see packageZip.ts), so
 *     Vortex on its own installs nothing. Vortex loses files when it installs
 *     in bulk, and a user without Event Horizon must not get that.
 *   - the upload's PAYLOAD, built here, lists the real mods. That list is what
 *     the collection page shows: mod authors get the collection credit their
 *     work earned, and a moderator can see exactly which mods are bundled
 *     rather than downloaded from their pages (owner decision 2026-09-16).
 *
 * The payload list is display, never install: pressing Install on the website
 * downloads the file alone and hands it to the installers, where Event Horizon
 * claims it. Nothing reads these entries back to fetch mods.
 *
 * The shape is Vortex's `ICollectionManifest`, because the upload goes through
 * Vortex's own `submit-collection` event, which converts it to Nexus's v3
 * `CollectionPayload`. Only fields that survive that conversion are written.
 */

import { NEXUS_GAME_DOMAIN_BY_GAME_ID } from "../manifest/buildManifest";
import type { EhcollManifest, EhcollMod } from "../../types/ehcoll";

/**
 * Nexus's limits on a collection name, from its v3 API schema
 * (`CollectionManifestInfo.name`). Checked before uploading: Nexus validates
 * the payload only after the whole file has transferred, so a name one
 * character too long would otherwise cost a multi-gigabyte upload.
 */
export const NEXUS_COLLECTION_NAME_MIN = 3;
export const NEXUS_COLLECTION_NAME_MAX = 36;

/**
 * What Vortex writes for a mod with no version when it exports a collection
 * (`mod.attributes?.version ?? "1.0.0"`). Used for the same case here, because
 * it is the value Nexus is known to accept from every Vortex-made collection.
 */
export const UNKNOWN_MOD_VERSION = "1.0.0";

export type NexusCollectionModSource =
  | { type: "nexus"; modId: number; fileId: number; updatePolicy: "exact" }
  | { type: "bundle" }
  | { type: "direct" | "browse"; url: string }
  | { type: "manual" };

export type NexusCollectionMod = {
  name: string;
  version: string;
  optional: boolean;
  domainName: string;
  source: NexusCollectionModSource;
};

export type NexusCollectionInfo = {
  info: {
    author: string;
    authorUrl: string;
    name: string;
    domainName: string;
    gameVersions: string[];
  };
  mods: NexusCollectionMod[];
};

export type NexusCollectionCounts = {
  nexus: number;
  bundled: number;
  /** External mods the user has to fetch themselves: a link or instructions. */
  elsewhere: number;
};

/**
 * The payload for one package's upload.
 *
 * No description or summary: Nexus keeps the page text the curator wrote on
 * the website, and a revision that sent its own could replace it.
 */
export function toNexusCollectionInfo(manifest: EhcollManifest): NexusCollectionInfo {
  const domainName = NEXUS_GAME_DOMAIN_BY_GAME_ID[manifest.game.id];
  return {
    info: {
      author: manifest.package.author,
      authorUrl: "",
      name: manifest.package.name,
      domainName,
      // What Vortex sends is the installed game's version; a package that could
      // not detect one says "unknown", which is not a version to tell Nexus.
      gameVersions: /^\d+(\.\d+)+$/.test(manifest.game.version) ? [manifest.game.version] : [],
    },
    mods: manifest.mods.map((mod) => toNexusCollectionMod(mod, domainName)),
  };
}

function toNexusCollectionMod(mod: EhcollMod, collectionDomain: string): NexusCollectionMod {
  const base = {
    name: mod.name,
    version: mod.version !== undefined && mod.version.trim() !== "" ? mod.version : UNKNOWN_MOD_VERSION,
    // Event Horizon installs every mod in the manifest, a disabled one
    // included, so none of them is optional to download.
    optional: false,
  };
  const { source } = mod;
  if (source.kind === "nexus") {
    return {
      ...base,
      domainName: source.gameDomain,
      // `exact`: the page names the file the curator built with. Event Horizon
      // downloads that file and checks its hash; a newer one is a different
      // collection.
      source: { type: "nexus", modId: source.modId, fileId: source.fileId, updatePolicy: "exact" },
    };
  }
  if (source.bundled) {
    return { ...base, domainName: collectionDomain, source: { type: "bundle" } };
  }
  if (source.url !== undefined) {
    // A link only starts a download when Vortex recorded it as one. Anything
    // else is a page to open, which is the safer reading of an unknown.
    const type = source.downloadMode === "direct" ? "direct" : "browse";
    return { ...base, domainName: collectionDomain, source: { type, url: source.url } };
  }
  return { ...base, domainName: collectionDomain, source: { type: "manual" } };
}

export function countNexusCollectionMods(info: NexusCollectionInfo): NexusCollectionCounts {
  const counts: NexusCollectionCounts = { nexus: 0, bundled: 0, elsewhere: 0 };
  for (const mod of info.mods) {
    if (mod.source.type === "nexus") counts.nexus += 1;
    else if (mod.source.type === "bundle") counts.bundled += 1;
    else counts.elsewhere += 1;
  }
  return counts;
}

/**
 * Why this package cannot be uploaded as it is, as sentences for the curator.
 * Empty when it can. Every check here is one Nexus would otherwise make after
 * the file had already transferred.
 */
export function nexusCollectionProblems(info: NexusCollectionInfo): string[] {
  const problems: string[] = [];
  const name = info.info.name.trim();
  if (name.length < NEXUS_COLLECTION_NAME_MIN || name.length > NEXUS_COLLECTION_NAME_MAX) {
    problems.push(
      `Nexus needs a collection name of ${NEXUS_COLLECTION_NAME_MIN} to ` +
        `${NEXUS_COLLECTION_NAME_MAX} characters, and "${info.info.name}" is ` +
        `${name.length}. Rename the collection and build again.`,
    );
  }
  if (info.info.author.trim() === "") {
    problems.push("The package has no author, and Nexus needs one. Build again with an author.");
  }
  if (info.info.domainName === undefined || info.info.domainName === "") {
    problems.push("Event Horizon does not know this game's Nexus site.");
  }
  return problems;
}

/**
 * Turn a Nexus validation pointer into something a curator can act on.
 *
 * Nexus answers a bad payload with JSON pointers such as
 * `/collection_data/collection_manifest/mods/12/source/file_id`. The index is
 * into the list this module built, so it names the mod — which is the only part
 * of that line anyone can fix.
 */
export function describeNexusPointer(pointer: string | undefined, info: NexusCollectionInfo): string {
  if (pointer === undefined || pointer === "") return "The collection";
  const match = /\/mods\/(\d+)(?:\/(.*))?$/.exec(pointer);
  if (match === null) return pointer;
  const mod = info.mods[Number(match[1])];
  if (mod === undefined) return pointer;
  const field = match[2];
  return field === undefined || field === "" ? `"${mod.name}"` : `"${mod.name}" (${field})`;
}
