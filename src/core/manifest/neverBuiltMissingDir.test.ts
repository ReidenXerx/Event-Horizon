/**
 * A config directory that has never been written to is the NORMAL state for
 * every user who installs collections and never builds one. It was logged as
 * an `error`, with a stack, three times in one tester's session — in the very
 * file they are asked to send when something goes wrong.
 *
 * A real failure (no permission, a path that is a file) must still be loud.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listNeverBuiltConfigs } from "./collectionConfig";
import * as vortexApi from "@nexusmods/vortex-api";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-nb-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/**
 * Log lines this call emitted at `error` level.
 *
 * Observed at Vortex's own `log` sink rather than by spying on `ehLog`:
 * `beginOp` calls `ehLog` through a module-internal binding, so a spy on the
 * export never sees it and every assertion made that way passes vacuously —
 * which is exactly how the first draft of this test "passed".
 */
function errorsFrom(spy: ReturnType<typeof vi.spyOn>): string[] {
  return spy.mock.calls
    .filter((c) => c[0] === "error")
    .map((c) => String(c[1]));
}

describe("listNeverBuiltConfigs on a directory that is not there", () => {
  it("returns nothing and logs no error", async () => {
    const spy = vi.spyOn(vortexApi, "log");
    const missing = path.join(dir, "never-created");

    await expect(listNeverBuiltConfigs(missing)).resolves.toEqual([]);
    expect(errorsFrom(spy)).toEqual([]);
    // The probe itself must be live, or "no errors" means "nothing observed".
    // Verified by the ENOTDIR case below, which sees a line through this
    // same spy.
    expect(spy).toHaveBeenCalled();
  });

  it("still reports a directory it is not allowed to read", async () => {
    /**
     * The half that must not be relaxed. Silencing ENOENT is only safe
     * because every OTHER reason a read fails is a genuine problem the
     * curator needs told about. A file where a directory should be produces
     * ENOTDIR on both Windows and POSIX, which is a failure this must keep.
     */
    const spy = vi.spyOn(vortexApi, "log");
    const notADir = path.join(dir, "config");
    fs.writeFileSync(notADir, "this is a file, not a directory");

    await expect(listNeverBuiltConfigs(notADir)).resolves.toEqual([]);
    expect(errorsFrom(spy).join(" ")).toContain(
      "collection-config.list-never-built.fail",
    );
  });
});
