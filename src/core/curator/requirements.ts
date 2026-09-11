/**
 * ──────────────────────────────────────────────────────────────────────
 * What a mod REQUIRES, and what requires it.
 *
 * Vortex knows this and does almost nothing with it. Its Nexus integration
 * can fetch every mod page's "Requirements" section in one batched call
 * (`api.ext.nexusGetModRequirements`, read from the deployed app.asar), and
 * the only consumer is a health check that reports a count. There is no
 * column, no "install what this needs", no "what would break if I disabled
 * this". A curator building a 1,700-mod profile answers those by hand,
 * page by page, or finds out from the game.
 *
 * ─── TWO SOURCES, ONE ANSWER ───────────────────────────────────────────
 * Requirements come from two places that must not be confused:
 *
 *   NEXUS   — the mod page's Requirements list. Soft in kind: authors list
 *             what they consider needed, sometimes with notes ("only for the
 *             SE version"). A mod can be listed that is not on Nexus at all
 *             (`externalRequirement`), or a DLC.
 *   MASTERS — the plugin file's own header. HARD: a plugin whose master is
 *             absent stops the game loading. Read from the TES4 record by
 *             `pluginMasters.ts`; nothing an author writes can override it.
 *
 * Both resolve against Vortex's per-game mod POOL, never a profile (NS-3):
 * a requirement met by a mod the curator has installed but disabled is
 * "installed, disabled" — a one-click fix — not "missing".
 *
 * ─── WHAT IS DELIBERATELY NOT GUESSED ──────────────────────────────────
 * A Nexus requirement names a MOD, not a file. The health check in Vortex
 * offers an install only when the required mod has exactly one main file
 * and stays silent otherwise. This module does the same classification but
 * says so: `pickInstallFile` returns "choose" with the candidates rather
 * than picking one, because the wrong file — the LE build, the optional
 * patch — installs cleanly and is wrong forever.
 *
 * Everything here is pure or takes its I/O as a function, so it is tested
 * without Vortex. The page owns the API calls.
 * ──────────────────────────────────────────────────────────────────────
 */

import { fileIdentity, type CuratorMod } from "./profileActions";

// ── Identity ───────────────────────────────────────────────────────────

/**
 * Vortex's UID for a Nexus mod: the numeric game id in the high 32 bits,
 * the mod id in the low 32. Copied from `makeModUID` in app.asar; the
 * requirements call is keyed on it.
 */
export function makeModUid(numericGameId: number, nexusModId: number): string {
  return ((BigInt(numericGameId) << BigInt(32)) | BigInt(nexusModId)).toString();
}

/** The reverse of {@link makeModUid}. */
export function splitModUid(uid: string): { numericGameId: number; nexusModId: number } {
  const n = BigInt(uid);
  return {
    numericGameId: Number(n >> BigInt(32)),
    nexusModId: Number(n & BigInt(0xffffffff)),
  };
}

/**
 * Nexus's numeric id for a game domain ("skyrimspecialedition" → 1704).
 *
 * Vortex caches the games list as `<userData>/temp/nexus_gamelist.json`;
 * this reads it through a function so the shape can be tested. Absent or
 * malformed → an empty map, and every requirement then resolves to
 * "unknown game" rather than a wrong UID that fetches nothing.
 */
export type GameNumbers = ReadonlyMap<string, number>;

export function parseGameList(json: string): GameNumbers {
  const out = new Map<string, number>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return out;
  }
  if (!Array.isArray(parsed)) return out;
  for (const entry of parsed) {
    const e = entry as { domain_name?: unknown; id?: unknown };
    if (typeof e.domain_name === "string" && typeof e.id === "number") {
      out.set(e.domain_name, e.id);
    }
  }
  return out;
}

/**
 * Vortex's game id → the Nexus domain the games cache and mod pages use.
 *
 * They are NOT the same namespace: Vortex says `skyrimse`, Nexus says
 * `skyrimspecialedition`. Every UID, pool key and requirement key in this
 * module is in NEXUS domains — convert once at the edge, never mix; the core
 * takes the converter as `toDomain`, so it stays pure.
 *
 * At runtime the edge asks Vortex's own `util.nexusGameId` first
 * (`requirementsIo.nexusDomainForVortexGame`). This function is the same rule
 * — a game extension's `details.nexusPageId`, else Vortex's table, else the
 * id — and exists as the FALLBACK for a Vortex that does not export the
 * converter, and for tests. The table is a copy of the one inside that
 * function in the installed app.asar (`convertGameId.nexusGameId`); do not
 * extend it here instead of there.
 */
const NEXUS_DOMAIN_BY_VORTEX_ID: Record<string, string> = {
  skyrimse: "skyrimspecialedition",
  skyrimvr: "skyrimspecialedition",
  falloutnv: "newvegas",
  fallout4vr: "fallout4",
  teso: "elderscrollsonline",
};

export function nexusDomainOf(vortexGameId: string, nexusPageId?: string | undefined): string {
  if (typeof nexusPageId === "string" && nexusPageId !== "") return nexusPageId;
  return NEXUS_DOMAIN_BY_VORTEX_ID[vortexGameId.toLowerCase()] ?? vortexGameId;
}

/** A converter for this module's callers: Vortex id → Nexus domain. Identity by default. */
export type ToDomain = (vortexGameId: string) => string;
const sameId: ToDomain = (id) => id;

export function domainForNumber(games: GameNumbers, numericGameId: number): string | undefined {
  for (const [domain, id] of games) if (id === numericGameId) return domain;
  return undefined;
}

// ── What Vortex returns ────────────────────────────────────────────────

/** One entry of a mod page's Requirements section, as the GraphQL query returns it. */
export type NexusRequirementNode = {
  id?: string | number;
  /** NUMERIC Nexus game id, as a string or number. */
  gameId?: string | number;
  modId?: string | number;
  modName?: string;
  notes?: string | null;
  url?: string | null;
  /** Off-Nexus requirement: a link and a name, nothing to resolve. */
  externalRequirement?: boolean;
};

export type NexusModRequirements = {
  dlcRequirements?: Array<{ gameExpansion?: { id?: number; name?: string }; notes?: string | null }>;
  nexusRequirements?: { nodes?: NexusRequirementNode[]; totalCount?: number };
  modsRequiringThisMod?: { nodes?: NexusRequirementNode[]; totalCount?: number };
};

/** The live surface, as a function so a page can pass `api.ext` and a test a stub. */
export type RequirementsFetcher = (
  uids: string[],
) => Promise<Record<string, Partial<NexusModRequirements> | undefined>>;

/**
 * Fetch requirements for many UIDs, in chunks, tolerating a chunk that
 * fails: the report says which mods were not asked about rather than
 * pretending they require nothing.
 */
export async function fetchRequirements(args: {
  uids: readonly string[];
  fetch: RequirementsFetcher;
  chunkSize?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ byUid: Map<string, Partial<NexusModRequirements>>; failedUids: string[] }> {
  const chunkSize = args.chunkSize ?? 50;
  const byUid = new Map<string, Partial<NexusModRequirements>>();
  const failedUids: string[] = [];
  const unique = [...new Set(args.uids)];
  for (let i = 0; i < unique.length; i += chunkSize) {
    if (args.signal?.aborted === true) {
      failedUids.push(...unique.slice(i));
      break;
    }
    const chunk = unique.slice(i, i + chunkSize);
    try {
      const got = await args.fetch(chunk);
      for (const uid of chunk) {
        const r = got?.[uid];
        if (r !== undefined) byUid.set(uid, r);
        else failedUids.push(uid);
      }
    } catch {
      failedUids.push(...chunk);
    }
    args.onProgress?.(Math.min(i + chunkSize, unique.length), unique.length);
  }
  return { byUid, failedUids };
}

// ── Resolution ─────────────────────────────────────────────────────────

export type RequirementStatus =
  /** A mod in the pool provides it and is enabled in the active profile. */
  | "satisfied"
  /** A mod in the pool provides it but is disabled — one click away. */
  | "installed-disabled"
  /**
   * The page ships several distinct FILES, the pool has them all, and only
   * some are enabled ("partly enabled: 1 of 2 files"). Not missing and not
   * plainly satisfied: settled with the user as a warning, with an Enable for
   * the disabled files. Two copies of ONE file (versions, variants of the same
   * logical file) are never partial.
   */
  | "partial"
  /** Nothing in the pool provides it. */
  | "missing"
  /** Not a Nexus mod; a link and a name is all there is. */
  | "external"
  /** A DLC the game must own. Not checkable from here. */
  | "dlc"
  /** The requirement names a game whose numeric id is not in the cache. */
  | "unknown-game";

export type ModRequirement = {
  source: "nexus" | "master";
  status: RequirementStatus;
  /** What it is called, best effort: Nexus's name, else the plugin file. */
  name: string;
  /** For a Nexus requirement: the page it points at. */
  nexusModId?: number;
  /** Nexus domain (`skyrimspecialedition`): pages, file lists. */
  gameDomain?: string;
  /**
   * Vortex's id for that game (`skyrimse`), when this Vortex knows the game:
   * `api.ext.nexusDownload` resolves its game argument with `gameById` and
   * refuses a domain. Absent when the requirement is for a game Vortex does
   * not manage here — then only the page can be opened.
   */
  vortexGameId?: string;
  url?: string;
  notes?: string;
  /** Vortex mod ids that provide it (one, usually; two when the pool holds duplicates). */
  satisfiedBy: string[];
  /** For a "partial" line: how many of the page's distinct files have an enabled copy. */
  files?: { enabled: number; total: number };
  /** For a master: the plugin that needs it and the master file name. */
  plugin?: string;
  master?: string;
};

export type ModRequirementReport = {
  /** Vortex mod id. */
  modId: string;
  requirements: ModRequirement[];
  /** Nexus listed more than the query returned. */
  truncatedBy: number;
  /** Nexus was not asked, or the ask failed. */
  unfetched: boolean;
};

export type RequirementsReport = {
  byMod: Map<string, ModRequirementReport>;
  /** Vortex mod id → Vortex mod ids that require it (either source). */
  requiredBy: Map<string, string[]>;
  /** Mods with a Nexus identity that could not be given a UID. */
  noUid: string[];
};

/** A Nexus mod the pool holds, keyed by "nexusDomain:modId". */
function poolIndex(mods: readonly CuratorMod[], activeGame: string, toDomain: ToDomain): Map<string, CuratorMod[]> {
  const idx = new Map<string, CuratorMod[]>();
  for (const m of mods) {
    if (m.nexusModId === undefined) continue;
    const key = `${toDomain(m.downloadGame ?? activeGame)}:${m.nexusModId}`;
    const list = idx.get(key) ?? [];
    list.push(m);
    idx.set(key, list);
  }
  return idx;
}

/**
 * A page's installs grouped by the FILE each came from ({@link fileIdentity}),
 * or undefined when any install's file cannot be told apart — then nothing
 * can be said about distinct files, and none is guessed.
 */
function byFile(providers: readonly CuratorMod[]): Map<string, CuratorMod[]> | undefined {
  const groups = new Map<string, CuratorMod[]>();
  for (const m of providers) {
    const id = fileIdentity(m);
    if (id === undefined) return undefined;
    groups.set(id, [...(groups.get(id) ?? []), m]);
  }
  return groups;
}

function statusOf(providers: CuratorMod[] | undefined): { status: RequirementStatus; files?: { enabled: number; total: number } } {
  if (providers === undefined || providers.length === 0) return { status: "missing" };
  if (!providers.some((m) => m.enabled)) return { status: "installed-disabled" };
  const groups = byFile(providers);
  if (groups === undefined || groups.size < 2) return { status: "satisfied" };
  const enabled = [...groups.values()].filter((copies) => copies.some((m) => m.enabled)).length;
  return enabled === groups.size ? { status: "satisfied" } : { status: "partial", files: { enabled, total: groups.size } };
}

/**
 * What "Enable" on a partly enabled line turns on: one copy of each file of
 * the page that has no enabled copy — the newest copy of that file.
 */
export function partialProvidersToEnable(q: ModRequirement, mods: readonly CuratorMod[]): CuratorMod[] {
  if (q.status !== "partial") return [];
  const byId = new Map(mods.map((m) => [m.id, m]));
  const providers = q.satisfiedBy.map((id) => byId.get(id)).filter((m): m is CuratorMod => m !== undefined);
  const out: CuratorMod[] = [];
  for (const [file, copies] of byFile(providers) ?? []) {
    if (copies.some((m) => m.enabled)) continue;
    const pick = pickProvider(copies, file);
    if (pick !== undefined) out.push(pick);
  }
  return out;
}

/**
 * The UID each mod should be asked about, or why it cannot be.
 *
 * Only mods that came from Nexus have a page to ask about; a hand-added
 * archive has no requirements anyone can fetch.
 */
export function uidsFor(
  mods: readonly CuratorMod[],
  games: GameNumbers,
  activeGame: string,
  toDomain: ToDomain = sameId,
): { uidByMod: Map<string, string>; noUid: string[] } {
  const uidByMod = new Map<string, string>();
  const noUid: string[] = [];
  for (const m of mods) {
    if (m.nexusModId === undefined) continue;
    if (m.source !== undefined && m.source !== "nexus") continue;
    const domain = toDomain(m.downloadGame ?? activeGame);
    const num = games.get(domain);
    if (num === undefined) {
      noUid.push(m.id);
      continue;
    }
    uidByMod.set(m.id, makeModUid(num, m.nexusModId));
  }
  return { uidByMod, noUid };
}

function asNum(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * Turn what Nexus said about every mod into per-mod requirement reports,
 * resolved against the pool.
 */
export function resolveNexusRequirements(args: {
  mods: readonly CuratorMod[];
  /** Vortex's id for the active game. */
  activeGame: string;
  games: GameNumbers;
  uidByMod: ReadonlyMap<string, string>;
  fetched: ReadonlyMap<string, Partial<NexusModRequirements>>;
  failedUids?: ReadonlySet<string>;
  noUid?: readonly string[];
  /** Vortex id → Nexus domain. Identity when the two coincide. */
  toDomain?: ToDomain;
  /** Every game this Vortex knows, so a requirement can name its Vortex id. */
  knownGameIds?: readonly string[];
}): RequirementsReport {
  const toDomain = args.toDomain ?? sameId;
  const pool = poolIndex(args.mods, args.activeGame, toDomain);
  const byMod = new Map<string, ModRequirementReport>();
  const requiredBy = new Map<string, string[]>();
  // Reverse map for the download surface: Nexus domain → Vortex game id.
  const vortexIdByDomain = new Map<string, string>();
  for (const id of [args.activeGame, ...(args.knownGameIds ?? [])]) {
    const d = toDomain(id);
    if (!vortexIdByDomain.has(d)) vortexIdByDomain.set(d, id);
  }

  const addRequiredBy = (providerId: string, requirerId: string): void => {
    const list = requiredBy.get(providerId) ?? [];
    if (!list.includes(requirerId)) list.push(requirerId);
    requiredBy.set(providerId, list);
  };

  for (const m of args.mods) {
    const uid = args.uidByMod.get(m.id);
    const raw = uid === undefined ? undefined : args.fetched.get(uid);
    const ownKey = m.nexusModId === undefined ? undefined : `${toDomain(m.downloadGame ?? args.activeGame)}:${m.nexusModId}`;
    const report: ModRequirementReport = {
      modId: m.id,
      requirements: [],
      truncatedBy: 0,
      unfetched: uid !== undefined && raw === undefined,
    };
    if (raw !== undefined) {
      const nodes = raw.nexusRequirements?.nodes ?? [];
      const total = raw.nexusRequirements?.totalCount ?? nodes.length;
      report.truncatedBy = Math.max(0, total - nodes.length);
      for (const node of nodes) {
        const notes = typeof node.notes === "string" && node.notes.trim() !== "" ? node.notes.trim() : undefined;
        const url = typeof node.url === "string" && node.url.trim() !== "" ? node.url.trim() : undefined;
        if (node.externalRequirement === true) {
          report.requirements.push({
            source: "nexus",
            status: "external",
            name: node.modName ?? url ?? "External requirement",
            ...(url !== undefined ? { url } : {}),
            ...(notes !== undefined ? { notes } : {}),
            satisfiedBy: [],
          });
          continue;
        }
        const reqModId = asNum(node.modId);
        const reqGameNum = asNum(node.gameId);
        const domain =
          reqGameNum === undefined ? toDomain(m.downloadGame ?? args.activeGame) : domainForNumber(args.games, reqGameNum);
        if (reqModId === undefined || domain === undefined) {
          report.requirements.push({
            source: "nexus",
            status: "unknown-game",
            name: node.modName ?? `mod ${String(node.modId ?? "?")}`,
            ...(reqModId !== undefined ? { nexusModId: reqModId } : {}),
            ...(url !== undefined ? { url } : {}),
            ...(notes !== undefined ? { notes } : {}),
            satisfiedBy: [],
          });
          continue;
        }
        const key = `${domain}:${reqModId}`;
        // Nexus sometimes lists a page as its own requirement (a re-upload,
        // a "see also"). A mod does not require itself.
        if (key === ownKey) continue;
        const providers = pool.get(key);
        const { status, files } = statusOf(providers);
        const satisfiedBy = (providers ?? []).map((p) => p.id);
        for (const p of satisfiedBy) addRequiredBy(p, m.id);
        const vortexGameId = vortexIdByDomain.get(domain);
        report.requirements.push({
          source: "nexus",
          status,
          ...(files === undefined ? {} : { files }),
          name: node.modName ?? providers?.[0]?.name ?? `mod ${reqModId}`,
          nexusModId: reqModId,
          gameDomain: domain,
          ...(vortexGameId === undefined ? {} : { vortexGameId }),
          url: url ?? `https://www.nexusmods.com/${domain}/mods/${reqModId}`,
          ...(notes !== undefined ? { notes } : {}),
          satisfiedBy,
        });
      }
      for (const dlc of raw.dlcRequirements ?? []) {
        const notes =
          typeof dlc.notes === "string" && dlc.notes.trim() !== "" ? dlc.notes.trim() : undefined;
        report.requirements.push({
          source: "nexus",
          status: "dlc",
          name: dlc.gameExpansion?.name ?? "Unknown DLC",
          ...(notes !== undefined ? { notes } : {}),
          satisfiedBy: [],
        });
      }
    }
    byMod.set(m.id, report);
  }

  return { byMod, requiredBy, noUid: [...(args.noUid ?? [])] };
}

// ── Plugin masters ─────────────────────────────────────────────────────

export type PluginOwner = {
  /** Plugin file name as the game sees it. */
  plugin: string;
  /** Vortex mod id that deploys it, when known. */
  modId?: string;
  /** The game itself ships it (Vortex's `isNative`). */
  native?: boolean;
};

/**
 * Fold plugin masters into the report as HARD requirements.
 *
 * `masters` maps a plugin name to the masters its header declares;
 * `owners` says which mod ships each plugin. A master nobody ships is
 * "missing" at the plugin level; a master shipped by a disabled mod is
 * "installed-disabled".
 */
export function addMasterRequirements(
  report: RequirementsReport,
  args: {
    mods: readonly CuratorMod[];
    owners: readonly PluginOwner[];
    masters: ReadonlyMap<string, readonly string[]>;
    /** Plugins the game itself ships (Skyrim.esm …): never a requirement to install. */
    isBaseGame: (master: string) => boolean;
  },
): RequirementsReport {
  const byMod = new Map(report.byMod);
  const requiredBy = new Map(report.requiredBy);
  const modById = new Map(args.mods.map((m) => [m.id, m]));
  const ownerOfPlugin = new Map<string, PluginOwner>();
  for (const o of args.owners) ownerOfPlugin.set(o.plugin.toLowerCase(), o);

  for (const [plugin, masters] of args.masters) {
    const owner = ownerOfPlugin.get(plugin.toLowerCase());
    if (owner?.modId === undefined) continue;
    const entry = byMod.get(owner.modId) ?? {
      modId: owner.modId,
      requirements: [],
      truncatedBy: 0,
      unfetched: false,
    };
    const requirements = [...entry.requirements];
    for (const master of masters) {
      if (args.isBaseGame(master)) continue;
      const provider = ownerOfPlugin.get(master.toLowerCase());
      // Present but not something a Vortex mod ships: the game's own file on a
      // game with no BASE_MASTERS row, a Creation Club master, a loose file
      // the user put in Data. It is THERE, so it is not missing, and there is
      // no mod to enable or install for it.
      if (provider !== undefined && (provider.native === true || provider.modId === undefined)) continue;
      const providerMod = provider?.modId === undefined ? undefined : modById.get(provider.modId);
      if (providerMod !== undefined && providerMod.id === owner.modId) continue; // its own master
      const status: RequirementStatus =
        providerMod === undefined ? "missing" : providerMod.enabled ? "satisfied" : "installed-disabled";
      // The same master may be needed by two plugins of one mod; say it once.
      if (requirements.some((r) => r.source === "master" && r.master?.toLowerCase() === master.toLowerCase())) {
        continue;
      }
      requirements.push({
        source: "master",
        status,
        name: providerMod?.name ?? master,
        plugin,
        master,
        satisfiedBy: providerMod === undefined ? [] : [providerMod.id],
      });
      if (providerMod !== undefined) {
        // Copy, never push: the array may belong to the input report.
        const list = requiredBy.get(providerMod.id) ?? [];
        if (!list.includes(owner.modId)) requiredBy.set(providerMod.id, [...list, owner.modId]);
      }
    }
    byMod.set(owner.modId, { ...entry, requirements });
  }
  return { byMod, requiredBy, noUid: report.noUid };
}

// ── Summaries the page reads ───────────────────────────────────────────

export type RequirementsSummary = {
  modsWithMissing: number;
  missing: number;
  installedDisabled: number;
  /** Pages the pool has every file of, some of them disabled. Not missing. */
  partial: number;
  external: number;
  dlc: number;
  unfetched: number;
  truncated: number;
};

/**
 * What a requirement line is ABOUT, for counting. A mod that lists USSEP on
 * its page and masters its plugin on USSEP has one requirement, not two —
 * the two lines are kept (they can disagree usefully) but counted once
 * WHEN THE POOL IDENTIFIES THE PROVIDER. With USSEP not installed at all,
 * nothing links the page id to the file name, and the cell honestly says
 * "2 missing": one page, one master.
 */
function requirementKey(q: ModRequirement): string {
  if (q.satisfiedBy.length > 0) return `mod:${[...q.satisfiedBy].sort().join("|")}`;
  if (q.nexusModId !== undefined) return `nexus:${q.gameDomain ?? ""}:${q.nexusModId}`;
  return `name:${(q.master ?? q.name).toLowerCase()}`;
}

/** Distinct requirements of one mod in a given status. */
export function countDistinct(r: ModRequirementReport, status: RequirementStatus): number {
  const keys = new Set<string>();
  for (const q of r.requirements) if (q.status === status) keys.add(requirementKey(q));
  return keys.size;
}

export function summarizeRequirements(
  report: RequirementsReport,
  opts: { /** Count only these mods (the enabled ones, by default on the page). */ onlyModIds?: ReadonlySet<string> } = {},
): RequirementsSummary {
  const out: RequirementsSummary = {
    modsWithMissing: 0,
    missing: 0,
    installedDisabled: 0,
    partial: 0,
    external: 0,
    dlc: 0,
    unfetched: 0,
    truncated: 0,
  };
  for (const r of report.byMod.values()) {
    if (opts.onlyModIds !== undefined && !opts.onlyModIds.has(r.modId)) continue;
    const missing = countDistinct(r, "missing");
    out.missing += missing;
    out.installedDisabled += countDistinct(r, "installed-disabled");
    out.partial += countDistinct(r, "partial");
    out.external += countDistinct(r, "external");
    out.dlc += countDistinct(r, "dlc");
    if (missing > 0) out.modsWithMissing += 1;
    if (r.unfetched) out.unfetched += 1;
    if (r.truncatedBy > 0) out.truncated += 1;
  }
  return out;
}

/**
 * The cell's CATEGORY, for an exact-match filter:
 * "missing" | "disabled" | "partial" | "not checked" | "incomplete" | "ok" | "".
 *
 * "partial" is a required page whose files are all installed and only some
 * enabled — a warning, never "missing". "incomplete" is a mod whose page
 * lists more requirements than Nexus returned (Vortex asks for ten): what
 * came back may all be met, and the rest is unknown — which is not "ok".
 */
export function requirementCellCategory(r: ModRequirementReport | undefined): string {
  if (r === undefined) return "";
  if (countDistinct(r, "missing") > 0) return "missing";
  if (countDistinct(r, "installed-disabled") > 0) return "disabled";
  if (countDistinct(r, "partial") > 0) return "partial";
  if (r.unfetched) return "not checked";
  if (r.truncatedBy > 0) return "incomplete";
  return r.requirements.some((q) => q.status === "satisfied") ? "ok" : "";
}

/** One cell's worth: "3 missing · 1 disabled" — or nothing when all is well. */
export function describeRequirementCell(r: ModRequirementReport | undefined): string {
  if (r === undefined) return "";
  const missing = countDistinct(r, "missing");
  const disabled = countDistinct(r, "installed-disabled");
  const partial = countDistinct(r, "partial");
  const parts: string[] = [];
  if (missing > 0) parts.push(`${missing} missing`);
  if (disabled > 0) parts.push(`${disabled} disabled`);
  if (partial > 0) parts.push(`${partial} partly enabled`);
  if (parts.length === 0) {
    if (r.unfetched) return "not checked";
    if (r.truncatedBy > 0) return "incomplete";
    const n = r.requirements.filter((q) => q.status === "satisfied").length;
    return n === 0 ? "" : "ok";
  }
  if (r.truncatedBy > 0) parts.push("incomplete");
  return parts.join(" · ");
}

/**
 * Whether a dependant loses a requirement line when every mod in `off` is
 * disabled: a line with no ENABLED provider left outside `off`.
 *
 * With `provider`, only the dependant's lines on that provider are looked at
 * (and `requiredBy` naming it with no such line left to check is taken at
 * its word). Without, the lines that an enabled mod in `off` was covering.
 */
function losesALine(
  report: RequirementsReport,
  byId: ReadonlyMap<string, CuratorMod>,
  dependantId: string,
  off: ReadonlySet<string>,
  provider?: string,
): boolean {
  const onIt = (report.byMod.get(dependantId)?.requirements ?? []).filter((q) =>
    provider === undefined ? q.satisfiedBy.some((p) => off.has(p) && byId.get(p)?.enabled === true) : q.satisfiedBy.includes(provider),
  );
  if (provider !== undefined && onIt.length === 0) return true;
  return onIt.some((q) => !q.satisfiedBy.some((p) => !off.has(p) && byId.get(p)?.enabled === true));
}

/**
 * The mods that would lose a requirement if `modIds` were disabled.
 *
 * Only ENABLED dependants count: a mod already off is not made worse. A
 * dependant that is itself in `modIds` is not a warning either, and neither
 * is one whose line another ENABLED provider still covers — two installs of
 * one page, a page and its re-upload: disabling one of them breaks nothing.
 */
export function dependantsOf(
  report: RequirementsReport,
  mods: readonly CuratorMod[],
  modIds: ReadonlySet<string>,
): Array<{ provider: CuratorMod; dependants: CuratorMod[] }> {
  const byId = new Map(mods.map((m) => [m.id, m]));
  const out: Array<{ provider: CuratorMod; dependants: CuratorMod[] }> = [];
  for (const id of modIds) {
    const provider = byId.get(id);
    if (provider === undefined) continue;
    const dependants = (report.requiredBy.get(id) ?? [])
      .filter((d) => !modIds.has(d))
      .map((d) => byId.get(d))
      .filter((d): d is CuratorMod => d !== undefined && d.enabled && losesALine(report, byId, d.id, modIds, id));
    if (dependants.length > 0) out.push({ provider, dependants });
  }
  return out;
}

/**
 * Everything "disable the dependants too" has to take down: the mods that
 * break when `modIds` go off, then the mods that break when THOSE go off, until
 * nothing new breaks. Never `modIds` themselves, never a mod already disabled,
 * never one whose line another enabled provider still covers. In the order
 * found, so the dialog lists the direct dependants first.
 */
export function dependantClosure(
  report: RequirementsReport,
  mods: readonly CuratorMod[],
  modIds: ReadonlySet<string>,
): CuratorMod[] {
  const byId = new Map(mods.map((m) => [m.id, m]));
  const off = new Set(modIds);
  const out: CuratorMod[] = [];
  for (let grew = true; grew; ) {
    grew = false;
    for (const id of [...off]) {
      for (const d of report.requiredBy.get(id) ?? []) {
        const m = byId.get(d);
        if (off.has(d) || m === undefined || !m.enabled) continue;
        if (!losesALine(report, byId, d, off)) continue;
        off.add(d);
        out.push(m);
        grew = true;
      }
    }
  }
  return out;
}

/**
 * Order two mod versions: negative when `a` is older, positive when newer.
 *
 * What authors actually write on Nexus: a leading "v", two or three or four
 * numeric segments, a prerelease tag. Numeric segments compare as numbers
 * (1.10 after 1.9), a missing segment is 0 (1.0 = 1.0.0), a prerelease sorts
 * below its release (2.0.0-beta before 2.0.0), and build metadata after "+"
 * is ignored. A missing version ranks below any version. A string compare —
 * even a "numeric" one — put 2.0.0-beta above 2.0.0 and v1.2 above 1.10.
 */
export function compareVersions(a: string | undefined, b: string | undefined): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === undefined || pb === undefined) return pa === pb ? 0 : pa === undefined ? -1 : 1;
  const n = Math.max(pa.core.length, pb.core.length);
  for (let i = 0; i < n; i += 1) {
    const c = compareSegment(pa.core[i] ?? "0", pb.core[i] ?? "0");
    if (c !== 0) return c;
  }
  // Same release: no prerelease beats any prerelease.
  if (pa.pre.length === 0 || pb.pre.length === 0) return pb.pre.length - pa.pre.length;
  const m = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < m; i += 1) {
    if (pa.pre[i] === undefined) return -1; // a shorter prerelease is the earlier one
    if (pb.pre[i] === undefined) return 1;
    const c = compareSegment(pa.pre[i]!, pb.pre[i]!);
    if (c !== 0) return c;
  }
  return 0;
}

function parseVersion(raw: string | undefined): { core: string[]; pre: string[] } | undefined {
  const s = (raw ?? "").trim().replace(/^v(?=\d)/i, "").split("+")[0]!;
  if (s === "") return undefined;
  const dash = s.indexOf("-");
  const core = (dash === -1 ? s : s.slice(0, dash)).split(".").filter((x) => x !== "");
  const pre = dash === -1 ? [] : s.slice(dash + 1).split(".").filter((x) => x !== "");
  return { core, pre };
}

function compareSegment(a: string, b: string): number {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) return Math.sign(Number(a) - Number(b));
  // A number ranks below a word in a prerelease (semver's rule); elsewhere
  // ("1.2a") the words compare as text.
  if (na !== nb) return na ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Of several disabled installs of one page, the one to enable.
 *
 * The pool can hold two copies of a mod (an old and a new install, both
 * off). Enabling both hands Vortex a file conflict the curator never
 * asked for, so one is chosen: the highest version, else the first.
 *
 * `preferFile` is a {@link fileIdentity} — which FILE of the page is meant,
 * when the caller knows. A page hosts a main file and its optional patches
 * with their own version numbers; "the highest version on the page" can be
 * a patch at 9.0 over the main file at 5.2. When copies of the preferred file
 * exist, only they compete.
 */
export function pickProvider(candidates: readonly CuratorMod[], preferFile?: string): CuratorMod | undefined {
  if (candidates.length === 0) return undefined;
  const sameFile = preferFile === undefined ? [] : candidates.filter((m) => fileIdentity(m) === preferFile);
  const pool = sameFile.length > 0 ? sameFile : candidates;
  // Stable: of equal versions, the first stays first.
  return pool.reduce((best, m) => (compareVersions(m.version, best.version) > 0 ? m : best));
}

/**
 * The installed-but-disabled providers that `modIds` need, so enabling a
 * mod can offer to enable what it depends on in the same act. One
 * provider per requirement line (see pickProvider).
 */
export function disabledProvidersFor(
  report: RequirementsReport,
  mods: readonly CuratorMod[],
  modIds: ReadonlySet<string>,
): CuratorMod[] {
  const byId = new Map(mods.map((m) => [m.id, m]));
  const seen = new Set<string>();
  const out: CuratorMod[] = [];
  for (const id of modIds) {
    for (const q of report.byMod.get(id)?.requirements ?? []) {
      if (q.status !== "installed-disabled") continue;
      const candidates = q.satisfiedBy
        .map((p) => byId.get(p))
        .filter((m): m is CuratorMod => m !== undefined && !m.enabled && !modIds.has(m.id));
      const mod = pickProvider(candidates);
      if (mod === undefined || seen.has(mod.id)) continue;
      seen.add(mod.id);
      out.push(mod);
    }
  }
  return out;
}

// ── Which file to install ──────────────────────────────────────────────

/** The part of Nexus's file record this decision reads. */
export type NexusFileInfo = {
  file_id: number;
  name?: string;
  file_name?: string;
  version?: string;
  category_id?: number;
  category_name?: string;
  is_primary?: boolean;
};

/** Nexus file categories, from its API. */
export const FILE_CATEGORY = {
  MAIN: 1,
  UPDATE: 2,
  OPTIONAL: 3,
  OLD_VERSION: 4,
  MISCELLANEOUS: 5,
  ARCHIVED: 6,
} as const;

export type InstallFileChoice =
  | { kind: "one"; file: NexusFileInfo }
  | { kind: "choose"; candidates: NexusFileInfo[] }
  | { kind: "none" };

/**
 * The file to install for a required mod, when that is not a judgement.
 *
 * Exactly one current MAIN file → that one. Several mains (an SE and an AE
 * build, a "full" and a "lite") → the curator chooses; the wrong pick
 * installs fine and is wrong forever. No mains at all → the current
 * non-old files are offered, or nothing.
 */
export function pickInstallFile(files: readonly NexusFileInfo[]): InstallFileChoice {
  const current = files.filter(
    (f) => f.category_id !== FILE_CATEGORY.OLD_VERSION && f.category_id !== FILE_CATEGORY.ARCHIVED,
  );
  const mains = current.filter((f) => f.category_id === FILE_CATEGORY.MAIN);
  if (mains.length === 1) return { kind: "one", file: mains[0]! };
  if (mains.length > 1) return { kind: "choose", candidates: mains };
  if (current.length === 0) return { kind: "none" };
  return { kind: "choose", candidates: current };
}
