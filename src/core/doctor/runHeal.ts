/**
 * ──────────────────────────────────────────────────────────────────────
 * Doing the repair.
 *
 * Every cure here re-runs a step of the install pipeline, using the SAME
 * function the install used. That is the point: a second implementation of
 * "apply the collection's rules" would drift from the first, and the whole
 * promise of this feature is that healing puts the machine back into a state
 * the installer would have produced.
 *
 * ─── REINSTALL IS A HANDOFF, NOT A REIMPLEMENTATION ────────────────────
 * Five of the six are single calls. `reinstall-mods` is not: it needs a
 * resolved install plan, conflict decisions, download retries, extraction
 * budgets and the stall watchdog — the entire driver. Rebuilding a small
 * version of that here would be a second install path, and this repo has
 * already learned three separate times what happens when two install routes
 * exist and only one gets a fix.
 *
 * So it hands the package to the installer the user already has. That flow is
 * idempotent — mods already correct are skipped — so "reinstall the 3 that
 * changed" and "run the installer again" are the same operation, and only one
 * of them needs maintaining.
 * ──────────────────────────────────────────────────────────────────────
 */

import type { types } from "@nexusmods/vortex-api";
import { ehLog } from "../logging/ehLog";

import type { EhcollManifest } from "../../types/ehcoll";
import type { InstallReceipt } from "../../types/installLedger";
import { rebuildPluginOrder } from "./heal";
import type { HealAction } from "./health";
import { nexusModIdOfCompareKey } from "../identity/compareKey";

export type HealOutcome =
  /** Done. `summary` is shown to the user. */
  | { kind: "done"; summary: string }
  /** Open the installer on this package — see the header. */
  | { kind: "handoff"; ehcollPath: string; summary: string }
  /** Could not run, and why. Never a silent no-op. */
  | { kind: "blocked"; reason: string };

export interface RunHealDeps {
  api: types.IExtensionApi;
  gameId: string;
  receipt: InstallReceipt;
  /** Present only when the `.ehcoll` was found and read. */
  manifest?: EhcollManifest;
  ehcollPath?: string;
  signal?: AbortSignal;
}

/**
 * Maps `applyModRules` needs to resolve the manifest's rule references.
 *
 * Built from the RECEIPT rather than from Vortex's current mod list: the
 * receipt says which mod ids this collection installed, so a rule cannot
 * accidentally be applied to a mod the user installed themselves that happens
 * to share a Nexus id.
 */
function resolveModMaps(receipt: InstallReceipt): {
  modIdByCompareKey: Map<string, string>;
  modIdByNexusModId: Map<string, string>;
  ambiguousNexusModIds: Set<string>;
} {
  const modIdByCompareKey = new Map<string, string>();
  const modIdByNexusModId = new Map<string, string>();
  const seenNexusIds = new Map<string, number>();

  for (const mod of receipt.mods) {
    modIdByCompareKey.set(mod.compareKey, mod.vortexModId);
    const nexusModId = nexusModIdOfCompareKey(mod.compareKey);
    if (nexusModId === undefined) continue;
    modIdByNexusModId.set(nexusModId, mod.vortexModId);
    seenNexusIds.set(nexusModId, (seenNexusIds.get(nexusModId) ?? 0) + 1);
  }

  // A partial pin naming one of these cannot be resolved — the map holds
  // whichever came last, and resolving a conflict rule onto the wrong variant
  // silently reverses the conflict it was meant to settle.
  const ambiguousNexusModIds = new Set(
    [...seenNexusIds.entries()].filter(([, n]) => n > 1).map(([id]) => id),
  );

  return { modIdByCompareKey, modIdByNexusModId, ambiguousNexusModIds };
}

/**
 * ─── THE DIAGNOSTIC TOOL WAS ITSELF UNDIAGNOSABLE ────────────────────
 * Doctor had not one log line in it. It is the screen a user opens when
 * something has already gone wrong, and every repair it performed left no
 * trace of having been attempted — so a report reading "I pressed heal and
 * nothing happened" could not be answered at all, by anyone.
 *
 * A wrapper rather than a line per branch: the switch below has a return in
 * every case, and instrumenting each one is a list that goes stale the first
 * time somebody adds a repair.
 */
export async function runHeal(
  action: HealAction,
  deps: RunHealDeps,
): Promise<HealOutcome> {
  const startedAt = Date.now();
  ehLog("info", "doctor.heal.start", {
    action,
    gameId: deps.gameId,
    profile: deps.receipt.vortexProfileName,
    mods: deps.receipt.mods.length,
  });
  try {
    const outcome = await healImpl(action, deps);
    ehLog("info", "doctor.heal.done", {
      action,
      ms: Date.now() - startedAt,
      kind: outcome.kind,
      summary: (outcome as { summary?: string }).summary,
      ...(outcome.kind === "blocked"
        ? { reason: (outcome as { reason?: string }).reason }
        : {}),
    });
    return outcome;
  } catch (err) {
    // A repair that threw is the single most important thing this file can
    // record, and it recorded nothing at all before.
    ehLog("error", "doctor.heal.fail", {
      action,
      ms: Date.now() - startedAt,
      err,
    });
    throw err;
  }
}

async function healImpl(
  action: HealAction,
  deps: RunHealDeps,
): Promise<HealOutcome> {
  const { api, gameId, receipt } = deps;

  switch (action) {
    case "switch-profile": {
      const { switchToProfile } = await import("../installer/profile");
      await switchToProfile(api, receipt.vortexProfileId, deps.signal);
      return {
        kind: "done",
        summary: `Switched to ${receipt.vortexProfileName}.`,
      };
    }

    case "enable-mods": {
      const { enableModInProfile } = await import("../installer/profile");
      let enabled = 0;
      for (const mod of receipt.mods) {
        enableModInProfile(api, receipt.vortexProfileId, mod.vortexModId);
        enabled += 1;
      }
      return {
        kind: "done",
        summary: `Re-enabled ${enabled} mod${enabled === 1 ? "" : "s"} in ${receipt.vortexProfileName}.`,
      };
    }

    case "restore-light-flags": {
      /**
       * ─── HEALABLE FROM THE RECEIPT ALONE ────────────────────────────
       * The receipt carries each plugin's name and the curator's flag, so
       * this needs no `.ehcoll` — which matters, because the user who needs
       * it is the one whose game stopped starting and who may no longer have
       * the package to hand.
       */
      const recorded = (receipt.rulesApplication?.baselinePluginOrder ?? [])
        .filter((p): p is typeof p & { light: boolean } => p.light !== undefined)
        .map((p) => ({ name: p.name, enabled: p.enabled, light: p.light }));

      if (recorded.length === 0) {
        return {
          kind: "blocked",
          reason:
            "This receipt did not record any ESL flags, so there is nothing " +
            "to restore. Packages built before that was captured cannot be " +
            "healed this way — reinstalling the collection would fix it.",
        };
      }

      const [{ applyPluginLightFlags, describePluginFlagRepair }, { getGameDirectory }] =
        await Promise.all([
          import("../installer/applyPluginLightFlags"),
          import("../manifest/externalDependencies"),
        ]);
      const gameDir = getGameDirectory(deps.api.getState(), gameId);
      if (gameDir === undefined) {
        // "Cannot check" and "nothing to do" are different answers, and only
        // one of them is a reason to stop.
        return {
          kind: "blocked",
          reason:
            "Vortex has not recorded where this game is installed, so the " +
            "plugin files could not be found.",
        };
      }

      const nodePath = await import("path");
      const repair = await applyPluginLightFlags({
        order: recorded,
        dataDir: nodePath.join(gameDir, "Data"),
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      });

      const lines = describePluginFlagRepair(repair) ?? [];
      // A repair that changed nothing is not a success worth claiming: if
      // every plugin was already correct the check would not have offered
      // this, so reaching here having done nothing means something stopped it.
      if (repair.corrected === 0) {
        return {
          kind: "blocked",
          reason:
            lines.length > 0
              ? lines.join(" ")
              : "No flag needed changing, which suggests the drift was fixed " +
                "elsewhere. Re-run the check.",
        };
      }
      return {
        kind: "done",
        summary:
          `Restored ${repair.corrected} ESL flag(s)` +
          (repair.failures.length > 0
            ? `, and ${repair.failures.length} could not be changed.`
            : ".") +
          (repair.unreadable.length > 0
            ? ` ${repair.unreadable.length} plugin(s) were locked — close the ` +
              `game and any xEdit/LOOT windows, then run this again.`
            : ""),
      };
    }

    case "repin-plugin-order": {
      const recorded = receipt.rulesApplication?.baselinePluginOrder;
      if (recorded === undefined || recorded.length === 0) {
        // The check that offers this button requires a baseline, so reaching
        // here means the receipt changed underneath us. Say so rather than
        // pinning an empty order, which would clear plugins.txt.
        return {
          kind: "blocked",
          reason:
            "This receipt did not record a plugin order, so there is nothing " +
            "to restore.",
        };
      }
      const [{ readUserPluginsTxt }, { applyPluginOrder }] = await Promise.all([
        import("../installer/checkPluginOrder"),
        import("../installer/applyPluginOrder"),
      ]);
      /**
       * Store-aware. Without it, a GOG or Xbox install reads the STEAM
       * plugins.txt — which usually does not exist, so `current` falls back
       * to `[]` and the rebuild silently drops every plugin the user has
       * added. A heal that strips the user's own plugins is worse than no
       * heal at all.
       */
      const { discoveredStore } = await import("../comparePlugins");
      const current =
        (await readUserPluginsTxt(
          gameId,
          discoveredStore(deps.api.getState(), gameId),
        )) ?? [];
      /**
       * ─── THE SAME MERGE THE INSTALL USES, AND NO SECOND SORT ──────────
       * This heal used to call `rebuildPluginOrder` — the curator's plugins
       * first, every plugin of the user's own APPENDED AT THE END — and then
       * let `applyPluginOrder` run LOOT on the result, because it did not pass
       * `skipSort`.
       *
       * Both halves were wrong, and together they made the button actively
       * destructive. The sort is the operation that was measured leaving 686
       * of 1,600 plugins out of the curator's order in the first place, so
       * clicking "restore the recorded order" right after a successful install
       * UNDID the install's re-pin and then reported "Set the recorded order
       * for N plugins" — the order strictly worse than before the click, and
       * the message saying it was restored. Meanwhile the append-at-end
       * rebuild produced exactly the stranded-at-the-end placement that the
       * install's three-step dance exists to avoid.
       *
       * `repinCuratorOrder` is the install's rule: the curator's plugins take
       * the curator's relative order in the slots they already occupy, and
       * every plugin of the user's own keeps the position LOOT gave it.
       * Nothing moves to the end, and nothing is re-sorted afterwards.
       *
       * Enabled flags come from the CURRENT file, never from the receipt —
       * the receipt describes install time, and asserting those would undo
       * every plugin the user has toggled since.
       */
      const { repinCuratorOrder } = await import(
        "../installer/repinPluginOrder"
      );
      const enabledByName = new Map(
        current.map((pl) => [pl.name.toLowerCase(), pl.enabled] as const),
      );
      const merged = repinCuratorOrder(
        recorded.map((e) => e.name),
        current.map((pl) => pl.name),
      );
      const order = merged.map((name) => ({
        name,
        enabled: enabledByName.get(name.toLowerCase()) ?? true,
      }));
      const result = await applyPluginOrder({
        api,
        gameId,
        collectionId: receipt.packageId,
        order,
        // No second sort: sorting is what displaced the curator's order.
        skipSort: true,
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      });
      // applyPluginOrder never throws — a load order it could not set is a
      // worse outcome, not an exception — so the outcome has to be read out
      // of the result rather than assumed from the absence of a throw.
      /**
       * `writeRequested` was named `written`, and this read it as an outcome
       * — worse, it accepted `pinned` ALONE as proof of a restore, so it
       * could report success having only put the order into Vortex's state
       * and never asked for it to reach disk.
       *
       * Both are requests, not confirmations. The wording now says what was
       * actually done, and the qualified sentence is the correct one under
       * "a false negative is cheaper than a false positive": telling someone
       * their order is restored when it is not is how they ship a broken
       * setup believing it is fixed.
       */
      return result.writeRequested || result.pinned
        ? {
            kind: "done",
            summary: result.writeRequested
              ? `Set the recorded order for ${order.length} plugins and asked ` +
                `Vortex to save it. Check the load order looks right before ` +
                `you launch — Vortex gives no confirmation that it wrote.`
              : `Set the recorded order for ${order.length} plugins in ` +
                `Vortex, but could not ask it to save to plugins.txt. It may ` +
                `not survive until the next deploy.`,
          }
        : {
            kind: "blocked",
            reason:
              result.notes.length > 0
                ? `Vortex would not set the plugin order: ${result.notes.join("; ")}.`
                : "Vortex did not apply the plugin order.",
          };
    }

    case "reapply-rules": {
      if (deps.manifest === undefined) {
        return { kind: "blocked", reason: MISSING_PACKAGE };
      }
      const { applyModRules } = await import("../installer/applyModRules");
      const maps = resolveModMaps(receipt);
      const result = applyModRules({
        api,
        gameId,
        rules: deps.manifest.rules ?? [],
        modIdByCompareKey: maps.modIdByCompareKey,
        modIdByNexusModId: maps.modIdByNexusModId,
        ambiguousNexusModIds: maps.ambiguousNexusModIds,
      });
      return {
        kind: "done",
        summary: `Re-applied ${result.applied} of ${
          deps.manifest.rules?.length ?? 0
        } collection rules.`,
      };
    }

    case "reapply-userlist": {
      if (deps.manifest === undefined) {
        return { kind: "blocked", reason: MISSING_PACKAGE };
      }
      const userlist = deps.manifest.userlist;
      if (userlist === undefined) {
        return {
          kind: "blocked",
          reason: "This collection did not record any LOOT rules.",
        };
      }
      const { applyUserlist } = await import("../installer/applyUserlist");
      const result = applyUserlist({
        api,
        userlist,
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      });
      return {
        kind: "done",
        summary: `Re-applied ${result.appliedRuleCount} LOOT plugin rules.`,
      };
    }

    case "reinstall-mods": {
      if (deps.ehcollPath === undefined) {
        return { kind: "blocked", reason: MISSING_PACKAGE };
      }
      return {
        kind: "handoff",
        ehcollPath: deps.ehcollPath,
        summary:
          "Opening the installer on this collection. Mods that are already " +
          "correct are skipped, so only what changed gets reinstalled.",
      };
    }
  }
}

const MISSING_PACKAGE =
  "This repair re-runs a step that reads the collection itself, and the " +
  ".ehcoll file could not be found. Point at it to continue.";
