/**
 * Packages with bundled mods in them, laid out the way a real one is — tests only.
 *
 * A bundle's identity comes from bundleZip.ts; the package's own zip comes from
 * the environment test writer, which shares nothing with our reader and flags
 * every name as UTF-8 — which 7-Zip does only because packaging passes it
 * -mcu=on — with entries stored or deflated.
 *
 * Not imported by any runtime path; nothing here ships.
 */
import * as fs from "fs";
import * as path from "path";
import { Readable } from "stream";

import { buildZip } from "../environment/fixtures.testutil";
import { bundleFolderInPackage } from "./bundleLayout";
import { writeBundleZip, type BundleFile } from "./bundleZip";
import { crc32 } from "./readZip";

/** A bundled mod's files: path inside the mod → its bytes. */
export type BundleContent = Record<string, string | Buffer>;

export type PackageEntry = { name: string; data: Buffer };

const bytesOf = (body: string | Buffer): Buffer =>
  typeof body === "string" ? Buffer.from(body) : body;

/** The identity these files make as a bundle. */
export async function bundleIdentity(files: BundleContent): Promise<string> {
  const listed: BundleFile[] = Object.entries(files).map(([p, body]) => {
    const buf = bytesOf(body);
    return { path: p, size: buf.length, crc32: crc32(buf), open: () => Readable.from([buf]) };
  });
  return (await writeBundleZip(listed, undefined)).sha256;
}

/** What a package carries for one bundled mod: its files, loose, under its folder. */
export async function bundleEntries(
  files: BundleContent,
): Promise<{ sha256: string; folder: string; entries: PackageEntry[] }> {
  const sha256 = await bundleIdentity(files);
  const folder = bundleFolderInPackage(sha256);
  return {
    sha256,
    folder,
    entries: Object.entries(files).map(([p, body]) => ({ name: `${folder}${p}`, data: bytesOf(body) })),
  };
}

/** Write a package of `entries` to `dir/name`, with a placeholder manifest unless one is among them. */
export function writePackage(
  dir: string,
  name: string,
  entries: readonly PackageEntry[],
  method: "store" | "deflate" = "deflate",
): string {
  const all = entries.some((e) => e.name === "manifest.json")
    ? [...entries]
    : [{ name: "manifest.json", data: Buffer.from("{}") }, ...entries];
  const out = path.join(dir, name);
  fs.writeFileSync(out, buildZip(all, method));
  return out;
}
