import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { util, __testGame, __testPaths } from "@nexusmods/vortex-api";

vi.mock("./gameProcess", () => ({ isProcessRunning: vi.fn(async () => false) }));
/** Restore points go to a temp file, never the real Vortex folder. */
vi.mock("./restorePoints", async (orig) => {
  const m = (await orig()) as typeof import("./restorePoints");
  const nodePath = await import("path");
  const nodeOs = await import("os");
  const file = nodePath.join(nodeOs.tmpdir(), `eh-restore-points-${process.pid}.json`);
  return {
    ...m,
    restorePointsFile: () => file,
    loadRestorePoints: () => m.loadRestorePoints(file),
    saveRestorePoint: (pt: import("./restorePoints").RestorePoint) => m.saveRestorePoint(pt, file),
  };
});
/** Never the machine's real preferences.json: askFirst is set per test. */
const prefs = vi.hoisted(() => ({ askFirst: true }));
vi.mock("../preferences", () => ({
  loadPreferences: () => ({ controlChannel: { enabled: true, askFirst: prefs.askFirst }, shownOnce: {} }),
}));
/** How "the user" answers Vortex's agent confirmation: a button, or "none" (walked away). */
const consent = vi.hoisted(() => ({ answer: "Allow" as string, asked: [] as Array<{ title: string; text: string }> }));
// plugins.txt on disk: the machine running the tests may have a real one.
const disk = vi.hoisted(() => ({ entries: undefined as undefined | Array<{ name: string; enabled: boolean }> }));
vi.mock("../installer/checkPluginOrder", () => ({ readUserPluginsTxt: vi.fn(async () => disk.entries) }));
// The archive an install looks into: a FOMOD with one question.
const HUB_XML = `<config><moduleName>Necessity</moduleName><installSteps><installStep name="Main"><optionalFileGroups><group name="Main" type="SelectExactlyOne"><plugins><plugin name="Base"><files><file source="Base.esp"/></files><typeDescriptor><type name="Optional"/></typeDescriptor></plugin><plugin name="PRP"><files><file source="PRP.esp"/></files><typeDescriptor><type name="Optional"/></typeDescriptor></plugin></plugins></group></optionalFileGroups></installStep></installSteps></config>`;
vi.mock("../manifest/sevenZip", () => ({ resolveSevenZip: () => ({}), sevenZipExtractFull: async () => ({}) }));
vi.mock("../manifest/archiveContents", () => ({
  listArchiveContents: async () => ({ entries: [{ path: "fomod/ModuleConfig.xml" }, { path: "Base.esp" }, { path: "PRP.esp" }], withCrc: 0 }),
}));
vi.mock("../manifest/runSelfChecks", () => ({ makeReadEntry: () => async () => Buffer.from(HUB_XML, "utf8") }));

import { isProcessRunning } from "./gameProcess";
import { answerFor, runVerb, setSettleWindowsForTests, VERBS } from "./verbs";

const running = isProcessRunning as unknown as ReturnType<typeof vi.fn>;

const OG = fs.mkdtempSync(path.join(os.tmpdir(), "eh-og-"));
const AE = fs.mkdtempSync(path.join(os.tmpdir(), "eh-ae-"));
fs.writeFileSync(path.join(AE, "Fallout4.exe"), "");
fs.writeFileSync(path.join(OG, "Fallout4.exe"), "");

type Api = ReturnType<typeof fakeVortex>["api"];

/** A Vortex that answers the events and actions the verbs use, and records their order. */
beforeEach(() => {
  consent.answer = "Allow";
  consent.asked = [];
  prefs.askFirst = true;
});

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
    state.session.notifications.dialogs.push({ id: d.id, type: "question", title: d.title, content: { text: d.text }, actions: [...d.actions] }); // as Vortex stores them: label strings
    return new Promise((resolve) => {
      pending.set(d.id, resolve);
      notify();
    });
  };
  const pending = new Map<string, (action: string) => void>();
  let dialogSeq = 0;
  const api = {
    getState: () => state,
    showDialog: async (_type: string, title: string, content: { text?: string }, actions: Array<{ label: string }>) => {
      const id = `dialog-${++dialogSeq}`;
      const pressed = openDialog({ id, title, text: content.text ?? "", actions: actions.map((a) => a.label) });
      if (title.startsWith("An agent wants to")) {
        consent.asked.push({ title, text: content.text ?? "" });
        if (consent.answer !== "none") setTimeout(() => api.closeDialog(id, consent.answer), 0);
      }
      return { action: await pressed, input: {} };
    },
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
        if (a.type === "STUB_SET_MOD_ATTRIBUTE") {
          const m = state.persistent.mods[a.payload.gameId][a.payload.modId];
          m.attributes = { ...(m.attributes ?? {}), [a.payload.key]: a.payload.value };
        }
        if (a.type === "STUB_SET_MOD_ENABLED") {
          state.persistent.profiles[a.payload.profileId].modState[a.payload.modId] = { enabled: a.payload.enabled };
        }
        if (a.type === "STUB_SET_NEXT_PROFILE") {
          log.push(`profile:${a.payload}`);
          state.settings.profiles.activeProfileId = a.payload;
          setTimeout(() => fire("profile-did-change", a.payload));
        }
        if (a.type === "ADD_USERLIST_RULE" || a.type === "REMOVE_USERLIST_RULE" || a.type === "SET_PLUGIN_GROUP") {
          state.userlist ??= { plugins: [], groups: [{ name: "default" }, { name: "Late Loaders" }] };
          const key = String(a.payload.pluginId).toLowerCase();
          let p = state.userlist.plugins.find((x: any) => x.name.toLowerCase() === key);
          if (p === undefined) state.userlist.plugins.push((p = { name: a.payload.pluginId }));
          if (a.type === "SET_PLUGIN_GROUP") p.group = a.payload.group;
          else {
            const list = a.payload.type === "requires" ? "req" : a.payload.type === "incompatible" ? "inc" : "after";
            p[list] = (p[list] ?? []).filter((r: string) => r.toLowerCase() !== String(a.payload.reference).toLowerCase());
            if (a.type === "ADD_USERLIST_RULE") p[list].push(a.payload.reference);
          }
        }
        if (a.type === "GAMEBRYO_SET_AUTOSORT_ENABLED") {
          state.settings.plugins = { ...(state.settings.plugins ?? {}), autoSort: a.payload };
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
    expect(r).toMatchObject({ type: "after", replaced: [], conflict: { files: 2, resolved: true }, verified: { rulesOnPair: ["after"] } });
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
    expect(r).toMatchObject({ entries: 4, unknown: ["Missing.esp"], verified: { state: "matches", order: "as given, after Vortex went quiet" } });
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

describe("plugin rules, groups, sort, autosort", () => {
  it("plugins.apply catches autosort re-sorting AFTER the apply (the live false positive)", async () => {
    v.state.settings.plugins = { autoSort: true };
    const emit = v.api.events.emit;
    v.api.events.emit = (ev: string, ...args: unknown[]) => {
      emit(ev, ...args);
      // LOOT moves C back after A, a moment later, as Vortex's autosort does.
      if (ev === "set-plugin-list") setTimeout(() => (v.state.loadOrder = { ...v.state.loadOrder, "c.esl": { ...v.state.loadOrder["c.esl"], loadOrder: 9 } }), 60);
    };
    await expect(
      run("plugins.apply", { order: [{ name: "C.esl", enabled: false }, { name: "A.esp", enabled: true }] }),
    ).rejects.toMatchObject({ code: "resorted-after-apply", details: { autoSort: true, outOfOrder: 1 } });
  });

  it("plugins.apply fails when plugins.txt on disk has them out of order", async () => {
    disk.entries = [{ name: "A.esp", enabled: true }, { name: "B.esp", enabled: true }];
    await expect(
      run("plugins.apply", { order: [{ name: "B.esp", enabled: true }, { name: "A.esp", enabled: true }] }),
    ).rejects.toMatchObject({ code: "plugins-txt-order" });
  });

  it("plugins.rule after: stored on the plugin, verified in the userlist", async () => {
    const r = (await run("plugins.rule", { name: "ArPrevisPatch.esp", type: "after", reference: "prp.esp" })) as any;
    expect(r).toMatchObject({ stored: { plugin: "ArPrevisPatch.esp", after: "prp.esp" }, verified: { inUserlist: true } });
    expect(((await run("plugins.rules", { name: "prp.esp" })) as any).plugins).toEqual([
      expect.objectContaining({ name: "ArPrevisPatch.esp", after: ["prp.esp"] }),
    ]);
  });

  it("plugins.rule before: stored the way LOOT stores it, on the other plugin", async () => {
    const r = (await run("plugins.rule", { name: "A.esp", type: "before", reference: "B.esp" })) as any;
    expect(r.stored).toEqual({ plugin: "B.esp", after: "A.esp" });
  });

  it("plugins.rule remove: gone from the userlist", async () => {
    await run("plugins.rule", { name: "A.esp", type: "after", reference: "B.esp" });
    const r = (await run("plugins.rule", { name: "A.esp", type: "after", reference: "B.esp", remove: true })) as any;
    expect(r).toMatchObject({ removed: true, verified: { inUserlist: false } });
    expect(v.state.userlist.plugins[0].after).toEqual([]);
  });

  it("plugins.rule sort: gives LOOT another sort when the first ran before the rule reached it (the live false negative)", async () => {
    let sorts = 0;
    const emit = v.api.events.emit;
    v.api.events.emit = (ev: string, ...args: unknown[]) => {
      if (ev === "autosort-plugins") {
        sorts += 1;
        // First sort: LOOT has not seen the rule yet. Second: it has.
        if (sorts >= 2) v.state.loadOrder = { ...v.state.loadOrder, "a.esp": { ...v.state.loadOrder["a.esp"], loadOrder: 9 } };
        (args[1] as (e: unknown) => void)(null);
        return;
      }
      emit(ev, ...args);
    };
    const r = (await run("plugins.rule", { name: "A.esp", type: "after", reference: "B.esp", sort: true })) as any;
    expect(r.sortedNow).toMatchObject({ ordered: true, attempts: 2 });
  });

  it("plugins.rule sort: says so after three sorts that do not honour the rule", async () => {
    v.api.events.emit = (ev: string, ...args: unknown[]) => {
      if (ev === "autosort-plugins") (args[1] as (e: unknown) => void)(null);
    };
    await expect(run("plugins.rule", { name: "A.esp", type: "after", reference: "B.esp", sort: true })).rejects.toMatchObject({
      code: "plugin-rule-not-effective",
      details: { attempts: 3 },
    });
  });

  it("plugins.rules filters by a names list too", async () => {
    await run("plugins.rule", { name: "A.esp", type: "after", reference: "B.esp" });
    await run("plugins.rule", { name: "C.esl", type: "after", reference: "Z.esp" });
    const r = (await run("plugins.rules", { names: ["z.esp"] })) as any;
    expect(r.plugins.map((p: any) => p.name)).toEqual(["C.esl"]);
  });

  it("plugins.setGroup: read back from the userlist", async () => {
    await expect(run("plugins.setGroup", { name: "A.esp", group: "Late Loaders" })).resolves.toMatchObject({
      verified: { group: "Late Loaders" },
    });
  });

  it("plugins.setAutoSort: read back, and state reports it", async () => {
    await expect(run("plugins.setAutoSort", { enabled: false })).resolves.toMatchObject({ verified: { autoSort: false } });
    expect(((await run("state")) as any).plugins).toEqual({ autoSort: false });
  });

  it("plugins.sort: fires LOOT and reports what moved", async () => {
    v.api.events.emit = (ev: string, ...args: unknown[]) => {
      if (ev === "autosort-plugins") {
        v.state.loadOrder = { ...v.state.loadOrder, "a.esp": { ...v.state.loadOrder["a.esp"], loadOrder: 5 } };
        (args[1] as (e: unknown) => void)(null);
      }
    };
    const r = (await run("plugins.sort")) as any;
    expect(r).toMatchObject({ movedCount: 1, moved: [{ name: "A.esp", from: 1, to: 5 }] });
  });

  it("mods.rules: the mod's own rules and the ones other mods hold on it", async () => {
    v.state.persistent.mods.fallout4.a.rules = [{ type: "after", reference: { id: "b" } }];
    const r = (await run("mods.rules", { id: "b" })) as any;
    expect(r.rules).toEqual([]);
    expect(r.heldByOthers).toEqual([{ from: "a", fromName: "Mod A", type: "after" }]);
  });
});

describe("nexus installs and the silent replace", () => {
  it("downloads first when unattended, and refuses when the download collides with an installed mod's name", async () => {
    v.state.persistent.downloads.files.dl9 = { localPath: "B.7z", state: "finished", game: ["fallout4"] }; // Vortex names the mod after the archive: "b"
    (v.api as any).ext = { nexusDownload: async () => "dl9" };
    await expect(run("install", { nexus: { modId: 1, fileId: 2 }, unattended: true })).rejects.toMatchObject({
      code: "would-replace-everywhere",
      details: { existing: ["b"], archiveId: "dl9" },
    });
  });
});

describe("deploy: Vortex's flag lags the callback", () => {
  it("waits for needToDeploy to clear instead of calling the deploy unverified", async () => {
    v.state.persistent.deployment = { needToDeploy: { fallout4: true } };
    setTimeout(() => (v.state.persistent.deployment.needToDeploy.fallout4 = false), 20);
    await expect(run("deploy")).resolves.toMatchObject({ verified: { deploymentNeeded: false } });
  });
});

describe("conflicts: identical files", () => {
  const stage = (a: string, b: string | undefined): void => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eh-stage-"));
    __testPaths.installPath = root;
    for (const [id, text] of [["a", a], ["b", b]] as const) {
      fs.mkdirSync(path.join(root, id, "meshes"), { recursive: true });
      if (text !== undefined) fs.writeFileSync(path.join(root, id, "meshes", "x.nif"), text);
      v.state.persistent.mods.fallout4[id].installationPath = id;
    }
    v.state.session = {
      notifications: { notifications: [], dialogs: [] },
      dependencies: { conflicts: { a: [{ otherMod: { id: "b" }, files: ["meshes/x.nif"] }] } },
    };
  };

  it("flags a pair whose contested files are byte-identical", async () => {
    stage("same bytes", "same bytes");
    const r = (await run("conflicts", { unresolvedOnly: true })) as any;
    expect(r.pairs[0]).toMatchObject({ modId: "a", otherId: "b", identical: true });
    expect(r.unresolvedDifferent).toBe(0);
    expect(r.pairs[0].allFiles).toBeUndefined();
  });

  it("says different when the bytes differ", async () => {
    stage("one", "two");
    expect(((await run("conflicts")) as any).pairs[0].identical).toBe(false);
  });

  it("leaves it unknown when a file cannot be read, never identical", async () => {
    stage("one", undefined);
    expect(((await run("conflicts")) as any).pairs[0].identical).toBeUndefined();
  });
});

describe("mods.rules with a list", () => {
  it("takes modIds like mods.setEnabled and answers per mod", async () => {
    const r = (await run("mods.rules", { modIds: ["a", "b"] })) as any;
    expect(r.mods.map((m: any) => m.id)).toEqual(["a", "b"]);
    await expect(run("mods.rules", { modIds: ["a", "zz"] })).rejects.toMatchObject({ code: "unknown-mods" });
  });
});

describe("FOMOD wizard", () => {
  /**
   * A wizard shaped the way Vortex's installer_fomod_native keeps it, answering
   * the same three events its view emits. Step 3 is invisible, so Next on step 2
   * is Finish.
   */
  const openWizard = (): void => {
    const opt = (id: number, name: string, selected = false) => ({ id, name, selected, type: "Optional" });
    const state = {
      installSteps: [
        { id: 0, name: "Main", visible: true, optionalFileGroups: { group: [{ id: 0, name: "Main", type: "SelectExactlyOne", options: [opt(0, "Base", true), opt(1, "PRP")] }] } },
        { id: 1, name: "F4SE", visible: true, optionalFileGroups: { group: [{ id: 0, name: "F4SE", type: "SelectExactlyOne", options: [opt(0, "None", true), opt(1, "OG"), opt(2, "AE")] }] } },
        { id: 2, name: "Hidden", visible: false, optionalFileGroups: { group: [] } },
      ],
      currentStep: 0,
    };
    v.state.session = {
      notifications: { notifications: [], dialogs: [] },
      fomod: { installer: { dialog: { activeInstanceId: "inst1", instances: { inst1: { info: { moduleName: "Necessity" }, state } } } } },
    };
    v.api.events.emit = (ev: string, ...args: unknown[]) => {
      const dlg = v.state.session.fomod.installer.dialog;
      const st = dlg.instances.inst1.state;
      if (ev === "fomod-installer-select-inst1") {
        const [stepId, groupId, ids] = args as [number, number, number[]];
        const step = st.installSteps.find((s: any) => s.id === stepId);
        for (const o of step.optionalFileGroups.group.find((g: any) => g.id === groupId).options) o.selected = ids.includes(o.id);
        v.state.session = { ...v.state.session }; // a new state object, as Redux makes
      }
      if (ev === "fomod-installer-continue-inst1") {
        if (args[0] === "finish") dlg.activeInstanceId = null;
        else st.currentStep += args[0] === "back" ? -1 : 1;
      }
      if (ev === "fomod-installer-cancel-inst1") dlg.activeInstanceId = null;
    };
  };

  it("reads the open wizard: module, steps, groups, options, selection", async () => {
    openWizard();
    const r = (await run("fomod")) as any;
    expect(r).toMatchObject({ open: true, moduleName: "Necessity", currentStep: 0 });
    expect(r.steps[1].groups[0].options.map((o: any) => o.name)).toEqual(["None", "OG", "AE"]);
    expect(((await run("vortex.notifications")) as any).openInstaller).toMatchObject({ moduleName: "Necessity", step: "Main" });
  });

  it("answers by name across steps and finishes on the last VISIBLE step", async () => {
    openWizard();
    const r = (await run("fomod.answer", { picks: [{ group: "Main", options: ["PRP"] }, { group: "f4se", options: ["AE"] }] })) as any;
    expect(r).toMatchObject({ moduleName: "Necessity", finished: true, verified: { selections: 2, closed: true } });
    const steps = v.state.session.fomod.installer.dialog.instances.inst1.state.installSteps;
    expect(steps[0].optionalFileGroups.group[0].options.find((o: any) => o.selected).name).toBe("PRP");
    expect(steps[1].optionalFileGroups.group[0].options.find((o: any) => o.selected).name).toBe("AE");
  });

  it("refuses a name that is not there, listing what is, without moving the wizard", async () => {
    openWizard();
    await expect(run("fomod.answer", { picks: [{ group: "Main", options: ["PRP 81"] }] })).rejects.toMatchObject({
      code: "bad-pick",
      message: expect.stringContaining('Options: "Base", "PRP"'),
    });
    expect(v.state.session.fomod.installer.dialog.instances.inst1.state.currentStep).toBe(0);
  });

  it("refuses two options in a pick-exactly-one group", async () => {
    openWizard();
    await expect(run("fomod.answer", { picks: [{ group: "Main", options: ["Base", "PRP"] }] })).rejects.toMatchObject({ code: "bad-pick" });
  });

  it("finish:false stops once the picks run out, leaving the wizard open", async () => {
    openWizard();
    const r = (await run("fomod.answer", { picks: [{ group: "Main", options: ["PRP"] }], finish: false })) as any;
    expect(r).toMatchObject({ finished: false, wizard: { currentStep: 0 } });
  });

  it("cancels the wizard", async () => {
    openWizard();
    await expect(run("fomod.cancel")).resolves.toMatchObject({ cancelled: true });
    expect(v.state.session.fomod.installer.dialog.activeInstanceId).toBeNull();
  });

  it("a command that opens a wizard reports it, so an agent knows the install waits on it", async () => {
    v.state.session = { notifications: { notifications: [], dialogs: [] }, fomod: { installer: { dialog: { activeInstanceId: null, instances: {} } } } };
    const emit = v.api.events.emit;
    v.api.events.emit = (ev: string, ...args: unknown[]) => {
      if (ev === "deploy-mods") {
        v.state.session = {
          ...v.state.session,
          fomod: { installer: { dialog: { activeInstanceId: "i9", instances: { i9: { info: { moduleName: "Patch Hub" }, state: { installSteps: [{ id: 0, name: "Patches", visible: true }], currentStep: 0 } } } } } },
        };
        (v.api.store as any).notifyForTest?.();
      }
      emit(ev, ...args);
    };
    const r = (await runVerb(v.api as any, "deploy", {})) as any;
    expect(r.vortex.openInstaller).toMatchObject({ moduleName: "Patch Hub", step: "Patches" });
  });
});

describe("install and the FOMOD question", () => {
  const withDownload = (): void => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-dl-"));
    __testPaths.downloadPath = dir;
    fs.writeFileSync(path.join(dir, "necessity.7z"), "x");
    v.state.persistent.downloads.files.nec = { localPath: "necessity.7z", state: "finished", game: ["fallout4"] };
  };

  it("refuses with needs-choices and the whole tree, instead of opening a wizard nobody told it how to answer", async () => {
    withDownload();
    const started = vi.fn();
    v.api.events.emit = (ev: string) => (ev === "start-install-download" ? started() : undefined);
    await expect(run("install", { archiveId: "nec" })).rejects.toMatchObject({
      code: "needs-choices",
      details: { archiveId: "nec", installer: { moduleName: "Necessity", steps: [{ name: "Main" }] } },
    });
    expect(started).not.toHaveBeenCalled();
  });

  it("installer.describe returns the same tree without installing", async () => {
    withDownload();
    const r = (await run("installer.describe", { archiveId: "nec" })) as any;
    expect(r.installer.steps[0].groups[0].options.map((o: any) => o.plugins)).toEqual([["Base.esp"], ["PRP.esp"]]);
  });

  it("install with picks answers the real wizard when it opens, and says what it chose", async () => {
    withDownload();
    const handlers = new Map<string, (...a: unknown[]) => void>();
    const on = v.api.events.on;
    v.api.events.on = (ev: string, fn: (...a: unknown[]) => void) => {
      handlers.set(ev, fn);
      on(ev, fn);
    };
    v.api.events.emit = (ev: string, ...args: unknown[]) => {
      if (ev === "start-install-download") {
        v.state.session = {
          notifications: { notifications: [], dialogs: [] },
          fomod: { installer: { dialog: { activeInstanceId: "w1", instances: { w1: { info: { moduleName: "Necessity" }, state: {
            currentStep: 0,
            installSteps: [{ id: 0, name: "Main", visible: true, optionalFileGroups: { group: [{ id: 0, name: "Main", type: "SelectExactlyOne",
              options: [{ id: 0, name: "Base", selected: true }, { id: 1, name: "PRP", selected: false }] }] } }],
          } } } } } },
        };
      }
      const dlg = v.state.session?.fomod?.installer?.dialog;
      if (ev === "fomod-installer-select-w1") {
        for (const o of dlg.instances.w1.state.installSteps[0].optionalFileGroups.group[0].options) o.selected = (args[2] as number[]).includes(o.id);
      }
      if (ev === "fomod-installer-continue-w1" && args[0] === "finish") {
        dlg.activeInstanceId = null;
        v.state.persistent.mods.fallout4.nec = { id: "nec", state: "installed", attributes: { name: "Necessity" } };
        setTimeout(() => handlers.get("did-install-mod")?.("fallout4", "nec", "nec"), 5);
      }
    };
    const r = (await run("install", { archiveId: "nec", picks: [{ group: "Main", options: ["PRP"] }] })) as any;
    expect(r).toMatchObject({ vortexModId: "nec", installer: { moduleName: "Necessity", finished: true } });
    expect(r.installer.applied).toEqual([{ step: "Main", group: "Main", options: ["PRP"] }]);
  });

  it("refuses picks together with recorded choices", async () => {
    await expect(run("install", { archiveId: "nec", picks: [], choices: { type: "fomod", options: [] } })).rejects.toMatchObject({ code: "bad-request" });
  });
});

describe("logs for troubleshooting", () => {
  it("lists crash and F4SE logs from the game's My Games folder, newest first, and reads one by id only", async () => {
    const docs = fs.mkdtempSync(path.join(os.tmpdir(), "eh-docs-"));
    __testPaths.documentsPath = docs;
    const se = path.join(docs, "My Games", "Fallout4", "F4SE");
    fs.mkdirSync(se, { recursive: true });
    const crashText = ['Unhandled exception "EXCEPTION_ACCESS_VIOLATION"', "PROBABLE CALL STACK:", "  [0] SomeMod.dll", ...Array(50).fill("x")];
    fs.writeFileSync(path.join(se, "crash-2026-09-26-10-00-00.log"), crashText.join("\n"));
    fs.writeFileSync(path.join(se, "f4se.log"), "plugin loaded correctly");
    const list = (await run("logs.list")) as any;
    const ids = list.logs.map((l: any) => l.id);
    expect(ids).toEqual(expect.arrayContaining(["crash:crash-2026-09-26-10-00-00.log", "extender:f4se.log"]));
    const crash = (await run("logs.read", { id: "crash:crash-2026-09-26-10-00-00.log", head: 3 })) as any;
    expect(crash.text).toContain("PROBABLE CALL STACK");
    expect(crash.returnedLines).toBe(3);
    await expect(run("logs.read", { id: "extender:../../secret.txt" })).rejects.toMatchObject({ code: "no-such-log" });
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

describe("Vortex's External Changes dialog (skyrim-collection, 2026-09-27)", () => {
  /** A deploy that stops on the dialog, as Vortex's does, and the dialog's two buttons. */
  function pauseDeployOnExternalChanges(kind = "refchange") {
    const seenAtConfirm: string[] = [];
    let held: ((e: unknown) => void) | undefined;
    v.state.session.mods = { changes: [] };
    v.state.persistent.mods.fallout4.a.installationPath = "GT Softbody-152103";
    const emit = v.api.events.emit;
    v.api.events.emit = (ev: string, ...args: unknown[]) => {
      if (ev !== "deploy-mods") return emit(ev, ...args);
      held = args[0] as (e: unknown) => void;
      v.state.session.mods.changes = [
        { modTypeId: "", filePath: "SKSE/Plugins/GTSoftbody.ini", source: "GT Softbody-152103", type: kind, action: kind === "refchange" ? "newest" : "restore" },
      ];
    };
    const reducer = v.api.store.dispatch;
    v.api.store.dispatch = (a: { type: string; payload: any }) => {
      if (a.type === "SET_EXTERNAL_CHANGE_ACTION") {
        for (const c of v.state.session.mods.changes) if (a.payload.filePaths.includes(c.filePath)) c.action = a.payload.action;
        return;
      }
      reducer(a);
    };
    const buttons: Record<string, () => void> = {
      "btn-confirm-activation": () => {
        seenAtConfirm.push(...v.state.session.mods.changes.map((c: any) => c.action));
        v.state.session.mods.changes = [];
        v.deployed.n = 9;
        setTimeout(() => held?.(null));
      },
      "btn-cancel-activation": () => {
        v.state.session.mods.changes = [];
        setTimeout(() => held?.(new Error("canceled")));
      },
    };
    (globalThis as any).document = { getElementById: (id: string) => (buttons[id] ? { click: buttons[id] } : null) };
    return { seenAtConfirm };
  }
  afterEach(() => delete (globalThis as any).document);

  it("deploy stops with external-changes and the dialog's content, instead of hanging", async () => {
    pauseDeployOnExternalChanges();
    const err = await run("deploy").catch((e) => e);
    expect(err).toMatchObject({ code: "external-changes", status: 409, details: { deployWaiting: true } });
    expect(err.details.externalChanges.mods).toEqual([
      expect.objectContaining({
        mod: "GT Softbody-152103",
        modId: "a",
        files: [expect.objectContaining({ path: "SKSE/Plugins/GTSoftbody.ini", kind: "refchange", choices: ["revert", "save", "newer"] })],
      }),
    ]);
  });

  it("state shows the dialog while it is open", async () => {
    pauseDeployOnExternalChanges();
    await run("deploy").catch(() => undefined);
    const s = (await run("state")) as any;
    expect(s.vortex.externalChanges).toMatchObject({ type: "external-changes", files: 1 });
  });

  it("answering sets Vortex's per-file action, confirms, and verifies the deploy it unblocked", async () => {
    const { seenAtConfirm } = pauseDeployOnExternalChanges();
    await run("deploy").catch(() => undefined);
    const r = await run("externalChanges.answer", { all: "save" });
    expect(seenAtConfirm).toEqual(["import"]);
    expect(r).toMatchObject({ answered: 1, deploy: "finished", deployedFiles: 9, verified: { dialogClosed: true, deploymentNeeded: false } });
  });

  it("refuses an answer Vortex does not offer for that change, and changes nothing", async () => {
    const { seenAtConfirm } = pauseDeployOnExternalChanges("deleted");
    await run("deploy").catch(() => undefined);
    await expect(run("externalChanges.answer", { all: "newer" })).rejects.toMatchObject({ code: "bad-answer" });
    expect(seenAtConfirm).toEqual([]);
    expect(v.state.session.mods.changes).toHaveLength(1);
  });

  it("cancel closes the dialog, which cancels the deploy", async () => {
    pauseDeployOnExternalChanges();
    await run("deploy").catch(() => undefined);
    await expect(run("externalChanges.answer", { cancel: true })).resolves.toMatchObject({ cancelled: true, verified: { dialogClosed: true } });
    expect(v.state.session.mods.changes).toEqual([]);
  });

  it("says so when no dialog is open", async () => {
    v.state.session.mods = { changes: [] };
    await expect(run("externalChanges.answer", { all: "newer" })).rejects.toMatchObject({ code: "no-external-changes" });
  });
});

describe("the owner's click before an agent destroys anything", () => {
  const withMods = () => {
    const v = fakeVortex();
    vi.spyOn(util, "removeMods").mockImplementation((async (_api: unknown, _game: string, ids: string[]) => {
      for (const id of ids) delete v.state.persistent.mods.fallout4[id];
    }) as never);
    return v;
  };

  it("asks in Vortex, naming every mod, and removes only after Allow", async () => {
    const v = withMods();
    const ids = Object.keys(v.state.persistent.mods.fallout4 ?? {}).slice(0, 1);
    await runVerb(v.api as never, "mods.remove", { modIds: ids });
    expect(consent.asked).toHaveLength(1);
    expect(consent.asked[0]!.title).toBe("An agent wants to remove 1 mod");
    expect(v.state.persistent.mods.fallout4[ids[0]!]).toBeUndefined();
  });

  it("changes nothing on Deny, and says so in a code the agent can read", async () => {
    consent.answer = "Deny";
    const v = withMods();
    const ids = Object.keys(v.state.persistent.mods.fallout4 ?? {}).slice(0, 1);
    await expect(runVerb(v.api as never, "mods.remove", { modIds: ids })).rejects.toMatchObject({ code: "owner-denied" });
    expect(v.state.persistent.mods.fallout4[ids[0]!]).toBeDefined();
  });

  it("gives up, closes the question and changes nothing when nobody answers", async () => {
    consent.answer = "none";
    const { setConsentTimeoutForTests } = await import("./ownerConsent");
    setConsentTimeoutForTests(50);
    try {
      const v = withMods();
      await expect(runVerb(v.api as never, "purge", {})).rejects.toMatchObject({ code: "owner-no-answer" });
      expect(v.closed.some((c) => c.action === "Deny")).toBe(true);
      expect(v.state.session.notifications.dialogs).toHaveLength(0);
    } finally {
      setConsentTimeoutForTests(10 * 60 * 1000);
    }
  });

  it("does not ask when the owner turned the question off", async () => {
    prefs.askFirst = false;
    const v = withMods();
    const ids = Object.keys(v.state.persistent.mods.fallout4 ?? {}).slice(0, 1);
    await runVerb(v.api as never, "mods.remove", { modIds: ids });
    expect(consent.asked).toHaveLength(0);
  });

  it("is never answered by the channel's own dialog watcher, whatever ifExisting says", async () => {
    consent.answer = "none";
    const { setConsentTimeoutForTests } = await import("./ownerConsent");
    setConsentTimeoutForTests(50);
    try {
      const v = withMods();
      const ids = Object.keys(v.state.persistent.mods.fallout4 ?? {}).slice(0, 1);
      await expect(runVerb(v.api as never, "mods.remove", { modIds: ids, ifExisting: "replace" })).rejects.toMatchObject({
        code: "owner-no-answer",
      });
      expect(v.closed.every((c) => c.action === "Deny")).toBe(true);
    } finally {
      setConsentTimeoutForTests(10 * 60 * 1000);
    }
  });
});

describe("restore points: one step back from what an agent changed", () => {
  it("takes one before a change and puts the enabled mods back", async () => {
    const v = fakeVortex();
    const profileId = v.state.settings.profiles.activeProfileId as string;
    const ids = Object.keys(v.state.persistent.mods.fallout4);
    const before = Object.fromEntries(ids.map((id) => [id, v.state.persistent.profiles[profileId].modState?.[id]?.enabled === true]));
    const target = ids.find((id) => before[id] === true) ?? ids[0]!;
    const r = (await runVerb(v.api as never, "mods.setEnabled", { modIds: [target], enabled: !before[target] })) as any;
    expect(r.restorePoint).toMatch(/^rp-/);
    expect(v.state.persistent.profiles[profileId].modState[target].enabled).toBe(!before[target]);

    const back = (await runVerb(v.api as never, "restore", {})) as any;
    expect(back.restoredTo.id).toBe(r.restorePoint);
    expect(v.state.persistent.profiles[profileId].modState[target]?.enabled === true).toBe(before[target]);
    expect(back.deployNeeded).toBe(true);
    // The restore took a point of its own, so it can be undone too.
    expect(back.restorePoint).toMatch(/^rp-/);
  });

  it("refuses a point from another profile rather than restoring into the wrong one", async () => {
    const v = fakeVortex();
    await runVerb(v.api as never, "mods.setEnabled", { modIds: [Object.keys(v.state.persistent.mods.fallout4)[0]!], enabled: true });
    v.state.settings.profiles.activeProfileId = "someone-else";
    await expect(runVerb(v.api as never, "restore", {})).rejects.toMatchObject({ code: "not-active-profile" });
  });
});

describe("diagnose.setup: findings an agent can act on", () => {
  const sub = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(6);
    head.write(type, 0, 4, "latin1");
    head.writeUInt16LE(data.length, 4);
    return Buffer.concat([head, data]);
  };
  const plugin = (masters: string[]): Buffer => {
    const body = Buffer.concat([sub("HEDR", Buffer.alloc(12)), ...masters.map((m) => sub("MAST", Buffer.from(`${m} `, "latin1")))]);
    const header = Buffer.alloc(24);
    header.write("TES4", 0, 4, "latin1");
    header.writeUInt32LE(body.length, 4);
    return Buffer.concat([header, body]);
  };

  it("names a disabled master, a missing one, and a master that loads too late, each with a fix", async () => {
    const v = fakeVortex();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-diag-"));
    const at = (name: string, masters: string[]): string => {
      fs.writeFileSync(path.join(dir, name), plugin(masters));
      return path.join(dir, name);
    };
    v.state.session.plugins.pluginList = {
      "fallout4.esm": { isNative: true },
      "a.esp": { filePath: at("A.esp", ["Fallout4.esm", "C.esl", "B.esp"]) },
      "b.esp": { filePath: at("B.esp", ["Fallout4.esm", "Missing.esm"]) },
      "c.esl": { filePath: at("C.esl", ["Fallout4.esm"]), modId: "c-mod" },
    };
    const r = (await runVerb(v.api as never, "diagnose.setup", {})) as any;
    const codes = r.findings.map((f: any) => `${f.code}:${f.message.split(" ")[0]}`);
    expect(codes).toEqual(expect.arrayContaining(["master-disabled:A.esp", "master-after:A.esp", "missing-master:B.esp"]));
    expect(r.findings.find((f: any) => f.code === "master-disabled").fix).toMatch(/c-mod/);
    expect(r.ok).toBe(false);
    expect(r.plugins).toMatchObject({ active: 3, full: 3, light: 0 });
    // Errors come first.
    expect(r.findings[0].severity).toBe("error");
  });
});

describe("mods.rename (Fallout-collection, Ivy Rev 13)", () => {
  it("sets Vortex's customFileName and reads it back", async () => {
    const r = (await run("mods.rename", { id: "a", name: "  Servitron 1.1.0 " })) as any;
    expect(v.state.persistent.mods.fallout4.a.attributes.customFileName).toBe("Servitron 1.1.0");
    expect(r).toMatchObject({ id: "a", previousName: "Mod A", name: "Servitron 1.1.0" });
  });

  it("clears the name with an empty string", async () => {
    await run("mods.rename", { id: "a", name: "Servitron 1.1.0" });
    const r = (await run("mods.rename", { id: "a", name: "" })) as any;
    expect(v.state.persistent.mods.fallout4.a.attributes.customFileName).toBeUndefined();
    expect(r.name).toBe("Mod A");
  });

  it("refuses an unknown id and a missing name", async () => {
    await expect(run("mods.rename", { id: "nope", name: "X" })).rejects.toMatchObject({ code: "unknown-mods" });
    await expect(run("mods.rename", { id: "a" })).rejects.toMatchObject({ code: "bad-request" });
  });

  it("says so when Vortex does not apply it", async () => {
    const dispatch = v.api.store.dispatch;
    v.api.store.dispatch = (a: any) => (a.type === "STUB_SET_MOD_ATTRIBUTE" ? undefined : dispatch(a));
    await expect(run("mods.rename", { id: "a", name: "X" })).rejects.toMatchObject({ code: "not-applied" });
  });
});

describe("mods.updates", () => {
  it("lists only mods with a pending update, the way Vortex's filter decides, scoped to the active profile", async () => {
    const v = fakeVortex();
    const mods = v.state.persistent.mods.fallout4;
    mods.a.attributes = { ...mods.a.attributes, source: "nexus", newestFileId: 99, newestVersion: "1.1", logicalFileName: "Mod A Main", newestChangelog: { format: "html", content: "<p>Fixes</p>" } };
    mods.c = { id: "c", state: "installed", attributes: { name: "Mod C", version: "2.0", modId: 5, fileId: 6, newestFileId: 6, newestVersion: "2.0" } };
    mods.d = { id: "d", state: "installed", attributes: { name: "Mod D", version: "1", modId: 7, fileId: 8, newestFileId: "unknown" } };
    v.state.persistent.profiles.og.modState = { a: { enabled: true }, c: { enabled: true } };

    const r = (await runVerb(v.api as never, "mods.updates", {})) as any;
    expect(r.mods.map((m: any) => m.id)).toEqual(["a"]);
    expect(r.mods[0]).toMatchObject({ version: "1.0", newestVersion: "1.1", fileId: 34, newestFileId: 99, logicalFileName: "Mod A Main", changelog: "<p>Fixes</p>" });

    const everything = (await runVerb(v.api as never, "mods.updates", { all: true })) as any;
    expect(everything.mods.map((m: any) => m.id)).toEqual(["a", "d"]);
    expect(everything.mods[1].newestFileId).toBe("unknown");
  });

  it("runs Vortex's own update check first when asked to refresh", async () => {
    const v = fakeVortex();
    const asked: unknown[][] = [];
    (v.api as any).emitAndAwait = async (...args: unknown[]) => {
      asked.push(args);
      return [];
    };
    const r = (await runVerb(v.api as never, "mods.updates", { refresh: true })) as any;
    expect(asked.map((a) => a[0])).toEqual(["check-mods-version"]);
    expect(asked[0]![1]).toBe("fallout4");
    expect(r.refreshed).toBe(true);
  });
});
