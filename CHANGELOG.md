# Changelog

Everything that changed in Event Horizon, newest first, written for the people who use it. Since the first commit
in April 2026 that is about 390 changes across 152 builds.

Until 0.1.0-alpha.149 builds were numbered `0.1.0-alpha.N`. From **0.1.151** the build number is the patch number:
Vortex ignores everything after the dash when it decides whether an extension has an update, so an alpha number
could never reach you as one.

Published on [Nexus Mods](https://www.nexusmods.com/site/mods/2235): 0.1.0-alpha.85 and 0.1.0-alpha.94
(7 September 2026), then 0.1.151 to 0.1.155.

## [0.1.156] — 2026-09-12

### Curator Tools
- **Requirements show up after you read them.** "Read requirements" counted what was missing and then threw its own
  result away the moment it finished, so the "Missing requirements" and "Needed by others" views never appeared, the
  Requires column stayed empty, the Plugins view had no headers and "Make it work" had nothing to plan from. The result
  now stays, through every later action.
- **Where the details are is said on the page.** When mods need something installed or enabled, a line under the
  buttons says how many, with "Show them" to open that view; each row's Requirements button opens every line with the
  one action that fits.
- **Column widths are yours.** Drag the right edge of any column header in every Curator Tools table — mods, plugins,
  downloads, disk cleanup — to make it wider or narrower; with the edge focused, the arrow keys do the same.
  Double-click an edge for that column's default, or "Reset column widths" for the whole table. Each table remembers its
  widths across restarts.
- The mods table's action column is wide enough for all three buttons; "Requirements" was cut to "Req".
- **The requirements panel reads cleanly.** Every line starts its name and note at the same place whatever its status
  says; Install and Open page sit under the text instead of beside it, where they squeezed a note to one word per line;
  providers are separated and a long archive name wraps inside itself.
- **The action bar is grouped**: what is ticked, then the actions, then Remove, then Kind, each held apart, and the groups
  wrap as whole units on a narrow window instead of wedging "Kind" against Remove.

## [0.1.155] — 2026-09-11

A review of 0.1.152 to 0.1.154 found real problems in what those builds added. This build fixes every one of them.

### License
- **From 0.1.155, Event Horizon is source-available under the PolyForm Strict License 1.0.0.** You may use it; copying,
  changing or redistributing its code needs written permission. Versions 0.1.154 and earlier were released under MIT,
  and copies of those keep it.

### Starfield
- **Light plugins use Starfield's own flag.** Event Horizon read and wrote the light flag at the bit Skyrim and Fallout 4
  use, which on Starfield is a different flag — so a Starfield collection recorded the wrong plugins as light and the
  installer changed that other bit on your plugins. It now uses Starfield's bit, counts medium plugins, and refuses to
  touch flags from a Starfield package built before this fix (rebuild the package with 0.1.155).

### Load order
- **"Turn automatic sorting off" works.** It sent Vortex an action nothing listens to and then said it had worked, both
  from the install prompt and from the Doctor card, so Vortex kept re-sorting. It now uses the action Vortex handles and
  checks the setting really changed; if it did not, you are told before the install goes on.
- **The load-order check looks at the right game and profile.** A collection installed into another game or profile no
  longer shows as moved, and Re-apply can no longer write one game's or profile's order into another.
- **Two collections on one profile:** the newest install owns the order; the older one says "superseded by …" and offers
  no Re-apply.
- **A curator plugin you switched off** shows as "N curator plugins off", not as the sort undoing the order.
- The preview and Re-apply now compute the same order. Re-apply waits while an install runs and cannot run twice.

### Install by link
- **A link can carry its checksum:** `…#sha256=<hex>`. The finished file is checked against it and refused if it
  differs; without one, the install says plainly that the file was not verified. The checksum is shown on screen.
- **Resuming is safe.** A partial download is tied to its link and to the server's version of the file; if the file
  changed, the download starts over instead of joining two different files.
- Plain http links, and redirects to http, are refused. An HTML page (a captcha, an error page) is never saved as the
  package. A connection that goes silent gives up after 60 seconds and can be resumed. A full disk is reported as a full
  disk, not as a dropped connection.
- Pasting a collection's Nexus page follows the link file on that page. A page with several packages asks which one.

### Curator Tools
- **Make it work** installs a requirement whose archive is already in Downloads (it used to wait 15 minutes and fail),
  switches on what it installed, and leaves the mod off when anything in the chain was skipped, saying what.
- **Stop** waits for the install that is already running before the page is free again.
- Enabling a mod turns on the whole chain of disabled requirements, not only the first level. A required page with
  some of its files off shows as "partly enabled".
- Choosing between copies of a mod compares versions properly (2.0.0 over 2.0.0-beta).
- Remove names the mods that have no archive on disk and so cannot be reinstalled.
- Endorse checks that you are logged in and that the mod has a version before sending anything.
- The Plugins view updates right after enable or disable, counts slots per game, and offers the light flag only in
  games that have light plugins.
- The page no longer breaks when the active game changes, and the table no longer breaks while scrolling rows of
  different heights.
- Private notes stay out of mod exports.
- A notification you hovered over closes by itself again.

### Under the hood
- `npm run ui:check` now catches a changed screen; a blank page or one recoloured button used to pass.
- The collection upload script checks every uploaded part against its bytes, rides out network drops for minutes, and
  refuses a file id from another page. The Nexus page script uses its own browser profile and its own tab.

## [0.1.154] — 2026-09-11

### Install a collection
- **A pixeldrain share link works as pasted.** `pixeldrain.com/u/<id>` is turned into the direct download; before this only the
  `api/file/<id>?download` form was fetched, and the share page came down as HTML. A direct download is now named the way
  the server names it (Content-Disposition), so a link that ends in an id still lands as `ivy-panties-1.0.19.ehcoll`.

## [0.1.153] — 2026-09-11

A collection can be installed from its link.

### Install a collection
- **Paste the link.** Under the drop zone the Install page now takes a link: the Nexus mod page a collection lives on,
  or a direct link to a .ehcoll file. A Nexus page's files are read and the package found. With Nexus Premium, Vortex
  downloads it — download only, it is never installed as a mod — and the plan opens the moment it lands. Without
  Premium, the file's page opens in your browser with the exact file named, and you pick it once it is down.
- **A direct link is fetched by Event Horizon itself**, into its own downloads folder. If the connection drops, paste
  the link again and it continues from where it stopped; the finished file's SHA-256 goes in the log.
- A link for a different game says which game to switch Vortex to. A page with several packages asks for the specific
  file's link rather than guessing.

## [0.1.152] — 2026-09-11

Curator Tools is rebuilt around one idea: your whole profile is one table, and the tool knows what every mod
needs. And the curator's load order gets a voice on the player's machine.

### Curator Tools — one workbench
- **One table, one selection.** Every view — updates, manual updates, frozen, missing requirements, needed by others,
  duplicates, disabled, outside Data, not from Nexus — is a filter over the same rows, and the views combine. A search
  box finds a mod, a requirement, a plugin or a provider by name. The table shows every mod without a cap.
- **The action bar follows the ticks** and offers only what applies: enable, disable, update, freeze, unfreeze,
  endorse, reinstall, remove, set kind. Every row has its own Enable/Disable and Requirements buttons.
- **Requirements are read and acted on.** Every mod's Nexus requirements and every plugin's masters are read once per
  game and resolved against what you have: satisfied, installed but disabled, missing, off Nexus, DLC. Each line gets
  the one action that fits — Enable, Install or Open page. Enabling a mod also enables the providers it lists that
  were off; disabling a provider says who needs it and offers to take them down too.
- **Make it work.** One button reads the whole chain of what a mod is missing — each requirement's own requirements
  too — shows the plan (downloads in dependency order, enables, off-Nexus links, pages Nexus did not answer for), lets
  you choose where a page ships several files, then installs one at a time and waits for each to land. Nexus
  downloads directly for Premium accounts only; for everyone else it runs guided, opening each page in turn and
  waiting for the file you fetch through "Mod manager download".
- **Plugins view**: Vortex's plugin list with the mod that ships each plugin, missing versus disabled masters, the
  light flag, and the regular-slot count against the 254 limit. Plugins of disabled mods are listed too. Enable,
  disable and flag light from here.
- **Downloads view**: archives in Vortex's cache that nothing was ever made from, installed one at a time.
- **Notes** on a mod, kept on the mod in Vortex. Start one with `@users` and it ships in the collection: installers
  see it on the plan, under "From the curator".
- **Reinstall is safe again.** It checked that Vortex recorded an archive, not that the file exists, and would have
  uninstalled a mod it could not put back. The archive is looked for on disk first; a mod without one is skipped and
  named.
- **Bulk endorse endorses.** It was sending Vortex the state it wanted, and Vortex's handler toggles, so it had been
  asking Nexus to abstain. It now sends the current state and reads Nexus's answer back for each mod.
- Reads the game's requirements under Vortex's own name for the game (skyrimse) while Nexus uses another
  (skyrimspecialedition); on Skyrim Special Edition nothing resolved before.

### Load order
- **A Load Order card on Doctor** says how the collection's order works — the curator's order pinned for the
  collection's plugins, your own plugins placed by LOOT between them — shows whether it still holds, exactly which
  plugins re-applying would move, and the Restore button. Vortex's automatic sorting can be turned off from it.
- **You are told when it changes.** A Vortex notification appears the moment a sort — automatic on deploy, or the
  Sort button — replaces the collection's order, with "Re-apply curator's order" on it, and goes away by itself when
  the order is back. Home shows "load order ok" or "N moved" on every installed collection.
- Doctor reads the order Vortex holds, so it agrees with the notification instantly, and says when plugins.txt on
  disk has not caught up.

### Under the hood
- Every screen has a golden fingerprint; `npm run ui:check` names any screen whose look changed.
- One line ending in the repository; the plugin header is read once per file instead of twice.

## [0.1.151] — 2026-09-11

The first Nexus release since **0.1.0-alpha.94** — 57 builds and more than ninety fixes and features later.
Grouped by what you do with Event Horizon.

### New: the game is ready before anything installs
- **Game setup check** before every install and every Play. The install stops, with the steps to fix it, when:
  - Vortex is not managing the game (*Manage* was never pressed), or the game's executable is not there
  - the game has never been started once, so its launcher never detected your hardware
  - a game file comes from a different copy of the game — the "Entry Point Not Found: SteamInternal_CreateInterface" error
  - the game is installed under Program Files
- **Clean game folder.** Before installing, Event Horizon purges Vortex's deployment and moves every file the game
  would load that is not part of the game, Vortex or the collection into an *Event Horizon quarantine* folder beside
  the game folder. Nothing is deleted, and the Doctor puts every file back. What counts as "the game" comes from
  Steam's and GOG's own install records, so it is right for every store, version and DLC. DLLs that belong to tools
  beside the game, like the Creation Kit, are left alone.
- **Play button** on Home, My Collections, the install summary and the Doctor. It starts the game through its script
  extender — never the bare game executable — and says why when it cannot. Use it instead of Vortex's Play, which can
  quietly start the game without the extender.
- **Doctor → Game setup**: run the same checks any time, save a **full diagnostic snapshot** (every game and mod file,
  with fingerprints for the ones that matter), **Save logs** into one zip you can send, and restore moved-aside files.
- Warnings, not blocks, for game files that differ from the store's copy and for leftover archive settings in your
  game INI files.

### Installing collections
- An interrupted install continues where it stopped, in the same profile, instead of reinstalling or starting a new
  profile — even after Vortex was killed.
- The curator's copy of a mod is installed beside yours, never over it, and Event Horizon only ever touches mods it
  installed.
- The profile the install filled is the one deployed, and the crash about thirty seconds after a successful install
  ("cb is not a function") is gone.
- Vortex's automatic plugin sorting — on by default, and it undid the collection's load order — is turned off with
  your consent; the curator's load order is restored after LOOT.
- Mods whose installers read your game setup install after what they read exists.
- Stop is honoured at every point; letter-case differences are no longer reported as missing files; Proton/Linux
  staging folders work.
- Healthy mods are no longer reported broken because a plugin wrote to its log file.
- If an install does not finish after the deployment was purged, you are told to deploy again.

### Building collections
- Mirroring reproduces your staging folder and only touches mods Event Horizon installed.
- A fourth answer for a mod: **leave it out**. "Picked nothing in the installer" is measured instead of guessed.
- Every update Vortex knows about is shown — before, a third of them — split per file; addon files are no longer
  mistaken for old versions.
- A deleted mod no longer blocks every build, and cleanup no longer calls live archives leftovers.
- Files you deleted from a mod get their own question, and archive file names with accents or non-Latin characters
  are read correctly.
- Two builds can no longer share a version number.

### Doctor
- Repairs work again — every one had been disabled by a bug — and the Doctor no longer counts its own work as damage.

### Under the hood
- A five-reviewer audit ran before this release. Its critical finding — a Steam Creation Kit could make the game's own
  files look foreign — is fixed.
- More than 2,500 automated tests, and every safety check is proven by breaking it on purpose.
- Releases are published to Nexus and GitHub by one command, with this changelog as the notes.

## 0.1.0-alpha.141 – alpha.149 — 2026-09-10
- The Doctor's repairs work again, and it no longer counts its own work as damage.
- An addon file is no longer mistaken for an old version of the file beside it; the version the author wrote into the
  file name is used when Nexus has none.
- Files a curator deleted from a mod get their own question; archive names with accents are read correctly.

## 0.1.0-alpha.130 – alpha.140 — 2026-09-09
- Vortex's automatic plugin sorting is detected and turned off with consent — it undid the load order.
- Mods whose installers ask about the game install after the answer exists.
- A retry is no longer refused because the previous run worked, and installers no longer refuse because the collection
  "did not exist yet".
- Renaming files on Proton staging folders works.
- Four ways an install reported success while losing something, fixed.
- Cleanup no longer calls a curator's live archives leftovers; two builds can no longer share a version.
- Stale download links are refreshed without picking the wrong version.

## 0.1.0-alpha.102 – alpha.129 — 2026-09-08
- Mirroring only touches what Event Horizon installed, and stopped being a feature that did nothing.
- New answer for a mod: leave it out.
- Every update Vortex sees is shown, split per file.
- A killed install can be resumed, and a resume says which profile it looked for.
- The "cb is not a function" crash after successful installs is fixed; the profile the run filled is deployed.
- A shared .ehcoll can no longer write into Vortex's extension folder.
- Letter case no longer produces "could not reproduce" reports.
- The curator's load order is restored after LOOT has sorted.
- A deleted mod no longer blocks every future build.
- The log says which profile, which mod, and how long each step took.

## 0.1.0-alpha.76 – alpha.101 — 2026-09-07 · alpha.85 and alpha.94 published on Nexus
- The plugin list survives packaging intact — three ways it was damaged in transit.
- Lost ESL flags are detected, and the Doctor can see and fix them.
- plugins.txt and INI files are read from the store-specific folders (GOG, Epic, Xbox).
- A readiness check for the machine, not only the collection.
- The build refuses to make a package that cannot work.
- Resuming an install no longer reinstalls what it installed; a broken mod is repaired even when it was skipped.
- The curator's copy installs beside the user's, never over it.
- The sidebar mark drifts and breathes.

## 0.1.0-alpha.61 – alpha.75 — 2026-09-06
- Packaging asks before packing, stops re-packing unchanged bytes, and no longer suggests declaring LODs.
- Bulk update works through every mod instead of stopping after one.
- A broken .ehcoll says what is wrong with it.
- Logging across every module; everything an install writes to a game is on record.
- The curator page can be left and stopped, and says what it is about to delete.

## 0.1.0-alpha.42 – alpha.60 — 2026-09-05
- **Mirroring**: reproduce the curator's staging folder while mods stay real Nexus downloads, so authors keep their
  downloads and endorsements.
- **Curator Tools**: bulk update (one mod at a time, each verified against its archive), reinstall, enable, set a mod's
  kind, and a disk cleanup that shows its plan before deleting anything.
- The build diff is shown where you decide to build; update lists are searchable tables.
- Endorsing says how long it will take before you press it.

## 0.1.0-alpha.25 – alpha.41 — 2026-09-04
- Automatic deployment is turned off for the install, with one click.
- Curators can mark a mod as edited on purpose.
- Engine injectors such as Engine Fixes Part 2 are reproduced as the right kind of mod.
- A full audit: one vocabulary, one resolver for where a mod's files live, every shipped field accounted for.

## 0.1.0-alpha.18 – alpha.24 — 2026-09-03
- Deployment pre-flight: you are told before the hour-long install, not after it.
- Unfinished and failed installs are shown and recorded.
- An install can be continued without finding the file again, and Event Horizon remembers where you found a mod.
- Branding and the Nexus page.

## 0.1.0-alpha.16 – alpha.17 — 2026-09-02
- "No deployment method active" is reported as a Vortex setting, not a broken mod.

## 0.1.0-alpha.7 – alpha.15 — 2026-09-01
- **Collection Doctor**: a health check for an installed collection, with six real repairs.
- Nexus is asked whether your account can download what the curator packed; mods deleted from Nexus ship as external
  dependencies instead of breaking the install.
- The dashboard tells you when your mods changed.

## 0.1.0-alpha.2 – alpha.6 — 2026-08-31
- The Collection Doctor's foundations.
- FOMOD installers are replayed silently, after a single question before the install starts.
- No time limit per mod — your hardware decides how long it takes.

## 0.1.0-alpha.1 — 2026-08-26 to 2026-08-30
- The first alpha.
- FOMOD choices are replayed; game INI settings are captured and applied, with hardware-specific keys left out; the
  curator's INI tweaks are enabled.
- The curator's plugin order is pinned, with LOOT weaving your own plugins in; ESL flags are carried.
- Install progress with time left and a Stop button; the failure screen leads with what went wrong.
- Packages carry checksums; archives are checked against the ones the collection was built from, and diverged mods are
  reported.
- Linux/Proton: no Windows-only paths, packages read without 7-Zip, a broken 7-Zip reported before installing, and
  Microsoft runtimes offered.
- One dead Nexus link no longer costs the whole install.
- A diagnostic report a tester can paste back.

## 0.0.1 — 2026-04-26 to 2026-08-25 — before the alpha
- The idea: capture a curator's exact mod setup into a portable, verified package and rebuild it on another machine.
- Mod and plugin comparison reports, with mod identity matched across sources.
- The build pipeline: archives hashed and verified against the staging folder, FOMOD installers expanded to real files,
  collisions caught by hash, lost archives re-acquired, and unchanged archives never hashed twice.
- External dependencies and game version requirements in the package.
