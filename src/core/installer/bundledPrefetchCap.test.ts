/**
 * The prefetch pool writes bundled mods' archives ahead of the install, and
 * each one is a full uncompressed copy of a mod in the temp folder.
 *
 * It used to start the next write whenever one FINISHED, whether or not the
 * driver had taken the finished one — so while the driver was busy with a long
 * run of other mods, every bundled mod in the collection ended up on the temp
 * drive at once. A write that is done but not yet taken now holds its place.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./modInstall", () => ({
  extractBundledFromEhcoll: vi.fn(),
  safeRmTempDir: vi.fn(async () => undefined),
}));

import { BundledPrefetchPool } from "./bundledPrefetch";
import { extractBundledFromEhcoll } from "./modInstall";

type Written = { extractedPath: string; tempDir: string };

/** Every write the pool starts, held open until the test finishes it. */
function controlledWrites(): Array<{ entry: string; finish: () => void }> {
  const started: Array<{ entry: string; finish: () => void }> = [];
  vi.mocked(extractBundledFromEhcoll).mockImplementation(
    (_pkg: string, entry: string) =>
      new Promise<Written>((resolve) => {
        started.push({ entry, finish: () => resolve({ extractedPath: `${entry}/mod.zip`, tempDir: entry }) });
      }),
  );
  return started;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.mocked(extractBundledFromEhcoll).mockReset();
});

describe("BundledPrefetchPool", () => {
  it("does not start another write while a finished one waits to be taken", async () => {
    const started = controlledWrites();
    const pool = new BundledPrefetchPool({ ehcollZipPath: "C:/p.ehcoll", concurrency: 1 });
    pool.prime([{ zipEntry: "a" }, { zipEntry: "b" }, { zipEntry: "c" }]);
    expect(started.map((w) => w.entry)).toEqual(["a"]);

    started[0]!.finish();
    await settle();
    // Written, not taken: its copy still sits on the temp drive.
    expect(started.map((w) => w.entry)).toEqual(["a"]);

    await expect(pool.take("a")).resolves.toEqual({ extractedPath: "a/mod.zip", tempDir: "a" });
    await settle();
    expect(started.map((w) => w.entry)).toEqual(["a", "b"]);

    await pool.dispose();
  });

  it("still writes one the driver asks for out of order, whatever is waiting", async () => {
    // The limit shapes what is written AHEAD; it must never stop the driver
    // getting the mod it is installing now.
    const started = controlledWrites();
    const pool = new BundledPrefetchPool({ ehcollZipPath: "C:/p.ehcoll", concurrency: 1 });
    pool.prime([{ zipEntry: "a" }, { zipEntry: "b" }]);
    started[0]!.finish();
    await settle();

    const wanted = pool.take("b");
    await settle();
    expect(started.map((w) => w.entry)).toEqual(["a", "b"]);
    started[1]!.finish();
    await expect(wanted).resolves.toEqual({ extractedPath: "b/mod.zip", tempDir: "b" });

    await pool.dispose();
  });
});
