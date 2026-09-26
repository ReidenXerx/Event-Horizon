# Event Horizon control channel

A local HTTP interface that lets agents on the same PC drive a **running** Vortex: read its state, deploy, purge,
enable/disable/install/remove mods, switch profiles, and repoint a game to another install folder.

It is **off by default**. The user turns it on from Event Horizon's **Agents** page (or the one-time popup).

## Connecting

While it runs, Event Horizon writes:

```
<Vortex userData>/event-horizon/control.json      (Windows: %APPDATA%\Vortex\event-horizon\control.json)
{ "url": "http://127.0.0.1:<port>/v1/", "port": 51234, "token": "<64 hex>", "pid": 1234, "version": "0.2.17", "startedAt": "..." }
```

- The port and token change every time Vortex starts. **Re-read the file before each session**; a connection refused
  means Vortex is closed or the channel was turned off, and the file may be stale.
- Every request needs `Authorization: Bearer <token>`.
- Requests carrying an `Origin` header (browsers) are refused, and `Host` must be `127.0.0.1:<port>` or
  `localhost:<port>`.

```bash
node -e '
const c = require(process.env.APPDATA + "/Vortex/event-horizon/control.json");
fetch(c.url + "state", { headers: { authorization: "Bearer " + c.token } }).then(r => r.json()).then(j => console.log(JSON.stringify(j, null, 1)));'
```

## Requests and replies

- `GET /v1/health` returns the version, every verb (`reads` or `mutates`), the running op, and the queue length.
- `POST /v1/<verb>` takes a JSON object body. Read verbs also accept `GET` with query parameters.
- **Changes run one at a time**, in arrival order. **Reads never wait** behind a running change, so you can watch
  a long deploy while it runs.
- Every state-changing command shows a notification in Vortex, and a refusal shows a warning.

### Every reply has the same shape

```jsonc
// success: HTTP 200
{ "ok": true,  "opId": "op-lx3k9q-a1b2c3", "verb": "install", "status": "succeeded", "ms": 5230,
  "result": { ..., "verified": { ... }, "vortex": { "notifications": [], "openDialogs": [] } } }
// failure: HTTP 400 bad request, 404 unknown thing, 409 guard refusal, 500 Vortex did not do it
{ "ok": false, "opId": "...", "verb": "mods.remove", "status": "failed", "ms": 812,
  "code": "remove-incomplete", "message": "...", "details": { "removed": [...], "notRemoved": [...], "vortex": {...} } }
```

- Vortex clears its "needs deploying" flag a few seconds after a deploy, so `deploy` waits up to 20 s for it before
  calling the deploy unverified.
- **`ok: true` is a verified success.** After acting, every changing verb reads Vortex back and fails with an
  `*-unverified` or `*-incomplete` code when the result is not there. `result.verified` lists what was checked.
  You do not need a follow-up `state` call to confirm.
- **`details` on a failure says what did happen**: the steps completed (`completedSteps`, `failedStep`), the mods
  removed before the error, and the files left deployed.
- **`vortex`** is attached to every changing command, on success (in `result`) and on failure (in `details`):
  - `notifications`: what Vortex raised while the command ran. An `error` one means something failed that no
    callback reported.
  - `dialogsSeen`: every dialog that opened during the command, even one answered and gone by the time it ended.
    Each one carries `answer` + `answeredBy: "ifExisting"` when the channel answered it.
  - `openDialogs`: dialogs waiting for the user. This is how you learn a FOMOD installer or a confirmation is
    blocking.

### Long commands: `async` and the op log

- Add `"async": true` to any changing command's body. You get `202 { opId, status: "queued" }` at once, and the
  command runs in the queue.
- `POST /v1/ops.get {"opId": "..."}` returns the record: `queued` → `running` → `succeeded` | `failed`, the same
  fields as the reply, plus the body you sent and timestamps. It answers straight away, even while a change is
  running.
- `POST /v1/ops.list {"limit"?, "verb"?, "status"?, "includeReads"?}` lists recent ops, newest first. Only
  changes are listed unless you pass `includeReads`.
- The last 500 ops are kept in memory. Every finished op is also appended to
  `<Vortex userData>/event-horizon/control-ops.jsonl`, so the owner can read what agents did.
- A dropped connection loses nothing: the op finishes anyway, and `ops.get` has the outcome.

## Verbs

All of them act on Vortex's **active game**.

### Reads

| Verb | Body | Returns |
|---|---|---|
| `state` | `include?`: any of `"mods"`, `"plugins"`, `"downloads"` | Game (path, store, executable, running), active profile, the game's profiles, deployment (`needed`, `deployedFiles`), `counts`, Vortex notifications and open dialogs. The long lists come only when you ask for them in `include`. |
| `mods.find` | `name?` (substring of name or id), `nexusModId?`, `enabled?`, `owner?`, `limit?` (200) | `{ total, mods[], truncated }`: id, name, version, enabled, state, type, nexus ids, source, archiveId, owner. |
| `mod.get` | `id` | Everything Vortex holds about one mod: attributes, rules, installationPath, which profiles enable it, and its plugins. |
| `plugins` | `name?`, `enabled?`, `limit?` (2000) | Plugins in load order. |
| `downloads` | `name?`, `state?`, `limit?` (500) | The active game's downloads, with Nexus ids. |
| `conflicts` | `modId?`, `unresolvedOnly?`, `limit?` (500) | Vortex's own computed file conflicts for the enabled mods, one entry per pair: both mods, the file count plus a sample, and `resolved` with the settling `rule` (a before/after/conflicts rule on either side, by Vortex's own test). `calculated: false` means Vortex has not computed them yet, which is not the same as having none. |
| `plugins.lastGood` | `profileId?` (default active) | The last good plugin list Event Horizon's wipe guard saved for that profile: `order: [{name, enabled}]` plus `savedAt` and `active`, ready to feed to `plugins.apply`. `no-snapshot` (404) until one has been saved. |
| `plugins.rules` | `name?` | LOOT's userlist as Vortex holds it: each plugin's `group`, `after`, `requires`, `incompatible`, plus the user's `groups` and whether autosort is on. `name` narrows to rules that mention that plugin on either side. |
| `mods.rules` | `id` | Every mod rule on a mod (with the mod each one `resolvesTo`), and the rules other mods hold on it (`heldByOthers`). |
| `vortex.notifications` | none | Every current Vortex notification and open dialog. |

### Changes

| Verb | Body | Does, and verifies |
|---|---|---|
| `deploy` | `assumeGameClosed?` | Deploys the active profile. Verifies the "needs deploying" flag is cleared and the manifests read. |
| `purge` | `assumeGameClosed?` | Purges the game folder. Verifies zero files are left deployed. |
| `mods.setEnabled` | `modIds[]`, `enabled`, `profileId?` | Enables or disables by exact id and verifies each change in the profile. It does not deploy. |
| `mods.remove` | `modIds[]`, `assumeGameClosed?` | Uninstalls by exact id and verifies each mod is gone from the pool. `removed` lists them with `owner`. |
| `mods.rule` | `source`, `type` (before/after/conflicts/requires/recommends), `reference`, `versionMatch?` (any/compatible/exact, default any); or `source`, `reference`, `remove: true`, `type?` | Adds or removes a rule, like Vortex's conflict editor: an order rule replaces any before/after/conflicts rule the source already has on that mod. Verified by reading the rules back. The reply has `rulesOnPair` (only the rules between the two) and `sourceRules` (everything the source holds). Reports `otherSideRules` (an order rule the other mod holds on this one, which could make a cycle) and whether the pair's conflict is now `resolved`. |
| `plugins.setEnabled` | `names[]`, `enabled`, `profileId?` (must be the active profile) | Enables or disables plugins by file name. Names Vortex does not list come back in `unknown`. Verified in Vortex's state, and `pluginsTxt` reports what plugins.txt on disk holds once flushed. |
| `plugins.apply` | `order: [{name, enabled}]`, `profileId?` (active only), `sort?` (default false) | Replays a known list, order and enabled state, through EH's installer writer: pins without disabling the user's other plugins, corrects only the states that differ, and flushes plugins.txt. The order is kept exactly unless `sort: true` lets LOOT place the rest. Verified in state (enabled, relative order) and on disk (`pluginsTxt.missingActive`). |
| `plugins.rule` | `name`, `type` (after/before/requires/incompatible), `reference`, `sort?`; or the same with `remove: true` | A LOOT userlist rule, the kind of order that **survives autosort** (a pinned order does not). Written through the installer's `applyUserlist` and verified in the userlist. A `before` rule is stored as LOOT stores it: `reference` gets `after: name` (see `stored`). `sort: true` runs LOOT at once and checks the two plugins came out in that order (`plugin-rule-not-effective` otherwise). |
| `plugins.setGroup` | `name`, `group` | Puts a plugin in a LOOT group (which must exist in LOOT's masterlist or the user's groups). Verified in the userlist. |
| `plugins.sort` | none | Runs LOOT now (the Sort button's event), waits for Vortex to go quiet, and reports `moved: [{name, from, to}]`. |
| `plugins.setAutoSort` | `enabled` | Turns Vortex's plugin autosort on or off, verified in `settings.plugins.autoSort`. `state.plugins.autoSort` reports it. |
| `profile.switch` | `profileId`, `assumeGameClosed?` | Switches profile (which may auto-deploy) and verifies it is the active profile. |
| `game.setPath` | `path`, `store?`, `assumeGameClosed?` | Repoints the active game and verifies the path and store Vortex now reports. |
| `game.switchInstall` | `path`, `profileId`, `store?`, `assumeGameClosed?` | Purge, then set path, switch profile and deploy, each step verified. It stops at the first failure with `failedStep` and `completedSteps`. |
| `install` | `nexus: {modId, fileId}` **or** `archiveId`; `choices?`, `unattended?`, `enable?` (default true), `ifExisting?`, `variantName?`, `asCopy?` | Installs and verifies the mod is in the pool as `installed`, and enabled when asked. It does not deploy. |

`owner` is `"eh-installed"` when an Event Horizon receipt proves Event Horizon installed the mod, and `"not-eh"`
otherwise. Adopted mods count as `"not-eh"`: they are the user's own.

### Failure codes worth knowing

| Code | Meaning |
|---|---|
| `purge-incomplete` / `purge-unverified` | Vortex said the purge was done, but files remain, or the manifests could not be read. |
| `deploy-unverified` | Vortex said the deploy was done, but it still flags the game as needing a deploy, or the manifests could not be read. |
| `install-unverified` / `enable-unverified` | The mod is missing from the pool, is not in the `installed` state, or was not enabled. |
| `remove-incomplete` | Some mods are still in the pool. `details` lists which were removed and which were not. |
| `resorted-after-apply` / `plugins-txt-order` | `plugins.apply` saw its order undone once Vortex went quiet (autosort on), or plugins.txt on disk disagrees with the order. Use `plugins.rule` for orders that must survive a sort. |
| `plugins-unverified` / `plugins-not-applied` | Vortex does not show the enabled state or order that was asked for. `details` lists the plugins. |
| `not-active-profile` | Plugin state lives in the active profile only. Switch first (`game.switchInstall` for another install). |
| `rule-unverified` | The rules Vortex now holds for the pair are not what was asked. `details.rulesOnPair` shows them. |
| `switch-unverified` / `set-path-failed` | Vortex does not report the profile or path that was asked for. |
| `vortex-error` | Vortex threw. The message is Vortex's own. |

## Guards (enforced, not advised)

| Code | When |
|---|---|
| `game-running` | The game's executable is running. This refuses deploy, purge, remove, profile switch and path changes. No flag overrides it. |
| `game-state-unknown` | The process list could not be read. Pass `"assumeGameClosed": true` only when you know the game is closed. |
| `not-purged` | `game.setPath` while any file is still deployed, or a purge that left files behind. |
| `deployment-unknown` | A deployment manifest could not be read. Unknown is never treated as zero. |
| `not-a-game-folder` / `path-missing` / `same-path` | The target folder is not a valid new install of this game. |
| `unknown-mods` | Any id not in the game's pool. **Nothing** is changed; a batch never half-applies. |
| `bad-profile` | The profile is missing, or belongs to another game. |

### Why `game.setPath` refuses unless everything is purged

Vortex's own "Manually set location" repoints a game **without** purging (`browseGameLocation` in Vortex's bundle).
That leaves every hardlink it deployed stranded in the old folder, and Vortex no longer knows about them. The
safe order is the one `game.switchInstall` runs: **purge while still pointed at the old folder**, then repoint,
then switch profile, then deploy.

### Store

`store` is what Vortex records for the folder (`steam`, `gog`, `xbox`, `epic`, ...). Pass it when you know better
than detection: a standalone or modified executable may detect as no store, or the wrong one. Without it, Vortex's
own `GameStoreHelper.identifyStore` decides. The reply always echoes what Vortex recorded.

### `ifExisting`: Vortex's "older version already installed" dialog

Installing a different file of a mod that is already in the pool makes Vortex ask whether to update **all**
profiles (replace) or only the current one (install alongside). Replace moves every profile to the new file,
including the profiles of another install of the same game. The dialog cannot be pre-answered from an extension, so
the channel answers it when it appears:

| `ifExisting` | Button pressed |
|---|---|
| `"ask"` (default) | none: the user answers it in Vortex |
| `"alongside"` | "Update current profile": both versions stay, and only the active profile switches |
| `"replace"` | "Update all profiles" |

Only that dialog is answered, and only while its buttons carry those exact labels. A Vortex that renamed them gets
no answer rather than a wrong one. The choice shows in `vortex.dialogsSeen`.

### Reinstalling an archive that is already installed

Installing the **same archive** again (for example with different FOMOD choices) raises Vortex's other dialog,
"Install options": Replace (every profile) or Install as variant, then "Name mod variant". With `ifExisting`:
`"alongside"` picks the variant and names it `variantName` (default: Vortex's pre-filled name), and `"replace"`
picks Replace. When you send `choices`, the old mod's choices are not copied over. A variant becomes mod
`<oldId>+<name>`, and Vortex disables the old one in the **current** profile only.

**`unattended: true` on such a reinstall is refused** (`would-replace-everywhere`): Vortex treats it as a
dependency reinstall and, outside a collection session, **replaces the mod in every profile without asking**.
The way to reinstall with no dialogs at all is `"asCopy": "<label>"`: the archive is copied as
`<name> (<label>).<ext>` and registered as a new download, so it installs as a separate mod while the original
stays untouched everywhere. Pass `ifExisting: "replace"` only when replacing everywhere is the intent.

### `state.deployment.needed`

`needed` is Vortex's own flag (`vortexFlag`) **or** "mods are enabled but nothing is deployed". After a game
folder is repointed by hand, Vortex's flag reads false with nothing deployed. When the two disagree, `reason` says
so.

### FOMOD installers

`install` without `choices` lets Vortex show its installer dialog, and the op waits until the user answers it. Send it
with `async: true`; the dialog then shows up in `vortex.notifications` → `openDialogs`, and in the op record once it ends.
With `choices` (Vortex's `{ type: "fomod", options: [...] }`), the choices are replayed. With `unattended: true`, no
dialog is shown.
