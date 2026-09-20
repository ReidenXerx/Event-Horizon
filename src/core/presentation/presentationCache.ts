/**
 * A collection's presentation on the machine of the person installing it.
 *
 * `<EH root>/presentation/<packageId>/<version>/` holds the images the package
 * carries, extracted and checked against the manifest, and `presentation.json`,
 * so the Collections page can still show a collection's card once its package
 * has been moved or deleted.
 *
 * An image whose bytes do not match the hash the manifest recorded is deleted
 * and not shown: the manifest says what the curator shipped, and anything else
 * is not that.
 */

import * as fsp from "fs/promises";
import * as path from "path";
import { pathToFileURL } from "url";

import { hashFileSha256 } from "../archiveHashing";
import { safePackageVersion } from "../manifest/packageFileName";
import { extractZipEntryToFile } from "../manifest/readZip";
import {
  presentationImages,
  readPresentation,
  withImagesPresent,
  type PackagePresentation,
  type PresentationImage,
  type PresentationLink,
  type PresentationTheme,
} from "./presentation";

export type ShownImage = { url: string; caption?: string };

/** What the screens show: images as URLs they can load. */
export type ShownPresentation = {
  header?: ShownImage;
  tile?: ShownImage;
  gallery: ShownImage[];
  theme?: PresentationTheme;
  about?: string;
  links: PresentationLink[];
  /** Package entry to URL, for the images the About page refers to. */
  images: Record<string, string>;
};

const RECORD_FILE = "presentation.json";

export function presentationCacheDir(cacheRoot: string, packageId: string, version: string): string {
  return path.join(cacheRoot, packageId, safePackageVersion(version));
}

const fileNameOf = (img: PresentationImage): string => path.posix.basename(img.file);

async function matches(
  file: string,
  img: PresentationImage,
  hash: (file: string) => Promise<string>,
): Promise<boolean> {
  try {
    const stat = await fsp.stat(file);
    if (stat.size !== img.size) return false;
    return (await hash(file)) === img.sha256;
  } catch {
    return false;
  }
}

function toShown(p: PackagePresentation, dir: string): ShownPresentation {
  const images: Record<string, string> = {};
  const shown = (img: PresentationImage): ShownImage => {
    const url = pathToFileURL(path.join(dir, fileNameOf(img))).href;
    images[img.file] = url;
    return { url, ...(img.caption !== undefined ? { caption: img.caption } : {}) };
  };
  const header = p.header !== undefined ? shown(p.header) : undefined;
  const tile = p.tile !== undefined ? shown(p.tile) : undefined;
  const gallery = p.gallery.map(shown);
  // Names a curator can write in the About page without knowing how images are
  // stored: ![caption](screenshot-2), ![](header), ![](card).
  if (header !== undefined) images.header = header.url;
  if (tile !== undefined) images.card = tile.url;
  gallery.forEach((g, i) => {
    images[`screenshot-${i + 1}`] = g.url;
  });
  return {
    ...(header !== undefined ? { header } : {}),
    ...(tile !== undefined ? { tile } : {}),
    gallery,
    ...(p.theme !== undefined ? { theme: p.theme } : {}),
    ...(p.about !== undefined ? { about: p.about } : {}),
    links: p.links,
    images,
  };
}

/**
 * Extract a package's presentation images into the cache, check each against
 * its recorded hash, and record what survived. An image already there with the
 * right bytes is not extracted again.
 */
export async function extractPresentation(args: {
  zipPath: string;
  packageId: string;
  version: string;
  presentation: PackagePresentation;
  cacheRoot: string;
  extract?: (zipPath: string, entry: string, dest: string) => Promise<void>;
  hash?: (file: string) => Promise<string>;
}): Promise<{ shown?: ShownPresentation; warnings: string[] }> {
  const extract = args.extract ?? extractZipEntryToFile;
  const hash = args.hash ?? ((file: string): Promise<string> => hashFileSha256(file));
  const dir = presentationCacheDir(args.cacheRoot, args.packageId, args.version);
  await fsp.mkdir(dir, { recursive: true });
  const warnings: string[] = [];
  const good = new Set<string>();
  for (const img of presentationImages(args.presentation)) {
    const dest = path.join(dir, fileNameOf(img));
    try {
      if (!(await matches(dest, img, hash))) {
        await extract(args.zipPath, img.file, dest);
        if (!(await matches(dest, img, hash))) {
          await fsp.rm(dest, { force: true });
          warnings.push(`${img.file} does not match the hash the collection recorded, so it is not shown.`);
          continue;
        }
      }
      good.add(img.file);
    } catch (err) {
      await fsp.rm(dest, { force: true }).catch(() => undefined);
      warnings.push(
        `${img.file} could not be extracted, so it is not shown: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  const kept = withImagesPresent(args.presentation, good).presentation;
  if (kept === undefined) return { warnings };
  await fsp.writeFile(path.join(dir, RECORD_FILE), JSON.stringify(kept), "utf8");
  return { shown: toShown(kept, dir), warnings };
}

/**
 * The presentation recorded for an installed version, for screens that no
 * longer have the package.
 *
 * Every image is checked against the hash the manifest recorded, the same
 * check the extraction ran. It used to accept a file on SIZE alone, resting
 * on "their bytes were checked when they were extracted" — a claim about the
 * past, about files sitting in a directory anyone can write to, months after
 * the fact. This module's own opening paragraph says an image whose bytes do
 * not match the hash is not what the curator shipped and is not shown; the
 * read path is where that promise is kept or broken, and hashing a handful of
 * pictures costs milliseconds (NS-1).
 */
export async function loadCachedPresentation(
  cacheRoot: string,
  packageId: string,
  version: string,
  /** Injectable for tests; the real one reads the file. */
  hash: (file: string) => Promise<string> = (file) => hashFileSha256(file),
): Promise<ShownPresentation | undefined> {
  const dir = presentationCacheDir(cacheRoot, packageId, version);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fsp.readFile(path.join(dir, RECORD_FILE), "utf8"));
  } catch {
    return undefined;
  }
  const read = readPresentation(parsed)?.presentation;
  if (read === undefined) return undefined;
  const present = new Set<string>();
  for (const img of presentationImages(read)) {
    // Gone, replaced, or truncated since — all the same answer: not shown.
    if (await matches(path.join(dir, fileNameOf(img)), img, hash)) {
      present.add(img.file);
    }
  }
  const kept = withImagesPresent(read, present).presentation;
  return kept === undefined ? undefined : toShown(kept, dir);
}
