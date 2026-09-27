/**
 * How an AI client starts Event Horizon's MCP connector, and the setup text a
 * newcomer can paste or have written for them.
 *
 * The connector runs on Vortex's own executable as plain Node
 * (ELECTRON_RUN_AS_NODE=1), so nobody has to install Node.js to use it.
 */

export type McpLaunch = { command: string; args: string[]; env: Record<string, string> };

export const SERVER_NAME = "event-horizon";

export function mcpLaunch(p: { vortexExe: string; serverJs: string; controlFile: string }): McpLaunch {
  return { command: p.vortexExe, args: [p.serverJs, "--control", p.controlFile], env: { ELECTRON_RUN_AS_NODE: "1" } };
}

const quote = (s: string): string => `"${s.replace(/"/g, '\\"')}"`;

/**
 * The one-line Claude Code setup command. The server name comes BEFORE
 * --env: the CLI takes --env as variadic, so a name after it is read as one
 * more KEY=value and the command fails ("Invalid environment variable
 * format: event-horizon"). Measured on the live CLI, 2026-09-27.
 */
export function claudeCodeCommand(l: McpLaunch): string {
  const env = Object.entries(l.env).map(([k, v]) => `--env ${k}=${v}`);
  return ["claude mcp add --scope user", SERVER_NAME, ...env, "--", quote(l.command), ...l.args.map(quote)].join(" ");
}

/** The `mcpServers` entry, as it appears in Claude Desktop's config file. */
export function desktopConfigSnippet(l: McpLaunch): string {
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: l } }, null, 2);
}

/**
 * Adds (or updates) Event Horizon in an existing Claude Desktop config.
 * Everything else in the file is kept. A file that is not a JSON object is
 * NOT touched: overwriting someone's other servers to add ours would be the
 * worst possible first impression.
 */
export function mergeDesktopConfig(existing: string | undefined, l: McpLaunch): { ok: true; text: string } | { ok: false; reason: string } {
  let doc: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim() !== "") {
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ok: false, reason: "Claude Desktop's config file is not a JSON object, so it was left alone." };
      }
      doc = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, reason: "Claude Desktop's config file could not be read as JSON, so it was left alone." };
    }
  }
  const servers = doc["mcpServers"];
  if (servers !== undefined && (servers === null || typeof servers !== "object" || Array.isArray(servers))) {
    return { ok: false, reason: 'Claude Desktop\'s config has an unexpected "mcpServers" value, so it was left alone.' };
  }
  const next = { ...doc, mcpServers: { ...((servers as Record<string, unknown> | undefined) ?? {}), [SERVER_NAME]: l } };
  return { ok: true, text: `${JSON.stringify(next, null, 2)}\n` };
}
