/**
 * "Connect your AI": the on-ramp for someone who has never touched a config
 * file. One button sets up Claude Desktop; Claude Code gets one command to
 * paste; any other MCP app gets the raw setup.
 *
 * The point of the whole feature (owner, 2026-09-27): a newcomer says what
 * they want in plain words and the AI does it in Vortex, troubleshooting
 * included. So the card ends with things to ask, not with protocol.
 */

import * as React from "react";

import { Button, Callout, Card } from "../../components";
import { writeToClipboard } from "../../clipboard";
import { addToClaudeDesktop, connectorLaunch } from "../../../core/control/controlService";
import { claudeCodeCommand, desktopConfigSnippet } from "../../../core/control/connectConfig";

const ASK = [
  "“Install the Unofficial Fallout 4 Patch and pick the right options for my setup.”",
  "“My game crashes when I load a save. Find out why and fix it.”",
  "“Why is this mod not showing up in game?”",
  "“Make this texture mod win over the other one.”",
  "“Turn off every mod that changes the body, I want to test without them.”",
];

export function ConnectCard(props: { enabled: boolean }): JSX.Element {
  const launch = React.useMemo(() => connectorLaunch(), []);
  const command = claudeCodeCommand(launch);
  const snippet = desktopConfigSnippet(launch);
  const [desktop, setDesktop] = React.useState<{ ok: boolean; message: string } | undefined>();
  const [copied, setCopied] = React.useState<string | undefined>();
  const [showRaw, setShowRaw] = React.useState(false);

  const copy = async (what: string, text: string): Promise<void> => {
    if (await writeToClipboard(text)) setCopied(what);
  };

  return (
    <Card
      title="Connect your AI"
      subtitle="Once connected, just tell it what you want in plain words. It installs, answers installers, fixes load order and conflicts, and reads crash logs, right here in Vortex."
    >
      <div className="eh-stack eh-stack--lg">
        {!props.enabled && (
          <Callout tone="info" title="Turn on agent control first">
            The AI can only reach Vortex while agent control (above) is on.
          </Callout>
        )}

        <div className="eh-stack eh-stack--sm">
          <h4>Claude Desktop</h4>
          <div className="eh-row">
            <Button intent="primary" onClick={(): void => setDesktop(addToClaudeDesktop())}>
              Add Event Horizon to Claude Desktop
            </Button>
          </div>
          {desktop !== undefined && (
            <Callout tone={desktop.ok ? "success" : "warning"} title={desktop.ok ? "Done" : "Not changed"}>
              {desktop.message}
            </Callout>
          )}
        </div>

        <div className="eh-stack eh-stack--sm">
          <h4>Claude Code</h4>
          <span className="eh-small eh-muted">Paste this once in a terminal:</span>
          <code className="eh-mono eh-agent-code">{command}</code>
          <div className="eh-row">
            <Button intent="ghost" size="sm" onClick={(): void => void copy("command", command)}>
              {copied === "command" ? "Copied" : "Copy command"}
            </Button>
            <Button intent="ghost" size="sm" onClick={(): void => setShowRaw(!showRaw)}>
              {showRaw ? "Hide setup for other apps" : "Other MCP apps"}
            </Button>
          </div>
          {showRaw && (
            <div className="eh-stack eh-stack--sm">
              <code className="eh-mono eh-agent-code">{snippet}</code>
              <div className="eh-row">
                <Button intent="ghost" size="sm" onClick={(): void => void copy("snippet", snippet)}>
                  {copied === "snippet" ? "Copied" : "Copy setup"}
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="eh-stack eh-stack--sm">
          <h4>Then just ask</h4>
          {ASK.map((a) => (
            <p key={a} className="eh-small eh-agent-ask">
              {a}
            </p>
          ))}
          <p className="eh-small eh-muted">
            Every change it makes shows in the live activity below, with what Event Horizon checked. It asks before removing
            anything, and it never touches the game while the game is running.
          </p>
        </div>
      </div>
    </Card>
  );
}
