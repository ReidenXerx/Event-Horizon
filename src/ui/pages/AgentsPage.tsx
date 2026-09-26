/**
 * Agents — the switch for the local control channel, and what it lets an
 * agent do.
 *
 * Owner poll, 2026-09-26: off by default, but visible and easy to reach,
 * which is why it is a page in the nav rather than a hidden setting.
 */

import * as React from "react";

import { Button, Callout, Card, Page, Pill } from "../components";
import { writeToClipboard } from "../clipboard";
import { useApi } from "../state";
import {
  getControlStatus,
  onControlStatus,
  setControlChannelEnabled,
  type ControlStatus,
} from "../../core/control/controlService";

type VerbRow = { verb: string; what: string };

const VERBS: VerbRow[] = [
  { verb: "state", what: "Read the active game, its folder and store, profiles, mods, plugins, downloads and deployment." },
  { verb: "deploy", what: "Deploy the active profile and wait for Vortex to finish." },
  { verb: "purge", what: "Remove every deployed file from the game folder." },
  { verb: "mods.setEnabled", what: "Enable or disable mods by exact id." },
  { verb: "mods.remove", what: "Uninstall mods by exact id. The reply says which ones Event Horizon installed." },
  { verb: "profile.switch", what: "Switch to another profile." },
  { verb: "game.setPath", what: "Point the game at another install folder (only when nothing is deployed)." },
  { verb: "game.switchInstall", what: "Purge, repoint, switch profile and deploy, in that order." },
  { verb: "install", what: "Install a Nexus file or an existing download, with optional FOMOD choices." },
];

const GUARDS = [
  "Listens on this PC only (127.0.0.1), and only with the token in control.json, which changes every time Vortex starts.",
  "Refuses anything sent from a web browser.",
  "Never deploys, purges, removes or repoints while the game is running.",
  "Will not move a game folder that still has mods deployed into it.",
  "Runs one command at a time, and every change shows a notification here.",
];

export function AgentsPage(): JSX.Element {
  const api = useApi();
  const [status, setStatus] = React.useState<ControlStatus>(() => getControlStatus());
  const [busy, setBusy] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => onControlStatus(setStatus), []);

  const toggle = async (): Promise<void> => {
    setBusy(true);
    try {
      setStatus(await setControlChannelEnabled(api, !status.enabled));
    } finally {
      setBusy(false);
    }
  };

  const copyPath = async (): Promise<void> => {
    setCopied(await writeToClipboard(status.infoFile));
  };

  const state = status.running ? "running" : status.enabled ? "starting" : "off";

  return (
    <Page>
      <div className="eh-stack eh-stack--xl">
        <Card
          title="Agent control"
          subtitle="Let AI assistants you run on this PC (Claude Code and similar) drive Vortex for you: deploy, purge, switch profiles, install, enable and remove mods."
          actions={
            <Pill intent={status.running ? "success" : status.enabled ? "warning" : "info"} withDot>
              {state === "running" ? `On · port ${String(status.port)}` : state === "starting" ? "Starting" : "Off"}
            </Pill>
          }
        >
          <div className="eh-stack">
            {status.error !== undefined && (
              <Callout tone="danger" title="The control channel could not start">
                {status.error}
              </Callout>
            )}
            <div className="eh-row">
              <Button intent={status.enabled ? "ghost" : "primary"} busy={busy} onClick={(): void => void toggle()}>
                {status.enabled ? "Turn off" : "Turn on"}
              </Button>
              <span className="eh-muted">
                {status.enabled
                  ? "Agents can connect while Vortex is open."
                  : "Nothing is listening. Turn it on only if you use an agent that needs it."}
              </span>
            </div>
            <div className="eh-stack eh-stack--sm">
              <span className="eh-small eh-muted">Agents find the port and token in</span>
              <div className="eh-row">
                <code className="eh-mono">{status.infoFile}</code>
                <Button intent="ghost" size="sm" onClick={(): void => void copyPath()}>
                  {copied ? "Copied" : "Copy path"}
                </Button>
              </div>
            </div>
          </div>
        </Card>

        <div className="eh-grid">
          <Card title="What an agent can do">
            <div className="eh-stack eh-stack--sm">
              {VERBS.map((v) => (
                <div key={v.verb} className="eh-stack eh-stack--xs">
                  <code className="eh-mono">{v.verb}</code>
                  <span className="eh-small eh-muted">{v.what}</span>
                </div>
              ))}
            </div>
          </Card>

          <Card title="What keeps it safe">
            <div className="eh-stack eh-stack--sm">
              {GUARDS.map((g) => (
                <p key={g} className="eh-small">
                  {g}
                </p>
              ))}
              <p className="eh-small eh-muted">
                Agents send <code className="eh-mono">POST /v1/&lt;command&gt;</code> with the header{" "}
                <code className="eh-mono">Authorization: Bearer &lt;token&gt;</code>. The full protocol is in
                docs/control-channel.md in the Event Horizon repository.
              </p>
            </div>
          </Card>
        </div>
      </div>
    </Page>
  );
}
