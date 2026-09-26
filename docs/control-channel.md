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

- `GET /v1/health` returns the version and the verb list.
- `POST /v1/<verb>` with a JSON object body (read verbs also accept `GET`).
- Success: `200 { "ok": true, "result": { ... } }`.
- Refusal or failure: `{ "ok": false, "code": "<code>", "message": "..." }`, with 400 for a bad request, 409 for a
  guard refusal, and 500 when Vortex failed.
- Commands run **one at a time** in arrival order. A long deploy holds the connection until it finishes, so use no
  client timeout, or a long one.
- Every state-changing command shows a notification in Vortex, and a refusal shows a warning.

## Verbs

All of them act on Vortex's **active game**.

| Verb | Body | Does |
|---|---|---|
| `state` | none | Game (path, store, executable, running), active profile, the game's profiles, mods (id, name, version, enabled, type, nexus ids, source, archiveId, `owner`), plugins (load order), downloads, and deployment (`needed`, `deployedFiles`). |
| `deploy` | `assumeGameClosed?` | Deploys the active profile and waits for Vortex. |
| `purge` | `assumeGameClosed?` | Purges the game folder. The reply carries `deployedFilesAfter`. |
| `mods.setEnabled` | `modIds[]`, `enabled`, `profileId?` | Enables or disables by exact id. It does not deploy. |
| `mods.remove` | `modIds[]`, `assumeGameClosed?` | Uninstalls by exact id. The reply lists `removed` (with `owner`) and `notRemoved`. |
| `profile.switch` | `profileId`, `assumeGameClosed?` | Switches profile, which may auto-deploy. |
| `game.setPath` | `path`, `store?`, `assumeGameClosed?` | Points the active game at another install folder. |
| `game.switchInstall` | `path`, `profileId`, `store?`, `assumeGameClosed?` | Purge, then set path, switch profile and deploy. It stops at the first failed step and names it. |
| `install` | `nexus: {modId, fileId}` **or** `archiveId`; `choices?`, `unattended?`, `enable?` (default true) | Installs into the active game and enables it in the active profile. It does not deploy. |

`owner` is `"eh-installed"` when an Event Horizon receipt proves Event Horizon installed the mod, and `"not-eh"`
otherwise. Adopted mods count as `"not-eh"`: they are the user's own.

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

### FOMOD installers

`install` without `choices` lets Vortex show its installer dialog, and the request waits until the user answers it.
With `choices` (Vortex's `{ type: "fomod", options: [...] }`), the choices are replayed. With `unattended: true`, no
dialog is shown.
