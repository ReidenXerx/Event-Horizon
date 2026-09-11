/**
 * Home lists every receipt; Vortex holds one order. The badge must not give
 * a verdict — or a Re-apply that writes into the active order — for a
 * receipt whose order is not the active one.
 */
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ToastProvider } from "../../components/Toast";
import { ApiProvider } from "../../state/ApiContext";
import { LoadOrderBadge, watchLoadOrderState } from "./LoadOrderBadge";

const on = (...names: string[]): { name: string; enabled: boolean }[] => names.map((name) => ({ name, enabled: true }));

const receipt = (over: Record<string, unknown> = {}): never =>
  ({
    packageId: "pkg-ivy",
    packageName: "Ivy 2",
    packageVersion: "1.0.11",
    gameId: "skyrimse",
    vortexProfileId: "prof-ivy",
    vortexProfileName: "Ivy 2",
    installedAt: "2026-09-01T10:00:00.000Z",
    mods: [],
    rulesApplication: { baselinePluginOrder: on("A.esp", "B.esp") },
    ...over,
  }) as never;

/** The collection's two plugins, swapped: drift, if this order were judged. */
const stateOn = (activeProfileId: string): unknown => ({
  settings: { profiles: { activeProfileId } },
  persistent: {
    profiles: {
      "prof-ivy": { gameId: "skyrimse", name: "Ivy 2" },
      default: { gameId: "skyrimse", name: "Default" },
      "prof-fo4": { gameId: "fallout4", name: "Fallout 4" },
    },
  },
  session: { plugins: { pluginList: { "b.esp": {}, "a.esp": {} } } },
  loadOrder: {
    "b.esp": { name: "B.esp", enabled: true, loadOrder: 0 },
    "a.esp": { name: "A.esp", enabled: true, loadOrder: 1 },
  },
});

const render = (activeProfileId: string, r: never, receipts: never[] = [r]): string =>
  renderToStaticMarkup(
    React.createElement(ApiProvider, {
      api: { getState: () => stateOn(activeProfileId) } as never,
      children: React.createElement(ToastProvider, {
        children: React.createElement(LoadOrderBadge, { receipt: r, receipts }),
      }),
    }),
  );

describe("LoadOrderBadge", () => {
  it("judges, and offers Re-apply, only for the order's owner in its own profile", () => {
    const html = render("prof-ivy", receipt());
    expect(html).toContain("1 moved");
    expect(html).toContain("Re-apply");
  });

  it("says 'not the active game' for another game's receipt, with no Re-apply", () => {
    const html = render("prof-fo4", receipt());
    expect(html).toContain("not the active game");
    expect(html).not.toContain("Re-apply");
    expect(html).not.toContain("moved");
  });

  it("says where it was installed when the user is on another profile, with no Re-apply", () => {
    const html = render("default", receipt());
    expect(html).toContain("installed in profile Ivy 2");
    expect(html).not.toContain("Re-apply");
  });

  it("names the newer install that owns the order, with no Re-apply", () => {
    const older = receipt();
    const newer = receipt({ packageId: "pkg-new", packageName: "Other", packageVersion: "2.0.0", installedAt: "2026-09-05T10:00:00.000Z" });
    const html = render("prof-ivy", older, [older, newer]);
    expect(html).toContain("superseded by Other v2.0.0");
    expect(html).not.toContain("Re-apply");
  });
});

describe("watchLoadOrderState — the badge re-reads live", () => {
  it("fires once per burst of plugin-order, plugin-list or profile changes, and stops when unsubscribed", () => {
    vi.useFakeTimers();
    try {
      const callbacks = new Map<string, () => void>();
      const api = {
        onStateChange: (path: string[], cb: () => void): void => {
          callbacks.set(path.join("."), cb);
        },
      };
      let hits = 0;
      const stop = watchLoadOrderState(api, () => {
        hits += 1;
      });
      expect([...callbacks.keys()].sort()).toEqual(["loadOrder", "session.plugins.pluginList", "settings.profiles.activeProfileId"]);

      // LOOT's sort lands as a burst; the badge re-reads once.
      callbacks.get("loadOrder")!();
      callbacks.get("loadOrder")!();
      callbacks.get("settings.profiles.activeProfileId")!();
      vi.advanceTimersByTime(500);
      expect(hits).toBe(1);

      callbacks.get("session.plugins.pluginList")!();
      vi.advanceTimersByTime(500);
      expect(hits).toBe(2);

      stop();
      callbacks.get("loadOrder")!();
      vi.advanceTimersByTime(500);
      expect(hits).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
