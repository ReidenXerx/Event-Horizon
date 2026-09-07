import * as path from "path";
import { util } from "@nexusmods/vortex-api";
import type { types } from "@nexusmods/vortex-api";

import { getActiveGameId } from "../core/getModsListForProfile";
import {
  comparePluginsTxtFiles,
  exportPluginsDiffReport,
  discoveredStore,
  getCurrentPluginsTxtPath,
} from "../core/comparePlugins";
import { openFile, openFolder } from "../utils/utils";
import { pickTxtFile } from "../utils/utils";
import { getVortexUserDataPath } from "../core/paths";
import { beginOp } from "../core/logging/ehLog";

export function createComparePluginsAction(
  context: types.IExtensionContext,
): () => Promise<void> {
  return async () => {
    const op = beginOp("compare-plugins");
    try {
      const state = context.api.getState();

      const gameId = getActiveGameId(state);
      if (!gameId) {
        throw new Error("No active game found");
      }

      const referenceFilePath = await pickTxtFile(context.api);

      if (!referenceFilePath) {
        // Settle the op: a `compare-plugins.start` with no end reads as
        // "the compare hung", not "the user closed the file picker".
        op.ok({ cancelled: "file-picker" });
        return;
      }

      // Store-aware: plugins.txt lives in a store-specific folder, and
      // comparing against the wrong one reports every plugin as changed.
      const currentFilePath = getCurrentPluginsTxtPath(
        gameId,
        discoveredStore(state, gameId),
      );

      const diff = await comparePluginsTxtFiles({
        referenceFilePath,
        currentFilePath,
      });

      const appDataPath = getVortexUserDataPath();
      const outputDir = path.join(appDataPath, "event-horizon", "plugin-diffs");

      const diffPath = await exportPluginsDiffReport({
        diff,
        outputDir,
        gameId,
      });

      op.ok({ diffPath });

      console.log(
        `[Vortex Event Horizon] Plugins diff | game=${gameId} | referenceOnly=${diff.summary.onlyInReference} | currentOnly=${diff.summary.onlyInCurrent} | enabledMismatch=${diff.summary.enabledMismatch} | positionChanged=${diff.summary.positionChanged}`,
      );

      context.api.sendNotification?.({
        type: "success",
        message: `Plugins diff | Ref only: ${diff.summary.onlyInReference} | Current only: ${diff.summary.onlyInCurrent} | Enabled: ${diff.summary.enabledMismatch} | Order: ${diff.summary.positionChanged}`,
        actions: [
          {
            title: "Open Diff",
            action: () => {
              openFile(diffPath);
            },
          },
          {
            title: "Open Folder",
            action: () => {
              openFolder(outputDir);
            },
          },
        ],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      context.api.sendNotification?.({
        type: "error",
        message: `Plugins compare failed: ${message}`,
      });

      op.fail(error);
      console.error("[Vortex Event Horizon] Plugins compare failed:", error);
    }
  };
}
