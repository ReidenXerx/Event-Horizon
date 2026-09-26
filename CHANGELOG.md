# Changelog

Everything that changed in Event Horizon, newest first, written for the people who use it. Since the first commit
in April 2026 that is about 390 changes across 152 builds.

Until 0.1.0-alpha.149 builds were numbered `0.1.0-alpha.N`. From **0.1.151** the build number is the patch number:
Vortex ignores everything after the dash when it decides whether an extension has an update, so an alpha number
could never reach you as one.

Published on [Nexus Mods](https://www.nexusmods.com/site/mods/2235): 0.1.0-alpha.85 and 0.1.0-alpha.94
(7 September 2026), then 0.1.151 to 0.1.164 as the alpha, and from 0.2.0 the beta.

## [0.2.16] — 2026-09-26

Faster where it was slow for no good reason, and safe when Event Horizon is installed twice.

### Using Event Horizon
- **Reading a package no longer crawls in Vortex 2.7.** Inside the new Vortex, opening a collection package
  to upload it sat on "Reading the package…" for about nine minutes: its 15.5 MB manifest came out of the
  zip at around 30 KB/s, against a fraction of a second outside Vortex. Small entries are now read in one go,
  and big bundled archives stream in 8 MB pieces instead of 64 KB. The same change applies when a collection is
  installed and when a build hashes its files.
- **Uninstalling a collection removes mods in batches.** Vortex undeploys a whole list of mods in one pass, and
  the uninstall used to hand it one mod at a time, paying that pass for every mod of a thousand-mod collection.
  It now removes fifty at a time. If a batch fails, it is retried one mod at a time, so every failure is still
  named and the rest still go.
- **Two copies of Event Horizon no longer both run.** A copy installed by hand and the copy installed from Nexus
  live in different folders, so Vortex loaded both, and both claimed collection archives and watched the load
  order. The first copy now runs, and the second loads nothing and tells you which two are installed, so you
  can remove one. Keep the one installed from Nexus: it updates itself.

## [0.2.15] — 2026-09-25

A patch of your own for one of the collection's plugins now stays below that plugin when Event
Horizon puts the curator's load order back.

### Using Event Horizon
- **"Re-apply curator's order" no longer moves your patch above the plugin it patches.** Re-applying
  puts the collection's plugins back in the curator's order, in the slots LOOT gave them. LOOT had
  placed your own plugins relative to where those plugins used to be, so a patch of yours sitting
  right under a collection plugin could end up above it. A patch that loads before its master does
  nothing: the master's records win. A tester's one-record patch for a companion sorted correctly
  under LOOT and landed one slot above the companion after every re-apply. Event Horizon now reads
  the masters of your own plugins and moves any that ended up above a master to just below it. The
  collection's plugins still load exactly in the curator's order. This applies to the install, to
  the Doctor's Re-apply button and to its preview.
- **The load-order notification says what re-applying does.** It used to say your own plugins "keep
  their places either way". Their slot numbers did, but the collection's plugins were reordered
  around them.

## [0.2.14] — 2026-09-25

Uninstalling a collection now removes all of it, not only its latest revision. A player asked how to
uninstall a collection, and the honest answer was: partly, from a button most people never found.

### Using Event Horizon
- **Uninstall removes every revision's mods, and shows its plan first.** A collection is uninstalled
  from its card now, not only from inside its details. Before anything happens you see the whole
  plan: the mods Event Horizon installed for the collection, in any revision, which are removed; the
  ones it keeps and why (another installed collection still uses them, or you enabled them in one of
  your own profiles); and the collection's profiles as a tick list. Mods you already had before the
  collection are never touched. The profile Vortex is on right now cannot be deleted from here, and
  the dialog says so. Game INI settings, light flags set on plugins, and files moved to quarantine
  are not changed back, and the dialog says that too.
- **Mods a collection dropped between revisions are remembered.** Until now, every update rewrote
  the collection's record with the new revision's mods only, so a mod the curator dropped lost the
  only proof that Event Horizon had installed it, and stayed on your disk for good. The record now
  keeps those mods from update to update, so uninstall can reach them. This starts with your next
  update: mods dropped before it left no record to find.

### Building collections
- **A Nexus server error during upload no longer reads as a rejection.** "Nexus rejected the upload:
  HTTP 504" was Nexus's server timing out, not a verdict on the collection, and the upload may still
  have gone through. The message now says so, and asks you to look for a new draft on the
  collection's Revisions tab before uploading again, so you do not end up with two.

## [0.2.13] — 2026-09-24

Two players lost an evening each to something Event Horizon could have told them first. Now it does. And
an update that waited three hours on a question nobody could see now goes through.

### Installing collections
- **A game without the Creation Club content a collection needs is stopped before anything
  downloads.** A player whose GOG Skyrim had no Anniversary Upgrade installed all 1,746 mods of a
  collection, then watched the game close a few seconds after starting, with no message. The
  collection's plugins list 70 of that upgrade's files as masters, and the game cannot start without
  a master. The build always knew this and told only the curator. A collection built on 0.2.13 now
  carries the list of Creation Club files its plugins need, and the install preview checks your
  game's Data folder for every one of them before a single mod downloads. If any are missing, it
  names them and says where they come from. For Skyrim that is the Anniversary Upgrade, which on GOG
  is a DLC you tick in GOG Galaxy under Manage installation → Configure. A collection built before
  this cannot say what it needs, so its preview says the files were not checked, and nothing is
  refused on that account.
- **A game inside OneDrive or Dropbox is refused, like one under Program Files.** Vortex links every
  file of every mod into the game folder, hundreds of thousands of files for a large collection. A
  synced folder tries to upload every one of them, can lock files while it works, and can swap files
  for online-only placeholders that have to download again before the game can read them. Install
  and Play now refuse a game folder inside OneDrive or Dropbox and say how to move it. If your game
  is in OneDrive today, Play will ask you to move it first. Google Drive is not recognised, because it
  keeps its folder in a database Event Horizon does not read.
- **"Move the game" now says where to.** The advice for a game under Program Files suggested D:\Games
  to everyone. Vortex's links cannot cross drives, so a player whose mods live on C: followed it into
  a game Vortex could no longer deploy to. The steps now name the drive your Vortex mods folder is on.

### Updating collections
- **An update no longer stops on a question nobody sees.** When a curator changes one of their own
  bundled mods, the previous revision's copy still holds that mod's name, and Vortex stops the
  install to ask whether to replace it or install a variant. That is one prompt per mod, and Event
  Horizon cannot answer it for you. One player's update stopped at mod 1,106 of 1,746 and waited
  three hours, and the half-built profile then started the game without Address Library. Replacing
  would change the mod in every profile, including the one you are playing, and a new revision
  builds into its own profile so that one stays intact. So the new copy now goes in beside the old
  one, and a resumed update finds it instead of installing it twice.

### Building collections
- **An archive that installs into the wrong folder is caught, and the build refuses it.** Vortex
  strips an archive's outer folder only when something inside matches what it expects for the game:
  a plugin, a BSA or BA2, a folder like textures or scripts. Meridia's grass cache matched none of
  those, so from 1.0.17 to 1.0.23 every player got it in a folder the game never reads. The build
  compared file names by their endings and let the extra folder through. It now works out where
  Vortex will put each file of a plain archive, using Vortex's own rule, and refuses a build whose
  archive would land anywhere else. The message names the mod and gives three ways out: re-pack the
  archive, mirror the mod, or bundle it.
- **Rebuild to protect your players.** Only a collection built on 0.2.13 or later carries the list of
  Creation Club files for the install check above. Older revisions install as before, with a
  "not checked" note.

### Elsewhere
- **A tech deep dive on the Nexus page and in the README**: a short side-by-side of how vanilla
  Vortex collections and Event Horizon differ, for readers who want the approach rather than the
  pitch. Every Vortex claim in it was read from Vortex 2.7's own code.

## [0.2.12] — 2026-09-23

Three fixes to the Doctor, each one a thing it said that was not true.

### When something goes wrong
- **Your own mod rules and LOOT rules are no longer "drift".** The Doctor compares the rules a
  collection applied with the rules set right now, and it flagged any difference, including rules
  a player had added on top. Adding your own does not change the collection, so that now stays
  healthy and says so: everything the collection applied is still there, plus yours. Only a drop is
  flagged, because a count can prove exactly one thing: a rule the collection set has gone. This
  covers mod rules, LOOT ordering rules and LOOT group assignments. A player asked for this, and they
  were right.
- **DirectX 9 is no longer reported missing on every PC.** The **System runtimes** check looked for
  the legacy DirectX DLL in a folder that does not exist, `C:\WINDOWSSystem32`, its separator lost
  to a one-character slip. So it said MISSING whether you had it or not, offered to install it, and
  after the install checked the same wrong folder and said missing again. Saved log bundles carried
  the same false line. It now looks in System32, and the same slip cannot come back unnoticed: a
  test now fails on it anywhere in the code.
- **.NET Desktop Runtime 8 is found when it is installed.** The check read an installer record in a
  shape that record never has, so it reported .NET 8 missing on machines that have it. It now reads
  the folder .NET itself uses to find a runtime. A folder it cannot read is reported as "could not
  check", never as missing.

## [0.2.11] — 2026-09-23

Two fixes, both found by someone looking rather than by something failing.

### Using Event Horizon
- **"Something went wrong" no longer appears on every deployment.** A user reported an error dialog
  that fired every time Vortex deployed, and that had never broken anything they could point at.
  They were right: the message — `ResizeObserver loop completed with undelivered notifications` — is
  not a fault. It is the browser saying it could not fit every layout notification into one frame
  and delivered the rest in the next one, which is exactly what a deployment's constant redrawing
  provokes. Event Horizon watches the whole application's errors on purpose, because a silent
  failure is worse than a noisy one, and it already tells its own errors apart from Vortex's — but
  that only ever distinguished two things, and this is a third: not an error at all. It is now
  recognised and left alone. Real errors are untouched, including any genuine fault that happens to
  mention the same browser feature.

### Building collections
- **The two most-installed plugins in modding are readable again.** A plugin's header can carry a
  block too large to state its own size — the unofficial patches for Skyrim and Fallout 4 both do —
  and the format handles that with a marker that gives the real size separately. Event Horizon's
  reader did not know about the marker, lost its place a few hundred kilobytes in, and gave up on
  the whole file. Measured across 2,486 plugins on one machine, those two were the only ones
  affected, and they are the cornerstone of most collections: the Unofficial Skyrim Special Edition
  Patch and the Unofficial Fallout 4 Patch. The build's missing-master check counted them as
  unreadable instead of checking them, the requirements pass lost the mods they depend on, and the
  ESL flag tool could not read them. All three work now.

## [0.2.10] — 2026-09-23

The headline is that Event Horizon looks like one piece of software now — and that a long audit of
the repair and packaging code found real damage before anybody hit it.

### A new look
- **The home screen is a dashboard, not a menu.** It opens on what your setup actually is: the
  collection you installed and its health, your load order, disk use, and the mods you have, with
  live figures instead of a list of buttons. There are two modes behind a toggle, so you can have
  the quiet version or the full one.
- **The whole app is repainted in near-black.** One palette, applied everywhere, with the decorative
  starfield and nebula removed — colour now means "act on this" rather than "this is a screen".
  Several things were unreadable against the old background and are not any more.
- **The first screen you see says what this page becomes** rather than showing an empty frame before
  a game is picked.

### The Collection Doctor
- **Its repairs now check which game and profile you are on.** "Restore the collection's ESL flags"
  rewrites bytes inside plugin files in the game folder, and it did that wherever Vortex happened to
  be pointing — so with the Doctor open on one collection while Vortex managed another game, one
  press wrote one setup's flags into another's, permanently, with no way to undo it. It refuses now,
  and says why. It also asks before it runs, which it never did.
- **Re-applying the collection's mod rules actually replaces the rules that contradict it.** It was
  calling the installer's own function with an argument missing, so your conflicting rule stayed
  beside the collection's, the toast said it had applied all of them, and the check stayed red —
  which is why pressing it again never helped.
- **Two repair dialogs no longer claim to destroy things they do not touch.** Re-applying mod rules
  and LOOT rules said "rules you added yourself will be lost". Neither wipes anything: only a rule of
  yours that contradicts the collection's on the same pair of mods is replaced, and the LOOT one
  removes nothing at all. They stopped asking; the flag repair started.
- **"Enable N mods" enables the N mods it found**, and says so. It used to enable every mod in the
  collection — 978 of them under a button that said 3 — including mods that are not installed any
  more, and reported success against a profile that no longer existed.
- **Restoring ESL flags tells you when your game still will not start.** The sentence about being
  over the 254-plugin limit was being worked out and then thrown away on exactly the runs where it
  matters: hundreds restored, hundreds locked, still over the limit, reported as a success.
- **One repair at a time.** Every other repair's button stayed live while one was running, so three
  could overlap — one changing the plugin list another was writing.
- **A collection for a game Vortex is not managing says so**, instead of "you are on a different
  profile" with a one-press button that would have purged the game folder.
- **An unreadable Vortex state reads as "not checked", not as catastrophe.** If the mod list could
  not be read at all, the Doctor reported every mod in the collection as missing and offered an
  hour-long reinstall.
- **The health ring stops filling up as the Doctor learns less.** Checks that could not run were
  dropped from the total, so a panel where most checks never ran drew a full circle at 100%. They
  count now, and the header says how many could not be run.

### Installing collections
- **Pressing Stop is no longer reported as a crash.** Stopping during verification left the driver
  by a route that recorded it as a failure and showed "Install driver crashed" with a report to copy
  out. It was your own Stop, in both the record and the message.
- **A mod Event Horizon installs mid-run is recognised as its own.** In a few repair and retry
  paths it was not, which meant a second copy of our own mod could be installed beside the first —
  and the record that switches your original mod back on afterwards was overwritten by it.
- **Mods recovered by the retry pass are reconciled like every other mod.** They were being skipped
  with a message saying the curator's archive could not be found, about mods installed from that
  archive seconds earlier — and counted as reconciled anyway.
- **A file restore that cannot be finished atomically keeps the good copy.** On Proton and Wine
  every restore takes that path, and a failure there deleted the destination and then discarded the
  verified replacement, leaving the file simply absent.
- **A mod whose folder could only be read in part is no longer certified as an exact match.**

### Building collections
- **The missing-master check asks what the collection ships, not what you have.** It was reading
  your whole plugin list, so the one case it exists for — "it works on your machine because you have
  that master from outside the collection" — was the case it could not see. Measured on both
  published collections before the change: 1,586 and 785 plugins checked, nothing missing, so this
  tightens the check without refusing a build that works.
- **A mod whose folder could not be fully read is never mirrored.** The guard that stops that was
  reading the result sixty lines before it existed, so a mod answered "reproduce my version" in an
  earlier build shipped with a file list known to be short — and on the player's machine every file
  under the part that could not be read would have been deleted as theirs, then reported as perfect.
  The build now refuses outright rather than trusting the ordering.
- **The self-check counts what it checked.** A mod whose check threw, a run you cancelled, and a
  7-Zip that could not be found each produced a result that looked complete: zero findings, zero
  warnings, and nothing saying nothing had run.
- **Files that could not be checksummed are named.** They fall back to a size-only comparison, which
  counts as "explained" — on a real collection that comparison found 1,130 files that had changed at
  the same path and the same size, so size alone would have caught none of them.
- **A cancelled build stops at the decision screen** instead of walking the whole profile first.
- **Warnings say what was measured.** The stale-archive hint claimed a property of all 1,176
  differing files after looking at ten of them; the empty-plugin-order refusal told you to launch
  the game when the file had in fact been read and was simply empty; and the undeclared-changes
  warning told you to hand-edit a config file for the same mods the build had just asked you about
  on screen.
- **Drift detection stops matching a file at the top of an archive against one in a subfolder** —
  a `readme.txt` beside a `docs/readme.txt` hid a real difference in both directions.

## [0.2.9] — 2026-09-22

The headline is for players: a collection built on another game version no longer turns you away.

### Installing collections
- **A different game version is a warning now, not a wall.** A collection built on one version of
  the game used to refuse every other version outright. Almost nothing in a collection cares: meshes,
  textures and plugins run on any build. What breaks is script-extender plugins, the `.dll` files
  compiled against one game executable. So the preview now explains the difference, offers both
  roads (keep your version and swap the mods that will not load, or change the game to the
  collection's version), and holds Continue until you tick one "I understand" box.
- **It names exactly which mods to swap.** Every script-extender plugin says in its own file which
  game versions it runs on, and Event Horizon checks each one against yours, for the copy that
  actually deploys when two mods ship the same file. On a real 1,746-mod Skyrim collection built on
  GOG 1.6.1179, a player on Steam 1.6.1170 is told to swap 6 mods (the GOG-specific builds), and
  the other 230 plugins are counted as working on any version through Address Library. A plugin
  that decides for itself when the game starts is counted, never named as a problem.
- **The Steam-versus-GOG warning got the same treatment for Skyrim.** It used to name every mod that
  ships a script-extender plugin, 245 on that collection, whose true answer was 6. Where the
  collection records what each plugin declares, the list is the judged one. Fallout 4 plugins do not
  say which store they are for, so there the old list stays.
- **Collections built before this release carry no plugin data.** For those the preview says it
  cannot name the exact mods, rather than guessing.
- **The install itself checks the tick too**, and for the same pair of versions you saw. A game that
  updated between the preview and the install is a different question and gets asked again. The
  install record notes that it ran on a different version, so a later problem can be traced to it.

### After you play
- **Event Horizon asks whether the collection worked, once you have actually played it.** Nexus
  keeps a success rating for every collection revision, and until now an Event Horizon install could
  never vote. The question waits until the game has started through Event Horizon's Play button,
  because before that nobody can honestly answer it. Answer "it worked" and you are offered the
  collection's endorsement as well.

### Building collections
- **Every build records what each script-extender plugin declares**, which is what makes the swap
  list above possible. It reads the plugins on every build, never from a cache: the answer depends on
  the file and on Event Horizon's reader, and a cached one could survive either changing.
- **A plugin that cannot load on your own game is flagged at build time.** On a real Fallout 4
  collection that caught a crafting-highlight plugin built only for the next-gen update, shipping to
  a 1.10.163 game where it silently never loads.
- **A plugin with a very long exported name no longer reads as damaged.** One real plugin exports a
  1,458-character name, and the reader stopped at 1,024.
- **Linked files inside a mod are kept when the staging folder is reached by its short Windows
  name** (`VORTEX~1`). The build and the install check compared the two spellings of the same folder
  as text and dropped the links as "outside the mod".

## [0.2.8] — 2026-09-21

Almost all of this is the curator's side, and most of it was found by building a real collection on
0.2.7 and watching where the tool told the truth about the wrong thing.

### Building collections
- **A mod you answered "mirror" for no longer blocks the build.** 0.2.7 started refusing to build
  when a mod the player supplies by hand had no archive on your machine — a good rule with a hole in
  it: mirroring already carries that mod's files in the package. With no archive there is nothing a
  mirror could leave to one, so it carries *all* of them and writes them over whatever the player
  supplies. The refusal pushed curators toward bundling, which replaces the author's download, and a
  curator who would not do that to an author was left with no answer at all — for a mod they had
  already answered and which the previous release shipped correctly.
- **Two warnings had the same blind spot and said the opposite of the truth.** The build form said a
  mirrored mod would make the build refuse; the drift warning said "the collection ships the
  ARCHIVE, so whoever installs it gets the original, not your version" about a mod whose files the
  package carries. Both now recognise mirroring, and both offer it alongside bundling with the
  difference stated: mirroring leaves the author's download in place, bundling replaces it.
- **A stale copy of an archive is now suspected before you are asked to decide anything.** Regenerate
  a mod, upload the new archive, update the link — and forget to replace the copy in Vortex's
  downloads, and the build compares your new staging against the old file. On a real build that read
  as "1,176 files its archive cannot produce", every word true of the file on disk and none of it
  true of the file players download. Event Horizon now notices that every differing file was written
  after the archive was, says both dates, and names the cheapest thing to try first. It only fires
  when *every* differing file is newer — a regeneration rewrites the whole output at once, while a
  handful of hand-edited files is a real difference with a real decision behind it.
- **Why that mattered more than a bigger download:** the build records your archive's checksum as the
  one a player's download is held to. Build on a stale copy and every player who fetches the correct
  file is told they have the wrong one.
- **The checksum pass says what it is doing.** It reported one line per mod when the mod finished and
  nothing in between, so a 39.7 GB output was eight minutes of total silence — indistinguishable from
  a hang, and reasonably reported as one. It now names each mod, its file count and its size when it
  starts, then reports progress and throughput every fifteen seconds.
- **And it no longer opens every file at once.** It started a read for every staged file
  simultaneously — over three thousand on a single mod — which is a way to run out of file handles
  and a way to make a disk seek instead of stream. Measured on one profile: a 3,040-file mod managed
  11 MB/s while a 68-file mod on the same disk managed 80. It is bounded now, by the same cpu-aware
  limit the hashing pass has always used.
- **"Re-read every file" explains itself.** It is a repair tool, not an extra safety check, and the
  card now says so and names the moment to tick it: when the build refuses a mod because its files
  changed after it measured them and you know nothing changed. You never need it for files you
  edited — changing a file moves a timestamp nothing can fake, so it is re-read on its own.
- **An archive Event Horizon recovered for you keeps its download link.** The record was written and
  then quietly dropped every time it was read back, so the hash outlived the file: a later build
  could identify a mod and not open it. Measured on a real machine before the fix — 990 recovered
  entries, none of them carrying the link.
- **Builds start faster.** Adding the creation-time field to the hash fingerprint in 0.2.7 left every
  previous entry unmatchable, and nothing removed them: 430,675 dead entries, 134 MB of JSON read on
  every build. They are dropped on load now.

### Under the hood
- The screenshot check photographs whole screens. It captured a fixed window and quietly cut anything
  taller, then compared the part that fitted and reported a match — so the bottom third of the build
  form and, worse, half of the Done screen, including every post-processing decision card, had no
  cover at all while looking exactly as covered as the rest.
- Deploying a development build refuses to ship compiled output older than its sources, after a
  deploy silently shipped the previous build with a matching version number and a passing smoke test.

## [0.2.7] — 2026-09-20

The update path, end to end. Most of 0.1 and 0.2 went into making a first install right; this release
is the second install, the third, and the one that failed halfway. Alongside it, a pass over every
place the tool could report a check it had not actually run.

### Updating a collection
- **An update is decided by the revision, not by the version string.** Two very different things used
  to hang on whether the curator remembered to change a number. A new revision builds into its own
  profile, so the version you are playing stays switchable and nothing is removed until the new one
  works; the same revision re-run stays the in-place repair it should be. The Update button already
  compared revisions — the installer now branches on the same fact, so the two cannot disagree.
- **A failed update resumes the profile it was filling instead of forking another.** Press Update,
  die at mod 400, press Update again, and you got a second profile with the same name — then a third.
  Since Vortex reopens on whichever profile was last active, you were usually looking at a different
  one from the one filling up, which is what "Event Horizon installs mods disabled" turned out to be.
- **A check that could not reach Nexus no longer erases an update it found earlier.** Not logged in,
  offline, a 503 — all of these produced an empty answer that replaced what was known, so the Update
  button silently disappeared and nothing said why. Only collections Nexus actually answered for are
  replaced now.
- **You are told which mods the new revision dropped.** Nothing is deleted — it never was, and it
  still is not — but a mod the curator removed simply stopped being mentioned anywhere, while staying
  in Vortex's pool and switched on in your previous profile. The Done screen now names them and says
  where they are still enabled. This is also the answer to "why is my staging folder 40 GB bigger
  than the collection".
- **INI tweaks the new revision dropped are switched off again.** Applying them has always been
  additive, so a performance preset the curator later removed stayed merged into your INI at every
  deploy, permanently, with nothing to explain the difference. Only tweaks Event Horizon itself
  ticked are switched off; your own are left alone, and you are told which went off.
- **An INI tweak is never ticked on a mod you kept as your own.** Vortex stores that setting on the
  mod rather than the profile, so it followed your copy into every other profile of that game and
  outlived uninstalling the collection.
- **Nothing is pre-ticked on the "remove superseded profiles" screen.** Every profile started ticked
  with "Remove ticked" as the obvious button, so opening it to look and pressing the obvious button
  destroyed all of them — including the previous revision's profile, which is the rollback the whole
  design exists to give you.
- **"Uninstall it" now says it removes the mod from every profile, and names the others.** True of
  Vortex's own behaviour all along; the prompt said "destructive" without saying that part.
- **An update can no longer reset an install that is already running.** The busy check happened
  before a download that takes minutes and never again, so a collection you started meanwhile had its
  wizard reset out from under it.
- **The kept copy of a collection is matched by revision**, not by a version string that two
  revisions can share — which could otherwise let a repair walk you backwards into the revision you
  just left, with every check passing.
- **One update check per moment, and one retry when Nexus has not finished logging you in.** Two
  callers arriving together asked Nexus twice and the later answer won; a session that had not
  settled at startup meant no check at all until you switched game or opened Collections.

### Installing
- **A file you supply by hand is checked the moment you pick it.** It used to be matched on filename,
  shown as "Linked archive" in green, and only actually compared an hour into the run as a log line
  nobody reads. The verdict — matches, differs, or damaged — now appears next to the pick, naming the
  file the curator built with, while going back for the right one still costs nothing. Warned, never
  blocked: a replaced download may be the only one the author still offers, and that is your call.
- **A remembered answer from the previous revision gets the same check.** It was pre-filled, counted
  as answered and unblocked Continue without anyone touching it — the one path that most needs it.
  And an answer you take back is now forgotten, instead of being pre-filled again next revision after
  you explicitly refused it.
- **The mirror no longer deletes files you wrote.** Anything absent from the curator's list counted
  as "extra", which is right on a folder made minutes ago and wrong on one lived in since the last
  revision — so BodySlide and Nemesis output could be removed, reported as "37 removed" with no way
  to know what. Files changed since the last install are left alone, and deletions are named.
- **Changed-since-last-time detection measures before the run can change it.** It ran after the
  mirror and the repair had already rewritten the folders it was asking about, so it could miss real
  drift and could also warn you that something edited a mod seconds after Event Horizon edited it. A
  mod whose recorded file list changed this revision is no longer reported as drifted either — that
  is the collection changing, not your disk.
- **A download that stops without saying so now ends with a message.** Paused, failed and removed
  were all handled; a transfer that simply stalls publishes nothing, so the wait ran forever and the
  only way out was killing Vortex mid-install. It gives up after fifteen minutes with no bytes at
  all, never while Vortex is hashing a finished transfer, and never on a download still queued —
  slow is not a failure.
- **Missing Visual C++ and .NET runtimes are offered before the install, with a button.** These have
  been detected for a while and turned into a sentence in a list; the fix was one paragraph away from
  the person who needed it. Now: a callout above the plan, installed silently from Microsoft, then
  re-probed so the result is what the registry says afterwards. Offered, never enforced — and only
  for runtimes genuinely absent, never for a probe that could not run.
- **"Files verified" now means files actually verified.** Where a collection carries no checksum for
  a file, it can only be size-checked — and a size match is reproduced exactly by a rewrite of the
  same length. Those are counted separately now, under "Size-checked only", instead of being added to
  a number that claimed more than had happened.
- **A collection too old to carry checksums says so.** That case used to render no integrity section
  at all, which looked exactly like a fully verified clean install — the one situation where nothing
  can be promised, looking like the most confident one. It still installs; it now tells you.
- **The launcher check refuses to answer about a file it could only read in part.** It reads which
  symbols a game executable needs from the DLLs beside it — the check that catches a GOG
  `steam_api64.dll` in a Steam install. A partly-read table meant fewer missing symbols, which reads
  as "this is fine". It now says "cannot tell" instead.

### When something goes wrong
- **The log bundle carries the script extender's log and what runtimes the machine has.** "My body
  physics stopped working" has at least four causes that all verify byte-for-byte, and asking a
  tester to find `f4se.log` and recite their installed VC++ versions is a round of questions that
  usually ends in a guess. Both now ride in the file you already send.
- **Event Horizon reads that log.** F4SE and SKSE are the only things that know whether a DLL loaded
  at all, and nothing here had ever looked. Per plugin: loaded, skipped, or failed — with the
  extender's own words as the reason, and support DLLs that the extender deliberately skips reported
  as skipped rather than as two failures to go hunting.
- **A mod supplied from a file that did not match is named when it is why the mirror could not
  finish.** The run knew both halves and reported "4 could not be mirrored" with nothing connecting
  it to the download you chose.

### Building collections
- **Every file of an external mod is checked against its archive, whatever the mod weighs.** Drift
  detection compared file NAMES, which is blind to the thing curators do most: regenerate an output
  mod. A regenerated BodySlide output shipped with 1,130 of its 2,994 files disagreeing with the
  archive players download — every name identical and every size identical, because rebuilding a mesh
  moves vertices, not file layout. The tester downloaded the correct archive and still got meshes the
  collection was never built against. Checksums are the only thing that can tell, so checksums are
  what it reads now, with no size budget: a 19.7 GB output is exactly the mod where half a check is
  worthless.
- **That check costs about five minutes on a 43 GiB collection, and is paid once.** Checksums are
  cached against the file's SHA-256 — the content, not its name or timestamp — so unchanged bytes are
  never read twice, and the same mod in two collections is read once ever. A cache that cannot be
  wrong is the only kind this check can have.
- **A file whose timestamp was restored can no longer look unchanged.** The hash cache keyed on path,
  size and modified time, which several tools reproduce exactly when they rewrite a file. It now also
  carries the creation-time field, which no timestamp-restoring tool can forge. One consequence worth
  knowing: this invalidates the existing cache, so your next build re-reads everything once and is
  fast again after.
- **A plugin whose master list could not be read in full is refused, not half-reported.** The reader
  returned what it had reached, the gate read that as the complete list, and a plugin with masters
  missing could ship in a collection that will not load on a machine without them.
- **A build refuses when a mod the player must supply by hand has no archive here.** The curator's
  archive is the only thing that makes that picker safe — without it there is nothing to check the
  player's file against. The build names those mods and all three ways out, and the form says it
  before Build is pressed.
- **Disabling a mod takes it out of the collection, quietly.** The dashboard reported it as "switched
  off — needs attention" while the build treated the same profile as having one mod fewer: two
  answers about one profile, one screen apart, with "uninstall the mod" as the workaround.
- **The changelog no longer writes "first release" because it stopped looking.** It opened three
  packages in the output folder and gave up, and republishing the same version consumes a slot every
  time, so three of those beside the new build discarded the entire history in silence. It reads the
  folder now, and says what it found either way.
- **Collection artwork is re-checked when it is read, not only when it is extracted** — a promise the
  code made in its own first paragraph and kept only on the way in.

### Under the hood
- The screenshot harness freezes its clock, so a run is byte-identical to the last one and a failing
  check means something actually changed.
- Proofs kept for resuming an interrupted install are pruned on read instead of accumulating forever
  across releases.
- A helper that was written, tested and never called — while the installer reinstalled about 11% of
  every collection for no reason — is gone, along with the quiet overstatement inside it.

## [0.2.6] — 2026-09-18

### Installing
- **Hardlink deployment is now required.** Event Horizon refuses to install when Vortex is set to copy or
  symlink deployment, and says where to change it. Copy is the one that bites silently: a Vortex purge under
  copy deployment rewrites plugins from your staging folder, which undoes the collection's ESL flags — a big
  collection then stops loading and nothing in the install reports a problem. Symlink is not supported or
  tested. If Vortex does not tell us which method it uses, the install goes ahead as before, and **Play is
  unaffected** — a collection already on your disk still starts.

### Fewer silent hangs
- **Three waits that could last forever now end with a message.** Cleaning the game folder before an install,
  uploading a collection, and starting a collection update all waited on Vortex to call back, and nothing
  ended the wait if it never did. None of these is a time limit on the work itself: the purge gets the same
  budget the install's own purge uses, sized by your mod count; the upload only gives up after **fifteen
  minutes with no progress at all**, so a multi-hour upload of a large package is untouched; and the update
  waits a minute for Vortex to accept the download, not for the download to finish. Cancelling an upload now
  also ends it on our side instead of waiting for Vortex to agree.

### Building collections
- **A build no longer claims a deployment method it could not read.** It recorded "hardlink" whenever Vortex's
  setting was unreadable, which could produce a "deployment method differs" line about something nobody had
  observed. It now records that it did not know, and older versions of Event Horizon can still read packages
  built this way.

## [0.2.5] — 2026-09-18

### Installing
- **Mods install without you clicking Install for each one.** Event Horizon asked Vortex to download *and*
  install each mod in one step — but whether Vortex does the second half depends on its own **"Install mods
  when downloaded"** setting. With that off, Vortex posts a "Download finished / Install" notification and
  waits for a click, so the run sat on every mod for ten minutes and then gave up. A tester with 963 mods
  spent a session clicking Install per mod, and the only mods that went through by themselves were the ones
  carrying the curator's installer answers, because those already took a different path. Every mod now takes
  that path: Event Horizon downloads, then installs it itself. Your Vortex settings no longer change whether
  an install can finish.
- Vortex's "Download finished" prompts are cleared while an install runs, like the other prompts that are
  wrong to answer mid-install — its **Install All** button would install the very mod Event Horizon is
  installing, and a second copy is what raises Vortex's "replace, or install as a variant?" question.

## [0.2.4] — 2026-09-18

### The Doctor
- **Repairs no longer ask you to go and find the collection file.** Half the Doctor's repairs re-run a step
  of the install, so they needed the `.ehcoll` — and nothing had ever recorded where it went. The tool that
  could name your exact problem was answering "fix my load order" with "first find the file you installed
  weeks ago". Event Horizon now **keeps a copy of every collection it installs**, beside that install's
  receipt, and uses it without a word. If it is ever missing, the exact revision you installed is downloaded
  again from its collection page — not the newest one, which would be a different collection.
- **Every repair is one press.** Restoring the load order, the ESL flags, re-enabling the collection's mods
  and switching to its profile now just happen when you press the button: they put back a recorded state,
  they remove nothing, and you can undo them by doing the opposite. Re-applying mod rules or LOOT rules
  (which replace what you set for the game) and reinstalling mods (which rebuilds mod folders) still say
  what they will do first.
- The deep scan and the repairs that were labelled "Needs the package" now say **"Reading the collection…"**
  or **"Fetching the collection…"** while that is happening, instead of looking broken.
- Uninstalling a collection deletes the kept copy along with its receipt, so nothing is left on your disk.

## [0.2.3] — 2026-09-18

### Installing
- **A dialog waiting for you is no longer mistaken for a hang.** Event Horizon already paused its stall timer
  while Vortex had a dialog open — but it was watching the wrong place, so the most common dialogs of all did
  not count: Vortex's own "Invalid fomod", "replace or install as a variant", and every error it asks you
  about mid-install. Two testers lost mods to this in one week, one of them while asleep. All of them pause
  the timer now, for as long as the dialog is on screen.
- **A mod that finished installing late is no longer installed a second time.** If a dialog held a mod past
  the stall timer, Event Horizon gave up on it and Vortex went on to install it anyway once the dialog was
  answered. The end-of-run retry then re-installed it, walked into Vortex's "replace or install as a
  variant?" question, stalled again, and recorded a mod as FAILED that had been installed for hours. The
  retry now re-asks Vortex's mod pool first and adopts what is already there.
- **Verifying can be stopped and continued.** Checking a 3,000-mod collection takes hours, and stopping it
  used to throw away everything it had proven. Each mod is now recorded as it passes, so the next run picks
  up where it left off. A proof is used again only for the same collection version, at the same level, and
  only while Vortex says the mod has not been re-installed since — otherwise it is checked again.

### Before installing
- **"Not a clean game" is no longer said about Event Horizon's own deployment.** After a collection was
  installed, every later preview warned that the game folder was not clean — about the collection's own
  files, with nothing foreign in the folder at all. There was nothing the player could do to clear it. When
  nothing unmanaged is present and the game's own files are intact, this is now shown as information, and it
  still says what Install will do to those files. A warning returns the moment something foreign is there.

## [0.2.2] — 2026-09-17

### Playing
- **Play no longer refuses a correctly downgraded game over its launcher.** Simple Fallout 4 Downgrader moves
  Fallout4.exe and steam_api64.dll back and leaves Fallout4Launcher.exe, which then cannot load the older DLL.
  Event Horizon refused to start the game because of that launcher, which Play never starts. A DLL mismatch
  now stops Play only for the script extender's loader and the game itself. For any other program Event
  Horizon warns, says a downgrade leaves exactly this, and says not to swap DLLs to make it go away.
- **Play checks the game's version before starting it.** When Steam updates a game after you installed a
  collection, the script extender closes without a word. Play now compares the game's version with the one
  the collection on your active profile was built for. If they differ, it stops and says how to move the game
  back, and on Steam how to stop it updating again. This covers collections installed with this version or
  later, and a version that cannot be read never blocks.

## [0.2.1] — 2026-09-17

### My Collections
- **A card no longer says "current profile" about a collection you are not playing.** That badge described how
  a collection was installed: into a profile of its own, or into the profile that was active at the time. But
  "current profile" read as "this is the profile Vortex is on", so an older install could look current while
  the collection you were actually playing said "active". It now says **own profile** or **existing profile**
  (hover it for what that means), on the collection cards, the Dashboard and the details view, and **active**
  comes first on the card of the collection whose profile Vortex is on.

### Building collections
- **Copy the changelog as Markdown after an upload.** Nexus collection pages take Markdown, so the upload dialog
  now offers **Copy changelog (Markdown)** beside the BBCode copy: this version's changes, ready for the
  revision notes.

## [0.2.0] — 2026-09-17

**Event Horizon is in beta.** Collections can now live on Nexus collection pages: you add one there, Event
Horizon installs it, and when the curator publishes a new revision Event Horizon offers you the update.

### Installing collections
- **Add collection on a Nexus collection page opens in Event Horizon.** Vortex downloads the collection and
  Event Horizon opens its install, instead of Vortex installing it: Vortex loses files when it installs
  hundreds of mods at once, and it cannot carry the curator's ESL flags, installer answers or load order.
  Only Event Horizon collections are taken this way. Every other Nexus collection installs in Vortex as it
  always did.
- **Updates come to you.** For a collection you installed from its Nexus page, Event Horizon checks for a
  newer published revision when Vortex starts. A notification offers **Update**, and so does the
  collection's card: it downloads the new revision and opens its install. The new revision installs into
  its own profile, so the version you were playing stays one click away. Nothing is checked while Vortex is
  logged out of Nexus, and a collection you installed from a file is never checked.
- **Without Event Horizon, an Event Horizon collection installs nothing.** Someone who adds it in plain
  Vortex gets no mods and a description saying the collection needs Event Horizon, rather than a bulk
  install that loses files.

### Building collections
- **Upload a finished build to a Nexus collection page.** When a build finishes as a .zip, **Upload to
  Nexus…** sends it to a new or existing collection page of yours through Vortex's own upload, so Event
  Horizon never handles your Nexus login. It arrives as a draft revision: publishing stays your click on the
  website. The page lists the real mods, Nexus mods by page and file and bundled ones as bundled, so their
  authors get collection credit. The name, author and game are checked before the transfer, a rejection
  from Nexus names the mod it is about, and progress shows in Vortex's notifications, so a long upload
  survives leaving the page.
- **You choose the collection's name on Nexus.** Vortex renames a collection page to the name each upload
  carries, so a name set on the website snapped back. The upload dialog now has a **Name on Nexus** field
  (3 to 36 characters), remembered with the collection, and a page that merely shares the collection's name
  is no longer picked for you.
- **The upload dialog opens on screen.** Pressing Upload to Nexus blurred the page and showed nothing: the
  dialog opened far below the visible area, inside the finished build's card.
- **A Nexus mod you marked external can go back to its Nexus download.** The external mods table gains
  **Use the Nexus download**. Nexus is asked first: a file it still offers switches back, and a file that
  has left Nexus is refused, naming the newer file to update to.
- **Switching a mod to Bundled no longer fails the build.** A mod answered "reproduce my version" earlier
  and then switched to Bundled was still counted as mirrored, and packaging stopped with "marked
  mirrored=true but … file(s) were not collected".
- **A restored draft no longer brings back decisions you removed.** Restoring a build draft laid its older
  copy of the per-mod decisions over the collection's settings, so a bundling answer you had taken out came
  back at the next build. The collection's settings now win.
- **A renamed collection keeps its header, card image, gallery and links.** A new name on the Build form
  builds a new collection, and that collection shipped without the presentation the form was showing. It
  now takes it along, with copies of the images.

### Linux and Steam Deck
- **Copy fix command.** On Wine and Proton, the notification about a broken 7-Zip gains **Copy fix
  command**: the exact lines to paste into a terminal to run setup-proton for your game's prefix.
  setup-proton now tests the prefix's 7-Zip before it changes anything and again afterwards, and says
  plainly when the problem is one it cannot fix.

## [0.1.164] — 2026-09-16

### Collection Doctor
- **The Doctor checks the collection you are actually playing.** It opened on whichever collection's receipt
  happened to sort first, so on a machine with more than one it could diagnose an install from weeks ago —
  and everything it then said was about the wrong collection. That included "you are on a different
  profile", whose **Switch to that profile** button moved Vortex off the collection you had just installed
  and put an older load order back over it. The Doctor now opens on the collection whose profile Vortex is
  on, falling back to the most recent install, and you can still pick another from the list at the top.
- **"No ESL flags recorded" no longer reads as a fault.** A collection installed before Event Horizon
  recorded the curator's ESL flags now says that is what happened, and that installing it again records
  them.
- **Re-check and Deep scan show that they are working.** Both ran with no sign they had started, so they
  looked like dead buttons and got pressed again. They now show progress while they run, and the panel says
  when it last checked: a check can take a few milliseconds, and "it finished instantly" and "nothing
  happened" looked exactly the same.

### Installing collections
- **Event Horizon offers to tidy up old profiles.** Installing a new version of a collection creates a
  profile for it on purpose, so you can go back to the version you were playing — but they add up. After a
  successful install Event Horizon now offers to remove the profiles earlier versions of that same
  collection left behind. You tick which ones go, nothing is removed until you confirm, and it never
  touches the profile you are on, the one just installed, or any profile Event Horizon did not create.
- **A file 7-Zip cannot read is no longer called damaged.** On Proton and Wine, Vortex's 7-Zip can unpack
  archives but cannot list them, so every `.rar` and `.7z` you supplied yourself looked unreadable — and
  Event Horizon told you the file was damaged and that downloading it again would probably fix it, which
  could never have worked. It now says what it actually knows: the file is not the one the collection was
  built from, and whether it is intact could not be checked. The broken extractor is named once in the
  summary, so a report you send a curator cannot blame an archive that was fine. A genuinely truncated
  download is still reported as damaged.

## [0.1.163] — 2026-09-16

### Installing collections
- **Updating a collection is no longer refused over an older version's answers.** Event Horizon remembers which
  local file you picked for each mod you downloaded yourself, so you are not asked again. When a newer version of the
  collection updated or dropped one of those mods, the old answer was still filled in, and the install was refused
  before anything installed ("stray conflictChoice key … matches no mod in the plan"). A remembered file is now used
  only for a mod the collection still asks for, and an answer for a mod the collection no longer has is ignored.

## [0.1.162] — 2026-09-16

### Installing collections
- **Hands off until Event Horizon is done.** Players on a collection page answered Vortex while their install ran
  (resolved conflicts by hand, deployed, accepted suggestions) and broke their own install. Once the pre-install
  checks have passed, Event Horizon now shows one warning before every install, guarded by Liberty Prime: what Vortex
  will show while mods install, what not to touch until Event Horizon says it is finished, and that a mod installer
  window that opens should be answered. "Understood" starts the install.
- **Fewer Vortex prompts during an install.** Event Horizon already cleared Vortex's "contains multiple plugins"
  prompts while it installs. It now also clears "Deployment necessary": a deploy clicked mid-install links the wrong
  files. If an install ends before Event Horizon's own deploy, it tells you to deploy.
- **No more External Changes dialog mid-install.** Mirroring rewrites files of mods Vortex had already deployed,
  and Vortex asked about each of them, where "Revert" undid the mirror. Event Horizon now purges Vortex's deployment
  right before the first mirror that changes files, and deploys everything again afterwards. Installs that mirror
  mods take a few minutes longer; you will see Vortex purging and relinking near the end, which is expected.
- **Mods that install on the second try are finished like the rest.** Some installers only work once the collection
  is deployed, so Event Horizon retries them at the end. Those mods were deployed before their mirror, mod type, INI
  tweaks and rules were applied, so they ran without them. They are now deployed after.

### Removed
- **The toolbar action "Event Horizon: Install (legacy dialog)".** It installed a collection without any of the
  checks the Install page runs. Install collections from the Install page.

## [0.1.161] — 2026-09-15

### Collections
- **A collection shows how its curator designed it.** The build form has a new card, "How your collection looks": a
  header and a card image, screenshots with captions, an accent and a background colour, links, and an About page in
  markdown, with a live preview of the banner. People installing the collection see that banner, the screenshots and
  the About page on the install preview, and the card image in the collection's colour on the Collections page. A
  package carries only images and text, never code, and a design Event Horizon cannot read never stops an install.
  Older versions of Event Horizon install these packages and just do not show the design.
- **Event Horizon writes the collection changelog.** Every build compares itself with the collection's previous
  version: mods added, removed and updated, mods whose files or installer options changed, mods delivered
  differently, plugins, the load order, rules, INI settings, prerequisites and requirements. Your own notes go on
  top. People updating see everything since the version they have. The finished build offers a copy for the Nexus
  changelog and a markdown copy, the full history is kept, and the package carries it as CHANGELOG.md.
- **Build asks whether to write a .zip or an .ehcoll.** Nexus Mods takes a package as a .zip. The question starts on
  the last answer you gave for that collection.

## [0.1.160] — 2026-09-14

### Collections
- **A collection package can be a .zip.** Nexus Mods quarantines files named `.ehcoll`: two copies of the same
  package went up on a hidden test page, and only the one named `.ehcoll` was quarantined. Collection pages now carry
  their package as a `.zip`, which is what it is, and Event Horizon takes a `.zip` package everywhere it takes a
  `.ehcoll`: the install page (drop it or pick it), a pasted Nexus page or direct link, and the Collection Doctor. On a
  Nexus page, what is inside a `.zip` decides whether it is the package or an older page's link file. Builds still
  write `.ehcoll`; upload it renamed to `.zip`, with mod manager download turned off, so Vortex never installs a
  package as a mod.

## [0.1.159] — 2026-09-14

### Collections
- **An installer kept inside a folder of its archive is checked like any other.** When a mod's archive kept its FOMOD
  installer inside a folder (`My Mod v2/fomod/…`), a build looked for the installer's files at the top of the archive,
  found none of them and gave up on the mod: no check for files missing from your folder, no proof that you ticked
  nothing, so users kept getting that installer's questions, and a mirrored mod carried every one of its files. The
  build now reads those paths from the folder the installer sits in. On a real collection that was at least 13 mods.

## [0.1.158] — 2026-09-14

### License
- **About names the license Event Horizon is under.** It still said "MIT licensed" three releases after 0.1.155 moved
  Event Horizon to the PolyForm Strict License 1.0.0. It now names that license and says what it allows, its link opens
  the license text (it pointed at a branch the repository does not have), and it no longer lists file overrides among
  what a collection captures, which Event Horizon stopped doing.

## [0.1.157] — 2026-09-14

### Collections
- **A mirrored mod's package carries only what its own archive cannot provide.** It carried every file of the mod, the
  author's untouched ones included — BodySlide's .exe files and OCBPC's .dll rode along unchanged, and Nexus Mods
  quarantined the package for carrying executables. A build now compares each mirrored mod's files with its archive and
  leaves out every file the archive installs byte for byte at the same place; the package carries the rest. A mod whose
  installer asks users questions, depends on which plugins are active, or could not be checked still carries every
  file. The event-horizon log says, for each mirrored mod, how many files were left to its archive, or why none were.
- **Installing takes such a file from the mod's own archive when it is missing.** Normally the install has already put
  it in place. When it has not — Vortex lost it, or an installer was answered differently — Event Horizon takes it from
  the archive the mod was installed from and checks its SHA-256 before writing it, as it does with the package's own
  files. Event Horizon 0.1.156 and older look for these files in the package instead, so a collection built with
  0.1.157 should require 0.1.157.
- The card for mirroring a mod says what the package carries.

## [0.1.156] — 2026-09-14

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
- **When a mod was enabled.** The mods table has an Enabled column — when each mod was last switched on in this profile,
  as Vortex records it — and opens sorted by it, freshest first. The Plugins view shows the same for each plugin's mod,
  and keeps load order as its own default.
- **State says only whether a mod is on.** A mod with an update showed "update 1.1.1.0" there instead of enabled or
  disabled, and a frozen one showed "frozen". Updates, manual updates and freezes now sit beside the version, and the
  Updates, Manual and Frozen views still list them.
- **Tables remember their sort.** Whatever sort you last chose in a table, including none, is how it opens next time.
- **Dismiss a requirement.** Mod pages often list things that do not apply, or advertise the author's other mods. Any
  requirement from a mod's Nexus page can be dismissed from its details panel: it stops counting everywhere — the
  Requires column, the Missing requirements view, the tiles, Make it work — through updates of the mod, and comes back
  only if that requirement changes on Nexus. Dismissed lines are listed under the rest with Restore. Missing plugin
  masters cannot be dismissed: the game will not load a plugin without them.

### Collections
- **A collection package no longer has an archive inside it.** Nexus Mods quarantines any upload with an archive inside
  it, and a package carried each bundled mod as a zip. A bundled mod now ships as its own files, and Event Horizon
  writes the archive back from them as it installs — an exact zip whose SHA-256 must match the one the collection names,
  so a missing, extra or altered file is refused before Vortex ever sees it.
- **A file that is itself an archive is left out of the package.** Any file in a bundled or mirrored mod that is an
  archive — judged by its contents, whatever it is called: a leftover .7z, a .docx readme, a .jar — is left out as if
  it had been deleted from staging, so users get the mod without it either way. Nothing needs cleaning up; the
  event-horizon log lists every file left out. Bethesda's .ba2 and .bsa files are not counted.
- **Packages built by earlier versions must be rebuilt.** They are refused with a message to download the collection's
  current package — to install or repair from, and in Curator Tools to import from or show as published. Older Event
  Horizon versions refuse the new packages with a message to update.
- **Bundling no longer runs 7-Zip over a mod's staging folder.** A build only measures the files, and remembers the
  answer while they stay the same; the archives the old builds kept — gigabytes for a LOD mod — are deleted. Files
  changed after the build measured them stop it, naming the mod; tick "Re-read every file" if nothing really changed.
- **A finished package is read back before the build says it is done.** Every bundled mod is rebuilt out of the package
  the way an install rebuilds it, so a file name 7-Zip could not store exactly, or a file it skipped, stops the build
  instead of every user's install.
- **A mod marked "bundle" that cannot be packed stops the build and says why** — no staging folder, an empty one, a file
  that cannot be read. Before, some of these shipped the mod's original archive in its place.
- **A build that fails or is cancelled keeps the package you already had.** Packaging a version whose package already
  existed deleted it when packaging failed or was cancelled; the new package now takes its place only once it is
  finished and checked.
- **A mod answered "mirror" and later ticked "Bundled" builds.** The build stopped, saying that mod's files were not
  collected; the later answer now stands.
- **Running out of disk space is caught before anything is written.** A build checks there is room for the new package
  and for any files it must copy from another drive; installing a bundled mod checks the temp drive, Vortex's download
  folder and its staging folder. Each refusal names the drive, what needs the room, and how much to free.
- **A bundled file whose saved hash is out of date stops the build.** File hashes come from a cache that trusts a file
  whose size and modified time have not changed. Packaging now hashes every bundled file again and names any that no
  longer match, instead of shipping a mod every user's check would fail. Tick "Re-read every file" and rebuild.
- **A mod taken off bundling in the decisions step ships under its own archive hash.** It kept its bundle's hash, which
  no Nexus download has, so no user could install it.
- **Long builds update the screen at most ten times a second**, instead of once for every file they check.
- **Mods whose installer was answered with nothing ticked no longer warn.** The build said users would be asked to choose
  for them; that empty answer is replayed like any other, as installs already did.
- **The Creation Club note names each file once.** A plugin spelled in two letter cases was listed, and counted, twice.
- **A decision card says where users get the mod.** "Reproduce my version" said users still download the mod from
  Nexus, even for a mod that is not on Nexus. For those it now says users get its archive themselves, from your link or
  instructions.
- **Answers on decision cards wrap.** In a narrow window their buttons cut the first and last letters off each answer.

### Linux (Wine/Proton)
- **Vortex in one Wine prefix and the game in another is caught, with how to fix it.** Vortex writes plugins.txt and the
  INI settings into the prefix it runs in. A game started from Heroic runs in Heroic's own prefix and never saw them —
  while the setup check, reading Vortex's prefix, said the game had never been started. Event Horizon now finds the
  prefix Heroic (for a GOG game) or Steam (for a Proton game) runs the game in, and checks whether Vortex's settings
  folders are the game's by writing a test file into one and looking for it in the other, so a link counts and a copy
  does not. Until they are, install and Play are refused with both prefixes named, a command that links each folder
  (keeping Vortex's old one), and how to run Vortex in the game's prefix instead.
- **The game's own settings are the ones checked.** "Has the game been started" and the INI leftovers check read the
  game's prefix when it is found; when it is not, they say they read Vortex's.
- **A GOG game installed by Heroic can be checked for leftovers.** Heroic writes no GOG Galaxy file list, so its folder
  could not be verified. Event Horizon now reads the hash database GOG ships for each product (`goggame-<id>.hashdb`),
  and only when every product in the folder has one.

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
