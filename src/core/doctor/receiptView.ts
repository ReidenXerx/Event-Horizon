/**
 * The receipt, as the health checks want to read it.
 *
 * Lifted out of the Doctor page when the dashboard needed the same view: two
 * screens computing health from two different projections of one receipt is
 * how they end up disagreeing about whether a collection is healthy, and the
 * user has no way to tell which one is lying.
 *
 * Pure. Every Vortex read stays in the caller.
 */
import { doctorLightFlagBaseline } from "./health";
import type { HealthReceiptView } from "./health";
import type { InstallReceipt } from "../../types/installLedger";

/**
 * The receipt, narrowed to what the checks read.
 *
 * `baselinePluginOrder` is mapped to names on purpose: the receipt stores
 * `{ name, enabled }`, the check compares ORDER, and handing it objects would
 * compare them against a list of strings and report every plugin as drifted.
 */
export function toHealthView(receipt: InstallReceipt): HealthReceiptView {
  // Light values recorded from a bit that is not this game's light bit are
  // dropped here, and the reason travels in their place.
  const { baseline, refused: lightFlagsRefused } = doctorLightFlagBaseline(
    receipt.gameId,
    receipt.rulesApplication?.baselinePluginOrder,
    receipt.rulesApplication?.baselineLightFlagBit,
  );
  return {
    packageName: receipt.packageName,
    packageVersion: receipt.packageVersion,
    gameId: receipt.gameId,
    vortexProfileId: receipt.vortexProfileId,
    vortexProfileName: receipt.vortexProfileName,
    mods: receipt.mods.map((m) => ({
      vortexModId: m.vortexModId,
      compareKey: m.compareKey,
      name: m.name,
    })),
    ...(receipt.rulesApplication !== undefined
      ? {
          rulesApplication: {
            ...(receipt.rulesApplication.appliedRuleCount !== undefined
              ? { appliedRuleCount: receipt.rulesApplication.appliedRuleCount }
              : {}),
            ...(baseline !== undefined
              ? {
                  // `enabled` travels with the name: the health check compares
                  // enabled plugins only, and cannot do that from a string[].
                  baselinePluginOrder: baseline.map((e) => ({
                    name: e.name,
                    enabled: e.enabled,
                    // And `light` travels too. This exact map is where the
                    // enabled flag was being dropped before; adding a field
                    // to the receipt and forgetting this line is how the
                    // next one gets lost.
                    ...(e.light !== undefined ? { light: e.light } : {}),
                  })),
                }
              : {}),
            ...(lightFlagsRefused !== undefined ? { lightFlagsRefused } : {}),
          },
        }
      : {}),
    ...(receipt.userlistApplication !== undefined
      ? {
          userlistApplication: {
            ...(receipt.userlistApplication.appliedRuleCount !== undefined
              ? {
                  appliedRuleCount:
                    receipt.userlistApplication.appliedRuleCount,
                }
              : {}),
            /**
             * Carried separately from `appliedRuleCount`, because they count
             * different acts: one ordering rule dispatched, versus one plugin
             * assigned to a group. Folding them together is what made the
             * LOOT check report a healthy install as 501 rules added.
             *
             * Left absent when the receipt has no number, so the check says
             * "unknown" rather than comparing against a zero it invented.
             */
            ...(receipt.userlistApplication.appliedGroupAssignmentCount !==
            undefined
              ? {
                  appliedGroupAssignmentCount:
                    receipt.userlistApplication.appliedGroupAssignmentCount,
                }
              : {}),
          },
        }
      : {}),
    /**
     * What the run that wrote this receipt could NOT do. Both were written to
     * disk and projected nowhere, so every check downstream read a partial
     * install as a complete healthy one — "All 978 mods are still installed"
     * about a collection missing one, and plugin-order drift against an order
     * the run deliberately never applied.
     */
    ...(receipt.failedMods !== undefined && receipt.failedMods.length > 0
      ? { failedMods: receipt.failedMods }
      : {}),
    ...(receipt.finishingSkipped !== undefined &&
    receipt.finishingSkipped.length > 0
      ? { finishingSkipped: receipt.finishingSkipped }
      : {}),
    ...(receipt.fomodReplayMode !== undefined
      ? { fomodReplayMode: receipt.fomodReplayMode }
      : {}),
  };
}
