/**
 * A collection card says where its install went, never in words that read as
 * "this is the profile Vortex is on" — that is what the "active" badge says.
 *
 * The regression, a tester's machine on 2026-09-17: the old Ivy card said
 * "current profile" (how it was installed) while Vortex was on the new Ivy's
 * profile, whose card said "active".
 */
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ReceiptCard } from "./CollectionsPage";
import { installModeLabel } from "./installModeLabel";
import type { InstallReceipt } from "../../types/installLedger";

const receipt = (mode: InstallReceipt["installTargetMode"], name: string): InstallReceipt =>
  ({
    schemaVersion: 1,
    packageId: name,
    packageVersion: "1.0.28",
    packageName: name,
    gameId: "fallout4",
    installedAt: "2026-09-16T23:41:05.752Z",
    vortexProfileId: `${name}-profile`,
    vortexProfileName: `${name} (Event Horizon v1.0.28)`,
    installTargetMode: mode,
    mods: [],
  }) as unknown as InstallReceipt;

const card = (r: InstallReceipt, isActive: boolean): string =>
  renderToStaticMarkup(React.createElement(ReceiptCard, { receipt: r, isActive, onOpen: () => undefined }));

describe("where an install went, on a collection card", () => {
  it("never calls an install mode the current profile", () => {
    for (const mode of ["fresh-profile", "current-profile"] as const) {
      const label = installModeLabel(mode);
      expect(`${label.short} ${label.long}`.toLowerCase()).not.toContain("current");
    }
    const html = card(receipt("current-profile", "ivy panties"), false);
    expect(html.toLowerCase()).not.toContain("current profile");
    expect(html).toContain("existing profile");
    expect(card(receipt("fresh-profile", "Ivy's Panties - Event Horizon"), true)).toContain("own profile");
  });

  it("puts the active badge first on the card Vortex is on, and nowhere else", () => {
    const active = card(receipt("fresh-profile", "Ivy's Panties - Event Horizon"), true);
    expect(active.indexOf(">active<")).toBeGreaterThan(-1);
    expect(active.indexOf(">active<")).toBeLessThan(active.indexOf(">v1.0.28<"));
    expect(card(receipt("current-profile", "ivy panties"), false)).not.toContain(">active<");
  });
});
