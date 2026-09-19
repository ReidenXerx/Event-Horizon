/**
 * Where the user said an external mod lives.
 *
 * A collection carries mods Vortex cannot fetch, and the install asks the user
 * to point at each archive. That answer used to live only in wizard state, so
 * resuming asked again for every one — a tester with two dozen external mods
 * re-supplied all of them to continue an install he had already answered.
 *
 * The dangerous direction is remembering too eagerly: a stale path fails
 * SILENTLY, pre-filling an answer nobody re-confirms and installing from a
 * file that has since moved or changed.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";

import {
  forgetOneSource,
  forgetSources,
  readSourceMemory,
  rememberSource,
  usableSources,
} from "./sourceMemory";

let dir: string;
beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "eh-src-"));
});
afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe("remembering answers", () => {
  it("round-trips one answer", async () => {
    await rememberSource(dir, "pkg", "external:abc", "C:/mods/thing.7z");
    const mem = await readSourceMemory(dir, "pkg");
    expect(mem["external:abc"]?.path).toBe("C:/mods/thing.7z");
  });

  it("MERGES, so answering the second mod does not forget the first", async () => {
    // Answers arrive one at a time as the user works down the list. A write
    // that replaced the file would lose everything said before it — which is
    // the whole problem this exists to solve.
    await rememberSource(dir, "pkg", "external:a", "C:/a.7z");
    await rememberSource(dir, "pkg", "external:b", "C:/b.7z");
    const mem = await readSourceMemory(dir, "pkg");
    expect(Object.keys(mem).sort()).toEqual(["external:a", "external:b"]);
  });

  it("keeps collections apart", async () => {
    // Two collections may legitimately reference the same mod from different
    // places.
    await rememberSource(dir, "pkg-1", "external:a", "C:/one.7z");
    await rememberSource(dir, "pkg-2", "external:a", "C:/two.7z");
    expect((await readSourceMemory(dir, "pkg-1"))["external:a"]?.path).toBe(
      "C:/one.7z",
    );
    expect((await readSourceMemory(dir, "pkg-2"))["external:a"]?.path).toBe(
      "C:/two.7z",
    );
  });

  it("overwrites when the user changes their mind", async () => {
    await rememberSource(dir, "pkg", "external:a", "C:/old.7z");
    await rememberSource(dir, "pkg", "external:a", "C:/new.7z");
    expect((await readSourceMemory(dir, "pkg"))["external:a"]?.path).toBe(
      "C:/new.7z",
    );
  });

  it("forgets a collection on request", async () => {
    await rememberSource(dir, "pkg", "external:a", "C:/a.7z");
    await forgetSources(dir, "pkg");
    expect(await readSourceMemory(dir, "pkg")).toEqual({});
  });
});

describe("refusing to fail an install", () => {
  it("reads nothing rather than throwing when there is no file", async () => {
    expect(await readSourceMemory(dir, "never-written")).toEqual({});
  });

  it("reads nothing rather than throwing on corrupt json", async () => {
    const d = path.join(dir, "event-horizon", "install-ledger", "sources");
    await fsp.mkdir(d, { recursive: true });
    await fsp.writeFile(path.join(d, "pkg.json"), "{ not json", "utf8");
    expect(await readSourceMemory(dir, "pkg")).toEqual({});
  });

  it("skips entries with no usable path", async () => {
    const d = path.join(dir, "event-horizon", "install-ledger", "sources");
    await fsp.mkdir(d, { recursive: true });
    await fsp.writeFile(
      path.join(d, "pkg.json"),
      JSON.stringify({ a: { path: "" }, b: {}, c: { path: "C:/ok.7z" } }),
      "utf8",
    );
    expect(Object.keys(await readSourceMemory(dir, "pkg"))).toEqual(["c"]);
  });

  it("never throws when the answer cannot be written", async () => {
    const blocked = path.join(dir, "a-file-not-a-dir");
    await fsp.writeFile(blocked, "x", "utf8");
    await expect(
      rememberSource(blocked, "pkg", "external:a", "C:/a.7z"),
    ).resolves.toBeUndefined();
  });
});

describe("usableSources", () => {
  const stamped = { size: 100, mtimeMs: 5 };
  const mem = {
    gone: { path: "C:/gone.7z", rememberedAt: "", ...stamped },
    here: { path: "C:/here.7z", rememberedAt: "", ...stamped },
  };
  const present = async (p: string) =>
    p === "C:/here.7z" ? stamped : undefined;

  it("drops answers whose file is no longer there", async () => {
    // Drives get unplugged and folders get tidied; a pre-filled answer
    // pointing at nothing is worse than asking again, because nobody
    // re-confirms a field that looks already answered.
    expect(Object.keys(await usableSources(mem, present))).toEqual(["here"]);
  });

  it("drops an answer whose file CHANGED under the same name", async () => {
    // The reason a path alone is not enough. Names get reused. Offering back a
    // different archive under a compareKey naming a specific sha256 is caught
    // eventually — by archive identity, or by verifying staged files — but
    // only after installing the wrong mod, and it surfaces as a puzzling
    // verification failure rather than "the file you picked has changed".
    const changed = async () => ({ size: 999, mtimeMs: 5 });
    expect(await usableSources(mem, changed)).toEqual({});
    const touched = async () => ({ size: 100, mtimeMs: 99 });
    expect(await usableSources(mem, touched)).toEqual({});
  });

  it("keeps an answer whose file is byte-for-byte where it was", async () => {
    expect(
      Object.keys(await usableSources(mem, async () => stamped)).sort(),
    ).toEqual(["gone", "here"]);
  });

  it("keeps an OLD entry that has no fingerprint at all", async () => {
    // Written before fingerprints existed. "Cannot compare" is not "does not
    // match", and forgetting a good answer has a cost too.
    const legacy = { a: { path: "C:/a.7z", rememberedAt: "" } };
    expect(
      Object.keys(await usableSources(legacy, async () => ({ size: 1, mtimeMs: 2 }))),
    ).toEqual(["a"]);
  });

  it("handles an empty memory", async () => {
    expect(await usableSources({}, async () => stamped)).toEqual({});
  });
});

/**
 * ──────────────────────────────────────────────────────────────────────
 * An answer must be forgettable one mod at a time.
 *
 * Without it the memory was write-only per mod: `setConflictChoice` recorded
 * a `use-local-file` pick and returned early for every other choice. So a
 * player who picked a file, was told by the pick-time check that it is NOT
 * the one the collection was built from, and switched that row to Skip left
 * the rejected path in the store — and the next revision pre-filled it as an
 * answered row, reversing an explicit refusal.
 * ──────────────────────────────────────────────────────────────────────
 */
describe("forgetting one mod's answer", () => {
  it("removes just that entry and keeps the others", async () => {
    await rememberSource(dir, "pkg", "external:aaa", "C:/a.7z");
    await rememberSource(dir, "pkg", "external:bbb", "C:/b.7z");

    await forgetOneSource(dir, "pkg", "external:aaa");

    const left = await readSourceMemory(dir, "pkg");
    expect(Object.keys(left)).toEqual(["external:bbb"]);
  });

  it("is a no-op for a key that was never remembered", async () => {
    await rememberSource(dir, "pkg", "external:bbb", "C:/b.7z");
    await forgetOneSource(dir, "pkg", "external:nope");
    expect(Object.keys(await readSourceMemory(dir, "pkg"))).toEqual([
      "external:bbb",
    ]);
  });

  it("never throws when there is nothing there at all", async () => {
    await expect(
      forgetOneSource(dir, "no-such-package", "external:aaa"),
    ).resolves.toBeUndefined();
  });
});
