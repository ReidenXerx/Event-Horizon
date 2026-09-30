/**
 * The handbook Event Horizon gives the user's AI: what an experienced Vortex
 * and Bethesda modder knows, written for an agent to act on (owner poll,
 * 2026-09-30: Vortex fundamentals, Bethesda game specifics, playbooks, and
 * Event Horizon's own guarantees).
 *
 * Why it ships here: a capable general model knows modding only as well as
 * the forum posts it read, which are often for another game version or
 * another mod manager. This is versioned with the tools it describes.
 *
 * Every claim is one a modder can check. Where the answer depends on the
 * user's setup, the text says which tool tells.
 *
 * Pure data, no imports: the connector runs outside Vortex on plain Node.
 */

export type HandbookTopic = { id: string; title: string; summary: string; text: string };
export type Playbook = {
  name: string;
  title: string;
  description: string;
  arguments?: Array<{ name: string; description: string; required?: boolean }>;
  /** The message the playbook starts the conversation with. */
  text: (args: Record<string, string>) => string;
};

const md = (lines: string[]): string => lines.join("\n");

export const HANDBOOK: HandbookTopic[] = [
  {
    id: "vortex",
    title: "How Vortex works",
    summary: "Staging, deploying, profiles, mod rules vs load order, FOMOD, External Changes. Read before changing anything.",
    text: md([
      "# How Vortex works",
      "",
      "## Staging and deploying",
      "- Every installed mod lives in its own folder in Vortex's **staging folder**, never inside the game.",
      "- **Deploy** links those files into the game folder (hard links by default). The game only sees what is deployed.",
      "  Enabling, disabling, installing, or adding a rule changes nothing in the game until a deploy.",
      "- **Purge** takes every deployed link back out. The mods stay installed; a deploy puts them back.",
      "- Hard links need the staging folder on the same drive as the game. With a hard link, the file in the game",
      "  folder and the one in staging are ONE file: a tool that edits one edits both.",
      "",
      "## Profiles",
      "- A profile is a set of enabled mods and a plugin list for one game. Switching profile switches both (and may",
      "  deploy). Plugin state lives in the ACTIVE profile only.",
      "- Mods are installed once per game and shared by all profiles; only whether each is enabled is per profile.",
      "",
      "## Two different orders, often confused",
      "- **File conflicts** (mod rules): two mods ship the same file path (a mesh, a texture, a script). One file wins.",
      "  Vortex decides by **mod rules** (A loads after B = A's file wins). Unsettled conflicts show a lightning bolt.",
      "  Tools: `conflicts` (unresolvedOnly), `mods_rule`. A pair whose files are byte-identical needs no rule.",
      "- **Plugin load order** (.esm/.esp/.esl): which plugin's version of a RECORD wins. Decided by the plugin list,",
      "  sorted by **LOOT**. See handbook `plugins`. Tools: `plugins_list`, `plugins_rule`, `plugins_sort`.",
      "- A mod rule never changes the plugin order, and the plugin order never decides a file conflict.",
      "",
      "## LOOT and autosort",
      "- With autosort on, Vortex re-sorts plugins whenever they change. A hand-made order is undone by the next sort.",
      "- An order that must survive sorting is a LOOT **rule** (`plugins_rule`) or **group** (`plugins_set_group`).",
      "",
      "## FOMOD installers",
      "- Many mods ask questions at install (a FOMOD wizard). Read the options first (`installer_describe` with",
      "  checkMasters), then install with `picks` by option name. Skip options whose plugins need masters the user",
      "  does not have (`missingMasters`). Prefer options marked Recommended, and match the user's game version and",
      "  body/texture choices.",
      "- A step where the user legitimately picks nothing is valid: leave that group out of `picks`.",
      "",
      "## Downloads and reinstalling",
      "- Vortex keeps each downloaded archive. Reinstalling from it gives the same files; a reinstall with different",
      "  FOMOD choices needs `ifExisting` (see the tool's description).",
      "- Installing another version of a mod asks whether to replace it in every profile or only this one.",
      "",
      "## External Changes",
      "- Before a deploy or purge, Vortex checks whether files it deployed were changed outside it. Most often the game",
      "  or a mod wrote its own settings file (an MCM .ini, a BodySlide output) through the link. Then both copies are",
      "  one file (`sameFile: true`) and `newer` keeps the user's settings.",
      "- Never answer `save` for a DELETED file without asking: it deletes the staged copy for good.",
      "",
      "## Mods that go to the game root",
      "- Script extender loaders, ENB, ReShade and some engine fixes belong next to the game's .exe, not in Data.",
      "  Vortex marks them with a mod type (for example `dinput`) and deploys them to the root. A root mod installed as",
      "  a normal mod lands in Data and silently does nothing.",
    ]),
  },
  {
    id: "plugins",
    title: "Plugins, masters and load order",
    summary: "ESM/ESP/ESL, masters, the plugin limits, what load order decides, patches.",
    text: md([
      "# Plugins, masters and load order (Bethesda games)",
      "",
      "## Kinds",
      "- `.esm` master, `.esp` regular, `.esl` light. An .esp or .esm can also carry the light flag (\"ESPFE\").",
      "- Light plugins share one load-order slot (FE) and do not count against the full-plugin limit.",
      "- Fallout 4 and Skyrim SE/AE: 254 full plugins, up to 4096 light. Starfield adds medium plugins. Fallout: New",
      "  Vegas and Oldrim have no light plugins. `diagnose_setup` counts the user's against their game's limit.",
      "",
      "## Masters",
      "- A plugin lists the masters it needs. Each must be installed, ENABLED, and load BEFORE it.",
      "- A missing master stops the game: it usually crashes at the main menu or right after starting, often with no",
      "  useful crash log. `diagnose_setup` reports `missing-master`, `master-disabled` and `master-after`.",
      "- Creation Club content (cc*.esl / cc*.esm) is owned per user. A plugin that needs one the user does not own",
      "  cannot load; the fix is that content, or disabling the plugin.",
      "",
      "## What load order decides",
      "- When two plugins change the same record (an NPC, a cell, a weapon), the one that loads LAST wins, whole",
      "  record, nothing merged. Patches exist to combine two mods' changes: a patch loads after both mods it patches.",
      "- LOOT sorts by its masterlist plus the user's rules. It is right far more often than a hand order. When it is",
      "  wrong for a pair, add a rule (`plugins_rule`), do not hand-move.",
      "- Changing load order mid-playthrough is mostly safe; REMOVING a plugin mid-playthrough is not (see `crashes`).",
      "",
      "## Light-flagging (ESL-ifying)",
      "- Flagging a plugin light is safe only when its new form IDs fit the light range, and it changes the form IDs",
      "  other plugins and saves refer to if it was not compacted before. Only do it with the user's agreement, on",
      "  plugins nothing else depends on, and never in the middle of a playthrough.",
      "",
      "## Inspecting records",
      "- xEdit (FO4Edit, SSEEdit) shows which plugin wins each record. The tools here do not replace it; tell the user",
      "  when a question needs it.",
    ]),
  },
  {
    id: "files",
    title: "Game files, archives and INIs",
    summary: "Data folder, loose files vs BA2/BSA, My Games INIs, plugins.txt, store-specific folders.",
    text: md([
      "# Game files, archives and INIs",
      "",
      "## Where things are",
      "- Mods deploy into the game's `Data` folder (root mods next to the .exe).",
      "- INIs and saves: `Documents\\My Games\\<game>`. The folder name depends on the store: Skyrim SE from GOG uses",
      "  `Skyrim Special Edition GOG`, from Steam `Skyrim Special Edition`. Crash logs and script-extender logs sit in",
      "  the extender's folder there (`...\\Fallout4\\F4SE`, `...\\Skyrim Special Edition\\SKSE`).",
      "- The active plugin list is `plugins.txt` in `%LOCALAPPDATA%\\<game>` (again store-specific). Vortex writes it.",
      "",
      "## Loose files and archives",
      "- Archives: `.ba2` (Fallout 4, Starfield), `.bsa` (Skyrim, older games). An archive named like a plugin",
      "  (`MyMod - Main.ba2` next to `MyMod.esp`) loads with that plugin; without its plugin it does not load.",
      "- Loose files override archives. Fallout 4 needs archive invalidation for that (in `Fallout4Custom.ini`,",
      "  `[Archive] bInvalidateOlderFiles=1` and `sResourceDataDirsFinal=`); Vortex normally sets it.",
      "",
      "## INIs",
      "- The game reads `<Game>.ini`, `<Game>Prefs.ini` and, for Fallout 4, `Fallout4Custom.ini` (the safe place for",
      "  tweaks). Mod-configuration menus (MCM) keep their own INIs under `Data\\MCM\\Settings`, written by the game.",
      "",
      "## Files the game or a tool writes",
      "- MCM settings, BodySlide output, generated LOD, behaviour files: they change after deploy. That is expected;",
      "  it is why Vortex's External Changes dialog appears (see `vortex`).",
    ]),
  },
  {
    id: "script-extenders",
    title: "Script extenders, Address Library and game versions",
    summary: "F4SE/SKSE/NVSE/SFSE, why DLL mods break on a game update, OG/NG/AE, GOG vs Steam.",
    text: md([
      "# Script extenders, Address Library and game versions",
      "",
      "## What they are",
      "- F4SE (Fallout 4), SKSE64 (Skyrim SE/AE), xNVSE (New Vegas), SFSE (Starfield). The game is started through the",
      "  extender's loader (for example `f4se_loader.exe`), which loads DLL plugins from `Data\\F4SE\\Plugins`",
      "  (`Data\\SKSE\\Plugins`). Many mods need it; the extender itself is a ROOT mod.",
      "",
      "## The version lock",
      "- The extender is built for ONE exact game version: its runtime DLL is named for it (`f4se_1_10_163.dll`,",
      "  `skse64_1_6_1170.dll`). A game update breaks it until the user installs the matching extender.",
      "- DLL plugins are either built for specific versions, or use the **Address Library**, a per-version data file",
      "  (`version-1-10-163-0.bin`, `versionlib-1-6-1170-0.bin`) that must also match. A DLL for another version is not",
      "  loaded (the extender's log says so), or crashes the game.",
      "- The same version number from GOG and from Steam is NOT the same executable: DLLs and Address Library files",
      "  for one store can fail on the other.",
      "- `diagnose_setup` checks the extender, the Address Library file and every deployed DLL plugin against the",
      "  installed game version and names the ones that will not load.",
      "",
      "## Fallout 4's three lines",
      "- **Old-gen (OG) 1.10.163**: the version most mods were built for, F4SE 0.6.23.",
      "- **Next-gen (NG) 1.10.980/984** (April 2024) and **Anniversary (AE) 1.11.x** (2025): F4SE 0.7.x. Many OG-only",
      "  DLLs do not load here; look for NG/AE builds or \"version independent\" releases.",
      "",
      "## Skyrim",
      "- **SE 1.5.97** and **AE 1.6.x** (1.6.640, then 1.6.1170 on Steam, 1.6.1179 on GOG). SE and AE DLLs and",
      "  Address Library files are different downloads.",
      "",
      "## Updates and downgrades",
      "- Steam updates the game on its own. A player whose mod list depends on a version sets the game to update only",
      "  when launched, or keeps a downgraded copy. Changing the game version is the user's decision, never yours:",
      "  explain what it costs (every version-locked DLL must be swapped) and let them choose.",
    ]),
  },
  {
    id: "fallout4",
    title: "Fallout 4 specifics",
    summary: "Precombines/previs, Creation Club, crash loggers, bodies and BodySlide, common requirements.",
    text: md([
      "# Fallout 4",
      "",
      "- **Crash logger**: Buffout 4 (OG), Buffout 4 NG or Addictol Crash Logger (NG/AE). Logs:",
      "  `Documents\\My Games\\Fallout4\\F4SE\\crash-*.log`. Without one, crashes leave little to read.",
      "- **Precombines and previs**: the game merges static objects per cell for performance. A mod that edits objects",
      "  in a cell without rebuilding them breaks them: frame drops, flickering, missing walls in that area. PRP",
      "  (Previsibines Repair Pack) and mod-specific patches fix it; they depend on load order, so do not hand-move",
      "  them.",
      "- **Creation Club / Creations**: `cc*.esl` / `cc*.esm`. Owned per user. AE ships many; a mod list may need some.",
      "- **Bodies**: CBBE / Fusion Girl and outfit mods ship BodySlide projects. After installing outfit mods the user",
      "  builds them in BodySlide (batch build); the output is written into the game or an output mod and shows up as",
      "  External Changes or a generated mod afterwards. Missing builds look like wrong or invisible bodies.",
      "- **MCM**: Mod Configuration Menu; mods keep settings in `Data\\MCM\\Settings\\*.ini`, written by the game.",
      "- **Common requirements**: F4SE, Address Library for F4SE Plugins, Buffout 4 / its NG successors, MCM,",
      "  LooksMenu for many appearance mods. Check a mod's Requirements on its Nexus page before installing.",
      "- **Two installs** (OG and AE side by side) share `Documents\\My Games\\Fallout4` INIs, saves and `plugins.txt`",
      "  unless separated. Use `game_switch_install` rather than repointing by hand.",
    ]),
  },
  {
    id: "skyrim",
    title: "Skyrim SE/AE specifics",
    summary: "SKSE, Engine Fixes, animation generators, LOD and grass, SkyUI, saves.",
    text: md([
      "# Skyrim Special Edition / Anniversary Edition",
      "",
      "- **Crash logger**: Crash Logger SSE; logs in `Documents\\My Games\\Skyrim Special Edition[ GOG]\\SKSE`.",
      "- **Core**: SKSE64, Address Library for SKSE Plugins (SE and AE are separate files), SSE Engine Fixes (a DLL",
      "  plus preloader files for the game root), SkyUI for MCM menus.",
      "- **Animations**: mods that add animations need the behaviour files regenerated (Nemesis, Pandora or FNIS) after",
      "  every change to them. The generator's output is its own mod and must win over the mods it reads.",
      "- **LOD and grass**: DynDOLOD/xLODGen output and grass caches (NGIO) are generated for ONE load order; after",
      "  big changes they are stale and must be regenerated. They load last.",
      "- **Saves and scripts**: scripted mods write into the save. Removing one mid-playthrough can leave running",
      "  scripts behind and corrupt the save over time. Say so before removing any scripted mod, and suggest a new game",
      "  or the mod's own uninstall procedure.",
      "- **Anniversary content**: AE's Creation Club items (`cc*.esl`/`esm`) are owned per user.",
    ]),
  },
  {
    id: "crashes",
    title: "Finding why the game crashes",
    summary: "The method: read the log, check the setup, look at what changed, bisect with restore points.",
    text: md([
      "# Finding why the game crashes",
      "",
      "1. **When does it crash?** At start / main menu (missing masters, extender or DLL version), loading a save (a",
      "   mod removed or changed since the save), in one place (a mesh, texture or cell edit there), at random (memory,",
      "   drivers, a script-heavy mod).",
      "2. **`diagnose_crash`** on the newest log. Read `meaning` and the top suspects. A suspect is where the evidence",
      "   points, not a verdict: base-game code crashing on a mod's object blames the object's mod.",
      "3. **`diagnose_setup`**. Fix every error first: a missing master or a DLL for the wrong version explains most",
      "   startup crashes on its own.",
      "4. **What changed?** `recent_operations` and `restore_points` show what agents did; ask the user what else",
      "   they changed. If the crash began after a change, `undo` it and test.",
      "5. **Bisect** when nothing points anywhere: disable half of the recently added mods (never masters others need),",
      "   deploy, test; keep the half that crashes. Each step takes a restore point, so `undo` goes back.",
      "6. **Test on a new game or an early save** when a save may be the problem: a crash that happens only on one save",
      "   is the save, not the setup.",
      "",
      "## Rules",
      "- Change one thing at a time, deploy, and ask the user to test. Say what you changed.",
      "- Never delete saves, INIs or the user's files. Disabling is reversible; removing is not.",
      "- No crash log at all: the crash logger is missing or failed to load. Check `logs_list` for the extender log;",
      "  Windows' Event Viewer (Application log) still names the crashing module.",
      "- Graphics-driver crashes (nvwgf2umx.dll, amdxx64.dll) are usually a bad mesh/texture, an ENB/ReShade preset or",
      "  running out of video memory.",
    ]),
  },
  {
    id: "event-horizon",
    title: "What Event Horizon guarantees, and what not to touch",
    summary: "Collections and receipts, the Doctor, the user's click before destructive changes, undo, refusals.",
    text: md([
      "# Event Horizon",
      "",
      "- Event Horizon installs **collections**: a curator's exact mod list, every archive verified byte-for-byte,",
      "  installed in order, with the curator's FOMOD choices, rules and plugin order. It keeps a **receipt** of what it",
      "  installed. Mods it installed have `owner: \"eh-installed\"` in replies.",
      "- The **Doctor** compares the setup with the receipt and lists what drifted (a mod missing, disabled, a plugin",
      "  moved). If you change a collection's mods, tell the user the Doctor will report it; they can mark a deliberate",
      "  change \"Keep as is\". Prefer disabling a collection mod over removing it.",
      "- **The user's click**: removing mods, purging, moving the game folder or replacing a mod in every profile stops",
      "  and asks the user in Vortex. `owner-denied` means they said no: do not send it again unless they ask.",
      "  `owner-no-answer` means nobody was at the PC.",
      "- **Undo**: every change to mods, rules or plugins takes a restore point first. `undo` goes back one step (or",
      "  to any point in `restore_points`). It never removes mods; mods removed since cannot come back from it.",
      "- **Refusals are information**: every refused command says why in `code` and `message`. Never repeat a refused",
      "  command unchanged. `game-running`: ask the user to close the game. `needs-choices`: the mod has an",
      "  installer, describe it and send `picks`.",
      "- **Game version**: a collection is built for one game version and store. The Doctor's native-plugins check and",
      "  the Play button tell the user what does not fit theirs.",
      "- Every command you send is logged for the user (`control-ops.jsonl`) and shown as a Vortex notification.",
    ]),
  },
];

export const PLAYBOOKS: Playbook[] = [
  {
    name: "fix_crash",
    title: "Fix a crash",
    description: "Find why the game crashes and fix it, one verified step at a time.",
    arguments: [{ name: "when", description: "When it crashes: at start, loading a save, in one place, at random." }],
    text: (a) =>
      `My game crashes${a["when"] ? ` (${a["when"]})` : ""}. Help me find out why and fix it.\n\n` +
      "Work like this: read the handbook topic `crashes` first. Then diagnose_crash and diagnose_setup, explain what " +
      "they found in plain words, propose ONE change, make it after I agree, deploy, and ask me to test. Repeat.",
  },
  {
    name: "wont_start",
    title: "The game will not start",
    description: "Startup crashes and black screens: masters, script extender, DLL versions.",
    text: () =>
      "My game will not start (it closes, or crashes at the main menu). Read the handbook topics `plugins` and " +
      "`script-extenders`, run diagnose_setup, and fix the errors it lists one at a time with my OK. Then deploy.",
  },
  {
    name: "install_mod",
    title: "Install a mod",
    description: "Install a Nexus mod correctly: requirements, installer options, rules, load order.",
    arguments: [{ name: "mod", description: "The Nexus link or mod name.", required: true }],
    text: (a) =>
      `Install ${a["mod"] ?? "this mod"} for me.\n\n` +
      "Check its requirements first and tell me what is missing. If it has an installer, read it with " +
      "installer_describe (checkMasters) and tell me which options you pick and why. Install, settle any new file " +
      "conflicts with rules, sort plugins, deploy, and run diagnose_setup.",
  },
  {
    name: "check_setup",
    title: "Check my setup",
    description: "A health check with plain-language findings and fixes.",
    text: () =>
      "Check my mod setup. Run diagnose_setup, explain every finding in plain words, most serious first, and " +
      "propose fixes. Do not change anything until I say which ones.",
  },
  {
    name: "load_order",
    title: "Sort out load order and conflicts",
    description: "File conflicts and plugin order: rules that survive sorting.",
    text: () =>
      "Help me sort out my load order. Read the handbook topics `vortex` (the two orders) and `plugins`. Show " +
      "unresolved file conflicts that actually differ, and plugins that load before their masters. Propose rules; " +
      "use plugins_rule (not a hand order) for plugin orders that must survive LOOT.",
  },
  {
    name: "undo_last",
    title: "Undo what the agent changed",
    description: "Go back to how the setup was before the last change.",
    text: () =>
      "Something got worse. Show me restore_points and recent_operations, tell me what changed, and undo to the point " +
      "I pick (the newest by default). Then deploy.",
  },
];

export function handbookIndex(): string {
  return md([
    "Handbook topics (read one with handbook {topic}):",
    ...HANDBOOK.map((t) => `- ${t.id}: ${t.summary}`),
    "",
    "Playbooks (step-by-step jobs, also offered as prompts):",
    ...PLAYBOOKS.map((p) => `- ${p.name}: ${p.description}`),
  ]);
}

export function handbookTopic(id: string): string | undefined {
  const t = HANDBOOK.find((x) => x.id === id);
  if (t !== undefined) return t.text;
  const p = PLAYBOOKS.find((x) => x.name === id);
  return p?.text({});
}
