#!/usr/bin/env node
/**
 * npm run release:nexus [-- --dry-run]
 *
 * Tests, packages, and uploads the current version to Event Horizon's Nexus
 * page as a new version of its main file, adds the changelog, verifies Nexus
 * now reports it, then tags the commit. Vortex offers the update to installed
 * copies once Nexus's daily extension-manifest refresh picks it up — which
 * requires the extension to be LISTED (see docs/PUBLISHING.md).
 *
 * Refuses, before touching Nexus, when:
 *   - package.json / info.json / src/ui/version.ts disagree
 *   - the version is not plain x.y.z (Vortex would never offer it as an update)
 *   - the version is not newer than what Nexus already has, by Vortex's rule
 *   - the working tree is dirty, or HEAD is not on the upstream branch
 *   - the tag v<version> already exists
 *   - tests, typecheck, packaging or the smoke load fail
 *
 * API key: NEXUSMODS_API_KEY, or the first line of ~/.nexusmods/api-key.
 * Create one at https://www.nexusmods.com/settings/api-keys. It is never printed.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  findMainFile,
  formatChangelog,
  isReleasableVersion,
  nexusClient,
  readZipEntry,
  vortexWouldOfferUpdate,
} from "./lib/nexusRelease.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");

const step = (msg) => console.log(`\n▶ ${msg}`);
const info = (msg) => console.log(`  ${msg}`);
const fail = (msg) => {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
};

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const npm = (script) => {
  const res = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", script], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (res.status !== 0) fail(`npm run ${script} failed (exit ${res.status}) — nothing was uploaded.`);
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

// ── 1. versions ──────────────────────────────────────────────────────────
step(`Release ${version}${dryRun ? " (dry run)" : ""}`);
const sync = spawnSync(process.execPath, [path.join(root, "scripts", "check-version-sync.mjs")], { cwd: root, stdio: "inherit" });
if (sync.status !== 0) fail("Version files disagree.");
if (!isReleasableVersion(version)) {
  fail(`Version "${version}" is not plain x.y.z. Vortex coerces "-alpha.N" away, so installed copies would never be offered this update.`);
}
if (!nexus.gameDomain || !nexus.modId || !nexus.fileName) fail(`package.json needs "nexus": { "gameDomain", "modId", "fileName" }.`);

// ── 2. git ───────────────────────────────────────────────────────────────
step("Checking git");
if (git("status", "--porcelain").length > 0) fail("Working tree is not clean. Commit first, so the upload is exactly a commit.");
git("fetch", "--quiet");
const head = git("rev-parse", "HEAD");
let upstream;
try {
  upstream = git("rev-parse", "@{u}");
} catch {
  fail("The current branch has no upstream.");
}
if (head !== upstream) fail("HEAD is not the upstream commit. Push (or pull --rebase) first.");
const tag = `v${version}`;
if (git("tag", "--list", tag).length > 0) fail(`Tag ${tag} already exists — bump the version.`);
info(`HEAD ${head.slice(0, 7)}, tag ${tag} is free`);

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

// ── 5. changelog ─────────────────────────────────────────────────────────
let previousTag;
try {
  previousTag = git("describe", "--tags", "--match", "v[0-9]*", "--abbrev=0", "HEAD");
} catch {
  previousTag = undefined;
}
const range = previousTag ? [`${previousTag}..HEAD`] : ["-n", "30"];
const subjects = git("log", "--no-merges", "--pretty=format:%s", ...range).split("\n");
const changelog = formatChangelog(subjects);
info(`changelog: ${subjects.filter(Boolean).length} commit(s) since ${previousTag ?? "the last 30"}`);

if (dryRun) {
  step("Dry run — stopping before any write to Nexus");
  console.log(changelog);
  process.exit(0);
}

// ── 6. upload ────────────────────────────────────────────────────────────
step("Uploading");
const uploadId = await client.uploadArchive({ bytes, filename: zipName, onState: info });
const created = await client.createModFileVersion(file.id, {
  upload_id: uploadId,
  name: nexus.fileName,
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
await client.addChangelog(mod.id, version, changelog);
info("changelog added");

// ── 7. verify, then tag ──────────────────────────────────────────────────
step("Verifying Nexus reports the new version");
const after = (await client.getModFileVersions(file.id))?.versions ?? [];
if (!after.some((v) => v.version === version)) fail(`Nexus does not list ${version} on file ${file.id} yet — check the page before tagging.`);
git("tag", "-a", tag, "-m", `Event Horizon ${version} on Nexus (${nexus.gameDomain}/mods/${nexus.modId})`);
git("push", "origin", tag);
step(`Released ${version}`);
info(`https://www.nexusmods.com/${nexus.gameDomain}/mods/${nexus.modId}?tab=files`);
info("Vortex offers the update after Nexus's daily extension-manifest refresh (~07:45 UTC), for listed extensions.");
