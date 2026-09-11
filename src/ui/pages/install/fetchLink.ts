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
 *   Direct link     → fetched by Event Horizon itself, resumably, into
 *                     its own downloads folder.
 *
 * Either way the file is hashed, and a link that published a SHA-256
 * (`#sha256=`) must match it or nothing is opened; a link that did not is
 * reported as unverified, with the hash, in the log and on screen.
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
  safeDownloadName,
  sanitizeFileName,
  type InstallLink,
} from "../../../core/installer/installLink";
import { ehLog } from "../../../core/logging/ehLog";
import { getEventHorizonDir } from "../../../core/paths";
import { openExternalUrl } from "../../../core/revealPath";
import { AbortError } from "../../../utils/abortError";
import { nexusDomainForVortexGame, nexusExtOf } from "../curator/requirementsIo";
import type { LinkPhase } from "./state";

export type FetchLinkEvents = {
  onPhase: (phase: LinkPhase, detail?: { fileName?: string; received?: number; total?: number }) => void;
};

/** What arrived, and whether anything published proves it is the package. */
export type LinkReceipt = {
  fileName: string;
  size: number;
  sha256: string;
  /** `match`: equals the link's `#sha256=`. `unverified`: the link published none. */
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
    throw new Error(
      `This link is a "${link.domain}" page on Nexus, and Vortex is managing "${gameId}" ` +
        `(Nexus: "${domain}"). Switch Vortex to the game the collection is for, then paste the link again.`,
    );
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
    throw new Error(
      `The page has ${chosen.files.length} packages (${names}). Open its Files tab, and paste the link of the one you want — ` +
        `each file's link carries its file_id.`,
    );
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
      const dl = await waitForVortexDownload(api, downloadId, signal, (received, total) =>
        events.onPhase("waiting-for-vortex", { fileName, received, ...(total !== undefined ? { total } : {}) }),
      );
      const baseDir = selectors.downloadPathForGame(api.getState(), gameId);
      if (!baseDir) throw new Error(`Could not resolve Vortex's download folder for "${gameId}".`);
      const zipPath = path.join(baseDir, dl.localPath as string);
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
 * timeout of its own — a 10 GB file takes as long as it takes — but
 * cancellable, which stops the waiting and leaves Vortex's download alone.
 */
async function waitForVortexDownload(
  api: types.IExtensionApi,
  downloadId: string,
  signal: AbortSignal,
  onProgress: (received: number, total: number | undefined) => void,
): Promise<types.IDownload> {
  for (;;) {
    throwIfAborted(signal);
    const files = (api.getState() as unknown as {
      persistent?: { downloads?: { files?: Record<string, types.IDownload> } };
    })?.persistent?.downloads?.files;
    const dl = files?.[downloadId];
    if (dl !== undefined) {
      if (dl.state === "finished" && typeof dl.localPath === "string" && dl.localPath.length > 0) return dl;
      if (dl.state === "failed") {
        const detail = dl.failCause as { message?: string } | undefined;
        throw new Error(`Vortex reported the download as failed${detail?.message !== undefined ? `: ${detail.message}` : "."}`);
      }
      const received = typeof dl.received === "number" ? dl.received : 0;
      const total = typeof dl.size === "number" && dl.size > 0 ? dl.size : undefined;
      onProgress(received, total);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
