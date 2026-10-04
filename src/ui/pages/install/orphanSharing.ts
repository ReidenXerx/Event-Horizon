/**
 * Where else an orphan is switched on, read live from Vortex.
 *
 * Shared by the Decisions screen (which shows it and defaults the choice) and
 * the step that fills the defaults before Confirm, so the two cannot disagree:
 * an orphan another profile uses defaults to Keep, because "Uninstall" removes
 * a mod from Vortex's whole pool (NS-3), not from this collection alone.
 */

import type { types } from "@nexusmods/vortex-api";

import { profilesEnabling } from "../../../core/curator/profilesEnabling";
import type { InstallPlan } from "../../../types/installPlan";

export function orphanEnabledIn(api: types.IExtensionApi, plan: InstallPlan, modId: string): string[] {
  try {
    const target = plan.installTarget;
    return profilesEnabling({
      state: api.getState(),
      gameId: plan.manifest.game.id,
      modId,
      ...(target.kind === "current-profile" ? { excludeProfileId: target.profileId } : {}),
    });
  } catch {
    // A prompt that cannot read state still has to render; it falls back to
    // the generic wording, and the default stays the recommendation.
    return [];
  }
}
