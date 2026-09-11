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
  | { kind: "one"; file: NexusFileCandidate }
  | { kind: "several"; files: NexusFileCandidate[] }
  | { kind: "none"; why: string };

/** Nexus's category id for Main Files. */
const MAIN_CATEGORY = 1;
/** Old versions, archived and deleted files carry these; never offered. */
const RETIRED_CATEGORIES = new Set([4, 6, 7]);

function isEhcoll(file: NexusFileCandidate): boolean {
  return /\.ehcoll$/i.test(file.file_name ?? "");
}

/**
 * Which file on the page is the collection.
 *
 * A named `fileId` wins outright, whatever its extension — the link's author
 * chose it. Otherwise only `.ehcoll` files are considered, retired ones are
 * dropped, and the page's primary file is preferred; then a single Main
 * file; then the newest Main file. Several equally good candidates are
 * returned as a choice rather than guessed (NS-8's spirit: an ambiguous
 * package is a question, not a coin toss).
 */
export function chooseEhcollFile(files: NexusFileCandidate[], fileId?: number): ChosenFile {
  if (fileId !== undefined) {
    const named = files.find((f) => f.file_id === fileId);
    return named !== undefined
      ? { kind: "one", file: named }
      : { kind: "none", why: `The link names file ${fileId}, and the page has no such file.` };
  }

  const packages = files.filter(isEhcoll).filter((f) => !RETIRED_CATEGORIES.has(f.category_id ?? -1));
  if (packages.length === 0) {
    return {
      kind: "none",
      why:
        files.length === 0
          ? "The page lists no files."
          : "The page has no .ehcoll file. It may be an ordinary mod page, or the collection is not published yet.",
    };
  }
  if (packages.length === 1) return { kind: "one", file: packages[0] };

  const primary = packages.filter((f) => f.is_primary === true);
  if (primary.length === 1) return { kind: "one", file: primary[0] };

  const main = packages.filter((f) => f.category_id === MAIN_CATEGORY);
  if (main.length === 1) return { kind: "one", file: main[0] };
  if (main.length > 1) {
    const stamped = main.filter((f) => typeof f.uploaded_timestamp === "number");
    if (stamped.length === main.length) {
      const newest = [...stamped].sort((a, b) => (b.uploaded_timestamp ?? 0) - (a.uploaded_timestamp ?? 0));
      return { kind: "one", file: newest[0] };
    }
    return { kind: "several", files: main };
  }
  return { kind: "several", files: packages };
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

/** A file name safe to write under our own downloads folder. */
export function safeDownloadName(url: string, fallback = "collection.ehcoll"): string {
  let last = "";
  try {
    const p = new URL(url).pathname;
    last = decodeURIComponent(p.slice(p.lastIndexOf("/") + 1));
  } catch {
    last = "";
  }
  const cleaned = last.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") return fallback;
  return /\.ehcoll$/i.test(cleaned) ? cleaned : `${cleaned}.ehcoll`;
}
