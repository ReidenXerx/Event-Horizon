/**
 * Bundling a mod must not cost it the curator's installer answers.
 *
 * `installFromBundledArchive` emitted `start-install`, which has no argument
 * for choices — so a bundled FOMOD installed with DEFAULT options while the
 * collection claimed to reproduce the curator's build. That is the same gap
 * that existed on the Nexus path and then on the hand-picked path: THREE
 * install routes, the same omission, each found separately.
 *
 * Which is why this asserts the CALL rather than the outcome. Every previous
 * instance was invisible from the outside: files all present, all correct, and
 * the wrong ones.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installFromBundledArchive } from "./modInstall";
// eslint-disable-next-line import/no-relative-packages
import { __testPaths } from "../../../test/stubs/vortex-api";

const CHOICES = {
  type: "fomod",
  options: [
    { name: "Step", groups: [{ name: "G", choices: [{ name: "C", idx: 1 }] }] },
  ],
};

let root: string;
let prevDownload: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "eh-bundled-"));
  prevDownload = __testPaths.downloadPath;
  __testPaths.downloadPath = path.join(root, "downloads");
  fs.mkdirSync(__testPaths.downloadPath, { recursive: true });
});
afterEach(() => {
  __testPaths.downloadPath = prevDownload;
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * A Vortex double that records emits and completes an install.
 *
 * It must answer BOTH completion routes, because the two install calls settle
 * differently: `start-install` resolves through its own callback, while
 * `start-install-download` is awaited via a `did-install-mod` listener. A
 * double that only did one of them would time out on exactly the path under
 * test and look like a hang rather than a missing feature.
 */
const fakeApi = () => {
  const emits: { event: string; args: unknown[] }[] = [];
  const listeners = new Map<string, ((...a: unknown[]) => void)[]>();
  const api = {
    events: {
      emit: (event: string, ...args: unknown[]) => {
        emits.push({ event, args });
        const cb = args[args.length - 1];
        if (typeof cb === "function") {
          setTimeout(() => (cb as (e: null, id: string) => void)(null, "new-mod"), 0);
        }
        setTimeout(() => {
          for (const fn of listeners.get("did-install-mod") ?? []) {
            fn("fallout4", "new-mod");
          }
        }, 0);
      },
      on: (event: string, fn: (...a: unknown[]) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      },
      removeListener: (event: string, fn: (...a: unknown[]) => void) => {
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((f) => f !== fn),
        );
      },
    },
    store: { dispatch: () => undefined, getState: () => ({}) },
    getState: () => ({}),
  } as never;
  return { api, emits };
};

const preExtracted = (): { extractedPath: string; tempDir: string } => {
  const tempDir = path.join(root, "extracted");
  fs.mkdirSync(tempDir, { recursive: true });
  const extractedPath = path.join(tempDir, "BundledMod.zip");
  fs.writeFileSync(extractedPath, Buffer.alloc(64, 3));
  return { extractedPath, tempDir };
};

describe("installFromBundledArchive", () => {
  it("hands the curator's choices to the installer", async () => {
    const { api, emits } = fakeApi();
    // Deliberately not awaited to completion. `start-install-download` settles
    // through a did-install-mod listener that matches on the archiveId Vortex
    // assigns, which a double cannot produce without reimplementing Vortex's
    // download table. What is under test is the CALL — whether the choices
    // reach the installer — and that is observable the moment it is emitted.
    void installFromBundledArchive(api, {
      gameId: "fallout4",
      ehcollZipPath: "C:/nowhere/pkg.ehcoll",
      bundleFolder: "bundled/abc/",
      preExtracted: preExtracted(),
      choices: CHOICES as never,
    });
    await new Promise((r) => setTimeout(r, 50));

    const call = emits.find((e) => e.event === "start-install-download");
    expect(call, "a bundled mod never reached the choices-carrying call").toBeDefined();
    expect(call!.args[1]).toEqual({
      allowAutoEnable: true,
      choices: CHOICES,
      unattended: true,
    });
    // And NOT through the call that cannot carry them.
    expect(emits.some((e) => e.event === "start-install")).toBe(false);
  });

  it("leaves a bundled mod with no choices on the original path", async () => {
    // Bundling must not start copying archives into the download folder for
    // mods that have no answers to replay.
    const { api, emits } = fakeApi();
    void installFromBundledArchive(api, {
      gameId: "fallout4",
      ehcollZipPath: "C:/nowhere/pkg.ehcoll",
      bundleFolder: "bundled/abc/",
      preExtracted: preExtracted(),
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(emits.some((e) => e.event === "start-install")).toBe(true);
    expect(emits.some((e) => e.event === "start-install-download")).toBe(false);
    expect(fs.readdirSync(__testPaths.downloadPath)).toEqual([]);
  });
});
