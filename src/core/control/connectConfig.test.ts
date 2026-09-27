import { describe, expect, it } from "vitest";

import { claudeCodeCommand, desktopConfigSnippet, mcpLaunch, mergeDesktopConfig } from "./connectConfig";

const L = mcpLaunch({
  vortexExe: "C:\\Program Files\\Vortex\\Vortex.exe",
  serverJs: "C:\\Users\\u\\AppData\\Roaming\\Vortex\\plugins\\vortex-event-horizon\\dist\\mcp\\server.js",
  controlFile: "C:\\Users\\u\\AppData\\Roaming\\Vortex\\event-horizon\\control.json",
});

describe("connect config", () => {
  it("runs the connector on Vortex's own executable as Node", () => {
    expect(L).toEqual({
      command: "C:\\Program Files\\Vortex\\Vortex.exe",
      args: [expect.stringMatching(/server\.js$/), "--control", expect.stringMatching(/control\.json$/)],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
  });

  it("writes a Claude Code command with the name BEFORE the variadic --env, and every path quoted", () => {
    expect(claudeCodeCommand(L)).toBe(
      'claude mcp add --scope user event-horizon --env ELECTRON_RUN_AS_NODE=1 -- "C:\\Program Files\\Vortex\\Vortex.exe" ' +
        '"C:\\Users\\u\\AppData\\Roaming\\Vortex\\plugins\\vortex-event-horizon\\dist\\mcp\\server.js" "--control" ' +
        '"C:\\Users\\u\\AppData\\Roaming\\Vortex\\event-horizon\\control.json"',
    );
  });

  it("gives a paste-able Claude Desktop snippet", () => {
    expect(JSON.parse(desktopConfigSnippet(L))).toEqual({ mcpServers: { "event-horizon": L } });
  });

  it("adds itself to an existing config and keeps everything else", () => {
    const before = JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } });
    const r = mergeDesktopConfig(before, L);
    expect(r.ok).toBe(true);
    expect(JSON.parse((r as { text: string }).text)).toEqual({ theme: "dark", mcpServers: { other: { command: "x" }, "event-horizon": L } });
  });

  it("creates the config when there is none", () => {
    const r = mergeDesktopConfig(undefined, L);
    expect(JSON.parse((r as { text: string }).text)).toEqual({ mcpServers: { "event-horizon": L } });
  });

  it("never touches a config it cannot read", () => {
    expect(mergeDesktopConfig("{ not json", L)).toMatchObject({ ok: false });
    expect(mergeDesktopConfig("[1,2]", L)).toMatchObject({ ok: false });
    expect(mergeDesktopConfig('{"mcpServers": []}', L)).toMatchObject({ ok: false });
  });
});
