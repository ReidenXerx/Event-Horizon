/**
 * The tools Event Horizon's MCP connector offers an AI, one per control
 * channel verb. The descriptions ARE the AI's manual, so they say what each
 * tool is for in a modder's words, not how it is built.
 *
 * Pure data, no imports: the connector runs outside Vortex (on Vortex's own
 * runtime as plain Node), where nothing but Node's built-ins is available.
 */

export type ToolSpec = {
  /** MCP tool name: letters, digits, _ and - only. */
  name: string;
  /** The control channel verb it calls. */
  verb: string;
  /** Changes the setup: run async and awaited through the op log. */
  mutates: boolean;
  /** Answered by the connector itself, with no call to Vortex (the handbook). */
  local?: boolean;
  description: string;
  properties: Record<string, unknown>;
  required?: string[];
};

const str = (description: string): Record<string, unknown> => ({ type: "string", description });
const bool = (description: string): Record<string, unknown> => ({ type: "boolean", description });
const num = (description: string): Record<string, unknown> => ({ type: "number", description });
const strings = (description: string): Record<string, unknown> => ({ type: "array", items: { type: "string" }, description });
const nexus = {
  type: "object",
  description: "A Nexus Mods file: the numbers in its page URL (mods/<modId>) and its file id (files tab, ?file_id=...).",
  properties: { modId: { type: "number" }, fileId: { type: "number" } },
  required: ["modId", "fileId"],
};
const picks = {
  type: "array",
  description:
    "Answers for a FOMOD installer, by the names installer_describe returns: [{group, options:[names], step?}]. " +
    "Groups you leave out keep the installer's defaults.",
  items: {
    type: "object",
    properties: { group: { type: "string" }, options: { type: "array", items: { type: "string" } }, step: { type: "string" } },
    required: ["group", "options"],
  },
};
const assume = bool("Only when you KNOW the game is closed and Event Horizon could not tell (code game-state-unknown).");

export const TOOLS: ToolSpec[] = [
  {
    name: "handbook",
    verb: "",
    mutates: false,
    local: true,
    description:
      "What an experienced Vortex and Bethesda modder knows, versioned with these tools: how Vortex works, plugins " +
      "and masters, game files, script extenders and game versions, Fallout 4 and Skyrim specifics, how to find a " +
      "crash, and what Event Horizon guarantees. Call it with no topic for the index. Read the topic before a job " +
      "it covers; it is faster than guessing and it is right for this user's tools.",
    properties: { topic: str("A topic id from the index (e.g. vortex, plugins, crashes), or a playbook name.") },
  },
  // ── look ──────────────────────────────────────────────────────────────
  {
    name: "state",
    verb: "state",
    mutates: false,
    description:
      "START HERE. The active game (folder, store, version exe, whether it is running), the active profile, other profiles, " +
      "deployment status, counts of mods/plugins/downloads, and anything Vortex is waiting on (open dialogs, an open " +
      "installer). include: [\"mods\",\"plugins\",\"downloads\"] adds the full lists.",
    properties: { include: strings('Any of "mods", "plugins", "downloads".') },
  },
  {
    name: "mods_find",
    verb: "mods.find",
    mutates: false,
    description: "Search the game's installed mods by name, Nexus mod id, enabled state, or who installed them. Returns ids to use with other tools.",
    properties: {
      name: str("Part of the mod's name or id."),
      nexusModId: num("Nexus mod id."),
      enabled: bool("Only enabled (true) or disabled (false) mods."),
      limit: num("Most results to return (default 200)."),
    },
  },
  {
    name: "mod_get",
    verb: "mod.get",
    mutates: false,
    description: "Everything about one installed mod: version, Nexus ids, rules, which profiles enable it, and the plugins it provides.",
    properties: { id: str("The mod id from mods_find.") },
    required: ["id"],
  },
  {
    name: "mods_rules",
    verb: "mods.rules",
    mutates: false,
    description: "The load-order rules on a mod (before/after/conflicts/requires) and the rules other mods hold on it.",
    properties: { id: str("One mod id."), modIds: strings("Several mod ids.") },
  },
  {
    name: "conflicts",
    verb: "conflicts",
    mutates: false,
    description:
      "File conflicts between enabled mods, as Vortex computed them, and whether a rule already settles each. " +
      "unresolvedOnly shows what still needs a rule; identical:true pairs ship the same bytes and need nothing.",
    properties: { modId: str("Only conflicts involving this mod."), unresolvedOnly: bool("Only the unsettled ones.") },
  },
  {
    name: "plugins_list",
    verb: "plugins",
    mutates: false,
    description: "Game plugins (.esp/.esm/.esl) in load order, with enabled state.",
    properties: { name: str("Part of a plugin name."), enabled: bool("Only enabled or disabled plugins.") },
  },
  {
    name: "plugins_rules",
    verb: "plugins.rules",
    mutates: false,
    description: "LOOT's user rules and groups: which plugin must load after which, and plugin groups. Also says whether autosort is on.",
    properties: { name: str("Only rules that mention this plugin."), names: strings("Only rules that mention any of these.") },
  },
  {
    name: "plugins_last_good",
    verb: "plugins.lastGood",
    mutates: false,
    description: "The last healthy plugin list Event Horizon saved for a profile (in case something wiped the load order). Feed it to plugins_apply to restore.",
    properties: { profileId: str("Default: the active profile.") },
  },
  {
    name: "downloads",
    verb: "downloads",
    mutates: false,
    description: "Archives Vortex has downloaded for the game, with ids usable by install and installer_describe.",
    properties: { name: str("Part of the file name.") },
  },
  {
    name: "installer_describe",
    verb: "installer.describe",
    mutates: false,
    description:
      "Look inside a mod's installer BEFORE installing: every page, choice and option with its description, which plugins " +
      "each option adds, and (checkMasters:true) which options need mods the user does not have. Use it to pick FOMOD " +
      "options that fit the user's setup.",
    properties: { nexus, archiveId: str("A download id from downloads."), checkMasters: bool("Check each option's plugin masters (recommended).") },
  },
  {
    name: "installer_open",
    verb: "fomod",
    mutates: false,
    description: "The FOMOD installer window open in Vortex right now, if any: pages, choices, options and what is ticked.",
    properties: {},
  },
  {
    name: "logs_list",
    verb: "logs.list",
    mutates: false,
    description:
      "For troubleshooting: the newest crash logs (Buffout 4 / Crash Logger), script extender logs (F4SE/SKSE), and " +
      "Event Horizon's and Vortex's logs. Read one with logs_read.",
    properties: {},
  },
  {
    name: "logs_read",
    verb: "logs.read",
    mutates: false,
    description:
      "Read a log from logs_list: the last lines by default. For a crash log, the top (head: 200) holds the exception " +
      "and probable call stack, which usually names the module or mod responsible.",
    properties: { id: str("The id from logs_list."), tail: num("Lines from the end (default 400)."), head: num("Lines from the top instead.") },
    required: ["id"],
  },
  {
    name: "diagnose_crash",
    verb: "diagnose.crash",
    mutates: false,
    description:
      "THE FIRST STEP FOR ANY CRASH. Reads the newest crash log (or id from logs_list) and returns a verdict: the " +
      "exception, what its location means in words, and ranked suspects (DLLs, plugins, files, Papyrus scripts) with " +
      "the Vortex mod each came from, plus the objects the game was handling. Explain it to the user; check the top " +
      "suspect before changing anything.",
    properties: { id: str("A crash log id from logs_list. Default: the newest crash log.") },
  },
  {
    name: "diagnose_setup",
    verb: "diagnose.setup",
    mutates: false,
    description:
      "A health check of the whole setup, as findings (error / warning / info), each with a fix: plugin limits, " +
      "masters that are missing, disabled or load too late, the script extender, Address Library and DLL plugins " +
      "against the installed game version, undeployed changes, and file conflicts no rule settles. Run it after " +
      "installing or changing mods, and when the game will not start.",
    properties: {},
  },
  {
    name: "vortex_notifications",
    verb: "vortex.notifications",
    mutates: false,
    description: "What Vortex is showing: notifications, dialogs waiting for the user, and an open installer.",
    properties: {},
  },
  {
    name: "operation",
    verb: "ops.get",
    mutates: false,
    description: "The outcome of an earlier command by its opId (every reply carries one), including ones still running.",
    properties: { opId: str("The opId from an earlier reply.") },
    required: ["opId"],
  },
  {
    name: "recent_operations",
    verb: "ops.list",
    mutates: false,
    description: "The most recent changes made through Event Horizon, newest first.",
    properties: { limit: num("How many (default 50).") },
  },
  {
    name: "restore_points",
    verb: "restorePoints.list",
    mutates: false,
    description:
      "The last 10 restore points, newest first. One is taken automatically before every change you make to mods, " +
      "rules or plugins; each reply that changed something carries its restorePoint id.",
    properties: {},
  },

  // ── change ────────────────────────────────────────────────────────────
  {
    name: "undo",
    verb: "restore",
    mutates: true,
    description:
      "Put the active profile back as it was at a restore point (the newest by default): which mods are enabled, mod " +
      "rules, LOOT rules and the plugin order. Use it when a change made things worse. Mods installed since are only " +
      "disabled; mods removed since are listed with their archive to install again. Deploy afterwards.",
    properties: { id: str("A restore point id from restore_points or an earlier reply. Default: the newest.") },
  },
  {
    name: "install",
    verb: "install",
    mutates: true,
    description:
      "Install a mod from Nexus (nexus) or from a download (archiveId) and enable it. A mod with a FOMOD installer needs " +
      "picks: without them the reply is needs-choices with the full installer tree to choose from. After installing, run deploy.",
    properties: {
      nexus,
      archiveId: str("A download id."),
      picks,
      ifExisting: { type: "string", enum: ["alongside", "replace", "ask"], description: "If an older version is installed: keep both (alongside), replace it in every profile, or let the user decide." },
      asCopy: str("Install a separate copy of an already-installed archive under this label."),
      checkMasters: bool("With needs-choices: also report options whose plugins need missing mods."),
    },
  },
  {
    name: "deploy",
    verb: "deploy",
    mutates: true,
    description: "Deploy the active profile so the game sees the current mods. Needed after installs, enables, disables and rules. The game must be closed.",
    properties: { assumeGameClosed: assume },
  },
  {
    name: "purge",
    verb: "purge",
    mutates: true,
    description: "Remove every deployed mod file from the game folder (mods stay installed in Vortex). The game must be closed.",
    properties: { assumeGameClosed: assume },
  },
  {
    name: "mods_set_enabled",
    verb: "mods.setEnabled",
    mutates: true,
    description: "Enable or disable mods by id in the active profile. Then deploy.",
    properties: { modIds: strings("Mod ids from mods_find."), enabled: bool("true to enable, false to disable.") },
    required: ["modIds", "enabled"],
  },
  {
    name: "mods_remove",
    verb: "mods.remove",
    mutates: true,
    description: "Uninstall mods by id (from every profile). Ask the user first: this deletes them. The reply says which ones Event Horizon installed.",
    properties: { modIds: strings("Mod ids from mods_find."), assumeGameClosed: assume },
    required: ["modIds"],
  },
  {
    name: "mods_rule",
    verb: "mods.rule",
    mutates: true,
    description: "Settle a file conflict: source loads after (wins over) or before reference. Also conflicts/requires/recommends. remove:true deletes a rule. Then deploy.",
    properties: {
      source: str("Mod id that gets the rule."),
      type: { type: "string", enum: ["after", "before", "conflicts", "requires", "recommends"] },
      reference: str("The other mod id."),
      remove: bool("Remove the rule instead."),
    },
    required: ["source", "reference"],
  },
  {
    name: "plugins_rule",
    verb: "plugins.rule",
    mutates: true,
    description: "A LOOT rule between two plugins (after/before/requires/incompatible), the way to fix a plugin order that must survive sorting. sort:true sorts and checks it worked.",
    properties: {
      name: str("Plugin file name."),
      type: { type: "string", enum: ["after", "before", "requires", "incompatible"] },
      reference: str("The other plugin file name."),
      sort: bool("Run LOOT now and verify."),
      remove: bool("Remove the rule instead."),
    },
    required: ["name", "type", "reference"],
  },
  {
    name: "plugins_set_enabled",
    verb: "plugins.setEnabled",
    mutates: true,
    description: "Switch plugins on or off by file name in the active profile.",
    properties: { names: strings("Plugin file names."), enabled: bool("true to enable.") },
    required: ["names", "enabled"],
  },
  {
    name: "plugins_apply",
    verb: "plugins.apply",
    mutates: true,
    description: "Replay a whole plugin list (order and on/off), e.g. from plugins_last_good after the game's launcher wiped it.",
    properties: {
      order: { type: "array", items: { type: "object", properties: { name: { type: "string" }, enabled: { type: "boolean" } }, required: ["name", "enabled"] } },
      sort: bool("Let LOOT sort afterwards instead of keeping the order exactly."),
    },
    required: ["order"],
  },
  {
    name: "plugins_sort",
    verb: "plugins.sort",
    mutates: true,
    description: "Sort the load order with LOOT now, and report what moved.",
    properties: {},
  },
  {
    name: "plugins_set_group",
    verb: "plugins.setGroup",
    mutates: true,
    description: "Put a plugin in a LOOT group.",
    properties: { name: str("Plugin file name."), group: str("LOOT group name.") },
    required: ["name", "group"],
  },
  {
    name: "plugins_set_autosort",
    verb: "plugins.setAutoSort",
    mutates: true,
    description: "Turn Vortex's automatic LOOT sorting on or off.",
    properties: { enabled: bool("true for on.") },
    required: ["enabled"],
  },
  {
    name: "installer_answer",
    verb: "fomod.answer",
    mutates: true,
    description: "Answer the FOMOD installer window open in Vortex right now (see installer_open), by option names, and finish it.",
    properties: { picks, finish: bool("Press Finish at the end (default true).") },
    required: ["picks"],
  },
  {
    name: "installer_cancel",
    verb: "fomod.cancel",
    mutates: true,
    description: "Cancel the FOMOD installer window open in Vortex right now.",
    properties: {},
  },
  {
    name: "external_changes_answer",
    verb: "externalChanges.answer",
    mutates: true,
    description:
      "Answer Vortex's External Changes dialog: mod files changed outside Vortex, found before a deploy or purge, which " +
      "waits on this answer (a deploy reply with code external-changes lists them). Per file: revert (put Vortex's copy " +
      "back), save (keep the change; for a deletion, delete for good), newer (keep whichever is newer; changed files " +
      "only). Then it finishes and verifies the waiting deploy.",
    properties: {
      all: { type: "string", enum: ["revert", "save", "newer"], description: "One answer for every file." },
      mods: { type: "object", description: "Answers per mod, by the mod name or id the dialog listed: {\"<mod>\": \"newer\"}." },
      files: { type: "object", description: "Answers per file path: {\"<path>\": \"revert\"}." },
      cancel: bool("Cancel instead: the waiting deploy or purge is cancelled."),
    },
  },
  {
    name: "profile_switch",
    verb: "profile.switch",
    mutates: true,
    description: "Switch to another Vortex profile (from state). The game must be closed.",
    properties: { profileId: str("Profile id."), assumeGameClosed: assume },
    required: ["profileId"],
  },
  {
    name: "game_switch_install",
    verb: "game.switchInstall",
    mutates: true,
    description: "Move the game to another install folder safely: purge, repoint, switch profile, deploy. For users with two copies of the game.",
    properties: { path: str("The other game folder."), profileId: str("Profile to use there."), store: str("steam / gog / xbox / epic."), assumeGameClosed: assume },
    required: ["path", "profileId"],
  },

  // ── collections (for curators) ────────────────────────────────────────
  {
    name: "collection_list",
    verb: "collection.list",
    mutates: false,
    description: "The curator's collections on this PC: exact name, package id, last built version and date, and the Nexus collection each is bound to.",
    properties: {},
  },
  {
    name: "collection_manifest",
    verb: "collection.manifest",
    mutates: false,
    description: "What a built collection package holds: name, version, game version and store, mod count, bundled mods. By name (the newest build) or by path.",
    properties: { name: str("The collection's exact name, from collection_list."), path: str("A built .ehcoll file instead.") },
  },
  {
    name: "collection_build",
    verb: "collection.build",
    mutates: true,
    description:
      "Build a new version of one of the curator's collections from the current Vortex setup, exactly as the Build page does. " +
      "Use the EXACT name from collection_list: a different name starts a new collection. Everything not given (author, " +
      "description, readme, changelog, per-mod decisions) is kept from the last build. Try dryRun:true first.",
    properties: {
      name: str("The collection's exact name."),
      version: str("New version, x.y.z, newer than the last build."),
      changelog: str("What changed in this version (replaces the kept changelog)."),
      description: str("Collection description (default: the last build's)."),
      readme: str("Readme (default: the last build's)."),
      author: str("Author (default: the last build's)."),
      gameVersion: str("Game version the collection needs (default: the installed game's)."),
      gameVersionPolicy: { type: "string", enum: ["exact", "minimum"] },
      dryRun: bool("Say what would be built without building."),
    },
    required: ["name", "version"],
  },
  {
    name: "collection_upload_draft",
    verb: "collection.upload",
    mutates: true,
    description:
      "Upload a built collection to its Nexus collection as a DRAFT revision. It never publishes: tell the curator the " +
      "draft is waiting for them to publish on Nexus. Refuses a package bound to no collection, a stale package, or one " +
      "whose name differs from the live collection's (an upload would rename the page). The reply's " +
      "changelog holds this version's changelog (markdown, bbcode) and the revision's id: EH cannot set it on Nexus " +
      "itself, so post it with Nexus's GraphQL createChangelog(revisionId, description) or give it to the curator.",
    properties: {
      name: str("The collection's exact name (uploads its newest build)."),
      path: str("A built .ehcoll file instead."),
      collection: str("The Nexus collection slug you expect, as a check."),
    },
  },
];

/** What the AI is told when it connects: how to work in Vortex safely, for someone who may be new to modding. */
export const GUIDE = [
  "You are driving the user's Vortex mod manager through Event Horizon. The user may be new to modding: explain what you",
  "are doing in plain words, one step at a time, and say what you changed.",
  "",
  "Know before you act:",
  "- handbook (no topic) lists what Event Horizon teaches: how Vortex works, plugins and masters, game files, script",
  "  extenders and game versions, Fallout 4 and Skyrim specifics, finding a crash, and Event Horizon's guarantees. Read",
  "  the topic for the job before starting it; it is written for these tools and this user's setup.",
  "- Call state first, and again whenever you are unsure what is set up.",
  "",
  "Ground rules:",
  "- Every change is checked before it reports success: ok:true means it really happened. On a failure, read code and",
  "  message; they say what to do. Never repeat a refused command unchanged.",
  "- Removing mods, purging, moving the game folder and replacing a mod everywhere stop and ask the user in Vortex. On",
  "  owner-denied, stop and ask the user what they want instead.",
  "- Every change to mods, rules or plugins takes a restore point; undo goes back one step. Offer it when something got",
  "  worse.",
  "- The game must be closed for deploy, purge, removals, profile switches and folder moves.",
  "- After installing, enabling, disabling or adding rules, deploy, or the game will not see the change.",
  "- Change one thing at a time when troubleshooting, and let the user test in between.",
  "",
  "Crashes and problems: diagnose_crash first (a verdict with suspects and the mod each came from), then",
  "diagnose_setup (findings with fixes). Explain, propose one fix, apply it with the user's OK, deploy, ask them to test.",
  "",
  "Installing mods: check requirements, installer_describe with checkMasters:true, choose options that fit the user's",
  "game and mods, tell the user what you chose and why, install with picks, settle new conflicts with mods_rule, deploy,",
  "then diagnose_setup.",
  "",
  "Collections (for curators): collection_list first; build under the exact name it shows, dryRun first.",
  "collection_upload_draft makes a DRAFT on Nexus. There is no publish tool: publishing is the curator's own click.",
].join("\n");
