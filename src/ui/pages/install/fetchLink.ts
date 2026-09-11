/**
 * ──────────────────────────────────────────────────────────────────────
 * Turn a pasted link into a `.ehcoll` on disk.
 *
 * The I/O half of "paste this link" (the pure half is
 * `core/installer/installLink.ts`). Two routes, chosen by what the link is:
 *
 *   Nexus mod page  → Vortex's own Nexus integration. The page's files are
 *                     listed, the package chosen, and — with Premium —
 *                     `nexusDownload(..., allowInstall = false)` fetches it
 *                     into Vortex's download folder WITHOUT installing it:
 *                     a 10 GB collection package installed as a mod would
 *                     be a 10 GB mod. Without Premium, Nexus issues no
 *                     link, so the file page is opened in the browser and
 *                     the caller is told to let the user pick the file.
 *                     A LANDING page (no package, a small link zip instead,
 *                     because Nexus quarantines packages) is followed: the
 *                     zip is fetched the same way, read, and its link taken
 *                     as a direct link with its checksum.
 *   Direct link     → fetched by Event Horizon itself, resumably, into
 *                     its own downloads folder.
 *
 * Either way the file is hashed, and a link that published a SHA-256
 * (`#sha256=`, or the link zip's) must match it or nothing is opened; a
 * link that did not is reported as unverified, with the hash, in the log
 * and on screen.
 *
 * Either way the result is a path, and everything after it is the
 * ordinary `pickFile` flow. Nothing here writes to a profile (NS-2).
 * ──────────────────────────────────────────────────────────────────────
 */

import * as fs from "fs";
import * as path from "path";

import { selectors, type types } from "@nexusmods/vortex-api";

import { getActiveGameId } from "../../../core/getModsListForProfile";
import { readNexusAccount } from "../../../core/installer/checkNexusAccount";
import {
  ChecksumMismatchError,
  downloadToFile,
  probeFileName,
  redactUrl,
  sha256OfFile,
} from "../../../core/installer/downloadDirect";
import {
  chooseEhcollFile,
  fileSizeOf,
  nexusFilePageUrl,
  parseInstallLink,
  safeDownloadName,
  sanitizeFileName,
  vortexGamesForNexusDomain,
  type InstallLink,
  type NexusFileCandidate,
} from "../../../core/installer/installLink";
import { readLinkCarrier } from "../../../core/installer/linkCarrier";
import { ehLog } from "../../../core/logging/ehLog";
import { getEventHorizonDir } from "../../../core/paths";
import { openExternalUrl } from "../../../core/revealPath";
import { AbortError } from "../../../utils/abortError";
import { nexusDomainForVortexGame, nexusExtOf, type NexusExt } from "../curator/requirementsIo";
import type { LinkPhase } from "./state";

export type FetchLinkEvents = {
  onPhase: (phase: LinkPhase, detail?: { fileName?: string; received?: number; total?: number }) => void;
};

/** What arrived, and whether anything published proves it is the package. */
export type LinkReceipt = {
  fileName: string;
  size: number;
  sha256: string;
  /** `match`: equals the link's `#sha256=` (or its link file's). `unverified`: none was published. */
  verified: "match" | "unverified";
  source: "direct" | "nexus";
};

export type FetchLinkOutcome =
  | { kind: "file"; zipPath: string; receipt: LinkReceipt }
  | {
      kind: "manual";
      pageUrl: string;
      fileName: string;
      size?: number;
      version?: string;
      why: string;
    };

/** Progress is reported at most this often; a 10 GB file has a lot of chunks. */
const PROGRESS_EVERY_MS = 250;

export async function fetchLink(
  api: types.IExtensionApi,
  link: Exclude<InstallLink, { kind: "invalid" }>,
  signal: AbortSignal,
  events: FetchLinkEvents,
): Promise<FetchLinkOutcome> {
  return link.kind === "direct"
    ? fetchDirect(link.url, link.sha256, signal, events)
    : fetchFromNexus(api, link, signal, events);
}

async function fetchDirect(
  url: string,
  expectedSha256: string | undefined,
  signal: AbortSignal,
  events: FetchLinkEvents,
): Promise<FetchLinkOutcome> {
  events.onPhase("resolving");
  // The server's own name for the file, when it gives one: a pixeldrain link
  // ends in an id, and a file named after that would hide which package it is.
  const served = await probeFileName(url, signal);
  const fileName = served !== undefined ? sanitizeFileName(served) : safeDownloadName(url);
  const destPath = path.join(getEventHorizonDir("downloads"), fileName);
  events.onPhase("downloading", { fileName });
  let lastReport = 0;
  const got = await downloadToFile({
    url,
    destPath,
    signal,
    ...(expectedSha256 !== undefined ? { expectedSha256 } : {}),
    onProgress: (p) => {
      const now = Date.now();
      if (now - lastReport < PROGRESS_EVERY_MS && (p.total === undefined || p.received < p.total)) return;
      lastReport = now;
      events.onPhase("downloading", { fileName, received: p.received, ...(p.total !== undefined ? { total: p.total } : {}) });
    },
  });
  ehLog("info", "install.link.direct-downloaded", {
    link: redactUrl(url),
    path: got.path,
    size: got.size,
    sha256: got.sha256,
    resumed: got.resumed,
    verified: got.verified === "match",
  });
  if (got.verified === "unverified") {
    ehLog("warn", "install.link.unverified", {
      sha256: got.sha256,
      why: "the link carries no #sha256=, so the file was not checked against a published checksum",
    });
  }
  return {
    kind: "file",
    zipPath: got.path,
    receipt: { fileName, size: got.size, sha256: got.sha256, verified: got.verified, source: "direct" },
  };
}

async function fetchFromNexus(
  api: types.IExtensionApi,
  link: Extract<InstallLink, { kind: "nexus" }>,
  signal: AbortSignal,
  events: FetchLinkEvents,
): Promise<FetchLinkOutcome> {
  const state = api.getState();
  const gameId = getActiveGameId(state);
  if (gameId === undefined) {
    throw new Error("Vortex has no active game. Pick the game this collection is for in Vortex, then paste the link again.");
  }
  const domain = nexusDomainForVortexGame(gameId).toLowerCase();
  if (domain !== link.domain) {
    throw new Error(gameMismatchMessage(state, gameId, link.domain));
  }

  const ext = nexusExtOf(api);
  if (ext.getModFiles === undefined) {
    throw new Error("Vortex's Nexus integration is not available. Is the Nexus extension enabled and are you signed in?");
  }

  events.onPhase("resolving");
  const files = await ext.getModFiles(gameId, link.modId);
  throwIfAborted(signal);
  const chosen = chooseEhcollFile(Array.isArray(files) ? files : [], link.fileId);
  if (chosen.kind === "none") throw new Error(chosen.why);
  if (chosen.kind === "several") {
    const names = chosen.files.map((f) => `"${f.file_name ?? f.name ?? f.file_id}"`).join(", ");
    ehLog("info", "install.link.several-files", { modId: link.modId, fileIds: chosen.files.map((f) => f.file_id) });
    throw new Error(
      `The page has ${chosen.files.length} files that could be the collection (${names}), and nothing says which one ` +
        "is meant. Open its Files tab and paste the link of the one you want — each file's link carries its file_id.",
    );
  }
  if (chosen.kind === "carrier") {
    return fetchThroughLinkFile(api, ext, link, gameId, chosen.file, signal, events);
  }
  const file = chosen.file;
  const fileName = file.file_name ?? `${file.name ?? `mod-${link.modId}`}.ehcoll`;
  const size = fileSizeOf(file);
  const pageUrl = nexusFilePageUrl(link.domain, link.modId, file.file_id);

  const account = readNexusAccount(api);
  const canTry = (account.kind === "premium" || account.kind === "unknown") && ext.download !== undefined;
  if (canTry && ext.download !== undefined) {
    events.onPhase("waiting-for-vortex", { fileName, ...(size !== undefined ? { total: size } : {}) });
    // `false`: download only. The one-step form would install the package
    // as a mod.
    const downloadId = await ext.download(gameId, link.modId, file.file_id, fileName, false);
    throwIfAborted(signal);
    if (typeof downloadId === "string" && downloadId.length > 0) {
      const zipPath = await vortexDownloadPath(api, gameId, downloadId, fileName, signal, (received, total) =>
        events.onPhase("waiting-for-vortex", { fileName, received, ...(total !== undefined ? { total } : {}) }),
      );
      const receipt = await verifyVortexDownload(zipPath, fileName, link.sha256, signal);
      ehLog("info", "install.link.nexus-downloaded", {
        downloadId,
        modId: link.modId,
        fileId: file.file_id,
        zipPath,
        size: receipt.size,
        sha256: receipt.sha256,
        verified: receipt.verified === "match",
      });
      return { kind: "file", zipPath, receipt };
    }
    if (account.kind === "premium") {
      throw new Error(
        "Vortex did not start the download. Its own notification says why (a sign-in that lapsed, or Nexus not answering); " +
          "fix that and paste the link again.",
      );
    }
    // Account status was unknown and Vortex refused: treat as not Premium.
  }

  const opened = await openExternalUrl(pageUrl);
  const why =
    account.kind === "logged-out"
      ? "Vortex is not signed in to Nexus Mods, so it cannot fetch the file. Sign in from Vortex's Nexus Mods settings and paste the link again, or download the file yourself:"
      : "Nexus hands direct download links to Premium accounts only. Without one, download the file yourself from its page:";
  ehLog("info", "install.link.manual", { modId: link.modId, fileId: file.file_id, account: account.kind, opened: opened.kind });
  return { kind: "manual", pageUrl, fileName, ...(size !== undefined ? { size } : {}), ...(file.version !== undefined ? { version: file.version } : {}), why };
}

/**
 * A landing page: its file is a small zip that says where the package is
 * and what its SHA-256 is. Fetched through Vortex like any page file, read,
 * and followed as a direct link held to that checksum.
 */
async function fetchThroughLinkFile(
  api: types.IExtensionApi,
  ext: NexusExt,
  link: Extract<InstallLink, { kind: "nexus" }>,
  gameId: string,
  file: NexusFileCandidate,
  signal: AbortSignal,
  events: FetchLinkEvents,
): Promise<FetchLinkOutcome> {
  const fileName = file.file_name ?? `mod-${link.modId}-link.zip`;
  const pageUrl = nexusFilePageUrl(link.domain, link.modId, file.file_id);
  const account = readNexusAccount(api);
  const canTry = (account.kind === "premium" || account.kind === "unknown") && ext.download !== undefined;
  ehLog("info", "install.link.landing-page", { modId: link.modId, fileId: file.file_id, fileName, account: account.kind });

  if (canTry && ext.download !== undefined) {
    events.onPhase("waiting-for-vortex", { fileName });
    const downloadId = await ext.download(gameId, link.modId, file.file_id, fileName, false);
    throwIfAborted(signal);
    if (typeof downloadId === "string" && downloadId.length > 0) {
      const zipPath = await vortexDownloadPath(api, gameId, downloadId, fileName, signal, (received, total) =>
        events.onPhase("waiting-for-vortex", { fileName, received, ...(total !== undefined ? { total } : {}) }),
      );
      const carrier = await readLinkCarrier(zipPath);
      if (link.sha256 !== undefined && link.sha256 !== carrier.sha256) {
        throw new Error(
          `The link you pasted carries SHA-256 ${link.sha256}, and the page's link file says ${carrier.sha256}. They cannot ` +
            "both describe the package, so nothing was downloaded. Copy the link from the collection's page again.",
        );
      }
      const direct = parseInstallLink(carrier.url);
      if (direct.kind !== "direct") {
        // parseLinkCarrier only returns direct links; this guards the contract.
        throw new Error(`The page's link file points at ${redactUrl(carrier.url)}, which is not a direct download.`);
      }
      ehLog("info", "install.link.carrier-read", {
        downloadId,
        modId: link.modId,
        fileId: file.file_id,
        carrierFile: path.basename(zipPath),
        from: carrier.source,
        link: redactUrl(direct.url),
        sha256: carrier.sha256,
        ...(carrier.size !== undefined ? { size: carrier.size } : {}),
      });
      return fetchDirect(direct.url, carrier.sha256, signal, events);
    }
    if (account.kind === "premium") {
      throw new Error(
        "Vortex did not start the download of the page's link file. Its own notification says why (a sign-in that " +
          "lapsed, or Nexus not answering); fix that and paste the link again.",
      );
    }
  }

  const opened = await openExternalUrl(pageUrl);
  ehLog("info", "install.link.landing-page-manual", { modId: link.modId, fileId: file.file_id, account: account.kind, opened: opened.kind });
  throw new Error(
    `This collection's page is a landing page: its file "${fileName}" is a small zip holding the package's download ` +
      "link and SHA-256, and Nexus hands direct downloads to Premium accounts only" +
      (account.kind === "logged-out" ? " (and Vortex is not signed in to Nexus)" : "") +
      `. ${opened.kind === "failed" ? `Open ${pageUrl}` : "The file's page was opened in your browser"}: download the zip, ` +
      "open it, and paste the link written inside it here. The page's description gives the same link.",
  );
}

/** Who Vortex says the collection is for, by name, and who it is managing now. */
function gameMismatchMessage(state: unknown, gameId: string, linkDomain: string): string {
  const known = readKnownGames(state);
  const current = known.find((g) => g.id === gameId)?.name ?? gameId;
  const targets = vortexGamesForNexusDomain(known, linkDomain, (id) => nexusDomainForVortexGame(id));
  if (targets.length === 0) {
    return (
      `This collection's page is for the Nexus game "${linkDomain}", and no game this Vortex has an extension for ` +
      `matches it (Vortex is managing ${current}). Add that game to Vortex, switch to it, then paste the link again.`
    );
  }
  const names = targets.map((g) => g.name).join(" or ");
  return `This collection is for ${names}, and Vortex is managing ${current}. Switch Vortex to ${names}, then paste the link again.`;
}

function readKnownGames(state: unknown): Array<{ id: string; name?: string }> {
  const known = (state as { session?: { gameMode?: { known?: unknown } } } | undefined)?.session?.gameMode?.known;
  if (!Array.isArray(known)) return [];
  return known
    .map((g) => g as { id?: unknown; name?: unknown })
    .filter((g): g is { id: string; name?: unknown } => typeof g?.id === "string" && g.id.length > 0)
    .map((g) => ({ id: g.id, ...(typeof g.name === "string" ? { name: g.name } : {}) }));
}

async function vortexDownloadPath(
  api: types.IExtensionApi,
  gameId: string,
  downloadId: string,
  fileName: string,
  signal: AbortSignal,
  onProgress: (received: number, total: number | undefined) => void,
): Promise<string> {
  const dl = await waitForVortexDownload(api, downloadId, signal, onProgress, { fileName });
  const baseDir = selectors.downloadPathForGame(api.getState(), gameId);
  if (!baseDir) throw new Error(`Could not resolve Vortex's download folder for "${gameId}".`);
  return path.join(baseDir, dl.localPath as string);
}

/**
 * Hash the file Vortex downloaded and hold it to the link's checksum.
 *
 * A mismatch leaves the file where it is: it belongs to Vortex's download
 * list, and deleting it under Vortex would leave a download record pointing
 * at nothing. The message says to remove it there.
 */
async function verifyVortexDownload(
  zipPath: string,
  fileName: string,
  expectedSha256: string | undefined,
  signal: AbortSignal,
): Promise<LinkReceipt> {
  const size = (await fs.promises.stat(zipPath)).size;
  const sha256 = await sha256OfFile(zipPath, signal);
  if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
    ehLog("error", "install.link.nexus-checksum-mismatch", { zipPath, size, sha256, expectedSha256 });
    throw new ChecksumMismatchError({
      expected: expectedSha256,
      actual: sha256,
      size,
      disposition: `Nothing was installed; remove "${path.basename(zipPath)}" from Vortex's Downloads tab.`,
    });
  }
  if (expectedSha256 === undefined) {
    ehLog("warn", "install.link.unverified", {
      sha256,
      why: "the link carries no #sha256=, so the file was not checked against a published checksum",
    });
  }
  return { fileName, size, sha256, verified: expectedSha256 !== undefined ? "match" : "unverified", source: "nexus" };
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new AbortError("cancelled");
}

/**
 * Poll Vortex's download record until the file is on disk.
 *
 * `nexusDownload` resolving is not the file being complete: Vortex hashes
 * after the transfer, and `localPath` is what says where it landed. No
 * limit on a download that is moving — a 10 GB file takes as long as it
 * takes — but a download that stops being one ends the wait with the
 * reason: removed from Vortex's list, paused there, or never listed at all.
 * Cancellable, which stops the waiting and leaves Vortex's download alone.
 */
export async function waitForVortexDownload(
  api: types.IExtensionApi,
  downloadId: string,
  signal: AbortSignal,
  onProgress: (received: number, total: number | undefined) => void,
  options: { fileName?: string; pollMs?: number; appearWithinMs?: number } = {},
): Promise<types.IDownload> {
  const pollMs = options.pollMs ?? 500;
  const appearWithinMs = options.appearWithinMs ?? 30_000;
  const what = options.fileName !== undefined ? `"${options.fileName}"` : "the file";
  const startedAt = Date.now();
  let seen = false;
  for (;;) {
    throwIfAborted(signal);
    const files = (api.getState() as unknown as {
      persistent?: { downloads?: { files?: Record<string, types.IDownload> } };
    })?.persistent?.downloads?.files;
    const dl = files?.[downloadId];
    if (dl === undefined) {
      if (seen) {
        ehLog("warn", "install.link.vortex-download-stopped", { downloadId, why: "removed" });
        throw new Error(
          `The download of ${what} was removed from Vortex's Downloads tab before it finished, so there is nothing to ` +
            "wait for. Paste the link again to start it over.",
        );
      }
      if (Date.now() - startedAt > appearWithinMs) {
        ehLog("warn", "install.link.vortex-download-stopped", { downloadId, why: "never listed" });
        throw new Error(
          `Vortex accepted the download of ${what} but never listed it in its Downloads tab. Check that tab, then paste the link again.`,
        );
      }
    } else {
      seen = true;
      if (dl.state === "finished" && typeof dl.localPath === "string" && dl.localPath.length > 0) return dl;
      if (dl.state === "failed") {
        const detail = dl.failCause as { message?: string } | undefined;
        ehLog("warn", "install.link.vortex-download-stopped", { downloadId, why: "failed", detail: detail?.message });
        throw new Error(`Vortex reported the download as failed${detail?.message !== undefined ? `: ${detail.message}` : "."}`);
      }
      if (dl.state === "paused") {
        ehLog("warn", "install.link.vortex-download-stopped", { downloadId, why: "paused", received: dl.received });
        throw new Error(
          `The download of ${what} is paused in Vortex's Downloads tab, so Event Horizon stopped waiting for it. Resume it ` +
            'there; when it has finished, pick the file with "Choose .ehcoll file" (Vortex\'s download folder), or paste the link again.',
        );
      }
      const received = typeof dl.received === "number" ? dl.received : 0;
      const total = typeof dl.size === "number" && dl.size > 0 ? dl.size : undefined;
      onProgress(received, total);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
