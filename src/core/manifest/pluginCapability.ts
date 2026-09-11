/**
 * ──────────────────────────────────────────────────────────────────────
 * What a plugin's header bits MEAN, per game — the one place that says so.
 *
 * ─── THE DEFECT THIS REPLACES ──────────────────────────────────────────
 * The light bit was a single constant, 0x200, used for every game: read by
 * the build into the package, read by Doctor, written by the installer onto
 * the user's plugins and by the curator's toggle. That is right for Skyrim SE
 * and Fallout 4 and wrong for Starfield, where light is 0x100 and 0x200 is a
 * different flag altogether. A Starfield collection recorded the wrong bit,
 * and the installer then flipped the wrong bit inside plugins it did not
 * write — damage to files that are not ours (NS-2), in the one step that
 * edits the user's game folder.
 *
 * A per-game table already existed in the curator's Plugins view, and was
 * used there only to refuse the toggle. It lives here now, and every reader
 * and writer takes the game's capability from it. There is no second copy.
 *
 * ─── SOURCE ────────────────────────────────────────────────────────────
 * Read from the installed Vortex, `resources/app.asar.unpacked/
 * bundledPlugins/gamebryo-plugin-management/index.cjs` and its source map:
 *   - the TES4 flag constants: `FLAG_MASTER = 0x00000001`, `FLAG_LIGHT =
 *     0x00000200`, `SF_FLAG_LIGHT = 0x00000100; // Starfield variant`,
 *     `FLAG_MEDIUM = 0x00000400`, `SF_FLAG_BLUEPRINT = 0x00000800`;
 *   - `ESPFile.isLight`: `gameMode === "starfield" ? flags & SF_FLAG_LIGHT
 *     : flags & FLAG_LIGHT`, and `setLightFlag` writes the same bit;
 *   - its `gameSupport` dictionary — `supportsESL` on skyrimse, fallout4,
 *     enderalspecialedition and starfield; `supportsMediumMasters` on
 *     starfield only; skyrimvr and fallout4vr explicitly `supportsESL: false`;
 *   - its plugin counter: regular = enabled and neither light nor medium,
 *     against `supportsMediumMasters ? 253 : supportsESL ? 254 : 255`.
 *
 * The extension exposes none of this at runtime (its only `registerAPI`s are
 * `lootSortAsync` and `isBlueprintPlugin`), so it is copied, once, here. A
 * game extension's `details.supportsESL` overrides a row, as Vortex applies it
 * for the VR games.
 *
 * ─── A GAME NOT IN THE TABLE IS UNKNOWN ────────────────────────────────
 * No bit is assumed for it. Readers return no flags, writers refuse, and the
 * installer applies nothing. Guessing 0x200 is exactly the mistake above.
 * ──────────────────────────────────────────────────────────────────────
 */

/** Bit 0: master (ESM), in every game here. */
const FLAG_MASTER = 0x1;
/** Light (ESL) in every game here that has light plugins, except Starfield. */
const FLAG_LIGHT = 0x200;
/** Light in Starfield. On Starfield, 0x200 is NOT light. */
const SF_FLAG_LIGHT = 0x100;
/** Medium — Starfield's FD-slot plugins. Only meaningful where the game has them. */
const FLAG_MEDIUM = 0x400;

/**
 * The bit every Event Horizon build read and wrote as "light" before flags
 * were per game — for every game, Starfield included.
 *
 * A package or receipt that does not say which bit its `light` values came
 * from was made by such a build, so this is what those values mean.
 */
export const LEGACY_LIGHT_FLAG_BIT = FLAG_LIGHT;

const GAMEBRYO_PLUGIN_SUPPORT: Readonly<
  Record<string, { supportsESL: boolean; supportsMediumMasters?: boolean; lightFlagBit?: number }>
> = {
  skyrim: { supportsESL: false },
  enderal: { supportsESL: false },
  skyrimse: { supportsESL: true },
  enderalspecialedition: { supportsESL: true },
  skyrimvr: { supportsESL: false },
  fallout3: { supportsESL: false },
  falloutnv: { supportsESL: false },
  fallout4: { supportsESL: true },
  fallout4vr: { supportsESL: false },
  starfield: { supportsESL: true, supportsMediumMasters: true, lightFlagBit: SF_FLAG_LIGHT },
  oblivion: { supportsESL: false },
  oblivionremastered: { supportsESL: false },
};

export type PluginCapability = {
  /** The game this describes, carried so every log line can say which. */
  gameId: string;
  /** The game loads light (ESL) plugins in the shared FE slot. */
  lightPlugins: boolean;
  /** The game loads medium plugins in the shared FD slot (Starfield). */
  mediumPlugins: boolean;
  /** Regular plugins the game can load, as Vortex's own counter says. */
  regularSlots: number;
  /** The header bit that means "light" in this game; undefined when it has no light plugins. */
  lightFlagBit: number | undefined;
  /** The header bit that means "medium"; undefined when the game has no medium plugins. */
  mediumFlagBit: number | undefined;
};

export function pluginCapabilityFor(
  gameId: string,
  details?: { supportsESL?: unknown },
): PluginCapability | undefined {
  const row = GAMEBRYO_PLUGIN_SUPPORT[gameId.toLowerCase()];
  if (row === undefined) return undefined;
  const lightPlugins = typeof details?.supportsESL === "boolean" ? details.supportsESL : row.supportsESL;
  const mediumPlugins = row.supportsMediumMasters === true;
  return {
    gameId,
    lightPlugins,
    mediumPlugins,
    regularSlots: mediumPlugins ? 253 : lightPlugins ? 254 : 255,
    lightFlagBit: lightPlugins ? (row.lightFlagBit ?? FLAG_LIGHT) : undefined,
    mediumFlagBit: mediumPlugins ? FLAG_MEDIUM : undefined,
  };
}

/** Whether Event Horizon can flag or unflag a plugin light in this game, correctly. */
export function canWriteLightFlag(capability: PluginCapability | undefined): boolean {
  return capability?.lightFlagBit !== undefined;
}

export type PluginFlags = {
  isLight: boolean;
  isMaster: boolean;
  /** Always false in a game without medium plugins. */
  isMedium: boolean;
};

/**
 * The TES4 flags word, read the way this game reads it.
 *
 * In a game without light plugins nothing is light, whatever bit 0x200 says —
 * the game loads it into a regular slot regardless.
 */
export function decodePluginFlags(raw: number, capability: PluginCapability): PluginFlags {
  const has = (bit: number | undefined): boolean => bit !== undefined && (raw & bit) !== 0;
  return {
    isLight: has(capability.lightFlagBit),
    isMaster: (raw & FLAG_MASTER) !== 0,
    isMedium: has(capability.mediumFlagBit),
  };
}

export const hexBit = (bit: number): string => `0x${bit.toString(16).toUpperCase().padStart(3, "0")}`;

export type LightFlagRefusal = "unknown-game" | "no-light-plugins" | "bit-mismatch";

export type RecordedLightFlagsVerdict =
  | { usable: true; capability: PluginCapability & { lightFlagBit: number } }
  | { usable: false; code: LightFlagRefusal; reason: string; capability?: PluginCapability };

/**
 * May `light` values recorded for this game be written onto its plugins?
 *
 * @param recordedBit the header bit the values were read from, as the package
 *        or receipt says; `undefined` means it predates per-game flags and the
 *        values came from {@link LEGACY_LIGHT_FLAG_BIT}.
 *
 * Refuses rather than translating a mismatched bit: a value read from the
 * wrong bit is not "the light flag, stored elsewhere", it is a different flag,
 * and nothing about it says whether the curator's plugin was light.
 */
export function judgeRecordedLightFlags(
  gameId: string,
  recordedBit: number | undefined,
): RecordedLightFlagsVerdict {
  const capability = pluginCapabilityFor(gameId);
  if (capability === undefined) {
    return {
      usable: false,
      code: "unknown-game",
      reason:
        `Vortex's plugin management does not know the game "${gameId}", so Event ` +
        `Horizon cannot tell which header bit means "light" there and will not guess.`,
    };
  }
  const bit = capability.lightFlagBit;
  if (bit === undefined) {
    return {
      usable: false,
      code: "no-light-plugins",
      reason: `${gameId} has no light (ESL) plugins, so there is no light flag to apply.`,
      capability,
    };
  }
  const recorded = recordedBit ?? LEGACY_LIGHT_FLAG_BIT;
  if (recorded !== bit) {
    return {
      usable: false,
      code: "bit-mismatch",
      reason:
        `The recorded light flags were read from header bit ${hexBit(recorded)}` +
        (recordedBit === undefined
          ? ` (the package was built before flags were read per game, and every build before then read that bit)`
          : ``) +
        `, but ${gameId} marks a light plugin with ${hexBit(bit)}. Applying them would flip the ` +
        `wrong bit inside your plugins, so none were changed. A package rebuilt with a current ` +
        `Event Horizon records the right bit.`,
      capability,
    };
  }
  return { usable: true, capability: { ...capability, lightFlagBit: bit } };
}
