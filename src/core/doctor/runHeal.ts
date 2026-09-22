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

/**
 * ─── A CURE THAT WRITES INTO THE GAME FOLDER MUST BE POINTED AT IT ─────
 * Two cures write outside Vortex's own state: `repin-plugin-order` writes
 * plugins.txt through Vortex's one `loadOrder`, and `restore-light-flags`
 * rewrites a header bit inside `<game>/Data/*.esp`. Neither call takes a game
 * or a profile — they both act on whatever is active RIGHT NOW.
 *
 * So the receipt on screen and the machine being written to are two different
 * facts, and `pickDoctorReceipt` deliberately falls back to the newest install
 * when no receipt claims the active profile: the Doctor can therefore be open
 * on a Skyrim receipt while Vortex is managing Fallout 4, or on the "Meridia"
 * profile's receipt while the player is on their own "Vanilla+".
 *
 * Under EH's required hardlink deployment `<game>/Data/X.esp` IS the owning
 * mod's staging file, so writing the curator's light bits there lands inside a
 * third-party mod's folder and is inherited by every profile on the machine —
 * NS-2's exact class of harm, permanent, and with no inverse cure. Plugin-name
 * overlap between two profiles of one game (USSEP, the unofficial patches, any
 * common ESP) makes it likely rather than exotic.
 *
 * Refused, and logged with both sides, rather than written. This used to guard
 * only the plugin ORDER; the flag write was the one that touched bytes.
 */
async function refuseUnlessReceiptIsActive(args: {
  api: types.IExtensionApi;
  gameId: string;
  receipt: InstallReceipt;
  /** For the log line, and for naming the act in the refusal. */
  what: "repin" | "light-flags";
  /** What would have been written, in the player's words. */
  wouldWrite: string;
}): Promise<{ kind: "blocked"; reason: string } | undefined> {
  const { activeContextFromState } = await import("./loadOrderStatus");
  const active = activeContextFromState(args.api.getState());
  const { receipt } = args;

  if (receipt.gameId !== active.gameId || args.gameId !== receipt.gameId) {
    ehLog("warn", `doctor.heal.${args.what}.refused`, {
      why: "not-active-game",
      receiptGame: receipt.gameId,
      healGame: args.gameId,
      activeGame: active.gameId,
    });
    return {
      kind: "blocked",
      reason:
        `This collection is for ${receipt.gameId}, but Vortex is managing ` +
        `${active.gameId ?? "no game"} right now. Switch to ${receipt.gameId} first — ` +
        `${args.wouldWrite}`,
    };
  }
  if (receipt.vortexProfileId !== active.profileId) {
    ehLog("warn", `doctor.heal.${args.what}.refused`, {
      why: "other-profile",
      receiptProfile: receipt.vortexProfileId,
      receiptProfileName: receipt.vortexProfileName,
      activeProfile: active.profileId,
      activeProfileName: active.profileName,
    });
    return {
      kind: "blocked",
      reason:
        `This collection was installed into the profile "${receipt.vortexProfileName}", ` +
        `and you are on "${active.profileName ?? active.profileId ?? "another profile"}". ` +
        `Switch profiles first — ${args.wouldWrite}`,
    };
  }
  return undefined;
}

/**
 * ─── THE TWO-WRITERS GATE, AT THE WRITE RATHER THAN AT THE RENDER ──────
 * `healingBlockedReason` exists because two things rewriting staging at once
 * "is how a collection gets corrupted in a way no verification would catch
 * afterwards". The Doctor page evaluated it once in its render body, never
 * subscribed to the session, and then never consulted it again — so for the
 * three cures that await a confirmation dialog, the gate was read an unbounded
 * time before the write, and for the rest it was whatever it had been at mount.
 *
 * It also read the weaker of the two sources. `installBusy` is raised by the
 * CURATOR session as well ("the rest of the app has no other way to know
 * staging is being rewritten"), so during a bulk update every cure stayed
 * enabled while the Home badge and the drift notification — which read the
 * runtime flag — correctly refused.
 *
 * Checked here, in core, immediately before the switch: the UI's disabled
 * button is now a courtesy rather than the safety.
 */
async function refuseWhileSomethingElseWrites(): Promise<
  { kind: "blocked"; reason: string } | undefined
> {
  const [{ healingBlockedReason }, { getEHRuntime }, { getInstallSession }] =
    await Promise.all([
      import("./health"),
      import("../../ui/runtime/ehRuntime"),
      import("../../ui/pages/install/installSession"),
    ]);

  if (getEHRuntime().getSnapshot().installBusy) {
    const reason = healingBlockedReason({ kind: "installing" });
    if (reason !== undefined) return { kind: "blocked", reason };
  }
  const reason = healingBlockedReason(getInstallSession().getSnapshot().state);
  return reason === undefined ? undefined : { kind: "blocked", reason };
}

async function healImpl(
  action: HealAction,
  deps: RunHealDeps,
): Promise<HealOutcome> {
  const { api, gameId, receipt } = deps;

  const busy = await refuseWhileSomethingElseWrites();
  if (busy !== undefined) {
    ehLog("warn", "doctor.heal.refused", { action, why: busy.reason });
    return busy;
  }

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
      /**
       * ─── ENABLE WHAT THE CHECK FOUND, AND COUNT WHAT WAS DONE ─────────
       * This enabled every mod in the receipt and reported that number, so a
       * button reading "Enable 3 mods" produced a toast reading "Re-enabled
       * 978 mods" (GP-8: every line you print is a claim). It also dispatched
       * `setModEnabled` for mods the sibling `mods-present` check had just
       * reported as MISSING — writing profile entries for mod ids Vortex does
       * not have — and, when the receipt's profile had been deleted, wrote 978
       * enables into a profile the `profile` check was simultaneously
       * reporting as gone, then called that a success.
       *
       * The check's own predicate is "installed AND not enabled"; recomputed
       * here from current state rather than trusted from the diagnosis, since
       * the two are separated by however long the card sat on screen.
       */
      const state = api.getState() as unknown as {
        persistent?: { mods?: Record<string, Record<string, unknown>> };
        settings?: { profiles?: Record<string, unknown> };
      };
      const profiles = state.settings?.profiles;
      if (
        profiles !== undefined &&
        typeof profiles === "object" &&
        !Object.prototype.hasOwnProperty.call(profiles, receipt.vortexProfileId)
      ) {
        ehLog("warn", "doctor.heal.enable-mods.refused", {
          why: "profile-gone",
          receiptProfile: receipt.vortexProfileId,
        });
        return {
          kind: "blocked",
          reason:
            `The profile "${receipt.vortexProfileName}" no longer exists in ` +
            `Vortex, so there is nothing to enable mods in. Reinstalling the ` +
            `collection would recreate it.`,
        };
      }

      const installed = new Set(
        Object.keys(state.persistent?.mods?.[gameId] ?? {}),
      );
      const { enableModInProfile } = await import("../installer/profile");
      let enabled = 0;
      let absent = 0;
      for (const mod of receipt.mods) {
        if (!installed.has(mod.vortexModId)) {
          absent += 1;
          continue;
        }
        enableModInProfile(api, receipt.vortexProfileId, mod.vortexModId);
        enabled += 1;
      }
      return {
        kind: "done",
        summary:
          `Re-enabled ${enabled} mod${enabled === 1 ? "" : "s"} in ${receipt.vortexProfileName}.` +
          (absent > 0
            ? ` ${absent} more are not installed any more, so they could not ` +
              `be enabled — reinstalling the collection restores those.`
            : ""),
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

      /**
       * Before the write, not after: `applyPluginLightFlags` opens the files
       * in the ACTIVE game's Data folder, which under hardlink deployment are
       * the owning mods' staging files. See the helper for what that costs
       * when the receipt on screen is not the machine in front of us.
       */
      const wrongTarget = await refuseUnlessReceiptIsActive({
        api,
        gameId,
        receipt,
        what: "light-flags",
        wouldWrite:
          "restoring flags now would rewrite plugin files that belong to " +
          "another setup, and that cannot be undone.",
      });
      if (wrongTarget !== undefined) return wrongTarget;

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
        gameId,
        // Absent on receipts from before flags were per game: those values
        // came from 0x200, and on Starfield that is not the light bit.
        recordedLightFlagBit: receipt.rulesApplication?.baselineLightFlagBit,
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      });

      if (repair.refused !== undefined) {
        ehLog("warn", "doctor.heal.light-flags.refused", {
          gameId,
          recordedLightFlagBit: receipt.rulesApplication?.baselineLightFlagBit,
          refused: repair.refused,
        });
        return { kind: "blocked", reason: repair.refused.reason };
      }

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
      /**
       * ─── THE OVER-LIMIT LINE BELONGS ON THE SUCCESS PATH TOO ──────────
       * `describePluginFlagRepair` computes the one sentence that answers "will
       * my game start" — regular plugins against the 254 limit — and it fires
       * precisely when some flags were restored and others failed, i.e. HERE.
       * It was read only in the `corrected === 0` branch, so a repair that
       * restored 900 flags and missed 300 reported success while the setup was
       * still 86 plugins over the limit and the game still would not launch.
       *
       * The re-diagnose does not recover it either: `evaluateHealth` compares
       * recorded flags against disk and never reads `regularAfter`.
       */
      return {
        kind: "done",
        summary: [
          `Restored ${repair.corrected} ESL flag(s)` +
            (repair.failures.length > 0
              ? `, and ${repair.failures.length} could not be changed.`
              : ".") +
            (repair.unreadable.length > 0
              ? ` ${repair.unreadable.length} plugin(s) were locked — close the ` +
                `game and any xEdit/LOOT windows, then run this again.`
              : ""),
          ...lines,
        ].join(" "),
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
      /**
       * ─── ONLY INTO THE ORDER THIS RECEIPT WAS PINNED INTO ───────────────
       * Vortex's `set-plugin-list` handler takes a list of names and nothing
       * else — no game, no profile — and dispatches UPDATE_PLUGIN_ORDER into
       * the ONE `loadOrder` it holds, creating an entry for every name it does
       * not know. So this heal writes into whatever game and profile are
       * active. Run for a receipt of another game, it wrote that game's
       * plugin names into this one's order; run from the Default profile for
       * a collection installed into a fresh one, it reordered Default's
       * plugins.txt — an order Event Horizon never installed (NS-2's class of
       * harm). Refused, and logged, rather than written.
       */
      const wrongTarget = await refuseUnlessReceiptIsActive({
        api,
        gameId,
        receipt,
        what: "repin",
        wouldWrite:
          "re-applying now would reorder a load order this collection was " +
          "never installed into.",
      });
      if (wrongTarget !== undefined) return wrongTarget;
      const [{ applyPluginOrder }, { buildRepinOrder, currentOrderFromState }] =
        await Promise.all([
          import("../installer/applyPluginOrder"),
          import("./loadOrderStatus"),
        ]);
      /**
       * ─── THE ORDER THE CARD PREVIEWS, FROM THE SAME SOURCE ────────────
       * This read plugins.txt while the Load order card previewed Vortex's
       * state, and ran a different merge (see buildRepinOrder) — so the moves
       * the card listed were not the moves the button made, exactly when the
       * card was warning that the file lagged the state.
       *
       * Vortex's state is the settled source for the Doctor's order: what it
       * compares, what the watcher reads, and what the write below asks
       * Vortex to persist. A plugins.txt that has not caught up is Vortex's
       * own pending write of that state; a hand-edited one is reported on the
       * card and not read here. It also retires the store problem this read
       * had — a GOG or Xbox game's plugins.txt lives in a different folder,
       * and a missed file came back as `[]`, dropping every plugin of the
       * user's own from the rebuilt order.
       */
      const current = currentOrderFromState(api.getState());
      if (current === undefined) {
        ehLog("warn", "doctor.heal.repin.refused", {
          why: "no-plugin-list",
          gameId,
        });
        return {
          kind: "blocked",
          reason:
            "Vortex lists no plugins for this game right now, so there is " +
            "no order to re-apply into.",
        };
      }
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
       * Enabled flags come from Vortex's CURRENT state, never from the
       * receipt — the receipt describes install time, and asserting those
       * would undo every plugin the user has toggled since.
       *
       * `buildRepinOrder` wraps that rule, and the card's preview calls it
       * with the same `current`.
       */
      const order = buildRepinOrder(recorded, current);
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
      const { applyModRules, collectExistingRules } = await import(
        "../installer/applyModRules"
      );
      const maps = resolveModMaps(receipt);
      /**
       * ─── THE SAME ARGUMENTS, OR IT IS NOT THE SAME FUNCTION ───────────
       * This file's promise is that healing re-runs the install's own step.
       * It called the install's own function with one argument missing, and
       * `existingRulesBySourceModId` is the one that drives the collection-wins
       * conflict pass: without it `applyModRules` reads `?? []` for every mod
       * and removes nothing.
       *
       * So the curator's rule was added while the player's contradicting rule
       * stayed beside it — the case applyModRules' own warning describes as
       * showing up "much later as a conflict order that will not stick" — and
       * the cure reported "Re-applied 412 of 412". The count check then stayed
       * red, so the player pressed it again, forever.
       */
      const result = applyModRules({
        api,
        gameId,
        rules: deps.manifest.rules ?? [],
        modIdByCompareKey: maps.modIdByCompareKey,
        modIdByNexusModId: maps.modIdByNexusModId,
        ambiguousNexusModIds: maps.ambiguousNexusModIds,
        existingRulesBySourceModId: collectExistingRules(
          api,
          gameId,
          maps.modIdByCompareKey,
        ),
      });
      return {
        kind: "done",
        summary:
          `Re-applied ${result.applied} of ${
            deps.manifest.rules?.length ?? 0
          } collection rules.` +
          (result.overwrittenUserRules > 0
            ? ` ${result.overwrittenUserRules} rule(s) of your own that ` +
              `contradicted them on the same mods were replaced.`
            : ""),
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
