/**
 * The curator's side of a collection's presentation: the images it picked,
 * kept beside the collection config, and what a build puts in the package.
 *
 * Images live in `<configDir>/.presentation/<packageId>/`. Keyed by package id,
 * the collection's identity, rather than by slug, which is only the config's
 * file name; and a dot folder, because every `*.json` directly in the config
 * folder is read as a collection config. A rename on the Build form picks a
 * different collection with a different package id, so that collection is
 * given copies (copyPresentationImages).
 *
 * A picked image is COPIED there, named by its content, so the original can be
 * moved or deleted without breaking the next build, and picking the same image
 * twice stores it once.
 */

import { constants as fsConstants } from "fs";
import * as fsp from "fs/promises";
import * as path from "path";

import { hashFileSha256 } from "../archiveHashing";
import {
  IMAGE_EXTENSIONS,
  MAX_CAPTION_CHARS,
  MAX_GALLERY_IMAGES,
  MAX_IMAGE_BYTES,
  PRESENTATION_DIR,
  imageFormatOf,
  isEmptyPresentation,
  isPresentationFileName,
  readPresentationConfig,
  type PackagePresentation,
  type PresentationConfig,
  type PresentationImage,
} from "./presentation";

export type PresentationImageRole = "header" | "tile" | "gallery";

export function presentationAssetsDir(configDir: string, packageId: string): string {
  return path.join(configDir, ".presentation", packageId);
}

/** A picked file that cannot be a collection image, said in words a curator can act on. */
export class PresentationImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PresentationImageError";
  }
}

async function readHead(file: string, bytes = 16): Promise<Buffer> {
  const handle = await fsp.open(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

const megabytes = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);

/** Copy a picked image into the collection's presentation folder. Returns the stored file name. */
export async function importPresentationImage(args: {
  configDir: string;
  packageId: string;
  sourcePath: string;
  role: PresentationImageRole;
}): Promise<{ file: string; size: number }> {
  const name = path.basename(args.sourcePath);
  const stat = await fsp.stat(args.sourcePath);
  if (!stat.isFile()) throw new PresentationImageError(`"${name}" is not a file.`);
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new PresentationImageError(
      `"${name}" is ${megabytes(stat.size)} MB. Collection images can be at most ${megabytes(MAX_IMAGE_BYTES)} MB.`,
    );
  }
  const format = imageFormatOf(await readHead(args.sourcePath));
  if (format === undefined) {
    throw new PresentationImageError(`"${name}" is not a PNG, JPEG, WebP or GIF image.`);
  }
  const sha256 = await hashFileSha256(args.sourcePath);
  const file = `${args.role}-${sha256.slice(0, 16)}.${IMAGE_EXTENSIONS[format]}`;
  const dir = presentationAssetsDir(args.configDir, args.packageId);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.copyFile(args.sourcePath, path.join(dir, file));
  return { file, size: stat.size };
}

/**
 * Give another collection copies of a presentation's images.
 *
 * For a rename on the Build form. The name picks the collection, so a new name
 * is a new collection with a new package id, and these folders are keyed by
 * package id: the new collection's folder is empty, and its build found none of
 * the images the form had just shown. Copied, not moved: the collection under
 * the old name keeps its own presentation.
 *
 * Never rejects. An image that cannot be copied is reported, and the build
 * warns about it when it measures the images it ships.
 */
export async function copyPresentationImages(args: {
  configDir: string;
  fromPackageId: string;
  toPackageId: string;
  presentation: PresentationConfig;
}): Promise<{ copied: string[]; failed: string[] }> {
  const copied: string[] = [];
  const failed: string[] = [];
  if (args.fromPackageId === args.toPackageId) return { copied, failed };
  const p = args.presentation;
  const files = [
    ...new Set([p.header, p.tile, ...(p.gallery ?? []).map((g) => g.file)]),
  ].filter(isPresentationFileName);
  const from = presentationAssetsDir(args.configDir, args.fromPackageId);
  const to = presentationAssetsDir(args.configDir, args.toPackageId);
  for (const file of files) {
    try {
      await fsp.mkdir(to, { recursive: true });
      // Stored names are content hashes, so one already there is this image.
      await fsp.copyFile(path.join(from, file), path.join(to, file), fsConstants.COPYFILE_EXCL);
      copied.push(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") failed.push(file);
    }
  }
  return { copied, failed };
}

export type BuildPresentation = {
  /** `package.presentation`, or undefined when there is nothing to show. */
  presentation?: PackagePresentation;
  /** What the package carries: entry name and where its bytes are. */
  files: Array<{ entry: string; sourcePath: string }>;
  /** What was left out, and why. */
  warnings: string[];
};

/**
 * What a build ships from the curator's presentation settings.
 *
 * Every image is measured and hashed now, so the manifest names exactly the
 * bytes the package carries. An image that has gone missing or is not an
 * image any more is left out with a warning: a plainer package is better than
 * a failed build.
 */
export async function resolvePresentationForBuild(args: {
  configDir: string;
  packageId: string;
  config: PresentationConfig | undefined;
}): Promise<BuildPresentation> {
  const warnings: string[] = [];
  const config = args.config === undefined ? undefined : readPresentationConfig(args.config);
  if (config === undefined) return { files: [], warnings };
  const dir = presentationAssetsDir(args.configDir, args.packageId);
  const files = new Map<string, string>();
  const measured = new Map<string, PresentationImage | null>();

  const image = async (
    file: string,
    what: string,
    caption?: string,
  ): Promise<PresentationImage | undefined> => {
    let base = measured.get(file);
    if (base === undefined) {
      base = await measure(dir, file, what, warnings);
      measured.set(file, base);
    }
    if (base === null) return undefined;
    files.set(base.file, path.join(dir, file));
    const kept = caption?.trim().slice(0, MAX_CAPTION_CHARS);
    return kept !== undefined && kept !== "" ? { ...base, caption: kept } : base;
  };

  const header = config.header !== undefined ? await image(config.header, "header image") : undefined;
  const tile = config.tile !== undefined ? await image(config.tile, "card image") : undefined;
  const pickedGallery = config.gallery ?? [];
  if (pickedGallery.length > MAX_GALLERY_IMAGES) {
    warnings.push(
      `The gallery has ${pickedGallery.length} images; the first ${MAX_GALLERY_IMAGES} are shipped.`,
    );
  }
  const gallery: PresentationImage[] = [];
  for (const [i, g] of pickedGallery.slice(0, MAX_GALLERY_IMAGES).entries()) {
    const img = await image(g.file, `gallery image ${i + 1}`, g.caption);
    if (img !== undefined) gallery.push(img);
  }

  const presentation: PackagePresentation = {
    ...(header !== undefined ? { header } : {}),
    ...(tile !== undefined ? { tile } : {}),
    gallery,
    ...(config.theme !== undefined ? { theme: config.theme } : {}),
    ...(config.about !== undefined ? { about: config.about } : {}),
    links: config.links ?? [],
  };
  return {
    ...(isEmptyPresentation(presentation) ? {} : { presentation }),
    files: [...files].map(([entry, sourcePath]) => ({ entry, sourcePath })),
    warnings,
  };
}

async function measure(
  dir: string,
  file: string,
  what: string,
  warnings: string[],
): Promise<PresentationImage | null> {
  if (!isPresentationFileName(file)) {
    warnings.push(`The ${what} "${file}" is not a plain image file name and was left out of the package.`);
    return null;
  }
  const full = path.join(dir, file);
  try {
    const stat = await fsp.stat(full);
    if (stat.size > MAX_IMAGE_BYTES) {
      warnings.push(`The ${what} is larger than ${megabytes(MAX_IMAGE_BYTES)} MB and was left out of the package.`);
      return null;
    }
    if (imageFormatOf(await readHead(full)) === undefined) {
      warnings.push(`The ${what} is no longer a PNG, JPEG, WebP or GIF image and was left out of the package.`);
      return null;
    }
    return { file: `${PRESENTATION_DIR}/${file}`, sha256: await hashFileSha256(full), size: stat.size };
  } catch (err) {
    warnings.push(
      `The ${what} could not be read and was left out of the package: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}
