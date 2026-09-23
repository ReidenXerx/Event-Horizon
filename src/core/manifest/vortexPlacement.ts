/**
 * Where Vortex puts each file of an archive that has no installer script.
 *
 * ─── "VORTEX STRIPS A LEADING WRAPPER DIRECTORY" — ONLY SOMETIMES ─────
 * The build's drift check compared an external archive with the curator's
 * staging folder on path TAILS, because Vortex was believed to drop a leading
 * wrapper folder on install. It drops one only when something inside the
 * archive matches the game's stop patterns — a plugin, a BSA, or a folder named
 * like game data (`textures`, `meshes`, `scripts`, `skse`…). When nothing does,
 * every path installs exactly as the archive spells it.
 *
 * Meridia 1.0.23 shipped exactly that: `Grass_Cache_Default_LOD.zip` holds
 * `Grass_Cache_Default/{README.txt, meta.ini, Data/Grass/*.cgid}` (an MO2
 * export) while the curator's staging folder has `Grass/` at its root. `grass`
 * is not a stop pattern, so every player got the cache at
 * `Data\Grass_Cache_Default\Data\Grass\`, which the game never reads — 9,087 of
 * 9,087 files "missing" after install, a repair that could only fail the same
 * way, and no grass at all under the collection's cache-only NGIO settings.
 * The build passed it twice: the drift check tail-matched the wrapper away, and
 * the CRC self-check matches by content, not by where a file lands.
 *
 * ─── THE RULE, FROM THE CODE THAT DEFINES IT ──────────────────────────
 * fomod-installer 0.13.3 (bundled with Vortex 2.7.0) handles an archive with no
 * script in Basic mode, `ModInstaller.Adaptor.Typed/Installer.cs`:
 *
 *  1. `ArchiveStructure.FindPathPrefix` takes the FIRST path in Vortex's walk of
 *     the extracted folder — directories included, with a trailing separator,
 *     `__MACOSX` skipped — that matches ANY stop pattern, and returns that path
 *     up to the match. No match: the prefix is empty.
 *  2. `BasicModInstall`: a path that starts with the prefix loses it; any other
 *     path installs unchanged.
 *  3. The "pluginPath" hack: a destination that starts with `Data\` loses it.
 *     This runs on the raw destination, so one left starting with a separator
 *     by step 2 keeps its `Data` folder.
 *
 * The stop patterns are Vortex's own `gameSupport` lists, copied verbatim. Only
 * the Gamebryo family is here; any other game returns `undefined` and callers
 * keep their old behaviour rather than trusting a rule written for another game.
 * ──────────────────────────────────────────────────────────────────────
 */

/** Vortex's `toWordExp`: a whole path segment. */
const word = (name: string): string => `(^|/)${name}(/|$)`;

/** Vortex's `uniPatterns`. */
const UNI_PATTERNS = [word("fomod")];

/** Vortex's `gamebryoPatterns`, in its order. */
const GAMEBRYO_PATTERNS = [
  "[^/]*\\.esp$",
  "[^/]*\\.esm$",
  "[^/]*\\.esl$",
  "[^/]*\\.bsa$",
  "[^/]*\\.ba2$",
  "fomod/ModuleConfig.xml$",
  ...[
    "distantlod",
    "textures",
    "meshes",
    "music",
    "shaders",
    "video",
    "interface",
    "fonts",
    "scripts",
    "facegen",
    "menus",
    "lodsettings",
    "lsdata",
    "sound",
    "strings",
    "trees",
    "asi",
    "tools",
    "calientetools",
  ].map(word),
];

const gamebryo = (...extenders: string[]): readonly string[] => [
  ...UNI_PATTERNS,
  ...GAMEBRYO_PATTERNS,
  ...extenders.map(word),
];

/** Vortex game id → its stop patterns. Every one of these games has `pluginPath: "Data"`. */
const STOP_PATTERNS: Readonly<Record<string, readonly string[]>> = {
  skyrimse: gamebryo("skse"),
  skyrimvr: gamebryo("skse"),
  enderalspecialedition: gamebryo("skse"),
  skyrim: gamebryo("skse", "SkyProc Patchers"),
  enderal: gamebryo("skse", "SkyProc Patchers"),
  fallout4: gamebryo("f4se"),
  fallout4vr: gamebryo("f4se"),
  fallout3: gamebryo("fose"),
  falloutnv: gamebryo("nvse"),
  oblivion: gamebryo("obse"),
  nehrim: gamebryo("obse"),
};

const PLUGIN_PATH = "data/";

/** fomod-installer's `m_lstIgnore`. */
const SKIPPED = /^__MACOSX/i;

/**
 * Beyond this many distinct candidate prefixes the layouts are not compared:
 * the answer is order-dependent anyway, and comparing is quadratic.
 */
const MAX_CANDIDATES = 16;

export type BasicPlacement = {
  /** Archive path, as given → where it lands inside the mod's staging folder. */
  readonly destinations: ReadonlyMap<string, string>;
  /** What Vortex cuts from the front of each path — `""` when nothing matched. */
  readonly prefix: string;
  /**
   * Several matches imply different prefixes that place files differently.
   * Vortex keeps the first one its own directory walk reaches, an order this
   * cannot reproduce, so `destinations` is one possibility rather than a
   * prediction and must not be reported as fact.
   */
  readonly orderDependent: boolean;
};

/**
 * True when Vortex hands the archive to a scripted installer instead of Basic
 * mode, whose layout this module does not model.
 */
export function hasInstallerScript(paths: readonly string[]): boolean {
  return paths.some((p) => /(^|\/)fomod\/(moduleconfig\.xml|script\.cs)$/i.test(p));
}

/**
 * Predict where Vortex installs each file of a script-less archive for
 * `gameId`, or `undefined` for a game whose stop patterns are not known here.
 *
 * `paths` are POSIX-style archive entries; directory entries (a trailing `/`)
 * are ignored.
 */
export function predictBasicPlacement(
  paths: readonly string[],
  gameId: string,
): BasicPlacement | undefined {
  const patterns = STOP_PATTERNS[gameId];
  if (patterns === undefined) return undefined;
  const stop = new RegExp(patterns.join("|"), "i");
  const files = paths.filter((p) => !p.endsWith("/"));

  // Vortex's walk includes folders too, but a folder that matches — say
  // `Wrapper/textures/` — matches at the same place in every file under it,
  // so the files alone yield every candidate. (Only an EMPTY matching folder
  // would add one, and an archive listing reports none.)
  const prefixes = new Set<string>();
  for (const file of files) {
    if (SKIPPED.test(file)) continue;
    const match = stop.exec(file);
    if (match !== null) prefixes.add(file.slice(0, match.index));
  }

  if (prefixes.size === 0) {
    return { prefix: "", destinations: place(files, ""), orderDependent: false };
  }
  const candidates = [...prefixes].sort((a, b) => a.length - b.length);
  const first = place(files, candidates[0]);
  if (candidates.length > MAX_CANDIDATES) {
    return { prefix: candidates[0], destinations: first, orderDependent: true };
  }
  // `Data` (from `Data/textures/`) and `Data/` (from `Data/x.esp`) are two
  // spellings of one layout; only prefixes that move a file disagree.
  const orderDependent = candidates
    .slice(1)
    .some((prefix) => !sameLayout(first, place(files, prefix)));
  return { prefix: candidates[0], destinations: first, orderDependent };
}

function place(files: readonly string[], prefix: string): Map<string, string> {
  return new Map(files.map((file) => [file, destinationOf(file, prefix)]));
}

function destinationOf(file: string, prefix: string): string {
  let destination = file.startsWith(prefix) ? file.slice(prefix.length) : file;
  if (destination.toLowerCase().startsWith(PLUGIN_PATH)) {
    destination = destination.slice(PLUGIN_PATH.length);
  }
  return destination.replace(/^\/+/, "");
}

function sameLayout(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  for (const [file, destination] of a) {
    if (b.get(file) !== destination) return false;
  }
  return true;
}
