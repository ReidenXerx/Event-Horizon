/**
 * ──────────────────────────────────────────────────────────────────────
 * A FILE'S NAME WITHOUT ITS VERSION.
 *
 * Two archives are versions of one file, or they are two different files.
 * Getting that wrong in either direction is expensive: merge two files and an
 * addon gets deleted as an "old version" of the thing beside it; split one
 * file and its old versions accumulate forever because nothing ever
 * supersedes them.
 *
 * The name is the only signal available for the second half — Nexus file ids
 * are opaque integers that say nothing about relatedness — and mod authors
 * routinely put the version INSIDE the name: `Addictol 1.0` and
 * `Addictol 1.1`, `apocalypse 10.0.0` and `apocalypse 10.2.2`,
 * `BodySlide and Outfit Studio - v5.7.0` and `- v5.8.0`. Compared as-is those
 * are different files, and their superseded versions are never reclaimable.
 *
 * ─── WHERE THIS COMES FROM ─────────────────────────────────────────────
 * Vortex solves the same problem for its "Remove related" action, in
 * `mod_management/util/modGrouping.ts`. Two mods are the same FILE when
 * either their `newestFileId` matches — the end of Nexus's own update chain —
 * or their `logicalFileName` matches once the version is removed:
 *
 *     function logicalName(attributes) {
 *       return attributes.logicalFileName.replace(attributes.version, "");
 *     }
 *
 * Event Horizon already had the first signal (`findSupersededMods` calls it
 * "update-chain") and the un-stripped half of the second. This is the missing
 * piece, and it is deliberately NOT a copy of the line above.
 *
 * ─── WHY NOT COPY IT ───────────────────────────────────────────────────
 * That `replace` is unanchored and substring-based, so a mod at version "1"
 * has every "1" cut out of its name: `Fallout 1 Weapons` becomes
 * `Fallout  Weapons`, and `Mod 1 - M1A1 Thompson` becomes
 * `Mod  - MA Thompson`. Both then collide with unrelated files on the same
 * page. Vortex gets away with it because the result only groups rows in a
 * table; here it decides what gets permanently deleted.
 *
 * So the rules are tighter, and every one of them is a refusal:
 *
 *   - ONLY at the end of the name. `Mod 1 - M1A1 Thompson` keeps its 1.
 *   - ONLY a token that LOOKS like a version — two or more dotted numeric
 *     parts (`1.8.1`), or an explicit `v` prefix (`v2.4`). A bare trailing
 *     integer is left alone: `HoloHUD 4PA`, `T6M Mag-12` and
 *     `.44 Auto-Revolver (Mateba Unica 6)` are names, not versions, and the
 *     cost of guessing wrong is a deleted file.
 *   - A KNOWN version is matched as a whole token, never as a substring.
 *   - NEVER returns empty. A name that is nothing but a version keeps its
 *     name; an empty identity would match every other empty identity.
 * ──────────────────────────────────────────────────────────────────────
 */

/**
 * A trailing version: two or more dot/underscore-separated numeric parts,
 * optionally `v`-prefixed and optionally with a single letter suffix
 * (`1.0.2b`). Requiring two parts is what keeps `Mateba Unica 6` intact.
 */
const TRAILING_DOTTED = /[\s_.\-–]+v?\d+(?:[._]\d+)+[a-z]?$/i;

/**
 * A trailing `v`-prefixed version, which may have only one part because the
 * `v` is the author saying "this is a version": `Mod v2`, `Mod v2b`.
 */
const TRAILING_V = /[\s_.\-–]+v\d+(?:[._]\d+)*[a-z]?$/i;

/** Separators an author puts between a name and its version. */
const TRAILING_SEPARATORS = /[\s_.\-–]+$/;

/**
 * `name` with any trailing version-looking token removed.
 *
 * Applied repeatedly, because `Mod - v1.2 - 1.2.3` exists and one pass would
 * leave half of it. Bounded, and stops the moment a pass changes nothing or
 * would empty the string.
 */
export function stripTrailingVersion(name: string): string {
  let out = name.trim();
  for (let pass = 0; pass < 4; pass += 1) {
    const next = out
      .replace(TRAILING_DOTTED, "")
      .replace(TRAILING_V, "")
      .replace(TRAILING_SEPARATORS, "")
      .trim();
    if (next === out || next === "") break;
    out = next;
  }
  return out === "" ? name.trim() : out;
}

/** Escape a version string for use inside a RegExp. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `name` with a KNOWN version removed — a whole token, and only at the END.
 *
 * ─── WHY THE END ONLY ──────────────────────────────────────────────────
 * Vortex removes the version from anywhere in the name. Two things go wrong
 * with that, and only the first is obvious:
 *
 *   1. Unanchored, it cuts through words. At version `1`,
 *      `Mod 1 - M1A1 Thompson` becomes `Mod  - MA Thompson`.
 *   2. Anchored but positional, it still fuses unrelated files. At version
 *      `4`, `Fallout 4 Weapons` becomes `Fallout Weapons` — which is a
 *      perfectly plausible name for a DIFFERENT file on the same page, and
 *      the older of the two is then offered for permanent deletion.
 *
 * Every one of the 41 archives this feature was measured against carries its
 * version at the end, so restricting to the end costs nothing real and
 * removes the whole of hazard 2. A version genuinely in the middle is left
 * in the name, and those files simply stay unrelated — the conservative
 * failure, which keeps an archive rather than destroying one.
 */
export function stripKnownVersion(
  name: string,
  version: string | undefined,
): string {
  const trimmedName = name.trim();
  const v = version?.trim();
  if (v === undefined || v === "") return trimmedName;

  const pattern = new RegExp(
    `[\\s_.\\-–]+v?${escapeForRegExp(v)}$`,
    "i",
  );
  const out = trimmedName.replace(pattern, "").trim();
  return out === "" ? trimmedName : out;
}

/**
 * Every form of `name` worth comparing against another file's: the name as
 * given, and the name with its version removed both ways.
 *
 * Returned as a set because matching is an INTERSECTION — two files are the
 * same when any form agrees. Keeping the un-stripped form is what makes this
 * purely additive: nothing that matched before stops matching.
 */
export function nameForms(
  name: string | undefined,
  version?: string,
): string[] {
  const base = name?.trim();
  if (base === undefined || base === "") return [];

  const forms = new Set<string>([base.toLowerCase()]);
  forms.add(stripTrailingVersion(base).toLowerCase());
  forms.add(stripKnownVersion(base, version).toLowerCase());
  // A known version removed from the middle can leave a trailing version too:
  // "Mod 1.2 Loose 1.2" is rare but free to handle.
  forms.add(
    stripTrailingVersion(stripKnownVersion(base, version)).toLowerCase(),
  );
  return [...forms].filter((f) => f !== "");
}
