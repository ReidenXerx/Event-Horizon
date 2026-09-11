/**
 * About page — pitch, version, authors, credits, license, and the
 * external links a curious user is most likely to want.
 *
 * Pure presentational component; no async work, no state. The links
 * use Electron's shell.openExternal so they open in the system browser
 * instead of trying to navigate the Electron renderer (which would
 * blank the Vortex window).
 */

import * as React from "react";

import { EventHorizonMark, Page, Pill, Card, StatTile, StatGrid } from "../components";
import { EXTENSION_VERSION } from "../version";

const REPO_URL = "https://github.com/ReidenXerx/Event-Horizon";
const ISSUE_URL = `${REPO_URL}/issues/new`;
const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;
const VORTEX_URL = "https://www.nexusmods.com/about/vortex/";
const NEXUS_URL = "https://www.nexusmods.com/";

export function AboutPage(): JSX.Element {
  return (
    <Page>
      <div className="eh-stack eh-stack--xl">
        <Card>
          <div className="eh-row eh-row--top eh-row--xl">
            <EventHorizonMark size={96} />
            <div className="eh-fill">
              <div className="eh-stack eh-stack--lg">
                <div className="eh-stack eh-stack--sm">
                  <h2>
                    <span className="eh-text-gradient">Event Horizon</span>
                  </h2>
                  <p>
                    A drop-in collection installer for Vortex that captures every
                    piece of curator state — FOMOD selections, mod rules, plugin
                    load order, INI tweaks, file overrides — and reproduces it
                    faithfully on the player&apos;s machine. Standalone format,
                    no interference with vanilla Vortex collections.
                  </p>
                </div>
                <div className="eh-row">
                  <Pill intent="info" withDot>
                    v{EXTENSION_VERSION}
                  </Pill>
                  <Pill intent="success" withDot>
                    MIT licensed
                  </Pill>
                  <Pill intent="warning">Pre-release</Pill>
                </div>
                <div className="eh-stack eh-stack--sm">
                  <h4>Supported games</h4>
                  <p className="eh-muted">
                    Skyrim Special Edition / Anniversary Edition, Fallout 3,
                    Fallout: New Vegas, Fallout 4, Starfield.
                  </p>
                </div>
                <div className="eh-stack eh-stack--sm">
                  <h4>Authors</h4>
                  <p className="eh-muted">
                    <strong className="eh-secondary">
                      DuduPhudu
                    </strong>{" "}
                    and{" "}
                    <strong className="eh-secondary">
                      Bluuuk
                    </strong>
                    .
                  </p>
                </div>
              </div>
            </div>
          </div>
        </Card>

        <StatGrid className="eh-stagger" min={220}>
          <StatTile label="Captures" value="FOMOD + rules + LO" />
          <StatTile label="Identity" value="Nexus IDs + sha256" />
          <StatTile label="Isolation" value="Fresh-profile by default" />
          <StatTile label="Conflicts" value="Explicit user pickers" />
        </StatGrid>

        <div className="eh-grid">
          <Card title="Links">
            <div className="eh-stack">
              <LinkRow
                href={REPO_URL}
                label="Source code"
                sub="GitHub repository · contributions welcome"
              />
              <LinkRow
                href={ISSUE_URL}
                label="Report a bug"
                sub="Open an issue with the Copy report payload from any error"
              />
              <LinkRow
                href={LICENSE_URL}
                label="MIT License"
                sub="© 2026 DuduPhudu and Bluuuk — see LICENSE for full text"
              />
            </div>
          </Card>

          <Card title="Built on">
            <div className="eh-stack">
              <LinkRow
                href={VORTEX_URL}
                label="Vortex"
                sub="The Nexus Mods mod manager Event Horizon plugs into"
              />
              <LinkRow
                href={NEXUS_URL}
                label="Nexus Mods"
                sub="Where mods live; Event Horizon resolves Nexus IDs to files"
              />
              <p className="eh-small">
                Not affiliated with or endorsed by Nexus Mods. &quot;Vortex&quot;
                is a trademark of its respective owners.
              </p>
            </div>
          </Card>

          <Card title="Credits">
            <ul
              className="eh-list"
            >
            <li>
              <strong className="eh-strong">
                vortex-api
              </strong>{" "}
              — extension framework + types from the Vortex team.
            </li>
            <li>
              <strong className="eh-strong">
                node-7z
              </strong>{" "}
              — streaming 7-Zip wrapper used to package and unpack
              <code> .ehcoll</code> archives.
            </li>
            <li>
              <strong className="eh-strong">React</strong>{" "}
              — UI runtime; thanks to the Vortex bundle for shipping it.
            </li>
            <li>
              Everyone testing pre-releases and filing issues. You make
              this less broken.
            </li>
          </ul>
          </Card>
        </div>
      </div>
    </Page>
  );
}

interface LinkRowProps {
  href: string;
  label: string;
  sub: string;
}

function LinkRow(props: LinkRowProps): JSX.Element {
  const handleClick = (e: React.MouseEvent): void => {
    e.preventDefault();
    void openExternal(props.href);
  };
  return (
    <div className="eh-stack eh-stack--xs">
      <a href={props.href} onClick={handleClick} className="eh-strong">
        {props.label} ↗
      </a>
      <div className="eh-small">{props.sub}</div>
    </div>
  );
}

/**
 * One implementation of "open a link", shared with the install flow.
 *
 * This used to be a second, thinner copy: `shell.openExternal` with no
 * fallback and no scheme check. `openExternalUrl` adds both — it falls back to
 * Vortex's own opener when Electron's shell is unavailable, and refuses
 * anything that is not http(s), which matters because the same helper is used
 * on URLs that came out of somebody else's manifest.
 */
async function openExternal(url: string): Promise<void> {
  const { openExternalUrl } = await import("../../core/revealPath");
  await openExternalUrl(url);
}
