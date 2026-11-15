/**
 * The agent journal is read from its END, and moved aside when it grows.
 *
 * 11-15: control-ops.jsonl held 80,377 ops (1.1 GB). Every start read the
 * whole file to show the last 100, the Vortex window ran out of memory four
 * times in a row, and Vortex gave up ("can't be restarted") with no control
 * server for any agent.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { OpLog, readOpsJournal, rotateOpsJournal } from "./ops";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-ops-"));
const line = (i: number, pad = 0): string =>
  `${JSON.stringify({ opId: `op-${i}`, verb: "state", status: "succeeded", body: {}, queuedAt: "x", result: { pad: "p".repeat(pad) } })}\n`;

describe("reading the journal's last ops", () => {
  it("returns the last ops from a tail read, never parsing the start", () => {
    const file = path.join(dir, "big.jsonl");
    fs.writeFileSync(file, "this first line is not JSON and must not be reached\n");
    for (let i = 0; i < 2000; i++) fs.appendFileSync(file, line(i, 200));
    const ops = readOpsJournal(file, 100, 64 * 1024);
    expect(ops).toHaveLength(100);
    expect(ops[0]!.opId).toBe("op-1900");
    expect(ops[99]!.opId).toBe("op-1999");
  });

  it("drops the line the tail read cut in half", () => {
    const file = path.join(dir, "cut.jsonl");
    fs.writeFileSync(file, line(0, 5000) + line(1) + line(2));
    const ops = readOpsJournal(file, 100, 2000);
    expect(ops.map((o) => o.opId)).toEqual(["op-1", "op-2"]);
  });

  it("reads a small journal whole, and a missing one as none", () => {
    const file = path.join(dir, "small.jsonl");
    fs.writeFileSync(file, line(0) + line(1));
    expect(readOpsJournal(file, 100).map((o) => o.opId)).toEqual(["op-0", "op-1"]);
    expect(readOpsJournal(path.join(dir, "nope.jsonl"), 100)).toEqual([]);
  });
});

describe("rotating an oversized journal", () => {
  it("moves it aside past the limit, replacing an older one, and leaves a small one", () => {
    const file = path.join(dir, "control-ops.jsonl");
    fs.writeFileSync(file, line(0) + line(1));
    expect(rotateOpsJournal(file, 1024 * 1024)).toBe(false);
    fs.writeFileSync(path.join(dir, "control-ops.previous.jsonl"), "old");
    expect(rotateOpsJournal(file, 10)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(path.join(dir, "control-ops.previous.jsonl"), "utf8")).toContain("op-1");
  });

  it("the log still shows the history on the start that rotates it", () => {
    const sub = fs.mkdtempSync(path.join(dir, "start-"));
    const file = path.join(sub, "control-ops.jsonl");
    let text = "";
    for (let i = 0; i < 300; i++) text += line(i, 300_000);
    fs.writeFileSync(file, text); // ~90 MB, past the 64 MB limit
    const log = new OpLog(file);
    expect(log.list({ limit: 1 })[0]!.opId).toBe("op-299");
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.join(sub, "control-ops.previous.jsonl"))).toBe(true);
  });
});
