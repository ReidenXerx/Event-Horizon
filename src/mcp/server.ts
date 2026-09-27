/**
 * Event Horizon's MCP connector: lets an AI assistant (Claude Desktop, Claude
 * Code, any MCP client) drive Vortex through Event Horizon's control channel.
 *
 * Runs OUTSIDE Vortex, as its own small process the AI client starts. It needs
 * no Node.js install: the client runs it with Vortex's own executable and
 * ELECTRON_RUN_AS_NODE=1, and it uses nothing but Node's built-ins.
 *
 *   Vortex.exe <this file> --control "<Vortex userData>\event-horizon\control.json"
 *
 * Protocol: MCP over stdio, one JSON-RPC 2.0 message per line. stdout carries
 * protocol only; anything else goes to stderr.
 */

import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";

import { GUIDE, TOOLS, type ToolSpec } from "./tools";

type Json = Record<string, unknown>;
type Control = { port: number; token: string };

export const VERSION = "1";
const WAIT_MS = 30 * 60 * 1000;

function controlFile(argv: readonly string[]): string {
  const i = argv.indexOf("--control");
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1]!;
  const appData = process.env["APPDATA"] ?? path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appData, "Vortex", "event-horizon", "control.json");
}

export class ChannelClosed extends Error {}

function readControl(file: string): Control {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new ChannelClosed(
      "Event Horizon's agent control is off, or Vortex is not running. Ask the user to open Vortex, go to Event Horizon → Agents, and click Turn on.",
    );
  }
  const c = JSON.parse(raw) as { port?: unknown; token?: unknown };
  if (typeof c.port !== "number" || typeof c.token !== "string") throw new ChannelClosed(`control.json is not readable: ${file}`);
  return { port: c.port, token: c.token };
}

/** One request to the control channel. The token and port are re-read every call: they change on each Vortex start. */
export function callChannel(file: string, verb: string, body: Json): Promise<Json> {
  const c = readControl(file);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: c.port,
        method: "POST",
        path: `/v1/${verb}`,
        headers: { authorization: `Bearer ${c.token}`, "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (d: string) => (text += d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(text) as Json);
          } catch {
            reject(new Error(`Event Horizon answered HTTP ${res.statusCode ?? "?"} with no JSON.`));
          }
        });
      },
    );
    req.on("error", (err: NodeJS.ErrnoException) =>
      reject(
        err.code === "ECONNREFUSED"
          ? new ChannelClosed("Vortex is not running (or its agent control was turned off). Ask the user to start Vortex.")
          : err,
      ),
    );
    req.write(payload);
    req.end();
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Runs a tool. A change is sent async and followed through the op log, so a
 * long install is one tool call however long it takes, and a dropped
 * connection loses nothing.
 */
export async function runTool(file: string, tool: ToolSpec, args: Json, pollMs = 1000): Promise<Json> {
  if (!tool.mutates) return callChannel(file, tool.verb, args);
  const accepted = await callChannel(file, tool.verb, { ...args, async: true });
  const opId = accepted["opId"];
  if (typeof opId !== "string" || accepted["status"] === "succeeded" || accepted["status"] === "failed") return accepted;
  for (let waited = 0; waited < WAIT_MS; waited += pollMs) {
    await sleep(pollMs);
    const r = await callChannel(file, "ops.get", { opId });
    const op = (r["result"] ?? {}) as Json;
    if (op["status"] === "succeeded" || op["status"] === "failed") return op;
  }
  return { ok: false, opId, status: "running", message: `Still running after ${WAIT_MS / 60000} minutes; check it later with operation {opId}.` };
}

function reply(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}
function error(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

/** One JSON-RPC message in, one reply line out (or none, for a notification). */
export async function handle(file: string, msg: Json): Promise<string | undefined> {
  const id = msg["id"];
  const method = String(msg["method"] ?? "");
  const params = (msg["params"] ?? {}) as Json;
  if (id === undefined || id === null) return undefined; // notifications (initialized, cancelled): nothing to answer
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: typeof params["protocolVersion"] === "string" ? params["protocolVersion"] : "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "event-horizon", title: "Event Horizon (Vortex)", version: VERSION },
        instructions: GUIDE,
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: { type: "object", properties: t.properties, ...(t.required !== undefined ? { required: t.required } : {}) },
        })),
      });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params["name"]);
      if (tool === undefined) return error(id, -32602, `Unknown tool ${String(params["name"])}.`);
      try {
        const out = await runTool(file, tool, (params["arguments"] ?? {}) as Json);
        return reply(id, { content: [{ type: "text", text: JSON.stringify(out, null, 1) }], isError: out["ok"] === false });
      } catch (err) {
        return reply(id, { content: [{ type: "text", text: String((err as Error)?.message ?? err) }], isError: true });
      }
    }
    default:
      return error(id, -32601, `Method not found: ${method}`);
  }
}

/** The stdio loop. Not run on import, so tests can drive handle() directly. */
export function main(argv: readonly string[] = process.argv): void {
  const file = controlFile(argv);
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (line.trim() === "") return;
    let msg: Json;
    try {
      msg = JSON.parse(line) as Json;
    } catch {
      process.stdout.write(`${error(null, -32700, "Parse error")}\n`);
      return;
    }
    void handle(file, msg).then((out) => {
      if (out !== undefined) process.stdout.write(`${out}\n`);
    });
  });
  process.stderr.write(`event-horizon MCP connector ready (control: ${file})\n`);
}

if (require.main === module) main();
