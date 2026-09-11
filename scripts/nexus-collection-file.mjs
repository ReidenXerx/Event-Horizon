// Put an Event Horizon package (.ehcoll) on a Nexus MOD page as a file.
//
// The curator's collections are distributed as mods, not as Vortex collections:
// the mod page holds the full package and tells people to install it with
// Event Horizon. Packages run to several GB, so this is the multipart flow of
// Nexus API v3: every part is checked against its own MD5 and retried with
// backoff for minutes, and Nexus verifies the upload before the file exists on
// the page. It is NOT resumable — the API has no way to reopen a multipart
// session — so a run that fails for good starts again from the first part; an
// unfinished upload adds nothing to the page.
//
//   node scripts/nexus-collection-file.mjs --file <pkg.ehcoll> --game fallout4 --mod 12345 \
//        --name "Ivy's Panties" --version 1.0.19 [--description-file notes.txt] \
//        [--category main|optional|miscellaneous] [--primary] [--file-id <existing file id>] \
//        [--concurrency 3]
//
// Without --file-id a NEW file is created on the page; with it, the package is
// added as a new VERSION of that file (the previous version stays as an old
// version). --mod is the game-scoped id from the page URL.
//
// Everything that can be wrong is checked BEFORE a byte is uploaded: the
// arguments (an option is never taken as another option's value), the file
// name, that the page is not Event Horizon's own (package.json "nexus"), and
// that --file-id is a file on THIS mod. A file id pasted from the extension's
// page would otherwise add the package to the extension's update chain, and
// with --primary change the extension's version.
//
// The API key is read from ~/.nexusmods/api-key and never printed.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { assertHeaderSafeFilename, hashFile, nexusClient, SINGLE_PART_LIMIT } from "./lib/nexusRelease.mjs";

export const USAGE =
  "Usage: node scripts/nexus-collection-file.mjs --file <pkg> --game <domain> --mod <id> --name <file name> --version <x.y.z> " +
  "[--description-file f] [--category main|optional|miscellaneous] [--primary] [--file-id id] [--concurrency n]";
/** NewModFileCategory in api.nexusmods.com/openapi.yaml (read 2026-09-11). */
export const FILE_CATEGORIES = ["main", "optional", "miscellaneous"];
const VALUE_OPTIONS = new Set(["file", "game", "mod", "name", "version", "category", "description-file", "file-id", "concurrency"]);
const FLAG_OPTIONS = new Set(["primary"]);

/** Wrong input: reported with the usage line, exit code 2. */
export class UsageError extends Error {}

export function parseArgs(argv) {
  const values = {};
  let primary = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new UsageError(`Unexpected argument "${arg}"; every value follows its option`);
    const key = arg.slice(2);
    if (FLAG_OPTIONS.has(key)) {
      primary = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(key)) throw new UsageError(`Unknown option ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new UsageError(`${arg} needs a value${value === undefined ? "" : `, and the next argument is the option ${value}`}`);
    }
    if (key in values) throw new UsageError(`${arg} is given twice`);
    values[key] = value;
    i += 1;
  }
  for (const k of ["file", "game", "mod", "name", "version"]) {
    if (values[k] === undefined) throw new UsageError(`--${k} is required`);
  }
  const { game, mod, name, version } = values;
  if (!/^[a-z0-9-]+$/i.test(game)) throw new UsageError(`--game "${game}" is not a game domain (fallout4, skyrimspecialedition, …)`);
  if (!/^[1-9]\d*$/.test(mod)) throw new UsageError(`--mod "${mod}" is not a mod id; use the number from the page URL`);
  const category = values.category ?? "main";
  if (!FILE_CATEGORIES.includes(category)) throw new UsageError(`--category "${category}" is not one of ${FILE_CATEGORIES.join(", ")}`);
  const concurrencyText = values.concurrency ?? "3";
  const concurrency = Number(concurrencyText);
  if (!/^\d+$/.test(concurrencyText) || !Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new UsageError(`--concurrency "${concurrencyText}" must be a whole number of at least 1`);
  }
  if (!/^[a-zA-Z0-9 _'().-]+$/.test(name) || name.length > 50) {
    throw new UsageError(`File name "${name}" is not accepted by Nexus (letters, digits, space, _'().- and at most 50 chars)`);
  }
  if (!/^[a-zA-Z0-9.-]+$/.test(version) || version.length > 50) throw new UsageError(`Version "${version}" is not accepted by Nexus`);
  return {
    filePath: values.file,
    game,
    modScopedId: mod,
    name,
    version,
    category,
    descriptionFile: values["description-file"],
    fileId: values["file-id"],
    primary,
    concurrency,
  };
}

/**
 * Event Horizon's own page is never a target: not the section it is published
 * in, and not its mod id. `extension` is package.json's "nexus" block.
 */
export function refuseExtensionPage({ game, modScopedId }, extension) {
  if (game === "site" || (extension?.gameDomain !== undefined && game === extension.gameDomain)) {
    throw new UsageError(
      `--game ${game} is where Event Horizon itself is published (package.json "nexus": ${extension?.gameDomain ?? "site"}/mods/${extension?.modId ?? "?"}); ` +
        "a collection package belongs on its game's mod page",
    );
  }
  if (extension?.modId !== undefined && String(extension.modId) === String(modScopedId)) {
    throw new UsageError(`--mod ${modScopedId} is Event Horizon's own mod id (package.json "nexus".modId); refusing, so a package cannot land on the extension's page`);
  }
}

/**
 * The whole command, with the client injected. Every local and remote check
 * runs before the upload; the client is only created once the arguments hold.
 */
export async function publish({ argv, extension, makeClient, log }) {
  const opts = parseArgs(argv);
  refuseExtensionPage(opts, extension);
  const filename = path.basename(opts.filePath);
  assertHeaderSafeFilename(filename);
  const stat = fs.statSync(opts.filePath);
  if (!stat.isFile()) throw new UsageError(`${opts.filePath} is not a file`);
  const descriptionText =
    opts.descriptionFile !== undefined ? fs.readFileSync(opts.descriptionFile, "utf8").replace(/\r\n/g, "\n").trim() : undefined;
  log(`${filename}: ${stat.size} bytes (${(stat.size / 1024 ** 3).toFixed(2)} GiB), ${stat.size > SINGLE_PART_LIMIT ? "multipart" : "single-part"} upload`);

  const client = makeClient();
  const mod = await client.getMod(opts.game, opts.modScopedId);
  if (!mod?.id) throw new Error(`Mod ${opts.game}/${opts.modScopedId} not found`);
  log(`mod: "${mod.name}" (id ${mod.id}, game-scoped ${mod.game_scoped_id ?? opts.modScopedId}, status ${mod.status ?? "?"})`);
  if (opts.fileId !== undefined) {
    const files = (await client.getModFiles(mod.id))?.mod_files ?? [];
    const target = files.find((f) => String(f.id) === opts.fileId);
    if (target === undefined) {
      throw new UsageError(
        `--file-id ${opts.fileId} is not a file on ${opts.game}/mods/${opts.modScopedId} ("${mod.name}"). ` +
          `Its files: ${files.map((f) => `${f.name} (${f.id})`).join("; ") || "none"}. Nothing was uploaded.`,
      );
    }
    log(`target: a new version of "${target.name}" (file ${target.id})`);
  } else {
    log("target: a new file on the page");
  }

  const digests = await hashFile(opts.filePath);
  log(`md5 ${digests.md5}`);
  log(`sha256 ${digests.sha256}`);
  const description = descriptionText ?? `Event Horizon package. SHA-256 ${digests.sha256}`;

  const uploadId = await client.uploadArchiveFromDisk({ filePath: opts.filePath, filename, onState: log, concurrency: opts.concurrency, digests });
  log(`upload ${uploadId} is available`);

  const common = {
    upload_id: uploadId,
    name: opts.name,
    version: opts.version,
    description,
    file_category: opts.category,
    primary_mod_manager_download: opts.primary,
    allow_mod_manager_download: true,
    show_requirements_pop_up: false,
    update_mod_version: opts.primary,
  };
  const created =
    opts.fileId !== undefined
      ? await client.createModFileVersion(opts.fileId, common)
      : await client.createModFile({ ...common, mod_id: String(mod.id) });
  log(`created: ${JSON.stringify(created)}`);
  log(`Page: https://www.nexusmods.com/${opts.game}/mods/${opts.modScopedId}?tab=files`);
  return created;
}

const invoked = process.argv[1] !== undefined && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (invoked) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const stamp = () => new Date().toISOString().slice(11, 19);
  const log = (m) => console.log(`${stamp()} ${m}`);
  try {
    await publish({
      argv: process.argv.slice(2),
      extension: pkg.nexus,
      log,
      makeClient: () =>
        nexusClient({
          apiKey: fs.readFileSync(path.join(os.homedir(), ".nexusmods", "api-key"), "utf8").trim(),
          userAgent: "event-horizon-collection-publisher",
        }),
    });
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${stamp()} ${err.message}\n${USAGE}`);
      process.exitCode = 2;
    } else {
      console.error(`${stamp()} ${err?.stack ?? err}`);
      process.exitCode = 1;
    }
  }
}
