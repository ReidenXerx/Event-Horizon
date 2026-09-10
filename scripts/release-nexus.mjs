#!/usr/bin/env node
/**
 * npm run release [-- --dry-run]        (alias: npm run release:nexus)
 *
 * One command publishes a version everywhere people look:
 *   1. Nexus — a new version of the main file on the mod page, with the
 *      changelog, so installed copies can be offered the update by Vortex
 *      (once the extension is listed; see docs/PUBLISHING.md)
 *   2. GitHub — tag v<version> and a Release with the same notes and the zip
 *
 * The notes are the version's section of CHANGELOG.md, and nothing else: what
 * players read on Nexus, on GitHub and in the repository is the same text.
 *
 * Refuses, before touching either site, when:
 *   - package.json / info.json / src/ui/version.ts disagree
 *   - the version is not plain x.y.z (Vortex would never offer it as an update)
 *   - CHANGELOG.md has no section for the version
 *   - the version is not newer than what Nexus already has, by Vortex's rule
 *   - the working tree is dirty, or HEAD is not on the upstream branch
 *   - the tag or the GitHub Release already exists, or `gh` is not signed in
 *   - tests, typecheck, packaging or the smoke load fail
 *
 * Nexus API key: NEXUSMODS_API_KEY, or the first line of ~/.nexusmods/api-key
 * (https://www.nexusmods.com/settings/api-keys). It is never printed.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractReleaseNotes, toPlainChangelog } from "./lib/changelog.mjs";
import {
  findMainFile,
  isReleasableVersion,
  nexusClient,
  readZipEntry,
  vortexWouldOfferUpdate,
} from "./lib/nexusRelease.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");
const isWindows = process.platform === "win32";

const step = (msg) => console.log(`\n▶ ${msg}`);
const info = (msg) => console.log(`  ${msg}`);
const fail = (msg) => {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
};

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const gh = (...args) => spawnSync("gh", args, { cwd: root, encoding: "utf8", shell: isWindows });
const npm = (script) => {
  const res = spawnSync(isWindows ? "npm.cmd" : "npm", ["run", script], { cwd: root, stdio: "inherit", shell: isWindows });
  if (res.status !== 0) fail(`npm run ${script} failed (exit ${res.status}) — nothing was published.`);
};

function readApiKey() {
  if (process.env.NEXUSMODS_API_KEY?.trim()) return process.env.NEXUSMODS_API_KEY.trim();
  const file = path.join(os.homedir(), ".nexusmods", "api-key");
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/)[0].trim();
  } catch {
    fail(`No Nexus API key. Set NEXUSMODS_API_KEY or put the key on the first line of ${file}.`);
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const nexus = pkg.nexus ?? {};
const version = pkg.version;
const tag = `v${version}`;

// ── 1. version and notes ─────────────────────────────────────────────────
step(`Release ${version}${dryRun ? " (dry run)" : ""}`);
const sync = spawnSync(process.execPath, [path.join(root, "scripts", "check-version-sync.mjs")], { cwd: root, stdio: "inherit" });
if (sync.status !== 0) fail("Version files disagree.");
if (!isReleasableVersion(version)) {
  fail(`Version "${version}" is not plain x.y.z. Vortex coerces "-alpha.N" away, so installed copies would never be offered this update.`);
}
if (!nexus.gameDomain || !nexus.modId || !nexus.fileName) fail(`package.json needs "nexus": { "gameDomain", "modId", "fileName" }.`);
const notes = extractReleaseNotes(fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), version);
if (notes === undefined) fail(`CHANGELOG.md has no notes for ${version}. Add a "## [${version}] — <date>" section first.`);
info(`notes: ${notes.split("\n").length} lines from CHANGELOG.md`);

// ── 2. git and GitHub ────────────────────────────────────────────────────
step("Checking git and GitHub");
if (git("status", "--porcelain").length > 0) fail("Working tree is not clean. Commit first, so the release is exactly a commit.");
git("fetch", "--quiet");
const head = git("rev-parse", "HEAD");
let upstream;
try {
  upstream = git("rev-parse", "@{u}");
} catch {
  fail("The current branch has no upstream.");
}
if (head !== upstream) fail("HEAD is not the upstream commit. Push (or pull --rebase) first.");
if (git("tag", "--list", tag).length > 0) fail(`Tag ${tag} already exists — bump the version.`);
if (gh("auth", "status").status !== 0) fail("GitHub CLI is not signed in (gh auth login).");
if (gh("release", "view", tag).status === 0) fail(`A GitHub Release ${tag} already exists.`);
info(`HEAD ${head.slice(0, 7)}; tag and release ${tag} are free; gh signed in`);

// ── 3. Nexus: what is there now ──────────────────────────────────────────
step(`Reading Nexus ${nexus.gameDomain}/mods/${nexus.modId}`);
const client = nexusClient({ apiKey: readApiKey(), userAgent: `EventHorizonRelease/${version}` });
const mod = await client.getMod(nexus.gameDomain, String(nexus.modId));
if (!mod?.id) fail("Nexus returned no mod id.");
const { file, latest } = await findMainFile(client, mod.id);
info(`mod "${mod.name ?? ""}" (${mod.id}), main file "${file.name}" (${file.id}), latest version ${latest.version} (${latest.id})`);
if (!vortexWouldOfferUpdate(latest.version, version)) {
  fail(`${version} is not newer than ${latest.version} as Vortex compares versions — installed copies would not update.`);
}

// ── 4. build and prove it ────────────────────────────────────────────────
step("Tests, typecheck, package, smoke");
npm("test");
npm("typecheck");
npm("package:extension");
npm("smoke");

const zipName = `event-horizon-${version}.zip`;
const zipPath = path.join(root, "release", zipName);
const bytes = fs.readFileSync(zipPath);
const infoEntry = readZipEntry(bytes, "info.json");
if (infoEntry === undefined) fail(`${zipName} has no info.json at its root — Vortex would reject it.`);
const zipInfo = JSON.parse(infoEntry.toString("utf8"));
if (zipInfo.version !== version) fail(`info.json inside ${zipName} says ${zipInfo.version}, expected ${version}.`);
info(`${zipName}: ${bytes.length} bytes, info.json ${zipInfo.name} ${zipInfo.version}`);

if (dryRun) {
  step("Dry run — stopping before any write to Nexus or GitHub. Notes that would be published:");
  console.log(notes);
  process.exit(0);
}

// ── 5. Nexus ─────────────────────────────────────────────────────────────
step("Uploading to Nexus");
const uploadId = await client.uploadArchive({ bytes, filename: zipName, onState: info });
const created = await client.createModFileVersion(file.id, {
  upload_id: uploadId,
  name: `${nexus.fileName} ${version}`,
  version,
  description: pkg.description ?? zipInfo.description ?? "",
  file_category: "main",
  primary_mod_manager_download: true,
  allow_mod_manager_download: true,
  update_mod_version: true,
  // One file under Main Files is a review rule; the previous version is archived.
  archive_existing_file: true,
  previous_version_id: latest.id,
});
info(`created version ${created?.version?.id ?? "?"}`);
await client.addChangelog(mod.id, version, toPlainChangelog(notes));
info("changelog added");
const after = (await client.getModFileVersions(file.id))?.versions ?? [];
if (!after.some((v) => v.version === version)) fail(`Nexus does not list ${version} on file ${file.id} yet — check the page before tagging.`);

// ── 6. GitHub ────────────────────────────────────────────────────────────
step("Tagging and publishing the GitHub Release");
git("tag", "-a", tag, "-m", `Event Horizon ${version}`);
git("push", "origin", tag);
const notesFile = path.join(os.tmpdir(), `event-horizon-${version}-notes.md`);
fs.writeFileSync(notesFile, `${notes}\n\nAlso on Nexus Mods: https://www.nexusmods.com/${nexus.gameDomain}/mods/${nexus.modId}\n`, "utf8");
const release = gh("release", "create", tag, zipPath, "--verify-tag", "--title", `Event Horizon ${version}`, "--notes-file", notesFile);
if (release.status !== 0) {
  fail(
    `Nexus has ${version} and the tag is pushed, but the GitHub Release failed:\n${release.stderr}\n` +
      `Finish it with: gh release create ${tag} "${zipPath}" --verify-tag --title "Event Horizon ${version}" --notes-file "${notesFile}"`,
  );
}
step(`Released ${version}`);
info(`Nexus:  https://www.nexusmods.com/${nexus.gameDomain}/mods/${nexus.modId}?tab=files`);
info(`GitHub: ${release.stdout.trim()}`);
info("Vortex offers the update after Nexus's daily extension-manifest refresh (~07:45 UTC), for listed extensions.");
