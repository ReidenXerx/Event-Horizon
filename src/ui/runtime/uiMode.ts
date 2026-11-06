/**
 * Player or Curator: the Dashboard's switch, remembered and shared.
 *
 * Owner poll, 2026-11-06 ("Show, but confirm first"): a player (ilhamitaa24,
 * Ivy) opened Curator Tools and ran "Make it work", which downloaded and
 * switched on a chain of Nexus mods that are not part of the collection. The
 * curator tabs stay visible, but in Player mode every curator action that
 * installs, enables, disables or removes mods asks first. A curator switches
 * the Dashboard to Curator once and is not asked again (the choice is kept).
 */

import * as React from "react";
import type { types } from "@nexusmods/vortex-api";

import { ehLog } from "../../core/logging/ehLog";

export type UiMode = "player" | "curator";

const KEY = "event-horizon.ui-mode";
let current: UiMode | undefined;
const listeners = new Set<() => void>();

export function getUiMode(): UiMode {
  if (current !== undefined) return current;
  try {
    current = globalThis.localStorage?.getItem(KEY) === "curator" ? "curator" : "player";
  } catch {
    current = "player";
  }
  return current;
}

export function setUiMode(mode: UiMode): void {
  current = mode;
  try {
    globalThis.localStorage?.setItem(KEY, mode);
  } catch {
    // Not remembered across restarts; the switch still works for this session.
  }
  for (const l of listeners) l();
}

export function useUiMode(): [UiMode, (mode: UiMode) => void] {
  const [mode, setMode] = React.useState<UiMode>(getUiMode());
  React.useEffect(() => {
    const l = (): void => setMode(getUiMode());
    listeners.add(l);
    return (): void => {
      listeners.delete(l);
    };
  }, []);
  return [mode, setUiMode];
}

export const CURATOR_CONFIRM_LABEL = "Continue";

/**
 * True when the action may run: always in Curator mode; in Player mode only
 * after the user says so in a dialog that names what it will do.
 */
export async function confirmCuratorAction(api: types.IExtensionApi, what: string): Promise<boolean> {
  if (getUiMode() === "curator") return true;
  const showDialog = (api as unknown as { showDialog?: unknown }).showDialog;
  if (typeof showDialog !== "function") return false;
  const result = (await (
    showDialog as (
      type: string,
      title: string,
      content: { text: string },
      actions: { label: string }[],
    ) => PromiseLike<{ action?: string } | undefined>
  )(
    "question",
    "This is a curator tool",
    {
      text:
        `${what}\n\n` +
        "Curator Tools are for people who build collections. Used on a collection you installed, they can add mods " +
        "that are not part of it or switch off ones it needs, and Event Horizon will not undo that for you.\n\n" +
        "If you play a collection, press Cancel. Curators: switch the Dashboard to Curator and this question stops.",
    },
    [{ label: "Cancel" }, { label: CURATOR_CONFIRM_LABEL }],
  )) as { action?: string } | undefined;
  const ok = result?.action === CURATOR_CONFIRM_LABEL;
  ehLog("info", "curator.player-mode.confirm", { what, ok });
  return ok;
}
