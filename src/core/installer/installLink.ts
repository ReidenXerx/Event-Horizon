/**
 * ──────────────────────────────────────────────────────────────────────
 * "Paste this link" — the pure half of installing a collection by URL.
 *
 * A collection page on Nexus says: install Event Horizon, then paste this
 * page's link. This module decides what a pasted link IS and which file on
 * a mod page is the package; nothing here touches the network or Vortex.
 *
 * Three shapes are accepted:
 *
 *   nexus   https://www.nexusmods.com/<domain>/mods/<id>[?tab=files&file_id=N]
 *           https://www.nexusmods.com/games/<domain>/mods/<id>
 *           nxm://<domain>/mods/<id>/files/<fileId>[?...]
 *   direct  any other http(s) URL — the link IS the file
 *   invalid anything else, with the reason
 *
 * The distinction matters because the two paths are nothing alike: a Nexus
 * link goes through Vortex's own Nexus integration (Premium downloads it,
 * a free account is sent to the page), a direct link is fetched by Event
 * Horizon itself. Guessing wrong sends someone to look for a page that never
 * appears, or waits for a download that never starts.
 * ──────────────────────────────────────────────────────────────────────
 */

export type InstallLink =
  | {
      kind: "nexus";
      /** Nexus's game domain as it appears in the URL, e.g. `skyrimspecialedition`. */
      domain: string;
      modId: number;
      /** Only when the link names one file (`file_id=` or an nxm link). */
      fileId?: number;
      /** The package's published SHA-256, from a `#sha256=` fragment. Lowercase hex. */
      sha256?: string;
    }
  | {
      kind: "direct";
      /** The download address: no fragment, no credentials. */
      url: string;
      /** The package's published SHA-256, from a `#sha256=` fragment. Lowercase hex. */
      sha256?: string;
    }
  | { kind: "invalid"; why: string };

const NEXUS_HOSTS = new Set(["www.nexusmods.com", "nexusmods.com"]);

/**
 * A host on this machine. Plain http to it never crosses a network, so
 * nothing between the two ends can change the bytes; everywhere else it can.
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** Why a web address may not carry a package, or undefined when it may. */
export function insecureLinkReason(url: URL): string | undefined {
  if (url.protocol === "https:") return undefined;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return undefined;
  if (url.protocol === "http:") {
    return (
      "Plain http links are refused: anything between you and the server can change the bytes on the way, and a " +
      "collection package installs DLLs. Use the https:// form of the link."
    );
  }
  return `Only web links are accepted, not "${url.protocol.replace(/:$/, "")}" links.`;
}

/**
 * The `#sha256=<64 hex>` a link may carry. A fragment is never sent to the
 * server, so the checksum travels with the link without changing what is
 * downloaded. A fragment that mentions sha256 but is not exactly that shape
 * is refused rather than ignored: whoever wrote it meant the file to be
 * checked, and silently not checking is the one wrong answer.
 */
function checksumOf(url: URL): { sha256?: string; why?: string } {
  const fragment = url.hash.replace(/^#/, "");
  if (!/sha-?256/i.test(fragment)) return {};
  const m = /^sha256=([0-9a-f]{64})$/i.exec(fragment);
  if (m === null) {
    return {
      why:
        "The link's #sha256= is not a SHA-256 checksum. It must be exactly 64 hexadecimal characters after " +
        "#sha256=, as the collection's page gives it.",
    };
  }
  return { sha256: m[1].toLowerCase() };
}

/** What the user pasted, classified. Whitespace around it is ignored. */
export function parseInstallLink(input: string): InstallLink {
  const raw = input.trim();
  if (raw.length === 0) return { kind: "invalid", why: "Paste a link first." };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      kind: "invalid",
      why: "That is not a link. Paste the address of a Nexus mod page, or a direct link to a .ehcoll file.",
    };
  }

  const checksum = checksumOf(url);
  if (checksum.why !== undefined) return { kind: "invalid", why: checksum.why };
  const sha = checksum.sha256 !== undefined ? { sha256: checksum.sha256 } : {};

  if (url.protocol === "nxm:") {
    // nxm://skyrimspecialedition/mods/191460/files/803758?key=...&expires=...
    const m = /^\/mods\/(\d+)\/files\/(\d+)/.exec(url.pathname);
    const domain = url.hostname.toLowerCase();
    if (m === null || domain.length === 0) {
      return { kind: "invalid", why: "That nxm link does not name a mod file." };
    }
    return { kind: "nexus", domain, modId: Number(m[1]), fileId: Number(m[2]), ...sha };
  }

  const insecure = insecureLinkReason(url);
  if (insecure !== undefined) return { kind: "invalid", why: insecure };

  if (NEXUS_HOSTS.has(url.hostname.toLowerCase())) {
    const m = /^\/(?:games\/)?([a-z0-9]+)\/mods\/(\d+)(?:\/|$)/i.exec(url.pathname);
    if (m === null) {
      return {
        kind: "invalid",
        why: "That is a Nexus link, but not a mod page. Paste the page address, like https://www.nexusmods.com/fallout4/mods/108944.",
      };
    }
    const fileIdRaw = url.searchParams.get("file_id");
    let fileId: number | undefined;
    if (fileIdRaw !== null) {
      // `file_id=1e3` is not file 1000 and not "no file named": the link
      // meant one file, and quietly choosing among the page's files instead
      // would install something its author did not point at.
      if (!/^[1-9]\d*$/.test(fileIdRaw) || !Number.isSafeInteger(Number(fileIdRaw))) {
        return {
          kind: "invalid",
          why: `The link's file_id "${fileIdRaw.slice(0, 40)}" is not a file number. Copy the file's link from the page's Files tab again.`,
        };
      }
      fileId = Number(fileIdRaw);
    }
    return {
      kind: "nexus",
      domain: m[1].toLowerCase(),
      modId: Number(m[2]),
      ...(fileId !== undefined ? { fileId } : {}),
      ...sha,
    };
  }

  // Credentials in a link would be sent to every host a redirect reaches and
  // written into the log; the fragment is ours, not the server's.
  url.username = "";
  url.password = "";
  url.hash = "";
  return { kind: "direct", url: directDownloadUrl(url), ...sha };
}

/**
 * Hosts whose share PAGE is what people paste, and whose direct link is a
 * known transform of it. Pasting the page as-is would download HTML and be
 * refused as a package one step later, with a message about the file rather
 * than the link.
 */
function directDownloadUrl(url: URL): string {
  const host = url.hostname.toLowerCase();
  if (host === "pixeldrain.com" || host === "www.pixeldrain.com") {
    // https://pixeldrain.com/u/<id>  ->  https://pixeldrain.com/api/file/<id>?download
    const m = /^\/u\/([A-Za-z0-9]+)\/?$/.exec(url.pathname);
    if (m !== null) return `https://pixeldrain.com/api/file/${m[1]}?download`;
  }
  return url.toString();
}

/** The fields of a Nexus file listing this module reads. */
export type NexusFileCandidate = {
  file_id: number;
  /** Display name on the page ("Ivy's Panties"). */
  name?: string;
  /** Name on disk ("ivy-panties-1.0.19.ehcoll"). */
  file_name?: string;
  version?: string;
  category_id?: number;
  category_name?: string;
  is_primary?: boolean;
  size_in_bytes?: number;
  /** Nexus's older listings report kilobytes. */
  size_kb?: number;
  uploaded_timestamp?: number;
};

export type ChosenFile =
  /** The collection package itself. */
  | { kind: "one"; file: NexusFileCandidate }
  /**
   * No package on the page, and this small zip is what it offers instead: a
   * landing page whose file carries the package's link and SHA-256 (read by
   * `core/installer/linkCarrier.ts`).
   */
  | { kind: "carrier"; file: NexusFileCandidate }
  | { kind: "several"; files: NexusFileCandidate[] }
  | { kind: "none"; why: string };

/**
 * Nexus's file categories, by the NAME the listing gives them ("MAIN",
 * "OLD_VERSION"). The names are what the site shows and what this code
 * means; the numeric ids were guessed, and one of the guesses was wrong.
 */
const MAIN_CATEGORY = "MAIN";
/** Old versions, archived and deleted files carry these; never offered. */
const RETIRED_CATEGORIES = new Set(["OLD_VERSION", "ARCHIVED", "DELETED", "REMOVED"]);

function categoryOf(file: NexusFileCandidate): string {
  return (file.category_name ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isEhcoll(file: NexusFileCandidate): boolean {
  return /\.ehcoll$/i.test(file.file_name ?? "");
}

function isZip(file: NexusFileCandidate): boolean {
  return /\.zip$/i.test(file.file_name ?? "");
}

/**
 * Which file on the page is the collection.
 *
 * A named `fileId` is the link author's choice: a `.ehcoll` is the package,
 * a `.zip` is a link file, and anything else is refused by name rather than
 * downloaded and failed on later. Otherwise retired files are dropped and the
 * `.ehcoll` files considered: the page's primary file, then a single Main
 * file. Two or more still equal are a question for the person, never a pick
 * by upload date (NS-8's spirit: an ambiguous package is a question, not a
 * coin toss). A page with no package but a link file is a landing page, and
 * the same rules choose among its zips.
 */
export function chooseEhcollFile(files: NexusFileCandidate[], fileId?: number): ChosenFile {
  if (fileId !== undefined) {
    const named = files.find((f) => f.file_id === fileId);
    if (named === undefined) {
      return { kind: "none", why: `The link names file ${fileId}, and the page has no such file.` };
    }
    if (isEhcoll(named)) return { kind: "one", file: named };
    if (isZip(named)) return { kind: "carrier", file: named };
    return {
      kind: "none",
      why:
        `The link names file ${fileId} ("${named.file_name ?? named.name ?? "unnamed"}"), which is neither a ` +
        "collection package (.ehcoll) nor a link file (.zip).",
    };
  }

  const live = files.filter((f) => !RETIRED_CATEGORIES.has(categoryOf(f)));
  const packages = live.filter(isEhcoll);
  if (packages.length > 0) {
    const pick = pickOne(packages);
    return pick.kind === "one" ? { kind: "one", file: pick.file } : pick;
  }
  const carriers = live.filter(isZip);
  if (carriers.length > 0) {
    const pick = pickOne(carriers);
    return pick.kind === "one" ? { kind: "carrier", file: pick.file } : pick;
  }
  return {
    kind: "none",
    why:
      files.length === 0
        ? "The page lists no files."
        : "The page has no .ehcoll file and no link file (.zip). It may be an ordinary mod page, or the collection is not published yet.",
  };
}

function pickOne(
  candidates: NexusFileCandidate[],
): { kind: "one"; file: NexusFileCandidate } | { kind: "several"; files: NexusFileCandidate[] } {
  if (candidates.length === 1) return { kind: "one", file: candidates[0] };
  const primary = candidates.filter((f) => f.is_primary === true);
  if (primary.length === 1) return { kind: "one", file: primary[0] };
  const main = candidates.filter((f) => categoryOf(f) === MAIN_CATEGORY);
  if (main.length === 1) return { kind: "one", file: main[0] };
  return { kind: "several", files: main.length > 1 ? main : candidates };
}

/**
 * The Vortex games whose Nexus domain is `domain`, named the way Vortex shows
 * them. Several can share one domain (Skyrim Special Edition and Skyrim VR).
 */
export function vortexGamesForNexusDomain(
  known: ReadonlyArray<{ id: string; name?: string }>,
  domain: string,
  toDomain: (vortexGameId: string) => string,
): Array<{ id: string; name: string }> {
  const want = domain.toLowerCase();
  return known
    .filter((g) => toDomain(g.id).toLowerCase() === want)
    .map((g) => ({ id: g.id, name: g.name !== undefined && g.name.length > 0 ? g.name : g.id }));
}

/** The page a free account is sent to: the file's own tab, with its download buttons. */
export function nexusFilePageUrl(domain: string, modId: number, fileId: number): string {
  return `https://www.nexusmods.com/${domain}/mods/${modId}?tab=files&file_id=${fileId}`;
}

/** The mod page itself. */
export function nexusModPageUrl(domain: string, modId: number): string {
  return `https://www.nexusmods.com/${domain}/mods/${modId}`;
}

/** Size in bytes from whichever field the listing carries. */
export function fileSizeOf(file: NexusFileCandidate): number | undefined {
  if (typeof file.size_in_bytes === "number") return file.size_in_bytes;
  if (typeof file.size_kb === "number") return file.size_kb * 1024;
  return undefined;
}

/** A file name safe to write under our own downloads folder, from the link's last path segment. */
export function safeDownloadName(url: string, fallback = "collection.ehcoll"): string {
  let last = "";
  try {
    const p = new URL(url).pathname;
    last = decodeURIComponent(p.slice(p.lastIndexOf("/") + 1));
  } catch {
    last = "";
  }
  return sanitizeFileName(last, fallback);
}

/** Longest name written, extension included: far inside Windows' 255 per component, with room for the folder. */
const MAX_NAME_CHARS = 120;
/** Windows device names, reserved with any extension: "CON.ehcoll" opens the console, not a file. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * A name a server or a link supplied, made safe to show and to write.
 *
 * Control, invisible and direction-changing characters are removed, not
 * replaced: U+202E makes "llocohe.exe" read as "exe.ehcoll" on screen, and a
 * name that displays differently from what is on disk is the one a person
 * trusts wrongly. Path and reserved characters become "_", trailing dots and
 * spaces go (Windows drops them silently), the length is capped with the
 * extension kept, and a device name is prefixed.
 */
export function sanitizeFileName(raw: string, fallback = "collection.ehcoll"): string {
  let name = raw
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .trim()
    .replace(/[. ]+$/, "");
  if (name.length === 0 || /^[._ ]+$/.test(name)) return fallback;
  if (!/\.ehcoll$/i.test(name)) name = `${name}.ehcoll`;
  const chars = Array.from(name);
  if (chars.length > MAX_NAME_CHARS) {
    const stem = chars.slice(0, MAX_NAME_CHARS - ".ehcoll".length).join("").replace(/[. ]+$/, "");
    name = `${stem}.ehcoll`;
  }
  if (WINDOWS_DEVICE.test(name)) name = `_${name}`;
  return name;
}

/**
 * The file name in a Content-Disposition header (RFC 6266), or undefined.
 *
 * `filename*` (RFC 8187, UTF-8) wins over `filename`. A quoted value is read
 * as a quoted-string, so `filename="a;b.ehcoll"` is "a;b.ehcoll", not "a".
 * The result is raw: pass it through {@link sanitizeFileName} before use.
 */
export function fileNameFromContentDisposition(header: string): string | undefined {
  const params = dispositionParams(header);
  const extended = params.get("filename*");
  if (extended !== undefined) {
    const m = /^([^']*)'[^']*'(.*)$/.exec(extended);
    if (m !== null && /^utf-8$/i.test(m[1])) {
      try {
        return decodeURIComponent(m[2]);
      } catch {
        /* malformed escapes: fall back to the plain parameter */
      }
    }
  }
  const plain = params.get("filename");
  return plain !== undefined && plain.length > 0 ? plain : undefined;
}

function dispositionParams(header: string): Map<string, string> {
  const out = new Map<string, string>();
  const first = header.indexOf(";");
  if (first < 0) return out;
  const s = header.slice(first + 1);
  let pos = 0;
  while (pos < s.length) {
    const eq = s.indexOf("=", pos);
    if (eq < 0) break;
    const rawName = s.slice(pos, eq);
    const cut = rawName.lastIndexOf(";");
    const name = (cut >= 0 ? rawName.slice(cut + 1) : rawName).trim().toLowerCase();
    pos = eq + 1;
    while (pos < s.length && (s[pos] === " " || s[pos] === "\t")) pos += 1;
    let value = "";
    if (s[pos] === '"') {
      pos += 1;
      while (pos < s.length && s[pos] !== '"') {
        if (s[pos] === "\\" && pos + 1 < s.length) pos += 1;
        value += s[pos];
        pos += 1;
      }
      const semi = s.indexOf(";", pos);
      pos = semi < 0 ? s.length : semi + 1;
    } else {
      const semi = s.indexOf(";", pos);
      value = s.slice(pos, semi < 0 ? s.length : semi).trim();
      pos = semi < 0 ? s.length : semi + 1;
    }
    if (name.length > 0 && !out.has(name)) out.set(name, value);
  }
  return out;
}
