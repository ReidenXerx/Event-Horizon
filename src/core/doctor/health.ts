/**
 * ──────────────────────────────────────────────────────────────────────
 * Collection Doctor — is this collection still what we installed?
 *
 * ─── WHAT "HEALTHY" MEANS, EXACTLY ─────────────────────────────────────
 * Identical to the LAST INSTALL OF THIS COLLECTION, as recorded in its
 * receipt. Not identical to the curator's disk, and not identical to the
 * manifest — the receipt is the only artefact that describes a state this
 * machine actually reached, so it is the only fair thing to be measured
 * against. Anything else reports drift the user never caused.
 *
 * That is the same reference discipline the drift detector already uses, and
 * it is deliberate: a curator's staging folder can be quietly corrupt, and
 * measuring users against it would turn the curator's bad day into everyone's.
 *
 * ─── WHY THE SPLIT ─────────────────────────────────────────────────────
 * {@link evaluateHealth} is pure: receipt + observations in, verdicts out. All
 * the Vortex reads live in the caller. That is what lets every interesting
 * case — a mod deleted, a plugin order rewritten by LOOT, a profile that no
 * longer exists — be tested without a running Vortex, which is the difference
 * between believing this works and knowing it.
 *
 * ─── EVERY FINDING MUST NAME ITS CURE ──────────────────────────────────
 * A diagnosis the user cannot act on is just anxiety. Each check that can fail
 * carries the install-pipeline step that repairs it, so the UI never has to
 * guess and the user never has to reinstall 900 mods to fix a plugin order.
 * ──────────────────────────────────────────────────────────────────────
 */

/** Which aspect of the collection a check covers. */
import type { FomodReplayMode } from "../installer/fomodReplayMode";
import {
  comparePluginOrder,
  type PluginOrderEntry,
} from "../installer/checkPluginOrder";

export type HealthCheckId =
  /**
   * The run that wrote the receipt did not finish — mods it could not
   * install, or finishing steps the user stopped it before. Listed FIRST
   * because it changes what every other check means.
   */
  | "install-incomplete"
  | "profile"
  | "mods-present"
  | "mods-enabled"
  | "staging"
  | "plugin-order"
  | "plugin-light-flags"
  | "mod-rules"
  /**
   * Two ids, because a LOOT userlist holds two different things and the
   * install writes them with two different counters.
   *
   * `userlist` is per-plugin ORDERING rules — after / req / inc.
   * `userlist-groups` is group ASSIGNMENTS — which group each plugin is in.
   *
   * They were one check, comparing rules-applied against plugin-entries-
   * present. On a real tester's collection that read "501 LOOT rules have
   * been added since installing" when the install had written all 501 itself
   * and nothing had drifted at all: `appliedRuleCount` was 0 because the
   * collection sets no ordering rules, `appliedGroupAssignmentCount` was 501,
   * and the current side counted entries, which is neither.
   */
  | "userlist"
  | "userlist-groups";

/**
 * Deliberately five states, not "pass/fail".
 *
 * `unknown` is load-bearing and must never be rendered as a pass: a receipt
 * written before a feature existed cannot tell us anything about it, and
 * "we did not check" is not "it is fine".
 */
export type HealthStatus =
  | "healthy"
  | "drifted"
  | "broken"
  | "unknown"
  | "not-applicable";

/** The install-pipeline step that repairs a given finding. */
export type HealAction =
  | "reinstall-mods"
  | "enable-mods"
  | "reapply-rules"
  | "reapply-userlist"
  | "repin-plugin-order"
  | "restore-light-flags"
  | "switch-profile";

export interface HealthCheck {
  id: HealthCheckId;
  /** Short label for the card. */
  title: string;
  status: HealthStatus;
  /** One line, written for a human who has not read any of this. */
  summary: string;
  /** Specifics — mod names, plugin names. Rendered as a list, may be long. */
  detail: string[];
  /** How many things are wrong, for a badge. 0 when healthy. */
  affectedCount: number;
  /** Absent when nothing can be done automatically. */
  heal?: { action: HealAction; label: string };
}

/** Everything the checks need, gathered from Vortex by the caller. */
export interface HealthObservations {
  /** Profile ids that currently exist for this game. */
  existingProfileIds: readonly string[];
  /** The profile Vortex is on right now, if any. */
  activeProfileId: string | undefined;
  /** Vortex mod ids currently installed for this game. */
  installedModIds: readonly string[];
  /** Vortex mod ids enabled in the receipt's profile. */
  enabledModIds: readonly string[];
  /**
   * Mods whose staging folder no longer matches what we installed, by
   * compareKey. Empty when nothing drifted; `undefined` when not checked
   * (the deep scan is opt-in because it hashes real bytes).
   */
  driftedCompareKeys: readonly string[] | undefined;
  /**
   * Current plugins.txt order, or undefined when the game has none.
   *
   * Carries `enabled`, and must: a disabled plugin occupies a line in the
   * file and changes nothing about what loads, so a comparison that cannot
   * see the flag has to treat every one of them as a positional difference.
   */
  currentPluginOrder: readonly PluginOrderEntry[] | undefined;
  /**
   * ESL / light flag of each recorded plugin as it is on disk NOW, keyed by
   * LOWERCASED name. `undefined` when it could not be read at all — which is
   * "not checked", never "no drift".
   */
  currentPluginLightFlags?: Readonly<Record<string, boolean>>;
  /** Mod rules currently set for this game, counted. */
  currentModRuleCount: number | undefined;
  /**
   * Per-plugin ORDERING rules currently set — entries carrying after / req /
   * inc. NOT the number of plugin entries: an entry that only names a group
   * carries no rule, and counting it here is what made this check report
   * permanent drift.
   */
  currentUserlistRuleCount: number | undefined;
  /** Plugin entries currently assigned to a LOOT group, counted. */
  currentUserlistGroupAssignmentCount: number | undefined;
}

/** The minimum of a receipt these checks read. */
export interface HealthReceiptView {
  packageName: string;
  packageVersion: string;
  vortexProfileId: string;
  mods: ReadonlyArray<{ vortexModId: string; compareKey: string; name: string }>;
  rulesApplication?: {
    appliedRuleCount?: number;
    baselinePluginOrder?: readonly (PluginOrderEntry & {
      /** The curator's ESL flag, when the package recorded one. */
      light?: boolean;
    })[];
  };
  userlistApplication?: {
    appliedRuleCount?: number;
    /**
     * Already written by every install — it just had no reader. A receipt
     * from before this check still parses; the group check reports
     * `unknown` for one that genuinely lacks the number, which is the
     * honest answer rather than a zero.
     */
    appliedGroupAssignmentCount?: number;
  };
  /**
   * How the curator's installer answers were replayed.
   *
   * `"supervised"` means the user could have changed them, which makes drift
   * ambiguous rather than wrong — see the staging check.
   */
  fomodReplayMode?: FomodReplayMode;
  /**
   * ─── WHAT THE RUN THAT WROTE THIS COULD NOT DO ────────────────────────
   * A receipt used to assert one thing: the collection IS installed. It now
   * also gets written by a run that installed 978 of 979 mods, or one the
   * user stopped after the deploy — because 978 mods with provenance beat 978
   * mods with none (NS-2).
   *
   * Both fields were written and read by NOTHING. The Doctor computed
   * `mods-present` from `receipt.mods`, which only ever held the mods that
   * DID install, so it reported "All 978 mods are still installed" about a
   * collection missing one — and the plugin-order check reported drift on an
   * order the run had deliberately not applied.
   *
   * Absent means the run completed; presence IS the signal.
   */
  failedMods?: ReadonlyArray<{ name: string; reason: string }>;
  finishingSkipped?: readonly string[];
}

const MAX_DETAIL = 25;

/** Cap a list for display without pretending it is complete. */
function detailList(names: readonly string[]): string[] {
  if (names.length <= MAX_DETAIL) return [...names];
  return [
    ...names.slice(0, MAX_DETAIL),
    `…and ${names.length - MAX_DETAIL} more`,
  ];
}


/**
 * Diagnose. Pure — every Vortex read happens in the caller.
 */
export function evaluateHealth(
  receipt: HealthReceiptView,
  obs: HealthObservations,
): HealthCheck[] {
  const checks: HealthCheck[] = [];

  // ── profile ──────────────────────────────────────────────────────────
  const profileGone = !obs.existingProfileIds.includes(receipt.vortexProfileId);
  checks.push({
    id: "profile",
    title: "Profile",
    status: profileGone
      ? "broken"
      : obs.activeProfileId === receipt.vortexProfileId
        ? "healthy"
        : "drifted",
    summary: profileGone
      ? "The profile this collection was installed into no longer exists."
      : obs.activeProfileId === receipt.vortexProfileId
        ? "You are on the profile this collection was installed into."
        : "The collection is installed, but you are on a different profile.",
    detail: profileGone ? [`Missing profile: ${receipt.vortexProfileId}`] : [],
    affectedCount: profileGone ? 1 : 0,
    // A profile that is gone cannot be recreated from a receipt — the mods
    // would have to be reinstalled — so only the survivable case offers a fix.
    ...(!profileGone && obs.activeProfileId !== receipt.vortexProfileId
      ? {
          heal: {
            action: "switch-profile" as const,
            label: "Switch to that profile",
          },
        }
      : {}),
  });

  /**
   * ─── THE RUN THAT WROTE THIS RECEIPT DID NOT FINISH ───────────────────
   * Before every other check, because it changes what the others MEAN. A
   * missing plugin order is not drift when the run never applied one, and a
   * mod that is absent because it failed to install is not a mod that
   * vanished afterwards.
   */
  const failedMods = receipt.failedMods ?? [];
  const finishingSkipped = receipt.finishingSkipped ?? [];
  if (failedMods.length > 0 || finishingSkipped.length > 0) {
    const parts: string[] = [];
    if (failedMods.length > 0) {
      parts.push(
        `${failedMods.length} mod(s) could not be installed, so this ` +
          `collection is incomplete`,
      );
    }
    if (finishingSkipped.length > 0) {
      parts.push(
        `you stopped the install before it finished ` +
          `${finishingSkipped.join(", ")}`,
      );
    }
    checks.push({
      id: "install-incomplete",
      title: "Install did not finish",
      status: "broken",
      summary: `${parts.join("; ")}. Run the install again to finish it.`,
      detail: detailList([
        ...failedMods.map((m) => `${m.name} — ${m.reason}`),
        ...finishingSkipped.map((phase) => `not applied: ${phase}`),
      ]),
      affectedCount: failedMods.length + finishingSkipped.length,
    });
  }

  // ── mods present ─────────────────────────────────────────────────────
  const installed = new Set(obs.installedModIds);
  const missing = receipt.mods.filter((m) => !installed.has(m.vortexModId));
  checks.push({
    id: "mods-present",
    title: "Mods installed",
    status: missing.length === 0 ? "healthy" : "broken",
    summary:
      missing.length === 0
        ? // Says "the ones it installed", not "all of them", when the run is
          // known to have left some out. The old wording read as a clean bill
          // of health for a collection that is short a mod.
          failedMods.length > 0
          ? `All ${receipt.mods.length} mods this install placed are still ` +
            `installed — but ${failedMods.length} more never installed at all.`
          : `All ${receipt.mods.length} mods are still installed.`
        : `${missing.length} of ${receipt.mods.length} mods are missing.`,
    detail: detailList(missing.map((m) => m.name)),
    affectedCount: missing.length,
    ...(missing.length > 0
      ? {
          heal: {
            action: "reinstall-mods" as const,
            label: `Reinstall ${missing.length} missing mod${missing.length === 1 ? "" : "s"}`,
          },
        }
      : {}),
  });

  // ── mods enabled ─────────────────────────────────────────────────────
  // Only meaningful for mods that are actually present; a missing mod being
  // disabled is the same finding twice.
  const enabled = new Set(obs.enabledModIds);
  const disabled = receipt.mods.filter(
    (m) => installed.has(m.vortexModId) && !enabled.has(m.vortexModId),
  );
  checks.push({
    id: "mods-enabled",
    title: "Mods enabled",
    status: disabled.length === 0 ? "healthy" : "drifted",
    summary:
      disabled.length === 0
        ? "Every installed mod is enabled in the profile."
        : `${disabled.length} installed mod${disabled.length === 1 ? " is" : "s are"} disabled.`,
    detail: detailList(disabled.map((m) => m.name)),
    affectedCount: disabled.length,
    ...(disabled.length > 0
      ? {
          heal: {
            action: "enable-mods" as const,
            label: `Enable ${disabled.length} mod${disabled.length === 1 ? "" : "s"}`,
          },
        }
      : {}),
  });

  // ── staging bytes ────────────────────────────────────────────────────
  if (obs.driftedCompareKeys === undefined) {
    checks.push({
      id: "staging",
      title: "Mod files",
      status: "unknown",
      summary: "Not checked — this one reads every file, so it runs on request.",
      detail: [],
      affectedCount: 0,
    });
  } else {
    const drifted = new Set(obs.driftedCompareKeys);
    const names = receipt.mods
      .filter((m) => drifted.has(m.compareKey))
      .map((m) => m.name);
    checks.push({
      id: "staging",
      title: "Mod files",
      status: names.length === 0 ? "healthy" : "drifted",
      summary:
        names.length === 0
          ? "Every mod's files are exactly as installed."
          : `${names.length} mod${names.length === 1 ? " has" : "s have"} changed on disk since installing.`,
      detail:
        names.length > 0 && receipt.fomodReplayMode === "supervised"
          ? [
              // The receipt records the RESULT, not the answers behind it, so
              // a deliberate deviation and a corrupted staging folder are
              // indistinguishable here. Reinstalling replays the CURATOR's
              // answers, which would undo the former. Say it before they
              // click, not after.
              "Note: you chose to review each installer on this install, so " +
                "some of these differences may be answers you changed on " +
                "purpose. Reinstalling restores the curator's answers.",
              ...detailList(names),
            ]
          : detailList(names),
      affectedCount: names.length,
      ...(names.length > 0
        ? {
            heal: {
              action: "reinstall-mods" as const,
              label: `Reinstall ${names.length} changed mod${names.length === 1 ? "" : "s"}`,
            },
          }
        : {}),
    });
  }

  // ── plugin order ─────────────────────────────────────────────────────
  const baseline = receipt.rulesApplication?.baselinePluginOrder;
  /**
   * ─── A PHASE THAT NEVER RAN IS NOT DRIFT ──────────────────────────────
   * `baselinePluginOrder` is recorded unconditionally, OUTSIDE the
   * `stopBeforeWriting` gate, so a run the user stopped after the deploy
   * recorded an order it then deliberately did not apply. Comparing against
   * it reported the user'''s plugins as "drifted" from a state that never
   * existed on their machine — and offered to heal it, which would apply the
   * order they had just stopped.
   *
   * "Not applied" and "applied then changed" are different facts with
   * different remedies, and only one of them is the user'''s doing.
   */
  const orderNotApplied = finishingSkipped.some((phase) =>
    phase.toLowerCase().includes("plugin order"),
  );
  if (orderNotApplied) {
    checks.push({
      id: "plugin-order",
      title: "Plugin order",
      status: "unknown",
      summary:
        "You stopped this install before it applied the load order, so " +
        "there is nothing to compare against yet. Run the install again to " +
        "finish it.",
      detail: [],
      affectedCount: 0,
    });
  } else if (baseline === undefined || baseline.length === 0) {
    checks.push({
      id: "plugin-order",
      title: "Plugin order",
      status: "unknown",
      summary:
        "This install did not record a plugin order, so there is nothing to compare against.",
      detail: [],
      affectedCount: 0,
    });
  } else if (obs.currentPluginOrder === undefined) {
    checks.push({
      id: "plugin-order",
      title: "Plugin order",
      status: "not-applicable",
      summary: "This game does not use a plugins.txt.",
      detail: [],
      affectedCount: 0,
    });
  } else {
    /**
     * ─── ONE DEFINITION OF "THE ORDER MATCHES" ──────────────────────────
     * This used to be a local `orderMatches` that bailed on
     * `a.length !== b.length` and then compared index by index. Fed the
     * curator's FULL baseline against the user's FULL plugins.txt, on a real
     * profile those lengths always differ — the user has their own plugins —
     * so it reported "drifted" on installs that reproduced perfectly, with a
     * summary quoting two plugin counts as though that were the finding.
     *
     * `comparePluginOrder` is the same question answered properly, and its
     * three choices are each argued where it lives: compare only ENABLED
     * plugins, compare only the SHARED subset, and compare RELATIVE sequence
     * rather than absolute index. The user's own extra plugins are not a
     * fault; a disabled plugin's position is not a fault.
     *
     * A diagnostic that is red on healthy machines teaches people to ignore
     * it, which is the expensive direction for a tool nobody can inspect.
     */
    const drift = comparePluginOrder(baseline, obs.currentPluginOrder);
    const same = drift.misordered.length === 0 && drift.missing.length === 0;
    checks.push({
      id: "plugin-order",
      title: "Plugin order",
      status: same ? "healthy" : "drifted",
      summary: same
        ? `All ${drift.compared} shared plugins load in the order the ` +
          `curator had.`
        : drift.misordered.length > 0
          ? `${drift.misordered.length} of ${drift.compared} shared plugins ` +
            `load in a different order than the curator had.`
          : `${drift.missing.length} plugin(s) the curator enabled are not ` +
            `enabled here.`,
      detail: same
        ? []
        : [
            ...drift.misordered
              .slice(0, 4)
              .map((m) => `"${m.name}" should load after "${m.expectedAfter}"`),
            ...(drift.missing.length > 0
              ? [`Not present or not enabled: ${drift.missing.slice(0, 4).join(", ")}`]
              : []),
          ],
      affectedCount: same ? 0 : drift.misordered.length + drift.missing.length,
      /**
       * ─── OFFERED EVEN WHEN THE CHECK IS HEALTHY ──────────────────────
       * The only heal on this panel that is useful on a HEALTHY machine, and
       * it is the one users ask for by name.
       *
       * Vortex sorts plugins with LOOT automatically — `autoSort` is on by
       * default — so the curator's order is liable to be replaced long after
       * the install, by an ordinary deploy or by enabling one plugin. The
       * install now offers to turn that off, but a user who leaves it on, or
       * who sorts by hand, needs a way back that does not mean re-running an
       * hour-long install.
       *
       * Safe to press at any time: the heal re-pins the recorded order with
       * `skipSort`, which is idempotent — pressing it on a machine that is
       * already correct changes nothing.
       */
      heal: {
        action: "repin-plugin-order" as const,
        label: same
          ? "Re-apply the curator's plugin order"
          : "Restore the curator's plugin order",
      },
    });
  }

  // ── ESL / light flags ────────────────────────────────────────────────
  /**
   * ─── THE FLAG LIVES IN THE FILE, SO IT CAN BE UNDONE ────────────────
   * Under copy deployment a Vortex purge rewrites plugins from staging and
   * silently reverts the install's flag repair. Nothing re-checked it: on the
   * profile this was built for, 1421 of 1607 plugins are light, and losing
   * them puts the setup roughly 1200 plugins over the 254 limit — the game
   * simply stops starting, with Doctor reporting everything healthy.
   */
  const recordedFlags = (baseline ?? []).filter((p) => p.light !== undefined);
  const onDisk = obs.currentPluginLightFlags;
  if (recordedFlags.length === 0) {
    checks.push({
      id: "plugin-light-flags",
      title: "ESL (light) flags",
      status: "unknown",
      summary:
        "This install did not record any ESL flags, so there is nothing to " +
        "compare against.",
      detail: [],
      affectedCount: 0,
    });
  } else if (onDisk === undefined) {
    checks.push({
      id: "plugin-light-flags",
      title: "ESL (light) flags",
      status: "unknown",
      summary:
        "The plugin files could not be read, so their ESL flags were not " +
        "checked. That is not the same as them being correct.",
      detail: [],
      affectedCount: 0,
    });
  } else {
    const wrong = recordedFlags.filter((p) => {
      const now = onDisk[p.name.toLowerCase()];
      // Absent means we could not read that one. Not evidence of drift.
      return now !== undefined && now !== p.light;
    });
    // Only a flag that was CLEARED costs a load-order slot; one wrongly set
    // is a different problem and much rarer. Both are drift, but the count
    // that decides whether the game starts is this one.
    const lostLight = wrong.filter((p) => p.light === true).length;
    checks.push({
      id: "plugin-light-flags",
      title: "ESL (light) flags",
      status: wrong.length === 0 ? "healthy" : "drifted",
      summary:
        wrong.length === 0
          ? `All ${recordedFlags.length} recorded ESL flags still match the ` +
            `curator's.`
          : `${wrong.length} plugin(s) no longer carry the ESL flag the ` +
            `curator had` +
            (lostLight > 0
              ? ` — ${lostLight} of them lost the light flag, and each one ` +
                `now uses a regular load-order slot. A Vortex purge under ` +
                `copy deployment does exactly this.`
              : "."),
      detail: wrong
        .slice(0, 5)
        .map((p) => `${p.name} should be ${p.light ? "light" : "regular"}`),
      affectedCount: wrong.length,
      /**
       * Healable WITHOUT the .ehcoll, which is what makes it worth offering:
       * the receipt carries the name and the flag, and the repair needs
       * nothing else. A user whose game stopped starting after a purge gets a
       * button rather than a reinstall.
       */
      ...(wrong.length > 0
        ? {
            heal: {
              action: "restore-light-flags" as const,
              label: `Restore ${wrong.length} ESL flag${wrong.length === 1 ? "" : "s"}`,
            },
          }
        : {}),
    });
  }

  // ── mod rules ────────────────────────────────────────────────────────
  const appliedRules = receipt.rulesApplication?.appliedRuleCount;
  checks.push(
    countCheck({
      id: "mod-rules",
      title: "Mod rules",
      applied: appliedRules,
      current: obs.currentModRuleCount,
      noun: "mod rule",
      healAction: "reapply-rules",
      healLabel: "Re-apply the collection's mod rules",
    }),
  );

  /**
   * ─── USERLIST: TWO COUNTS, TWO CHECKS ───────────────────────────────
   * Collapsing them compared `appliedRuleCount` against the number of plugin
   * ENTRIES, and a collection that assigns groups without setting ordering
   * rules then reported every one of its own entries as the user's addition.
   * Measured on a real tester's receipt: 501 group assignments, 0 rules, 501
   * entries present — reported as "501 LOOT rules have been added since
   * installing", with nothing whatever wrong.
   *
   * Both cures are the same button; the diagnosis is what had to split.
   */
  checks.push(
    countCheck({
      id: "userlist",
      title: "LOOT ordering rules",
      applied: receipt.userlistApplication?.appliedRuleCount,
      current: obs.currentUserlistRuleCount,
      noun: "LOOT ordering rule",
      healAction: "reapply-userlist",
      healLabel: "Re-apply the collection's LOOT rules",
    }),
  );
  checks.push(
    countCheck({
      id: "userlist-groups",
      title: "LOOT group assignments",
      applied: receipt.userlistApplication?.appliedGroupAssignmentCount,
      current: obs.currentUserlistGroupAssignmentCount,
      noun: "LOOT group assignment",
      healAction: "reapply-userlist",
      healLabel: "Re-apply the collection's LOOT rules",
    }),
  );

  return checks;
}

/**
 * Rules and userlist share a shape: a count we applied against a count that is
 * there now.
 *
 * Counting is a WEAK check and the wording says so rather than implying a
 * byte-level comparison. A rule swapped for a different rule keeps the count
 * identical, so this catches removal and addition, not substitution. Claiming
 * more than that would be the kind of false green this project keeps finding.
 */
function countCheck(args: {
  id: HealthCheckId;
  title: string;
  applied: number | undefined;
  current: number | undefined;
  noun: string;
  healAction: HealAction;
  healLabel: string;
}): HealthCheck {
  const { applied, current } = args;
  if (applied === undefined) {
    return {
      id: args.id,
      title: args.title,
      status: "unknown",
      summary: `This install did not record ${args.noun}s, so there is nothing to compare against.`,
      detail: [],
      affectedCount: 0,
    };
  }
  if (current === undefined) {
    return {
      id: args.id,
      title: args.title,
      status: "unknown",
      summary: `Could not read the current ${args.noun}s.`,
      detail: [],
      affectedCount: 0,
    };
  }
  if (current === applied) {
    return {
      id: args.id,
      title: args.title,
      status: "healthy",
      summary: `All ${applied} ${args.noun}s the collection applied are still set.`,
      detail: [],
      affectedCount: 0,
    };
  }
  const lost = applied - current;
  return {
    id: args.id,
    title: args.title,
    status: "drifted",
    summary:
      lost > 0
        ? `${lost} of ${applied} ${args.noun}s are gone.`
        : `${-lost} ${args.noun}s have been added since installing.`,
    detail: [
      `Applied at install: ${applied}`,
      `Set right now: ${current}`,
      "Counts only — a rule replaced by a different rule would look unchanged.",
    ],
    affectedCount: Math.abs(lost),
    heal: { action: args.healAction, label: args.healLabel },
  };
}

/** Roll the checks up into one verdict for the header. */
export function overallHealth(checks: readonly HealthCheck[]): {
  status: HealthStatus;
  headline: string;
  problems: number;
} {
  const problems = checks.filter(
    (c) => c.status === "broken" || c.status === "drifted",
  );
  if (problems.some((c) => c.status === "broken")) {
    return {
      status: "broken",
      headline: "This collection is not intact",
      problems: problems.length,
    };
  }
  if (problems.length > 0) {
    return {
      status: "drifted",
      headline: "Mostly intact, with drift",
      problems: problems.length,
    };
  }
  // "Everything we CHECKED is fine" — an unknown is not a pass, and saying so
  // is the difference between a health check and a reassurance machine.
  if (checks.some((c) => c.status === "unknown")) {
    return {
      status: "unknown",
      headline: "Healthy so far — some checks have not run",
      problems: 0,
    };
  }
  return {
    status: "healthy",
    headline: "Identical to the day it was installed",
    problems: 0,
  };
}

/**
 * Why healing must not run right now, or `undefined` when it may.
 *
 * Every heal action re-runs a step of the install pipeline, and those steps
 * mutate Vortex: they install mods, flip enabled state, clear and rewrite the
 * user's rules, rewrite the plugin order. Doing that WHILE the driver is doing
 * the same thing is how a collection gets corrupted in a way no verification
 * would catch afterwards, because both halves would look individually correct.
 *
 * Only the `installing` phase is mutating. Loading, previewing and choosing
 * are read-only, so blocking those would be superstition rather than safety.
 *
 * Deliberately fails to BLOCKED on an unrecognised shape: if we cannot tell
 * what the installer is doing, the safe answer is not to also start writing.
 */
/**
 * ─── `kind` IS REQUIRED HERE ON PURPOSE ────────────────────────────────
 * It used to be `{ kind?: unknown }`, and optional is what made this
 * unfalsifiable. The Doctor called it with the install session's SNAPSHOT —
 * `{ state, errorSeq }` — whose `kind` lives one level down on `.state`.
 * An absent optional property satisfies that type, so nothing complained,
 * `kind` was `undefined` on every render, and the guard below returned
 * "cannot tell" forever.
 *
 * The whole healing feature was disabled by it: all seven repair buttons read
 * "Install in progress" on a machine with nothing installing, and the page
 * still looked like it was working — a diagnosis, a health score, and every
 * cure greyed out with a plausible reason.
 *
 * Required means the snapshot no longer typechecks and the caller has to say
 * `.state`. `unknown` rather than `string` keeps the runtime guard honest:
 * this is called with data from a UI singleton, so a non-string `kind` is
 * still worth refusing rather than assuming.
 */
export function healingBlockedReason(
  installState: { kind: unknown } | undefined,
): string | undefined {
  if (installState === undefined) return undefined;
  const kind = installState.kind;
  if (typeof kind !== "string") {
    return "Cannot tell whether an install is running, so healing is paused.";
  }
  if (kind === "installing") {
    return (
      "An install is running right now. Healing re-runs steps of the same " +
      "pipeline, and two of them writing at once is how a collection gets " +
      "quietly corrupted — wait for it to finish."
    );
  }
  return undefined;
}
