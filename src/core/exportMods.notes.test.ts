import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterAll, describe, expect, it } from "vitest";

import type { AuditorMod } from "./getModsListForProfile";
import { exportModsToJsonFile } from "./exportMods";
import { compareMods } from "../utils/utils";

const mod = (id: string, over: Partial<AuditorMod> = {}): AuditorMod =>
  ({
    id,
    name: id,
    enabled: true,
    modType: "",
    installOrder: 0,
    hasInstallerChoices: false,
    hasDetailedInstallerChoices: false,
    fileOverrides: [],
    enabledINITweaks: [],
    ...over,
  }) as AuditorMod;

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
});

describe("export keeps private curator notes on the machine", () => {
  it("drops a private note and keeps a note marked @users, in every list of the file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "eh-export-notes-"));
    dirs.push(dir);
    const file = await exportModsToJsonFile({
      mods: [
        mod("private", { curatorNote: "conflicts with my own tweak, do not ship" }),
        mod("public", { curatorNote: "@users Open its MCM once", enabled: false }),
        mod("none"),
      ],
      gameId: "skyrimse",
      profileId: "p1",
      outputDir: dir,
    });
    const text = await fs.readFile(file, "utf8");
    expect(text).not.toContain("do not ship");
    const json = JSON.parse(text) as { mods: AuditorMod[]; enabledMods: AuditorMod[]; disabledMods: AuditorMod[] };
    const byId = new Map(json.mods.map((m) => [m.id, m]));
    expect(byId.get("private")).not.toHaveProperty("curatorNote");
    expect(byId.get("public")!.curatorNote).toBe("@users Open its MCM once");
    expect(json.enabledMods.find((m) => m.id === "private")).not.toHaveProperty("curatorNote");
    expect(json.disabledMods.find((m) => m.id === "public")!.curatorNote).toBe("@users Open its MCM once");
  });

  it("does not report a note edit as a change to the mod", () => {
    // Pinned: the snapshot diff compares a fixed field list without notes.
    const before = mod("a", { version: "1.0", curatorNote: "old" });
    const after = mod("a", { version: "1.0", curatorNote: "@users new" });
    expect(compareMods(before, after)).toEqual([]);
  });
});
