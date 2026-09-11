# Publishing Event Horizon as a Vortex extension

How this extension gets from this repo onto someone else's Vortex.

Everything in **Mechanism** below was read out of the Vortex installation on
this machine (`C:\Program Files\Vortex\resources\app.asar` and its unpacked
`bundledPlugins`), not from documentation or memory. Where something could not
be verified that way it says so explicitly — those are the parts to confirm
before relying on them.

---

## 1. What a Vortex extension actually is

A folder containing a manifest and an entry point. Vortex loads extensions from
`%APPDATA%/Vortex/plugins/<name>/`.

Ours consists of exactly four things, which is what
`scripts/deploy-to-vortex.js` installs and what the release package contains:

| Path | What it is |
| --- | --- |
| `info.json` | The manifest. **Must be at the archive root.** |
| `index.js` | Entry point Vortex requires at load. |
| `dist/**` | Compiled TypeScript (`npm run build`). |
| `assets/**` | Static assets — currently the sidebar icon sprite. |

### `info.json`

**Verified:** all 60 extensions bundled with this Vortex build use exactly
these four fields and no others:

```json
{
  "name": "Event Horizon",
  "author": "DuduPhudu and Bluuuk",
  "version": "0.1.0-alpha.1",
  "description": "Capture and reproduce a curator's exact mod state ..."
}
```

`version` here is what the extension browser displays. `npm run
package:extension` refuses to build if it disagrees with `package.json`,
because shipping them out of step advertises a version the code does not claim.

---

## 2. Mechanism — how Vortex finds extensions

Two separate things, and conflating them is why "I uploaded it and it isn't in
the list" happens.

### 2a. Extensions are Nexus mods under the `site` game

Vortex builds extension links as `` `${NEXUS_BASE_URL}/site/mods/` `` — the
`site` game domain, presented in the UI as **"Tools & Extensions"**
(`SITE_GAME_NAME`). So an extension is uploaded like any other Nexus mod, just
under that pseudo-game rather than Fallout 4.

Vortex special-cases downloads from it: when the download's game is `site` it
emits `install-extension-from-download` instead of installing a mod.

### 2b. The browser list is a CURATED manifest, not a Nexus query

Vortex's extension browser does not search Nexus. It downloads:

```
https://raw.githubusercontent.com/Nexus-Mods/Vortex-Backend/main/out/extensions-manifest.json
```

(`EXTENSION_URL` = `githubRawUrl("Nexus-Mods/Vortex-Backend", "main",
"out/extensions-manifest.json")`. Preview builds read `Vortex-Staging`
instead.)

That file is `{ "last_updated": <ms>, "extensions": [ ... ] }`. A full entry
looks like:

```json
{
  "name": "Archive binding fix",
  "description": { "short": "...", "long": "..." },
  "image": "https://staticdelivery.nexusmods.com/mods/2295/images/25/...",
  "tags": [], "downloads": 8600, "endorsements": 910,
  "author": "Nexus Mods", "version": "0.1.0",
  "modId": 25, "fileId": 71,
  "timestamp": 1537516083, "uploader": "Tannin42"
}
```

Only `modId` and `fileId` are load-bearing — some entries carry nothing else,
and the rest is metadata mirrored from the Nexus page. Some entries also carry
`type` (`"translation"`, `"theme"`) or `language`.

**The consequence:** uploading to Nexus makes the extension *installable by
URL/file*. It does **not** put it in the browser. That requires an entry in a
repository owned by Nexus Mods.

**The submission route (verified against Nexus's own wiki, 2026-08-30):** it is
a **GitHub issue form on the `Nexus-Mods/Vortex` repo** — not a PR to
`Vortex-Backend`, and not Discord.

- Form: `Review Extension`
  ([template `review-extension.yaml`](https://github.com/Nexus-Mods/Vortex/issues/new?assignees=&labels=extension+%3Agear%3A&projects=&template=review-extension.yaml&title=Review%3A+Game+Name)),
  labelled `extension :gear:`.
- Nexus states: *"One of our team will take a look and be in touch within 5
  working days of submission."*
- New extensions are **never** added automatically. `Vortex-Backend`'s own
  README says: *"Completely new extensions aren't added automatically as we
  verify these manually"*. A maintainer then runs the repo's **Add Extension**
  workflow (`workflow_dispatch`), whose inputs are `modid`, `extension-type`
  (`game` / `theme` / `translation` / `tool`), plus `gamedomain` for a game
  extension or `language` for a translation, and an optional `dry-run`.
- **Ours is `extension-type: tool`**, not `game`. That distinction matters for
  the packaging rules below.

Questions outside the review process go to the
[Vortex forums](https://forums.nexusmods.com/forum/4306-vortex-support/) or the
[Nexus Mods Discord](https://discord.gg/nexusmods).

---

## 3. Procedure — cutting a release

### Step 1 — decide the version

Bump `package.json`, `info.json` and `src/ui/version.ts` to the same value.

**Plain `x.y.z` only — no `-alpha.N`.** Vortex decides whether to offer an
extension update with `!semver.gte(semver.coerce(installed),
semver.coerce(listed))` (read out of app.asar), and `semver.coerce` drops a
prerelease suffix: `0.1.0-alpha.149` and `0.1.0-alpha.150` are both `0.1.0`,
so no alpha release is ever offered as an update. None of the 807 extensions
in the curated manifest uses a prerelease version. The alpha counter lives in
the patch number instead: `0.1.0-alpha.150` was followed by `0.1.151`.

### Step 2 — build and package

```
npm run package:extension
```

This runs `npm run build` (which itself runs `check-version-sync`), then writes
`release/event-horizon-<version>.zip` with `info.json` at the archive root.

Why a script rather than zipping the folder: Vortex reads `info.json` from the
archive **root**, and zipping the project directory buries it one level down.
Vortex then rejects the extension for a missing manifest, and you find out
after the upload.

### Step 3 — check it before uploading

Do not skip this. It is two minutes and it is the difference between a broken
release and a working one.

```
npm test                 # full suite
npm run typecheck        # src
npm run typecheck:test   # tests, which tsc otherwise never sees
npm run smoke            # loads the DEPLOYED copy and registers its actions
```

Then install the zip into a real Vortex the way a user will:

1. Vortex → Extensions → the drop zone at the bottom (or the "Install from
   file" control), and pick `release/event-horizon-<version>.zip`.
2. Restart Vortex when prompted.
3. Confirm the sidebar entry appears and the Build and Install pages open.

Installing the zip is not the same code path as `npm run deploy:vortex`, which
copies loose files. Only the zip proves the archive layout is right.

### Step 4 — upload to Nexus

Under **Tools & Extensions** (`nexusmods.com/site`), as a normal mod. Nexus's
wiki adds two rules that are easy to get wrong and are checked at review:

- **Category must be `Vortex > Extensions`.** Upload from the Modding Tools
  section.
- **Exactly one file under "Main Files".** Not two, not a file parked under
  Optional. `release/event-horizon-<version>.zip` is that file.
- **`info.json`'s version must exactly match the version you type into the
  Nexus upload form.** `package:extension` already refuses to build when
  `info.json` and `package.json` disagree, which removes one of the two ways
  this drifts; the Nexus form is the other, and nothing but care guards it.

Note the resulting **`modId`** and the uploaded file's **`fileId`** — those two
numbers are what the extension manifest keys on.

#### The page images

Branding lives in `docs/branding/`, already sized for upload — the originals
are 2 MB each and want resizing before they go anywhere.

| file | where it goes |
| --- | --- |
| `banner.jpg` (1600×640) | the mod page header, and the README's |
| `banner-portal.jpg` | alternative header, same treatment |
| `hero-planet.jpg` | a second image for the gallery |
| `icon-512.png` | transparent mark, for anywhere square |
| `wordmark.png` | transparent lockup, for a light-on-dark header |

`NEXUS_MOD_PAGE.bbcode` embeds its images straight from the repository on
GitHub (`raw.githubusercontent.com/.../docs/branding/banner.jpg` and
`docs/screenshots/*.png`), so the description needs no gallery upload to
render. The gallery is still worth filling for the page's thumbnail and the
image strip — the same files, from `docs/screenshots/`.

The description itself cannot be written through the Nexus API: v3 exposes
mods read-only (only collections have an edit endpoint, checked against
`api.nexusmods.com/openapi.yaml` on 2026-09-11). Paste the file's contents into
the page's description editor by hand after a release that changes it.

The banner already carries the wordmark and the tagline, so the text title
below it is deliberate duplication — it is what the page still says if the
image fails to load.

#### One thing Nexus's BBCode does that will surprise you

**A block tag must open and close on the same line.** `[center]` opened on line
1 and closed on line 6, spanning blank lines — valid BBCode by any normal
reading, and Nexus never closed it. Everything downstream inherited it, so
*every bullet list on the page* rendered centre-aligned **and paragraph breaks
stopped working**. Keep `[center]`, `[size]` and friends on one line each;
balanced tags are not enough, they have to be balanced per line.

That one fault produced two symptoms, which is worth remembering because it
cost a wrong fix: the missing paragraph gaps looked like a separate
blank-line problem, and doubling every blank line "fixed" nothing while
double-spacing the whole page. Single blank lines between paragraphs and two
before a `[size=5]` heading are correct — once no block tag is leaking.

### Step 5 — request the browser listing

File the [**Review Extension**](https://github.com/Nexus-Mods/Vortex/issues/new?assignees=&labels=extension+%3Agear%3A&projects=&template=review-extension.yaml&title=Review%3A+Game+Name)
issue form on `Nexus-Mods/Vortex`, supplying the `modId`. A maintainer runs the
`Add Extension` workflow in `Vortex-Backend` with `extension-type: tool`.
Expect a reply within **5 working days**.

Do not open a PR against `Vortex-Backend` — additions go through the workflow,
run by them, after manual verification.

Until that lands, people can still install by downloading the zip from the mod
page and using Install from file — worth saying plainly in the mod description
rather than letting testers conclude it is broken.

### Step 6 — updating: `npm run release`

Event Horizon lives at [nexusmods.com/site/mods/2235](https://www.nexusmods.com/site/mods/2235)
(`package.json` → `nexus`). Releases go through one script, which uses the
Nexus API v3 upload flow and adds the zip as a **new version of the existing
main file** (the previous version is archived, so the page keeps exactly one
main file):

First write the notes: add a `## [x.y.z] — YYYY-MM-DD` section to `CHANGELOG.md`
(newest first, player-facing). The release refuses without one, and those exact words
become the Nexus changelog and the GitHub Release notes.

```
npm run release -- --dry-run   # everything except writes to Nexus and GitHub
npm run release                # alias: npm run release:nexus
```

It refuses before touching either site when the version files disagree, the
version is not plain `x.y.z`, CHANGELOG.md has no section for it, it is not newer
than Nexus's latest by Vortex's own comparison, the tree is dirty or not pushed,
the tag or GitHub Release exists, `gh` is not signed in, or tests, typecheck,
packaging or the smoke load fail. It uploads to Nexus as "Event Horizon x.y.z",
adds the changelog, checks Nexus lists the version, then tags `v<version>` and
publishes the GitHub Release with the same notes and the zip attached.

In API v3 a "mod file" is an update chain and every upload is a version in it.
The release adds a version to the page's chain (on 2026-09-11 its newest,
alpha.94, was archived — that is fine) and archives the previous one, so the
page keeps exactly one Main file. It refuses only when several chains exist
and not exactly one has a Main version.

API key: `NEXUSMODS_API_KEY`, or the first line of `~/.nexusmods/api-key`
(create one at nexusmods.com/settings/api-keys). It is never printed.

**When users get it.** Only listed extensions auto-update (§2b). Vortex-Backend's
`Update Extensions Manifest` workflow runs daily at 07:45 UTC and picks up the
newest file version; Vortex re-downloads the manifest at most hourly. So an
upload reaches installed copies within about a day, and never before the
listing exists.

---

## 4. Before the first public release

These are open, and none of them is a code change:

- [x] ~~Confirm the manifest submission channel~~ — done, §2b. It is the
      `Review Extension` issue form on `Nexus-Mods/Vortex`.
- [ ] **Sequencing.** Steps 4 and 5 do not have to happen together, and
      probably should not. Uploading to Nexus (step 4) makes the extension
      installable by file immediately and is easy to withdraw. Step 5 puts it
      in front of every Vortex user and costs a review cycle to redo. Do step 4
      now; do step 5 once the alpha has more than two testers.
- [x] ~~Decide the public name~~ — **Event Horizon**, settled. The GitHub repo
      is [ReidenXerx/Event-Horizon](https://github.com/ReidenXerx/Event-Horizon).
      Nexus's wiki says `info.json`'s `name` *"shouldn't be changed in future
      updates"*, so treat it as fixed from the first upload.
- [ ] **The install folder is named from the ZIP filename, not from
      `info.json`.** Installing `event-horizon-0.1.0-alpha.1.zip` produced
      `%APPDATA%\Vortex\plugins\event-horizon-0.1.0-alpha.1\` — observed, not
      assumed. Two consequences worth settling before the first public upload:
      `npm run deploy:vortex` writes to a *different* folder
      (`vortex-event-horizon`), so a dev deploy and a zip install coexist as
      two registered copies; and because the version is in the folder name,
      confirm Vortex removes the old folder on update rather than leaving
      every release installed side by side.
- [ ] A mod-page description and at least one screenshot; the browser shows
      `description.short` and `image` from the mirrored Nexus data.
- [ ] Decide what a supported game list means publicly — the code accepts
      `skyrimse`, `fallout3`, `falloutnv`, `fallout4`, `starfield`, but only
      Fallout 4 has been exercised on a real 963-mod collection.
- [ ] State the Nexus Premium expectation up front. Installing a large
      collection without it means one manual click per mod.
