/**
 * Test stub for `@nexusmods/vortex-api`.
 *
 * The real package is TYPES ONLY — no runtime `main`, no `.` export condition.
 * Vortex injects the implementation at load time through its own module hook, so
 * anything importing it is unloadable under vitest and the module is untestable
 * without this. That is why the first test file in this repo covered
 * `modIdentity`, the one core module that imports nothing from the API.
 *
 * Only the surface the tests actually exercise is implemented, and the
 * implementations mirror Vortex's real semantics rather than returning
 * placeholders — a stub that lies produces tests that pass against broken code.
 *
 * Wired up by `resolve.alias` in vitest.config.ts. Lives outside `src/` so `tsc`
 * never compiles it into `dist/`.
 */

/**
 * Paths the stub reports. Mutable so a test that needs REAL files on disk (the
 * archive-recovery tests hash actual bytes) can point Vortex's download folder
 * at its own temp directory.
 */
export const __testPaths = {
  downloadPath: "/stub/downloads",
  installPath: "/stub/install",
  /**
   * What `getVortexPath("documents")` reports. Settable because the game's
   * INI files live under it, and a test that writes real INIs needs them in a
   * temp directory rather than the developer's own My Games folder.
   */
  documentsPath: "/stub/documents",
};

/**
 * What the Nexus account selectors report.
 *
 * `undefined` means "this Vortex build does not answer" — which is a real
 * case, not a test artifact: `@nexusmods/vortex-api` is types-only, so a
 * selector present in `api.d.ts` may simply not exist in the app that loads
 * the extension. Code reading these has to survive that, and leaving these
 * unset is how a test puts it in that situation.
 */
export const __testNexusAccount: {
  isLoggedIn?: boolean;
  isPremium?: boolean;
} = {};

/** Vortex keeps the active profile in settings, never on the profile object. */
export const selectors = {
  isLoggedIn: (_state: any): boolean | undefined =>
    __testNexusAccount.isLoggedIn,
  isPremium: (_state: any): boolean | undefined =>
    __testNexusAccount.isPremium,
  activeProfileId: (state: any): string | undefined =>
    state?.settings?.profiles?.activeProfileId,
  activeProfile: (state: any): any => {
    const id = state?.settings?.profiles?.activeProfileId;
    return id === undefined ? undefined : state?.persistent?.profiles?.[id];
  },
  activeGameId: (state: any): string | undefined =>
    state?.settings?.profiles?.activeGameId,
  installPathForGame: (): string => __testPaths.installPath,
  downloadPathForGame: (): string => __testPaths.downloadPath,
};

/**
 * node-7z 0.8.1's export shape, reproduced exactly: a CONSTRUCTOR whose
 * methods live on the PROTOTYPE.
 *
 * This detail is the whole point of the stub. `SevenZip.list` is `undefined`
 * — only `new SevenZip().list` exists — and code that forgets the `new`
 * throws a synchronous TypeError that a surrounding try/catch turns into a
 * silent "skipped". A stub that exposed `list` directly would let exactly
 * that bug pass its tests, which is what happened for real.
 */
function SevenZipStub(this: unknown): void {
  /* node-7z's constructor is empty too */
}
/**
 * Can a real archiver open this file at all?
 *
 * The stub used to answer "yes" for every path, including ones that did not
 * exist and files that were half a download. That made it impossible to test
 * the case where an archive is DAMAGED rather than merely different — the
 * distinction that decides whether a user re-downloads or a curator gets a bug
 * report — because the double always said the archive was fine.
 *
 * A ZIP is identified by its end-of-central-directory record, which lives at
 * the END. That is the first thing any archiver looks for and the first thing a
 * truncated download loses, so checking for it is both cheap and faithful. 7z
 * and RAR are recognised by their leading magic and otherwise taken on trust —
 * this stub cannot parse them, and pretending to would be its own lie.
 */
function looksOpenable(archive: string): boolean {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fsm = require("fs") as typeof import("fs");
  let buf: Buffer;
  try {
    buf = fsm.readFileSync(archive);
  } catch {
    return false; // not on disk: a real 7z cannot list it either
  }
  if (buf.length >= 6 && buf.subarray(0, 6).equals(Buffer.from("377abcaf271c", "hex"))) {
    return true; // 7z
  }
  if (buf.length >= 4 && buf.subarray(0, 4).toString("latin1") === "Rar!") {
    return true; // rar
  }
  return buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06])) !== -1;
}

SevenZipStub.prototype.list = async (archive: string): Promise<unknown> => {
  if (!looksOpenable(archive)) {
    throw new Error(`Cannot open the file as an archive: ${archive}`);
  }
  return { path: archive, type: "zip", physicalSize: "0" };
};
SevenZipStub.prototype.add = async (): Promise<unknown> => ({ code: 0, errors: [] });
SevenZipStub.prototype.extractFull = async (): Promise<unknown> => ({
  code: 0,
  errors: [],
});

export const util = {
  SevenZip: SevenZipStub,
  getVortexPath: (id: string): string =>
    id === "documents" ? __testPaths.documentsPath : `/stub/${id}`,
  installIconSet: (): Promise<void> => Promise.resolve(),
  getManifest: (): unknown => ({}),
  removeMods: (): Promise<void> => Promise.resolve(),
};

export const actions = {
  // Carries its arguments, because WHICH profile a mod is enabled in is the
  // whole question: enablement is per-profile, and a resume that enabled mods
  // in the wrong profile looked exactly like installing them disabled.
  setModEnabled: (profileId: string, modId: string, enabled: boolean) => ({
    type: "STUB_SET_MOD_ENABLED",
    payload: { profileId, modId, enabled },
  }),
  /** Carries its payload so a test can assert WHICH mod a tweak landed on. */
  setINITweakEnabled: (
    gameId: string,
    modId: string,
    tweak: string,
    enabled: boolean,
  ) => ({
    type: "STUB_SET_INI_TWEAK_ENABLED",
    payload: { gameId, modId, tweak, enabled },
  }),
  /**
   * Carries its payload, because the thing worth asserting about adopting a
   * local archive is WHAT was registered — specifically that `localPath` is
   * relative to the download folder. Vortex resolves it against that folder,
   * so an absolute path here produces an entry it can never find again, and a
   * stub that dropped the payload could not catch it.
   */
  addLocalDownload: (
    id: string,
    game: string,
    localPath: string,
    fileSize: number,
  ) => ({
    type: "STUB_ADD_LOCAL_DOWNLOAD",
    payload: { id, game, localPath, fileSize },
  }),
  setLoadOrder: () => ({ type: "STUB_SET_LOAD_ORDER" }),
  // These carry their payloads for the same reason the ones below do: a rule
  // purge is only testable if the double records WHICH rule was removed, and
  // an action that forgets its arguments makes "we deleted exactly what we
  // captured" an unprovable claim.
  addModRule: (gameId: string, modId: string, rule: unknown) => ({
    type: "STUB_ADD_MOD_RULE",
    payload: { gameId, modId, rule },
  }),
  removeModRule: (gameId: string, modId: string, rule: unknown) => ({
    type: "STUB_REMOVE_MOD_RULE",
    payload: { gameId, modId, rule },
  }),
  // Payloads are carried, not dropped: a test double has to be able to react
  // to what the code asked for (switching to profile X emits X's did-change),
  // and an action that forgets its argument makes that impossible.
  setNextProfile: (profileId: string) => ({
    type: "STUB_SET_NEXT_PROFILE",
    payload: profileId,
  }),
  setProfile: (profile: unknown) => ({ type: "STUB_SET_PROFILE", payload: profile }),
};

/** Swallowed by default so tests do not print. Reassign in a test to assert on it. */
export const log = (): void => {
  /* no-op */
};

export const types = {};
