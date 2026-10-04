/**
 * Claude Desktop from the Microsoft Store reads its config from inside its
 * package folder (MSIX), which shadows %APPDATA%\Claude. 2026-10-04: a player
 * pressed "Add Event Horizon to Claude Desktop", restarted, and Claude saw
 * nothing.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";

import { addToClaudeDesktop, claudeDesktopConfigPaths } from "./controlService";

const saved = { APPDATA: process.env["APPDATA"], LOCALAPPDATA: process.env["LOCALAPPDATA"] };
afterEach(() => {
  process.env["APPDATA"] = saved.APPDATA;
  process.env["LOCALAPPDATA"] = saved.LOCALAPPDATA;
});

const sandbox = (withStore: boolean): { roaming: string; store: string } => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eh-desktop-"));
  process.env["APPDATA"] = path.join(root, "Roaming");
  process.env["LOCALAPPDATA"] = path.join(root, "Local");
  fs.mkdirSync(path.join(root, "Local", "Packages", "SomethingElse_123"), { recursive: true });
  if (withStore) fs.mkdirSync(path.join(root, "Local", "Packages", "Claude_pzs8sxrjxfjjc"), { recursive: true });
  return {
    roaming: path.join(root, "Roaming", "Claude", "claude_desktop_config.json"),
    store: path.join(root, "Local", "Packages", "Claude_pzs8sxrjxfjjc", "LocalCache", "Roaming", "Claude", "claude_desktop_config.json"),
  };
};

describe("where Claude Desktop reads its config", () => {
  it("is only %APPDATA%\Claude for the regular installer", () => {
    const p = sandbox(false);
    expect(claudeDesktopConfigPaths()).toEqual([p.roaming]);
  });

  it("includes the Store package's own folder when that build is installed, and writes both", () => {
    const p = sandbox(true);
    expect(claudeDesktopConfigPaths()).toEqual([p.roaming, p.store]);
    // The Store build already has its own config with another server in it.
    fs.mkdirSync(path.dirname(p.store), { recursive: true });
    fs.writeFileSync(p.store, JSON.stringify({ mcpServers: { other: { command: "x" } } }));
    const r = addToClaudeDesktop();
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/Microsoft Store/);
    for (const f of [p.roaming, p.store]) {
      expect(Object.keys(JSON.parse(fs.readFileSync(f, "utf8")).mcpServers)).toContain("event-horizon");
    }
    expect(Object.keys(JSON.parse(fs.readFileSync(p.store, "utf8")).mcpServers)).toContain("other");
  });
});
