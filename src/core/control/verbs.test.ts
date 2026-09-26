import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { util, __testGame } from "@nexusmods/vortex-api";

vi.mock("./gameProcess", () => ({ isProcessRunning: vi.fn(async () => false) }));
// plugins.txt on disk: the machine running the tests may have a real one.
const disk = vi.hoisted(() => ({ entries: undefined as undefined | Array<{ name: string; enabled: boolean }> }));
vi.mock("../installer/checkPluginOrder", () => ({ readUserPluginsTxt: vi.fn(async () => disk.entries) }));

import { isProcessRunning } from "./gameProcess";
import { answerFor, runVerb, setSettleWindowsForTests, VERBS } from "./verbs";

const running = isProcessRunning as unknown as ReturnType<typeof vi.fn>;

const OG = fs.mkdtempSync(path.join(os.tmpdir(), "eh-og-"));
const AE = fs.mkdtempSync(path.join(os.tmpdir(), "eh-ae-"));
fs.writeFileSync(path.join(AE, "Fallout4.exe"), "");
fs.writeFileSync(path.join(OG, "Fallout4.exe"), "");

type Api = ReturnType<typeof fakeVortex>["api"];

/** A Vortex that answers the events and actions the verbs use, and records their order. */
function fakeVortex() {
  const log: string[] = [];
  const deployed = { n: 5 };
  const handlers = new Map<string, Set<(...a: unknown[]) => void>>();
  const state: any = {
    settings: {
      profiles: { activeGameId: "fallout4", activeProfileId: "og" },
      gameMode: { discovered: { fallout4: { path: OG, store: "gog", executable: "Fallout4.exe" } } },
    },
    persistent: {
      profiles: {
        og: { id: "og", name: "Ivy OG", gameId: "fallout4", modState: { a: { enabled: true } } },
        ae: { id: "ae", name: "Ivy AE", gameId: "fallout4", modState: {} },
        sky: { id: "sky", name: "Meridia", gameId: "skyrimse", modState: {} },
      },
      mods: {
        fallout4: {
          a: { id: "a", state: "installed", attributes: { name: "Mod A", version: "1.0", modId: 12, fileId: 34 } },
          b: { id: "b", state: "installed", attributes: { customFileName: "Mod B" } },
        },
      },
      downloads: {
        files: {
          d1: { localPath: "a.zip", state: "finished", game: ["fallout4"] },
          d2: { localPath: "s.zip", state: "finished", game: ["skyrimse"] },
        },
      },
    },
  };
  state.session = { plugins: { pluginList: { "fallout4.esm": { isNative: true }, "a.esp": {}, "b.esp": {}, "c.esl": {} } }, notifications: { notifications: [], dialogs: [] } };
  state.loadOrder = {
    "a.esp": { enabled: true, loadOrder: 1, name: "A.esp" },
    "b.esp": { enabled: true, loadOrder: 2, name: "B.esp" },
    "c.esl": { enabled: false, loadOrder: 3, name: "C.esl" },
  };
  const fire = (ev: string, ...args: unknown[]): void => handlers.get(ev)?.forEach((fn) => fn(...args));
  const listeners = new Set<() => void>();
  const notify = (): void => listeners.forEach((l) => l());
  const closed: Array<{ id: string; action: string }> = [];
  /** Opens a Vortex dialog; resolves with the button pressed (by the watcher, or by "the user" in a test). */
  const openDialog = (d: { id: string; title: string; text: string; actions: string[] }): Promise<string> => {
    state.session ??= { notifications: { notifications: [], dialogs: [] } };
    state.session.notifications.dialogs.push({ id: d.id, type: "question", title: d.title, content: { text: d.text }, actions: d.actions.map((label) => ({ label })) });
    return new Promise((resolve) => {
      pending.set(d.id, resolve);
      notify();
    });
  };
  const pending = new Map<string, (action: string) => void>();
  const api = {
    getState: () => state,
    closeDialog: (id: string, action: string) => {
      closed.push({ id, action });
      state.session.notifications.dialogs = state.session.notifications.dialogs.filter((x: any) => x.id !== id);
      pending.get(id)?.(action);
      notify();
    },
    sendNotification: vi.fn(),
    events: {
      on: (ev: string, fn: (...a: unknown[]) => void) => {
        if (!handlers.has(ev)) handlers.set(ev, new Set());
        handlers.get(ev)!.add(fn);
      },
      removeListener: (ev: string, fn: (...a: unknown[]) => void) => handlers.get(ev)?.delete(fn),
      emit: (ev: string, ...args: unknown[]) => {
        if (ev === "set-plugin-list") {
          const names = args[0] as string[];
          names.forEach((n, i) => {
            const id = n.toLowerCase();
            if (state.loadOrder[id] !== undefined) state.loadOrder[id].loadOrder = i;
          });
        }
        if (ev === "purge-mods") {
          log.push("purge");
          setTimeout(() => {
            deployed.n = 0;
            (args[1] as (e: unknown) => void)(null);
          });
        }
        if (ev === "deploy-mods") {
          log.push(`deploy:${String(args[1])}`);
          setTimeout(() => {
            deployed.n = 9;
            (args[0] as (e: unknown) => void)(null);
          });
        }
      },
    },
    store: {
      subscribe: (l: () => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      dispatch: (a: { type: string; payload: any }) => {
        if (a.type === "STUB_SET_MOD_ENABLED") {
          state.persistent.profiles[a.payload.profileId].modState[a.payload.modId] = { enabled: a.payload.enabled };
        }
        if (a.type === "STUB_SET_NEXT_PROFILE") {
          log.push(`profile:${a.payload}`);
          state.settings.profiles.activeProfileId = a.payload;
          setTimeout(() => fire("profile-did-change", a.payload));
        }
        if (a.type === "SET_PLUGIN_ENABLED") {
          const id = String(a.payload.pluginName).toLowerCase();
          if (state.loadOrder[id] !== undefined) state.loadOrder[id].enabled = a.payload.enabled;
        }
        if (a.type === "STUB_ADD_MOD_RULE") {
          const m = state.persistent.mods[a.payload.gameId][a.payload.modId];
          m.rules = [...(m.rules ?? []), a.payload.rule];
        }
        if (a.type === "STUB_REMOVE_MOD_RULE") {
          const m = state.persistent.mods[a.payload.gameId][a.payload.modId];
          m.rules = (m.rules ?? []).filter((r: any) => !(r.type === a.payload.rule.type && r.reference?.id === a.payload.rule.reference?.id));
        }
        if (a.type === "STUB_SET_GAME_PATH") {
          log.push(`setPath:${path.basename(a.payload.gamePath)}`);
          const d = state.settings.gameMode.discovered[a.payload.gameId];
          Object.assign(d, { path: a.payload.gamePath, store: a.payload.store });
        }
      },
    },
  };
  return { api, state, log, deployed, openDialog, closed };
}

let v: ReturnType<typeof fakeVortex>;
const run = (verb: string, body: Record<string, unknown> = {}, api: Api = v.api) => VERBS[verb]!.run(api as any, body);

beforeEach(() => {
  setSettleWindowsForTests(40);
  disk.entries = undefined;
  v = fakeVortex();
  running.mockResolvedValue(false);
  __testGame.current = { requiredFiles: ["Fallout4.exe"], executable: () => "Fallout4.exe" };
  vi.spyOn(util, "getManifest").mockImplementation((async () => ({
    files: Array.from({ length: v.deployed.n }, () => ({})),
  })) as never);
});
afterEach(() => vi.restoreAllMocks());

describe("state", () => {
  it("reports the active game, its mods with enablement, and only this game's profiles and downloads", async () => {
    const s = (await run("state", { include: ["mods", "downloads"] })) as any;
    expect(s.gameId).toBe("fallout4");
    expect(s.game).toMatchObject({ path: OG, store: "gog", executable: "Fallout4.exe", running: false });
    expect(s.profile).toEqual({ id: "og", name: "Ivy OG" });
    expect(s.profiles.map((p: any) => p.id)).toEqual(["og", "ae"]);
    expect(s.mods).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "a", name: "Mod A", enabled: true, nexus: { modId: 12, fileId: 34 }, owner: "not-eh" }),
        expect.objectContaining({ id: "b", name: "Mod B", enabled: false }),
      ]),
    );
    expect(s.downloads.map((d: any) => d.id)).toEqual(["d1"]);
    expect(s.deployment.deployedFiles).toBe(5);
  });
});

describe("game.setPath", () => {
  it("refuses while files are still deployed, and changes nothing", async () => {
    await expect(run("game.setPath", { path: AE })).rejects.toMatchObject({ code: "not-purged" });
    expect(v.state.settings.gameMode.discovered.fallout4.path).toBe(OG);
  });

  it("refuses when a deployment manifest cannot be read (unknown is not zero)", async () => {
    v.deployed.n = 0;
    vi.spyOn(util, "getManifest").mockRejectedValue(new Error("EACCES") as never);
    await expect(run("game.setPath", { path: AE })).rejects.toMatchObject({ code: "deployment-unknown" });
  });

  it("refuses a folder without the game in it", async () => {
    v.deployed.n = 0;
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "eh-empty-"));
    await expect(run("game.setPath", { path: empty })).rejects.toMatchObject({ code: "not-a-game-folder" });
  });

  it("refuses while the game runs, and when it cannot tell", async () => {
    v.deployed.n = 0;
    running.mockResolvedValue(true);
    await expect(run("game.setPath", { path: AE })).rejects.toMatchObject({ code: "game-running" });
    running.mockResolvedValue(undefined);
    await expect(run("game.setPath", { path: AE })).rejects.toMatchObject({ code: "game-state-unknown" });
  });

  it("repoints a purged game and records the store the caller named", async () => {
    v.deployed.n = 0;
    const r = await run("game.setPath", { path: AE, store: "steam" });
    expect(r).toMatchObject({ previousPath: OG, previousStore: "gog", path: AE, store: "steam" });
  });
});

describe("game.switchInstall", () => {
  it("purges, repoints, switches profile and deploys, in that order", async () => {
    const r = (await run("game.switchInstall", { path: AE, store: "steam", profileId: "ae" })) as any;
    expect(v.log).toEqual(["purge", "setPath:" + path.basename(AE), "profile:ae", "deploy:ae"]);
    expect(r).toMatchObject({ path: AE, profileId: "ae", steps: ["purge", "setPath", "profile", "deploy"], deployedFiles: 9 });
  });

  it("stops before repointing when the purge leaves files behind", async () => {
    v.api.events.emit = (ev: string, ...args: unknown[]) => {
      if (ev === "purge-mods") setTimeout(() => (args[1] as (e: unknown) => void)(null)); // files stay
    };
    await expect(run("game.switchInstall", { path: AE, profileId: "ae" })).rejects.toMatchObject({
      code: "purge-incomplete",
      details: { failedStep: "purge", completedSteps: [], deployedFilesAfter: 5 },
    });
    expect(v.state.settings.gameMode.discovered.fallout4.path).toBe(OG);
  });

  it("refuses a profile of another game before touching anything", async () => {
    await expect(run("game.switchInstall", { path: AE, profileId: "sky" })).rejects.toMatchObject({ code: "bad-profile" });
    expect(v.log).toEqual([]);
  });
});

describe("verified outcomes", () => {
  it("purge fails when Vortex says done but files remain", async () => {
    v.api.events.emit = (ev: string, ...args: unknown[]) => {
      if (ev === "purge-mods") setTimeout(() => (args[1] as (e: unknown) => void)(null));
    };
    await expect(run("purge")).rejects.toMatchObject({ code: "purge-incomplete", details: { deployedFilesAfter: 5 } });
  });

  it("deploy fails when Vortex still says the game needs deploying", async () => {
    v.state.persistent.deployment = { needToDeploy: { fallout4: true } };
    await expect(run("deploy")).rejects.toMatchObject({ code: "deploy-unverified" });
  });

  it("deploy succeeds with what it verified", async () => {
    await expect(run("deploy")).resolves.toMatchObject({
      verified: { deploymentNeeded: false, deployedFiles: 9 },
    });
  });

  it("remove fails, naming what did and did not go, when Vortex leaves a mod", async () => {
    vi.spyOn(util, "removeMods").mockImplementation((async () => {
      delete v.state.persistent.mods.fallout4.a; // b stays
    }) as never);
    await expect(run("mods.remove", { modIds: ["a", "b"] })).rejects.toMatchObject({
      code: "remove-incomplete",
      details: { removed: [expect.objectContaining({ id: "a" })], notRemoved: [expect.objectContaining({ id: "b" })] },
    });
  });
});

describe("queries", () => {
  it("mods.find filters by name, nexus id and enabled", async () => {
    expect(((await run("mods.find", { name: "mod b" })) as any).mods.map((m: any) => m.id)).toEqual(["b"]);
    expect(((await run("mods.find", { nexusModId: 12 })) as any).mods.map((m: any) => m.id)).toEqual(["a"]);
    expect(((await run("mods.find", { enabled: true })) as any).mods.map((m: any) => m.id)).toEqual(["a"]);
  });

  it("mod.get returns the whole record and where it is enabled; 404 for an unknown id", async () => {
    const m = (await run("mod.get", { id: "a" })) as any;
    expect(m).toMatchObject({ id: "a", name: "Mod A", enabled: true, enabledIn: [{ id: "og", name: "Ivy OG" }] });
    await expect(run("mod.get", { id: "zz" })).rejects.toMatchObject({ code: "no-such-mod", status: 404 });
  });

  it("state stays compact unless the lists are asked for", async () => {
    const s = (await run("state")) as any;
    expect(s.mods).toBeUndefined();
    expect(s.counts).toMatchObject({ mods: 2, enabledMods: 1, downloads: 1 });
  });
});

describe("runVerb: what Vortex said while a command ran", () => {
  it("attaches notifications raised during the command and dialogs left open", async () => {
    v.state.session = { notifications: { notifications: [{ id: "old", type: "info", title: "before" }], dialogs: [] } };
    v.api.events.emit = (ev: string, ...args: unknown[]) => {
      if (ev === "deploy-mods") {
        v.state.session.notifications.notifications.push({ id: "n1", type: "error", title: "Deploy hiccup", message: "x" });
        v.state.session.notifications.dialogs.push({ id: "d1", type: "question", title: "FOMOD", content: { text: "Pick one" } });
        setTimeout(() => (args[0] as (e: unknown) => void)(null));
      }
    };
    const r = (await runVerb(v.api as any, "deploy", {})) as any;
    expect(r.vortex.notifications).toEqual([{ type: "error", title: "Deploy hiccup", message: "x" }]);
    expect(r.vortex.openDialogs).toEqual([{ type: "question", title: "FOMOD", text: "Pick one" }]);
  });

  it("attaches them to a failure too", async () => {
    v.state.session = { notifications: { notifications: [], dialogs: [] } };
    await expect(runVerb(v.api as any, "game.setPath", { path: AE })).rejects.toMatchObject({
      code: "not-purged",
      details: { vortex: { notifications: [], openDialogs: [] } },
    });
  });
});

describe("ifExisting: Vortex's older-version dialog", () => {
  const OLDER = {
    id: "dlg1",
    title: "F4SE",
    text: "An older version of this mod is already installed. You can replace the existing one - which will update all profiles - or install this one alongside it.",
    actions: ["Cancel", "Update all profiles", "Update current profile"],
  };
  // A deploy stands in for any changing command that raises the dialog mid-way
  // and waits for its answer, which is what Vortex's installer does.
  const deployRaising = (dialog: typeof OLDER, onAnswer: (a: string) => void = () => undefined) => {
    v.api.events.emit = (ev: string, ...args: unknown[]) => {
      if (ev === "deploy-mods") {
        void v.openDialog(dialog).then((answer) => {
          onAnswer(answer);
          (args[0] as (e: unknown) => void)(null);
        });
      }
    };
  };

  it("answers alongside with 'Update current profile', and records it", async () => {
    let answered = "";
    deployRaising(OLDER, (a) => (answered = a));
    const r = (await runVerb(v.api as any, "deploy", { ifExisting: "alongside" })) as any;
    expect(answered).toBe("Update current profile");
    expect(r.vortex.dialogsSeen).toEqual([
      expect.objectContaining({ title: "F4SE", answer: "Update current profile", answeredBy: "ifExisting" }),
    ]);
    expect(r.vortex.openDialogs).toEqual([]);
  });

  it("answers replace with 'Update all profiles'", async () => {
    let answered = "";
    deployRaising(OLDER, (a) => (answered = a));
    await runVerb(v.api as any, "deploy", { ifExisting: "replace" });
    expect(answered).toBe("Update all profiles");
  });

  it("leaves the dialog to the user when not told, and still records that it opened", async () => {
    deployRaising(OLDER);
    const p = runVerb(v.api as any, "deploy", {});
    await new Promise((r) => setTimeout(r, 20));
    expect(v.closed).toEqual([]);
    v.api.closeDialog("dlg1", "Update current profile"); // the owner clicks
    const r = (await p) as any;
    expect(r.vortex.dialogsSeen).toEqual([expect.objectContaining({ title: "F4SE" })]);
    expect(r.vortex.dialogsSeen[0].answer).toBeUndefined();
  });

  it("does not press a button Vortex no longer has", async () => {
    deployRaising({ ...OLDER, actions: ["Cancel", "Replace", "Keep both"] });
    const p = runVerb(v.api as any, "deploy", { ifExisting: "alongside" });
    await new Promise((r) => setTimeout(r, 20));
    expect(v.closed).toEqual([]);
    v.api.closeDialog("dlg1", "Keep both");
    await p;
  });

  it("does not answer other dialogs", async () => {
    deployRaising({ ...OLDER, text: "Updating may break dependencies", actions: ["Cancel", "Ignore"] });
    const p = runVerb(v.api as any, "deploy", { ifExisting: "replace" });
    await new Promise((r) => setTimeout(r, 20));
    expect(v.closed).toEqual([]);
    v.api.closeDialog("dlg1", "Cancel");
    await p;
  });

  it("rejects an unknown ifExisting before doing anything", async () => {
    await expect(runVerb(v.api as any, "deploy", { ifExisting: "both" })).rejects.toMatchObject({ code: "bad-request" });
    expect(v.log).toEqual([]);
  });
});

describe("conflicts + mods.rule", () => {
  const withConflict = () => {
    v.state.session = {
      notifications: { notifications: [], dialogs: [] },
      dependencies: {
        conflicts: {
          a: [{ otherMod: { id: "b" }, files: ["meshes/x.nif", "textures/y.dds"] }],
          b: [{ otherMod: { id: "a" }, files: ["meshes/x.nif", "textures/y.dds"] }],
        },
      },
    };
  };

  it("reports one entry per pair, unresolved when no order rule exists", async () => {
    withConflict();
    const r = (await run("conflicts")) as any;
    expect(r).toMatchObject({ calculated: true, total: 1, unresolved: 1 });
    expect(r.pairs[0]).toMatchObject({ modId: "a", otherId: "b", files: 2, resolved: false });
  });

  it("says when Vortex has not calculated conflicts, instead of reporting none", async () => {
    const r = (await run("conflicts")) as any;
    expect(r).toMatchObject({ calculated: false, pairs: [] });
  });

  it("adds an order rule, reads it back, and the pair reads resolved", async () => {
    withConflict();
    const r = (await run("mods.rule", { source: "a", type: "after", reference: "b" })) as any;
    expect(v.state.persistent.mods.fallout4.a.rules).toEqual([{ type: "after", reference: { id: "b", versionMatch: "*" } }]);
    expect(r).toMatchObject({ type: "after", replaced: [], conflict: { files: 2, resolved: true }, verified: { rulesNow: ["after"] } });
    expect(((await run("conflicts", { unresolvedOnly: true })) as any).pairs).toEqual([]);
  });

  it("replaces a contradicting order rule rather than stacking a second one", async () => {
    v.state.persistent.mods.fallout4.a.rules = [{ type: "before", reference: { id: "b" } }];
    const r = (await run("mods.rule", { source: "a", type: "after", reference: "b" })) as any;
    expect(r.replaced).toEqual(["before"]);
    expect(v.state.persistent.mods.fallout4.a.rules.map((x: any) => x.type)).toEqual(["after"]);
  });

  it("reports an order rule the other mod holds on this one", async () => {
    v.state.persistent.mods.fallout4.b.rules = [{ type: "after", reference: { id: "a" } }];
    const r = (await run("mods.rule", { source: "a", type: "after", reference: "b" })) as any;
    expect(r.otherSideRules).toEqual([{ type: "after" }]);
  });

  it("removes a rule and verifies it is gone", async () => {
    v.state.persistent.mods.fallout4.a.rules = [{ type: "after", reference: { id: "b" } }];
    const r = (await run("mods.rule", { source: "a", reference: "b", remove: true })) as any;
    expect(r.removed).toBe(1);
    expect(v.state.persistent.mods.fallout4.a.rules).toEqual([]);
  });

  it("refuses unknown mods, self-rules and unknown types before touching anything", async () => {
    await expect(run("mods.rule", { source: "a", type: "after", reference: "zz" })).rejects.toMatchObject({ code: "unknown-mods" });
    await expect(run("mods.rule", { source: "a", type: "after", reference: "a" })).rejects.toMatchObject({ code: "bad-request" });
    await expect(run("mods.rule", { source: "a", type: "loadsnear", reference: "b" })).rejects.toMatchObject({ code: "bad-request" });
    expect(v.state.persistent.mods.fallout4.a.rules).toBeUndefined();
  });

  it("uses the mod's version for exact and compatible matches", async () => {
    await run("mods.rule", { source: "b", type: "requires", reference: "a", versionMatch: "compatible" });
    expect(v.state.persistent.mods.fallout4.b.rules).toEqual([{ type: "requires", reference: { id: "a", versionMatch: "^1.0" } }]);
  });
});

describe("reinstalling an archive already in the pool", () => {
  const REINSTALL = {
    id: "r1",
    title: "Install options",
    text: '"AAF" is already installed on your system.[br][/br][br][/br]Would you like to:',
    actions: ["Cancel", "Continue"],
  };
  const NAME = { id: "n1", title: "Install options - Name mod variant", text: 'Enter a variant name for "AAF"', actions: ["Cancel", "Continue"], inputDefault: "2" };

  it("refuses an unattended reinstall, which Vortex would turn into a silent replace everywhere", async () => {
    v.state.persistent.mods.fallout4.a.archiveId = "arc1";
    await expect(run("install", { archiveId: "arc1", unattended: true, choices: { type: "fomod", options: [] } })).rejects.toMatchObject({
      code: "would-replace-everywhere",
      details: { existing: ["a"] },
    });
  });

  it("alongside answers Install as variant, without pre-filling the old choices when new ones were sent", () => {
    expect(answerFor({ ifExisting: "alongside", ownChoices: true }, REINSTALL)).toEqual({
      label: "Continue",
      input: { replace: false, variant: true, remember: false, preserveChoices: false },
    });
  });

  it("replace answers Replace", () => {
    expect(answerFor({ ifExisting: "replace" }, REINSTALL)?.input).toMatchObject({ replace: true, variant: false, preserveChoices: true });
  });

  it("names the variant from variantName, else keeps Vortex's pre-filled name", () => {
    expect(answerFor({ ifExisting: "alongside", variantName: "AE" }, NAME)).toEqual({ label: "Continue", input: { variant: "AE", remember: false } });
    expect(answerFor({ ifExisting: "alongside" }, NAME)?.input).toEqual({ variant: "2", remember: false });
    expect(answerFor({ ifExisting: "replace" }, NAME)).toBeUndefined();
  });

  it("ask, or a dialog without a Continue button, gets no answer", () => {
    expect(answerFor({ ifExisting: "ask" }, REINSTALL)).toBeUndefined();
    expect(answerFor({ ifExisting: "alongside" }, { ...REINSTALL, actions: ["Cancel", "Next"] })).toBeUndefined();
  });
});

describe("plugins.setEnabled / plugins.apply", () => {
  it("disables and enables by name, reports unknown names, and reads the state back", async () => {
    const r = (await run("plugins.setEnabled", { names: ["A.esp", "nope.esp"], enabled: false })) as any;
    expect(v.state.loadOrder["a.esp"].enabled).toBe(false);
    expect(r).toMatchObject({ changed: 1, unknown: ["nope.esp"], verified: { state: "matches" } });
  });

  it("refuses a profile that is not the active one: plugin state lives there only", async () => {
    await expect(run("plugins.setEnabled", { names: ["A.esp"], enabled: false, profileId: "ae" })).rejects.toMatchObject({
      code: "not-active-profile",
    });
  });

  it("replays a list: order and enabled state, unknown names reported", async () => {
    const r = (await run("plugins.apply", {
      order: [
        { name: "C.esl", enabled: true },
        { name: "B.esp", enabled: false },
        { name: "Missing.esp", enabled: true },
        { name: "A.esp", enabled: true },
      ],
    })) as any;
    expect(v.state.loadOrder["c.esl"]).toMatchObject({ enabled: true, loadOrder: 0 });
    expect(v.state.loadOrder["b.esp"]).toMatchObject({ enabled: false, loadOrder: 1 });
    expect(v.state.loadOrder["a.esp"].loadOrder).toBe(3);
    expect(r).toMatchObject({ entries: 4, unknown: ["Missing.esp"], verified: { state: "matches", order: "as given" } });
  });

  it("fails as unverified when Vortex does not take the enabled state", async () => {
    const dispatch = v.api.store.dispatch;
    v.api.store.dispatch = (a: any) => (a.type === "SET_PLUGIN_ENABLED" ? undefined : dispatch(a));
    await expect(run("plugins.apply", { order: [{ name: "C.esl", enabled: true }] })).rejects.toMatchObject({
      code: "plugins-unverified",
      details: { wrongEnabled: ["C.esl"] },
    });
  });

  it("checks plugins.txt on disk and says which active plugins it lacks", async () => {
    disk.entries = [{ name: "A.esp", enabled: true }];
    const r = (await run("plugins.apply", { order: [{ name: "A.esp", enabled: true }, { name: "C.esl", enabled: true }] })) as any;
    expect(r.pluginsTxt).toMatchObject({ read: true, active: 1, missingActiveCount: 1, missingActive: ["C.esl"] });
    expect(r.verified.pluginsTxt).toBe(false);
  });

  it("rejects a malformed list before touching anything", async () => {
    await expect(run("plugins.apply", { order: [{ name: "A.esp" }] })).rejects.toMatchObject({ code: "bad-request" });
    expect(v.state.loadOrder["a.esp"]).toMatchObject({ enabled: true, loadOrder: 1 });
  });
});

describe("deploy: Vortex's flag lags the callback", () => {
  it("waits for needToDeploy to clear instead of calling the deploy unverified", async () => {
    v.state.persistent.deployment = { needToDeploy: { fallout4: true } };
    setTimeout(() => (v.state.persistent.deployment.needToDeploy.fallout4 = false), 20);
    await expect(run("deploy")).resolves.toMatchObject({ verified: { deploymentNeeded: false } });
  });
});

describe("state: deployment.needed", () => {
  it("says a deploy is needed when mods are enabled but nothing is deployed, whatever Vortex's flag says", async () => {
    v.deployed.n = 0;
    const s = (await run("state")) as any;
    expect(s.deployment).toMatchObject({ needed: true, vortexFlag: false, deployedFiles: 0 });
    expect(s.deployment.reason).toMatch(/1 mods are enabled but nothing is deployed/);
  });

  it("follows Vortex's flag otherwise", async () => {
    const s = (await run("state")) as any;
    expect(s.deployment).toEqual({ needed: false, vortexFlag: false, deployedFiles: 5 });
  });
});

describe("mods.setEnabled / mods.remove", () => {
  it("enables by exact id in the active profile", async () => {
    await run("mods.setEnabled", { modIds: ["b"], enabled: true });
    expect(v.state.persistent.profiles.og.modState.b).toEqual({ enabled: true });
  });

  it("changes nothing when any id is unknown", async () => {
    await expect(run("mods.setEnabled", { modIds: ["b", "nope"], enabled: true })).rejects.toMatchObject({
      code: "unknown-mods",
    });
    expect(v.state.persistent.profiles.og.modState.b).toBeUndefined();
  });

  it("removes nothing when any id is unknown", async () => {
    const remove = vi.spyOn(util, "removeMods");
    await expect(run("mods.remove", { modIds: ["a", "nope"] })).rejects.toMatchObject({ code: "unknown-mods" });
    expect(remove).not.toHaveBeenCalled();
  });

  it("removes the named mods and says whose they were", async () => {
    const remove = vi.spyOn(util, "removeMods").mockImplementation((async (_api: unknown, _g: string, ids: string[]) => {
      for (const id of ids) delete v.state.persistent.mods.fallout4[id];
    }) as never);
    const r = (await run("mods.remove", { modIds: ["a"] })) as any;
    expect(remove).toHaveBeenCalledWith(v.api, "fallout4", ["a"]);
    expect(r.removed).toEqual([{ id: "a", name: "Mod A", owner: "not-eh" }]);
    expect(r.notRemoved).toEqual([]);
  });
});
