/**
 * The snapshot is hand-streamed JSON over hundreds of thousands of rows, so the
 * first property is that it PARSES. The second is that it carries what a remote
 * diagnosis needs — verdicts first, every file with size and mtime, hashes for
 * the files whose bytes decide behaviour — and the third is that a hard-linked
 * file (Vortex's normal deployment) is hashed once, not once per link.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hashCalls = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("../archiveHashing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../archiveHashing")>();
  return {
    ...actual,
    hashFileSha256: (p: string, signal?: AbortSignal) => {
      hashCalls.paths.push(p);
      return actual.hashFileSha256(p, signal);
    },
  };
});

import { __testPaths } from "@nexusmods/vortex-api";

import { writeEnvironmentSnapshot } from "./snapshot";

let tmp: string;
let game: string;
let staging: string;
const originalLocal = process.env["LOCALAPPDATA"];
const originalDocs = __testPaths.documentsPath;
const originalInstall = __testPaths.installPath;

const write = (full: string, content: string | Buffer = "x"): void => {
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
};

beforeEach(() => {
  hashCalls.paths = [];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "eh-snapshot-"));
  game = path.join(tmp, "Fallout 4");
  staging = path.join(tmp, "staging");
  process.env["LOCALAPPDATA"] = path.join(tmp, "Local");
  __testPaths.documentsPath = path.join(tmp, "Documents");
  __testPaths.installPath = staging;

  write(path.join(game, "goggame-galaxyFileList.ini"), "[1998527297]\nF1=Fallout4.exe\n");
  write(path.join(game, "Fallout4.exe"), "EXE");
  write(path.join(game, "readme.txt"), "not hashed");
  write(path.join(staging, "ModA", "F4SE", "Plugins", "mod.dll"), "DLL BYTES");
  fs.mkdirSync(path.join(game, "Data", "F4SE", "Plugins"), { recursive: true });
  fs.linkSync(path.join(staging, "ModA", "F4SE", "Plugins", "mod.dll"), path.join(game, "Data", "F4SE", "Plugins", "mod.dll"));
  write(path.join(staging, "ModB", "plugin.esp"), "TES4");
  write(path.join(game, "Data", "leftover.esp"), "OLD");
  write(path.join(tmp, "Local", "Fallout4", "plugins.txt"), "*Fallout4.esm\r\n*plugin.esp\r\n");
  write(path.join(tmp, "Documents", "My Games", "Fallout4", "Fallout4Prefs.ini"), "[Display]\r\niSize W=1920\r\n");
});
afterEach(() => {
  if (originalLocal === undefined) delete process.env["LOCALAPPDATA"];
  else process.env["LOCALAPPDATA"] = originalLocal;
  __testPaths.documentsPath = originalDocs;
  __testPaths.installPath = originalInstall;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const api = () =>
  ({
    getState: () => ({
      settings: {
        profiles: { activeGameId: "fallout4", activeProfileId: "p1" },
        gameMode: { discovered: { fallout4: { path: game, store: "steam" } } },
      },
      session: { gameMode: { known: [{ id: "fallout4", name: "Fallout 4", executable: "Fallout4.exe" }] } },
      persistent: { profiles: { p1: { name: "Ivy", gameId: "fallout4" } }, mods: { fallout4: { a: {}, b: {} } } },
    }),
  }) as never;

describe("writeEnvironmentSnapshot", () => {
  it("writes valid JSON with verdicts, texts, and every file of the game and staging folders", async () => {
    const filePath = path.join(tmp, "snapshot.json");
    const result = await writeEnvironmentSnapshot({ api: api(), gameId: "fallout4", filePath, extensionVersion: "test" });
    const snap = JSON.parse(fs.readFileSync(filePath, "utf8"));

    expect(snap.schema).toBe("event-horizon.snapshot/1");
    expect(snap.summary.gameDir).toBe(game);
    expect(snap.summary.verdicts.map((v: { id: string }) => v.id)).toContain("game-folder");
    expect(snap.summary.unmanagedFiles).toBe(2); // leftover.esp and the hard-linked dll: nothing deployed it per a manifest
    expect(snap.vortex.modsInPool).toBe(2);
    expect(snap.texts[path.join(tmp, "Local", "Fallout4", "plugins.txt")]).toMatch(/plugin\.esp/);

    const game_ = new Map<string, unknown[]>(snap.gameFiles.map((r: unknown[]) => [r[0] as string, r]));
    expect(game_.get("Fallout4.exe")?.[1]).toBe(3);
    expect(typeof game_.get("Fallout4.exe")?.[3]).toBe("string");
    expect(game_.get("readme.txt")?.[3]).toBeNull();
    const staging_ = new Map<string, unknown[]>(snap.stagingFiles.map((r: unknown[]) => [r[0] as string, r]));
    expect(staging_.get("ModB/plugin.esp")?.[3]).toMatch(/^[0-9a-f]{64}$/);

    // Same inode, same hash, and hashed once.
    expect(staging_.get("ModA/F4SE/Plugins/mod.dll")?.[3]).toBe(game_.get("Data/F4SE/Plugins/mod.dll")?.[3]);
    expect(hashCalls.paths.filter((p) => p.endsWith("mod.dll"))).toHaveLength(1);

    expect(result.gameFiles).toBe(snap.gameFiles.length);
    expect(result.stagingFiles).toBe(2);
  });

  it("stops when cancelled, and still leaves a closed file behind", async () => {
    const filePath = path.join(tmp, "cancelled.json");
    const controller = new AbortController();
    const pending = writeEnvironmentSnapshot({
      api: api(),
      gameId: "fallout4",
      filePath,
      extensionVersion: "test",
      signal: controller.signal,
      onProgress: (p) => {
        if (p.phase === "game-files") controller.abort();
      },
    });
    await expect(pending).rejects.toThrow(/cancelled/i);
  });
});
