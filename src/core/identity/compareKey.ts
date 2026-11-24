/**
 * ──────────────────────────────────────────────────────────────────────
 * The two string vocabularies a collection uses to name a mod.
 *
 * They look alike, they share prefixes, and treating them as one thing is why
 * six files each grew their own builder and four grew their own parser.
 *
 * ─── 1. compareKey — WHICH MOD IS THIS, inside this package ────────────
 *   nexus:<modId>:<fileId>              a specific file on Nexus
 *   external:<sha256>                   identified by its archive's bytes
 *   external:staging:<stagingSetHash>   repacked from staging; no archive
 *
 * Always FULLY PINNED: it names one mod, never a family. It is the key that
 * links a manifest entry to its rules, its receipt row and its install state.
 *
 * ─── 2. mod reference — WHICH MOD DOES THIS RULE POINT AT ──────────────
 *   nexus:<modId>:<fileId>   the same full pin
 *   nexus:<modId>            a PARTIAL pin: a mod PAGE, not a file
 *   archive:<archiveId>      Vortex's local download id
 *
 * A reference may be partial, and that difference is load-bearing: a partial
 * pin can match several installed variants of the same mod, so `applyModRules`
 * refuses to guess and reports a skip instead. Anything that treated the two
 * vocabularies as interchangeable would resolve a conflict rule onto the wrong
 * variant — a wrong answer that looks like the collection merely not working.
 *
 * ─── WHAT THIS DELIBERATELY DOES NOT OWN ───────────────────────────────
 * `getModCompareKey` in `src/utils/utils.ts` builds a THIRD thing that shares
 * these prefixes and is NOT this: its `archive:<archiveId>` and `id:<mod.id>`
 * fallbacks are MACHINE-LOCAL, so the same mod gets different keys on two
 * machines and shows up as missing on one and extra on the other. It is
 * `@deprecated` in its own doc, superseded by `matchSnapshots` in
 * `modIdentity.ts`, and survives only to label report rows.
 *
 * It is not folded in here on purpose. Consolidating onto the widest-used
 * spelling would have made the OBSOLETE conception canonical and left the
 * migration those two modules describe harder to finish. The forms below are
 * the portable ones the manifest actually emits.
 * ──────────────────────────────────────────────────────────────────────
 */

/** `nexus:<modId>:<fileId>`. Ids are stringified, never re-coerced. */
export function nexusCompareKey(
  nexusModId: string | number,
  nexusFileId: string | number,
): string {
  return `nexus:${String(nexusModId)}:${String(nexusFileId)}`;
}

/**
 * `nexus:<modId>:<fileId>#<store>` — the OTHER store's build installed from
 * the SAME Nexus file. One FOMOD can hold both (CBPC 21224:814665 carries the
 * GOG 1.6.1179 and Steam 1.6.1170 DLLs), so the curator installs it twice and
 * tags the pair; the second gets this key (Skyrim-collection, 11-24). Still
 * fully pinned: it names one manifest entry. Its source is the plain file.
 */
export function nexusStoreTwinCompareKey(plainKey: string, store: string): string {
  return `${plainKey}#${store}`;
}

/** `external:<sha256>` — a mod identified by its source archive's bytes. */
export function externalArchiveCompareKey(sha256: string): string {
  return `external:${sha256}`;
}

/**
 * `external:staging:<hash>` — repacked from the staging folder.
 *
 * Three segments under a prefix the parser's own comment once described as
 * single-segment. Kept distinct from the archive form because they answer
 * different questions: one names bytes that existed before the build, the
 * other names bytes the build produced.
 */
export function externalStagingCompareKey(stagingSetHash: string): string {
  return `external:staging:${stagingSetHash}`;
}

export type ParsedCompareKey =
  | { kind: "nexus"; nexusModId: string; nexusFileId: string; storeTwin?: string }
  | { kind: "external-archive"; sha256: string }
  | { kind: "external-staging"; stagingSetHash: string }
  | { kind: "unrecognised"; raw: string };

/**
 * Read a compareKey back.
 *
 * Never throws and never guesses: an unfamiliar shape comes back as
 * `unrecognised` with the original string, so a caller can report it rather
 * than silently treat it as one of the known kinds.
 */
export function parseCompareKey(key: string): ParsedCompareKey {
  const parts = key.split(":");
  if (parts[0] === "nexus" && parts.length === 3) {
    const [fileId, twin, extra] = parts[2]!.split("#");
    if (extra === undefined && twin !== "") {
      return { kind: "nexus", nexusModId: parts[1]!, nexusFileId: fileId!, ...(twin !== undefined ? { storeTwin: twin } : {}) };
    }
  }
  if (parts[0] === "external") {
    if (parts.length === 3 && parts[1] === "staging") {
      return { kind: "external-staging", stagingSetHash: parts[2]! };
    }
    if (parts.length === 2) {
      return { kind: "external-archive", sha256: parts[1]! };
    }
  }
  return { kind: "unrecognised", raw: key };
}

/** The Nexus mod id a compareKey names, when it names one. */
export function nexusModIdOfCompareKey(key: string): string | undefined {
  const parsed = parseCompareKey(key);
  return parsed.kind === "nexus" ? parsed.nexusModId : undefined;
}

/** `nexus:<modId>:<fileId>` — a rule pointing at one specific file. */
export function nexusFileReference(
  nexusModId: string | number,
  nexusFileId: string | number,
): string {
  return `nexus:${String(nexusModId)}:${String(nexusFileId)}`;
}

/**
 * `nexus:<modId>` — a rule pointing at a mod PAGE.
 *
 * Deliberately partial. The curator's rule named a mod, not a file, and
 * pretending otherwise by inventing a fileId would resolve onto whichever
 * variant happened to be installed.
 */
export function nexusModReference(nexusModId: string | number): string {
  return `nexus:${String(nexusModId)}`;
}

/** `archive:<archiveId>` — Vortex's local download id. */
export function archiveReference(archiveId: string): string {
  return `archive:${archiveId}`;
}

export type ParsedModReference =
  /** A specific file. Resolves to at most one installed mod. */
  | { kind: "nexus-file"; nexusModId: string; nexusFileId: string }
  /** A mod PAGE. May match several installed variants — see applyModRules. */
  | { kind: "nexus-mod"; nexusModId: string }
  | { kind: "archive"; archiveId: string }
  /** Produced only by the deprecated `getModCompareKey`. Machine-local. */
  | { kind: "legacy-id"; modId: string }
  | { kind: "unrecognised"; raw: string };

export function parseModReference(reference: string): ParsedModReference {
  const parts = reference.split(":");
  if (parts[0] === "nexus") {
    if (parts.length === 3) {
      return {
        kind: "nexus-file",
        nexusModId: parts[1]!,
        nexusFileId: parts[2]!,
      };
    }
    if (parts.length === 2) {
      return { kind: "nexus-mod", nexusModId: parts[1]! };
    }
  }
  if (parts[0] === "archive" && parts.length === 2) {
    return { kind: "archive", archiveId: parts[1]! };
  }
  if (parts[0] === "id" && parts.length === 2) {
    return { kind: "legacy-id", modId: parts[1]! };
  }
  return { kind: "unrecognised", raw: reference };
}

/**
 * Does this reference name exactly one mod?
 *
 * `nexus:<modId>` alone does not: it is a page, and several of its files may
 * be installed. Everything else here carries a single opaque identifier and
 * resolves to one thing or to nothing.
 */
export function isFullyPinnedReference(reference: string): boolean {
  const parsed = parseModReference(reference);
  return (
    parsed.kind === "nexus-file" ||
    parsed.kind === "archive" ||
    parsed.kind === "legacy-id"
  );
}
