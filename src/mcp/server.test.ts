import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";

import { startControlServer, type ControlServer } from "../core/control/controlServer";
import { VERBS } from "../core/control/verbs";
import { handle } from "./server";
import { TOOLS } from "./tools";

let server: ControlServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const tmp = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "eh-mcp-")), "control.json");
const call = async (file: string, name: string, args: Record<string, unknown> = {}) =>
  JSON.parse((await handle(file, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } }))!).result;

describe("the tool table", () => {
  it("maps every tool to a real control channel verb (or the op log)", () => {
    const known = new Set([...Object.keys(VERBS), "ops.get", "ops.list"]);
    expect(TOOLS.filter((t) => !known.has(t.verb)).map((t) => t.verb)).toEqual([]);
  });

  it("uses names MCP accepts, once each, and marks the right tools as changes", () => {
    for (const t of TOOLS) expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
    for (const t of TOOLS) if (VERBS[t.verb] !== undefined) expect(t.mutates).toBe(VERBS[t.verb]!.mutates);
  });
});

describe("MCP protocol", () => {
  it("initializes with the safety guide as instructions", async () => {
    const r = JSON.parse((await handle("unused", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }))!);
    expect(r.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "event-horizon" } });
    expect(r.result.instructions).toMatch(/Call state first/);
  });

  it("lists every tool with an object schema", async () => {
    const r = JSON.parse((await handle("unused", { jsonrpc: "2.0", id: 2, method: "tools/list" }))!);
    expect(r.result.tools).toHaveLength(TOOLS.length);
    expect(r.result.tools.find((t: any) => t.name === "install").inputSchema).toMatchObject({ type: "object" });
  });

  it("answers nothing to a notification, and method-not-found to an unknown method", async () => {
    expect(await handle("unused", { jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
    expect(JSON.parse((await handle("unused", { jsonrpc: "2.0", id: 3, method: "resources/list" }))!).error.code).toBe(-32601);
  });

  it("tells the AI what to ask the user when Vortex is closed or the channel is off", async () => {
    const r = await call(path.join(os.tmpdir(), "no-such-dir", "control.json"), "state");
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Turn on/);
  });
});

describe("through a real control channel", () => {
  it("reads directly, and follows a change through the op log to its verified end", async () => {
    const file = tmp();
    let release!: () => void;
    server = await startControlServer({
      infoFile: file,
      version: "test",
      verbs: {
        state: { mutates: false, run: async () => ({ gameId: "fallout4" }) },
        deploy: { mutates: true, run: () => new Promise((r) => (release = () => r({ deployedFiles: 9, verified: {} }))) },
      },
    });
    expect((await call(file, "state")).content[0].text).toContain("fallout4");

    const pending = handle(file, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "deploy", arguments: {} } });
    await new Promise((r) => setTimeout(r, 50));
    release();
    const done = JSON.parse((await pending)!).result;
    expect(done.isError).toBe(false);
    expect(JSON.parse(done.content[0].text)).toMatchObject({ status: "succeeded", ok: true, result: { deployedFiles: 9 } });
  });

  it("marks a refused change as an error, with the channel's code and message", async () => {
    const file = tmp();
    server = await startControlServer({
      infoFile: file,
      version: "test",
      verbs: {
        purge: {
          mutates: true,
          run: async () => {
            throw Object.assign(new Error("Fallout4.exe is running."), { code: "game-running", status: 409 });
          },
        },
      },
    });
    const r = await call(file, "purge");
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text)).toMatchObject({ status: "failed", code: "game-running" });
  });
});
