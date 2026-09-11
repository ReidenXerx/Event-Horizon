// Put an Event Horizon package (.ehcoll) on a Nexus MOD page as a file.
//
// The curator's collections are distributed as mods, not as Vortex collections:
// the mod page holds the full package and tells people to install it with
// Event Horizon. Packages run to several GB, so this is the multipart flow of
// Nexus API v3, resumable per part and verified by Nexus before the file
// exists on the page.
//
//   node scripts/nexus-collection-file.mjs --file <pkg.ehcoll> --game fallout4 --mod 12345 \
//        --name "Ivy's Panties" --version 1.0.19 [--description-file notes.txt] \
//        [--category main] [--primary] [--file-id <existing file id>]
//
// Without --file-id a NEW file is created on the page; with it, the package is
// added as a new VERSION of that file (the previous version stays as an old
// version). --mod is the game-scoped id from the page URL. The API key is read
// from ~/.nexusmods/api-key and never printed.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { nexusClient, SINGLE_PART_LIMIT } from "./lib/nexusRelease.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const filePath = opt("file");
const game = opt("game");
const modScopedId = opt("mod");
const name = opt("name");
const version = opt("version");
const category = opt("category", "main");
const descriptionFile = opt("description-file");
const fileId = opt("file-id");
if (!filePath || !game || !modScopedId || !name || !version) {
  console.error("Usage: --file <pkg> --game <domain> --mod <id> --name <file name> --version <x.y.z> [--description-file f] [--category main] [--primary] [--file-id id]");
  process.exit(2);
}
if (!/^[a-zA-Z0-9 _'().-]+$/.test(name) || name.length > 50) throw new Error(`File name "${name}" is not accepted by Nexus (letters, digits, space, _'().- and at most 50 chars)`);
if (!/^[a-zA-Z0-9.-]+$/.test(version) || version.length > 50) throw new Error(`Version "${version}" is not accepted by Nexus`);

const apiKey = fs.readFileSync(path.join(os.homedir(), ".nexusmods", "api-key"), "utf8").trim();
const client = nexusClient({ apiKey, userAgent: "event-horizon-collection-publisher" });
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (m) => console.log(`${stamp()} ${m}`);

const { size } = fs.statSync(filePath);
const filename = path.basename(filePath);
log(`${filename}: ${size} bytes (${(size / 1024 ** 3).toFixed(2)} GiB), ${size > SINGLE_PART_LIMIT ? "multipart" : "single-part"} upload`);

const mod = await client.getMod(game, modScopedId);
if (!mod?.id) throw new Error(`Mod ${game}/${modScopedId} not found`);
log(`mod: "${mod.name}" (id ${mod.id}, game-scoped ${mod.game_scoped_id ?? modScopedId}, status ${mod.status ?? "?"})`);

const sha256 = createHash("sha256");
await new Promise((resolve, reject) => fs.createReadStream(filePath).on("data", (c) => sha256.update(c)).on("end", resolve).on("error", reject));
const digest = sha256.digest("hex");
log(`sha256 ${digest}`);

const description = descriptionFile ? fs.readFileSync(descriptionFile, "utf8").replace(/\r\n/g, "\n").trim() : `Event Horizon package. SHA-256 ${digest}`;

const uploadId = await client.uploadArchiveFromDisk({ filePath, filename, onState: log, concurrency: Number(opt("concurrency", "3")) });
log(`upload ${uploadId} is available`);

const common = {
  upload_id: uploadId,
  name,
  version,
  description,
  file_category: category,
  primary_mod_manager_download: flag("primary"),
  allow_mod_manager_download: true,
  show_requirements_pop_up: false,
  update_mod_version: flag("primary"),
};
const created = fileId
  ? await client.createModFileVersion(fileId, common)
  : await client.createModFile({ ...common, mod_id: String(mod.id) });
log(`created: ${JSON.stringify(created)}`);
console.log(`Page: https://www.nexusmods.com/${game}/mods/${modScopedId}?tab=files`);
