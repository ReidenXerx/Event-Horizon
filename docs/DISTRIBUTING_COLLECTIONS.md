# Distributing collections

**Status**: SETTLED 2026-09-11 — a collection is distributed as a **Nexus mod
page** (landing page: description, install steps, checklist, 18+ notice) whose
package, the full `.ehcoll`, is hosted on **pixeldrain**. Vortex's own
collection pipe (sections 2–6 below) is research that was never built and is
not going to be: Event Horizon exists because that pipe loses the curator's
state, so pointing people at it again would be the wrong door.

**Why not the package on Nexus itself:** it was tried first (multipart upload
works, see below) and Nexus's automated safety scan quarantined both files
within the hour. The stated reason list includes *nested archives (a zip
containing another zip)*, and an `.ehcoll` with bundled files is exactly that
— `bundled/*.zip` inside the package, with no executable anywhere (checked:
zero `.exe`/`.dll` entries in either). That is structural to the format, so
every revision would be quarantined again pending a manual review by email.
The curator chose pixeldrain, which the collections already used for their
BodySlide and FaceGen outputs.

**How a collection reaches its users:**

1. The curator builds the `.ehcoll` (Curator Tools → Build).
2. Upload it to pixeldrain with the account key (`~/.pixeldrain/api-key`, never
   printed or committed): `PUT https://pixeldrain.com/api/file/<name>` with
   Basic auth (empty user, the key as password), streaming from disk. Verify by
   size and a few sampled Range reads; pixeldrain serves Ranges, which is what
   Event Horizon's resumable direct download needs.
3. The mod page's description says: install Event Horizon (0.1.155 or newer),
   then **paste this link**:
   `https://pixeldrain.com/api/file/<id>?download#sha256=<sha256 of the .ehcoll>`.
   The fragment never reaches the server; Event Horizon checks the finished
   file against it and refuses a mismatch (settled with the curator,
   2026-09-11). A link without `#sha256=` still installs, and says it was not
   verified. The share page `pixeldrain.com/u/<id>` is accepted too.
   The page's own file is a small zip holding `event-horizon-link.json` —
   `{"format":"event-horizon-link","version":1,"url":"https://pixeldrain.com/api/file/<id>?download","sha256":"<64 hex>","fileName":"<name>.ehcoll","size":<bytes>}`
   — plus a readme. Pasting the page's address follows that file with a
   Premium account (Vortex downloads the zip), and a zip without a SHA-256 is
   refused. Older zips holding a plain text file with exactly one https link
   and one SHA-256 are read too.
4. The mod page is created and edited in a browser over the DevTools
   protocol, the same way `scripts/nexus-page.mjs` writes the extension's page:
   a dedicated browser profile (its own `--user-data-dir`, logged into Nexus
   and nothing else), closed as soon as the edit is done — while its debugging
   port is open, any program on the machine can read that profile's cookies
   ([`PUBLISHING.md`](PUBLISHING.md) step 4 has the details). The API uploads
   files but cannot create a mod or write a description. The page requires
   the Event Horizon file (file-to-file requirement, min 0.1.152) and carries
   the adult tags.

`scripts/nexus-collection-file.mjs` (`uploadArchiveFromDisk` in
`scripts/lib/nexusRelease.mjs`) puts any file on a mod page, multipart above
100 MiB: one presigned PUT per part, three in flight, ETags folded into the
completion XML, then finalise and wait for `available`.

- **Checked before a byte is uploaded:** every argument (an option is never
  read as another option's value), the file name (printable ASCII — it goes
  into a signed header), that the page is not Event Horizon's own, and that
  `--file-id` is a file on the `--mod` page.
- **Verified:** each part's ETag must be the MD5 of the bytes sent, the
  assembled object's ETag must be the one those parts make, and the file must
  not change on disk, or the upload is not finalised. The whole file's MD5 and
  SHA-256 are logged; the MD5 is not sent, because the multipart create
  request has no `md5` field (`openapi.yaml`, read 2026-09-11).
- **Failures:** a failed part is retried with exponential backoff for at least
  four minutes. A part that cannot succeed (an expired presigned URL answers
  403) stops the whole upload at once. There is **no resume**: the API cannot
  reopen a multipart session, so a failed run starts again from the first
  part, and an unfinished upload adds nothing to the page.

Measured 2026-09-11 with the earlier uploader, before the per-part
verification: 3.4 GB in 64 s, 10.7 GB in 2 min 40 s. It is what uploads the
link zip now, and it is ready if Nexus ever whitelists the packages.
`--file-id <id>` adds a new VERSION of an existing file.

The first two pages: Fallout 4 mod 108944 (Ivy's Panties, pixeldrain 4gheZH7F)
and Skyrim SE mod 191460 (Meridia's Panties, pixeldrain Qc8K6SYR). The old
Vortex Collection pages stay up with a description that points at the mod
pages; their forum guides carry a legacy note.

---

## Earlier research (kept for the record)

**Status**: RESEARCH. Section 6's recommended hybrid was never implemented —
`registerInstaller` appears nowhere in `src/`, so nothing claims a `.ehcoll`
downloaded from Nexus. **How collections actually reach users today:** the
curator hands over the `.ehcoll` file by whatever means they like, and the user
picks it from disk on the Install page. That is the whole mechanism.

**Do not confuse this with [`PUBLISHING.md`](PUBLISHING.md).** Two different
problems that both used to be called "publishing":

| Doc | Question | State |
| --- | --- | --- |
| [`PUBLISHING.md`](PUBLISHING.md) | How does the **extension** get to Vortex users? | Procedure written, packaging script built |
| **This file** | How does a **collection** (`.ehcoll`) get to its users? | Research only, unbuilt |

This file was `RESEARCH_PUBLISHING.md` and nothing linked to it.

**Last updated**: 2026-04-27 (the research; this header is newer)
**Related**: [`PROPOSAL_INSTALLER.md`](PROPOSAL_INSTALLER.md)

---

## 1. Question

How do `.ehcoll` files get from a curator's machine to a user's? Today the
build flow drops a `.ehcoll` on disk and the curator distributes it
manually (Discord, GitHub release, Nexus mod attachment, etc.). The
`PROPOSAL_INSTALLER.md` v1 non-goals explicitly defer hosting / publishing
infrastructure.

This doc captures the findings of an architecture spike on whether (and
how) we should integrate with Nexus's *collection* publishing pipe — and
what the cleanest install-side interception story looks like — so the
decision isn't re-litigated from scratch later.

---

## 2. What Vortex API exposes

All sources from `node_modules/vortex-api/lib/api.d.ts` (vortex-api
`2.0.0-beta.1`).

### 2.1 The collection submit pipe

```ts
// INexusAPIExtension, line 5253
nexusSubmitCollection?: (
  collectionInfo: ICollectionManifest,
  assetFilePath: string,
  collectionId: number,
  callback: (err: Error, response?: any) => void,
) => void;
```

Important properties:

- **Optional method** (`?`). Provided by the bundled `nexus-integration`
  extension. Always feature-detect:
  `if (typeof api.ext.nexusSubmitCollection === "function") { ... }`.
- **Eats `ICollectionManifest`** from `@nexusmods/nexus-api` — Nexus's
  own manifest schema, validated server-side. Not our `.ehcoll`
  manifest. To use this pipe we'd have to translate.
- **Eats `assetFilePath`** — a zip on disk.
- `collectionId: 0` ⇒ create new; non-zero ⇒ update existing revision.
- Old-style Node callback. Wrap in a `Promise`.

### 2.2 Adjacent helpers (all on `INexusAPIExtension`)

```ts
nexusGetMyCollections?: (gameId, count?, offset?) => PromiseLike<IRevision[]>;
nexusGetCollectionRevision?: (slug, revisionNumber) => PromiseLike<IRevision>;
nexusOpenCollectionPage?: (gameId, slug, revisionNumber, source) => void;
nexusRequestNexusLogin?: (callback) => void;
nexusGetUserKeyData?: () => PromiseLike<IValidateKeyDataV2>;
```

Enough to: list curator's existing collections (to choose update target),
open the published page after submit, gate on login, read API-key data.

### 2.3 Generic uploader (top-level export)

```ts
declare function upload(
  targetUrl: string,
  dataStream: Readable,
  dataSize: number,
): Promise<Buffer>;
```

Plain HTTP upload helper — useful only if we ever target our own server.

### 2.4 What's *not* exposed

- **No mod-publish API.** Only collections. There is no extension-side
  way to programmatically upload a regular Nexus mod.
- **No raw Nexus REST client.** Extensions can only call what
  `INexusAPIExtension` chooses to surface.
- **No download URL fetcher for arbitrary mods.** Only via
  `nexusDownload(gameId, modId, fileId)`.

### 2.5 The install hook

```ts
// IExtensionContext, line 3444
registerInstaller: (
  id: string,
  priority: number,
  testSupported: TestSupported,
  install: InstallFunc,
) => void;
```

Mechanics:

- Every registered installer gets `testSupported(files, gameId)` for
  each downloaded archive.
- First installer (by priority order) whose `testSupported` returns true
  claims the install.
- Vanilla collection installer is itself one of these registrations.

This is the lever for any "intercept downloads on the user's machine"
story.

---

## 3. The two halves of the publishing problem

```
Curator side                      User side
────────────                      ──────────
1. Build .ehcoll                  3. Click "download" on Nexus
2. Get it onto Nexus              4. Vortex fetches the asset
   (in our format, somehow)       5. Middleware sniffs: EH or vanilla?
                                  6. EH → our installer; else → vanilla
```

Half 1 (publish in our format) and half 2 (intercept on download) have
*very* different feasibility and we evaluated them separately.

---

## 4. Half 1 — Publishing in our format on Nexus

There is no Nexus extension API that says "publish this arbitrary file
as a collection." The only door is `nexusSubmitCollection`, which means
"publishing in our format" reduces to **smuggling our payload inside a
Nexus-shaped envelope**.

### 4.1 Sub-option A — Minimal-shell collection

Submit a manifest with bare-minimum required fields (game, name,
version, empty/dummy mod list). Asset zip contains both Nexus's
expected `collection.json` AND our `.ehcoll` alongside.

**Risks:**

- Nexus backend likely **rejects empty/dummy collections** (zero mods,
  broken refs). The submit endpoint isn't documented for extensions;
  we'd need to test against a real account. **UNKNOWN.**
- Even if accepted, Nexus's web UI displays it as a collection with 0
  mods — confusing to anyone browsing.
- Collection moderation team may flag it as broken/spam.

### 4.2 Sub-option B — Wrapper collection with synthetic mod

Manifest references one synthetic "mod" whose archive is actually our
`.ehcoll`. Vortex's vanilla installer would try to install the synthetic
mod normally — bad. We'd need our installer to claim it first (see
Half 2).

### 4.3 Sub-option C — Dual-format hidden inside a legit collection

Asset zip contains BOTH a working `collection.json` (so server
validation passes) AND our `.ehcoll`. Our installer detects the dual
format and prefers our flow.

Same risks as 4.1 plus: if Vortex's installer wins the priority race,
the user gets the vanilla collection install — defeating the whole
point.

### 4.4 Verdict on Half 1

You **can** publish through this pipe but you're fighting Nexus's
validation, their UI, and their moderation policy simultaneously, and
you're coupled to an undocumented endpoint contract. **Not recommended
as the primary distribution path.**

---

## 5. Half 2 — Intercepting Vortex's install flow

This part is **structurally feasible** via `registerInstaller`. Register
at higher priority than the vanilla collection installer; in
`testSupported`, sniff the archive for our manifest signature; if found,
claim the install and route to Event Horizon's flow.

### 5.1 What's known to work

`registerInstaller` is the documented extension point for *every* mod
download (i.e. every `nxm://mods/...` URL). Any third-party mod
installer (FOMOD-OMOD-converter etc.) uses it. Higher-priority installer
wins. This is well-trodden ground.

### 5.2 Real unknowns (must be validated before committing)

| Risk | Likelihood | Impact |
|---|---|---|
| Vortex pre-routes `nxm://collections/...` URLs directly to vanilla collection installer, bypassing `registerInstaller` entirely | **MED-HIGH** | Fatal — our installer never sees the download |
| Vanilla installer has a higher priority than user-registerable max | LOW | Workaround: register at `their_priority - 1` |
| Auto-update flow polls Nexus revisions and uses an internal install path that bypasses `registerInstaller` | MED | EH collections wouldn't auto-update |
| Vortex's collections UI shows our hijacked collections as "broken" / "missing manifest" | MED | Cosmetic but annoying |

The first risk is the killer. Nexus collection downloads come in via
`nxm://collections/...` and Vortex *probably* has a fast path: "URL is
a collection → call collection installer directly." If true,
`registerInstaller` never sees it.

### 5.3 Validation experiments needed

Three cheap tests, in order:

1. **Does `registerInstaller` claim downloads from `nxm://mods/...`?**
   Register a no-op installer at high priority, log invocations,
   download any normal Nexus mod. *(~20 min)*
2. **Does it claim `nxm://collections/...`?** Same setup, download a
   vanilla collection. **This single experiment decides whether the
   collection-hijack approach can ever work.** *(~20 min)*
3. **Does Nexus's submit endpoint accept a synthetic collection?** Only
   worth doing if (2) is positive. Requires test Nexus account. *(~1-2h)*

---

## 6. The recommended hybrid

Drop the "publish as Nexus collection" angle. Distribute `.ehcoll`
files as **regular Nexus mods** (not collections):

```
Curator                                User
───────                                ────
Build .ehcoll                          Browse Nexus mod page (regular mod)
Manually upload to Nexus               Click "Mod Manager Download"
as a regular mod attachment            → nxm://mods/... URL
                                       → registerInstaller fires (defined
                                          contract for mod downloads)
                                       → Our installer sees .ehcoll
                                          signature → claims install
                                       → Event Horizon flow runs
```

### 6.1 Why this is structurally cleaner

- **`registerInstaller` is the documented path** for `nxm://mods/...`
  — no special-casing, no priority wars with the collection installer.
- **No Nexus server-side validation friction.** Mod attachments accept
  arbitrary files (subject only to size/extension limits).
- **No collision with Vortex's collection system at all** — we never
  enter that codepath. Aligns with the
  [`PROPOSAL_INSTALLER.md` §2 non-goal](PROPOSAL_INSTALLER.md):
  *"Replacing or modifying Vortex's built-in collection system."*
- **Auto-updates work for free.** When the curator uploads v1.0.1, the
  user gets the standard mod-update flow and our installer claims the
  new version too.
- **Discovery works** — same SEO, tags, comments, endorsements as any
  Nexus mod.
- **Honest framing**: Event Horizon collections ARE distributed as
  files, not as Nexus collections. No deception, no moderation friction.

### 6.2 What you give up

- The "Collections" tab on Nexus as a discovery surface. EH collections
  appear under regular mods (probably with a tag like "Event Horizon
  Collection" or a category convention).
- Programmatic publish-from-Vortex (Nexus doesn't expose a mod-upload
  API to extensions). Curator has to drag the file to Nexus's web
  uploader manually. Same as today.

### 6.3 What gets harder later

If Nexus ever exposes mod uploading via the extension API, this
architecture absorbs that without changes — `nexusSubmitMod(file)` would
just be a "Publish" button on the Done step of the build wizard. Today
it's manual; that's a distribution-friction issue, not an architectural
one.

---

## 7. Roadmap

### Phase A — Validate the install hijack *(no-code-yet)*

Run experiments 5.3.1 and 5.3.2 to confirm `registerInstaller` works
for `nxm://mods/...` (very likely) AND for `nxm://collections/...`
(uncertain). **Result determines which 6.x approach is even possible.**

### Phase B — Ship the hybrid

Implement Event Horizon's installer registration:

1. Register at high priority via `registerInstaller`.
2. `testSupported(files, gameId)`: returns true if any file in the
   archive matches our manifest signature (e.g. presence of a top-level
   `manifest.json` with our schema discriminator, or the `.ehcoll`
   extension itself if Vortex preserves it).
3. `install(files, destinationPath, gameId, ...)`: invoke the existing
   install pipeline (already built in
   [`INSTALL_DRIVER.md`](business/INSTALL_DRIVER.md)).
4. Curator publishes manually as a Nexus mod attachment.

This is the cheapest path to "click a Nexus link → EH installs the
collection" UX.

### Phase C — Future: collection-page presence (optional)

*Only if* experiment 5.3.2 shows we can hijack `nxm://collections/`
URLs AND there's actual user demand for collection-page discovery.
Re-evaluate the Half 1 sub-options at that point. Not a v1 concern.

### Phase D — Future: self-hosted registry (optional)

If at some point we decide to run our own infrastructure, the generic
`upload(url, stream, size)` helper plus an external endpoint covers it.
Heavy ops cost (TLS, auth, moderation, takedowns, GDPR, uptime); not
justified by current user count. Revisit only if the friction of "drag
the file to Nexus's web UI" becomes a bottleneck for adoption.

---

## 8. Open questions

| Q | Why it matters | How to resolve |
|---|---|---|
| Does `registerInstaller` see `nxm://mods/` downloads? | Confirms Phase B is viable | Experiment 5.3.1 |
| Does `registerInstaller` see `nxm://collections/` downloads? | Decides whether Phase C is even possible | Experiment 5.3.2 |
| What priority does the vanilla collection installer use? | Calibrates our priority value | Read Vortex source / probe `registerInstaller` callbacks |
| Does the `.ehcoll` extension survive Nexus's archive ingestion? | If Nexus re-zips into `.7z`, our extension-based detection breaks | Upload a test file, inspect what Vortex receives |
| Does the auto-update poller use `registerInstaller`? | Decides whether mod-updates Just Work | Read Vortex source for the periodic update task |
| Can a Nexus regular-mod attachment be marked / filtered as "collection-like" via tags or category? | Discovery convention for EH-mods | Nexus admin docs |

---

## 9. What we are NOT doing (yet)

To prevent scope creep — these are explicitly out of scope until
Phase B is shipped and validated:

- Programmatic submission via `nexusSubmitCollection`.
- Self-hosted registry / our own auth / our own CDN.
- Cross-mod-manager support (MO2, etc.).
- Generic publish abstraction (`PublishTarget` interface) — premature
  until there's a second concrete target. See the discussion in the
  build wizard's `DonePanel`: today's "Open file / Open folder" UX *is*
  the publish story.

---

## 10. Decision log

- **2026-04-27**: Spike findings. Decision: defer all programmatic
  publishing. Curator distribution stays manual. Install-side hijack
  via `registerInstaller` is the next concrete experiment.

---

## 11. Code references

- `node_modules/vortex-api/lib/api.d.ts:3444` —
  `IExtensionContext.registerInstaller`
- `node_modules/vortex-api/lib/api.d.ts:5236-5272` —
  `INexusAPIExtension` (publish + adjacent helpers)
- `node_modules/vortex-api/lib/api.d.ts:9009` — top-level `upload()`
- [`docs/PROPOSAL_INSTALLER.md`](PROPOSAL_INSTALLER.md) — v1 scope and
  non-goals (this doc explicitly defers to that proposal's Phase 4
  install-driver work; nothing here changes its contract)
- [`docs/business/INSTALL_DRIVER.md`](business/INSTALL_DRIVER.md) — the
  existing install driver Phase B's `installFunc` would invoke
