import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { OpLog, readOpsJournal, type OpRecord } from "../../../core/control/ops";
import { activityStats, formatDuration, presentOp, relativeTime } from "./activity";

const NOW = Date.parse("2026-09-26T21:00:00.000Z");
const at = (s: number): string => new Date(NOW - s * 1000).toISOString();
const op = (o: Partial<OpRecord>): OpRecord =>
  ({ opId: "op-1", verb: "deploy", status: "succeeded", body: {}, queuedAt: at(10), ...o }) as OpRecord;

describe("presentOp", () => {
  it("a running command says what it is doing and for how long", () => {
    const v = presentOp(op({ status: "running", startedAt: at(12), mutates: true }), NOW);
    expect(v).toMatchObject({ tone: "running", badge: "DEPLOY", title: "Deploying…", duration: "12.0 s" });
  });

  it("a success reads as the verb's own summary, with what was checked and answered", () => {
    const v = presentOp(
      op({
        verb: "install",
        mutates: true,
        summary: "installed AAF (AE)",
        endedAt: at(60),
        ms: 48200,
        result: {
          verified: { inPool: true },
          vortex: { dialogsSeen: [{ title: "F4SE", answer: "Update current profile" }], notifications: [{ type: "error", title: "Hash mismatch" }] },
        },
      }),
      NOW,
    );
    expect(v.title).toBe("Installed AAF (AE)");
    expect(v.chips).toEqual([
      { text: "✓ Verified", tone: "ok" },
      { text: "Answered “Update current profile”", tone: "info" },
      { text: "Vortex error: Hash mismatch", tone: "fail" },
    ]);
    expect(v.when).toBe("1m ago");
  });

  it("a refusal shows the reason and the code", () => {
    const v = presentOp(
      op({ verb: "install", mutates: true, status: "failed", body: { nexus: { modId: 75767, fileId: 409642 } }, code: "would-replace-everywhere", message: "no" }),
      NOW,
    );
    expect(v).toMatchObject({ tone: "fail", title: "Installing Nexus 75767:409642: refused", detail: "no" });
    expect(v.chips[0]).toEqual({ text: "would-replace-everywhere", tone: "fail" });
  });

  it("a switch shows its four steps, and where a failed one stopped", () => {
    const ok = presentOp(op({ verb: "game.switchInstall", mutates: true, result: { steps: ["purge", "setPath", "profile", "deploy"] } }), NOW);
    expect(ok.steps?.map((s) => s.state)).toEqual(["done", "done", "done", "done"]);
    const bad = presentOp(
      op({ verb: "game.switchInstall", mutates: true, status: "failed", details: { completedSteps: ["purge"], failedStep: "setPath" } }),
      NOW,
    );
    expect(bad.steps?.map((s) => s.state)).toEqual(["done", "failed", "todo", "todo"]);
  });

  it("reads are marked as reads, so the feed can hide them", () => {
    expect(presentOp(op({ verb: "state", mutates: false }), NOW)).toMatchObject({ tone: "read", mutates: false });
  });
});

describe("activityStats", () => {
  it("counts changes, verified changes, refusals and dialogs answered; reads do not count", () => {
    const s = activityStats([
      op({ mutates: true, result: { verified: {} } }),
      op({ mutates: true, result: { vortex: { dialogsSeen: [{ answer: "x" }, { title: "y" }] } } }),
      op({ mutates: true, status: "failed", details: { vortex: { dialogsSeen: [{ answer: "z" }] } } }),
      op({ verb: "state", mutates: false, result: { verified: {} } }),
    ]);
    expect(s).toEqual({ changes: 2, verified: 1, refused: 1, answered: 2 });
  });
});

describe("time", () => {
  it("formats durations and ages", () => {
    expect(formatDuration(210)).toBe("210 ms");
    expect(formatDuration(23400)).toBe("23.4 s");
    expect(formatDuration(125000)).toBe("2m 5s");
    expect(relativeTime(at(2), NOW)).toBe("just now");
    expect(relativeTime(at(7200), NOW)).toBe("2h ago");
  });
});

describe("OpLog feeds the page", () => {
  it("tells listeners about create, start and finish", () => {
    const log = new OpLog();
    const seen: string[] = [];
    log.subscribe((o) => seen.push(o.status));
    const o = log.create("deploy", {});
    log.start(o);
    log.finish(o, { ok: true, result: {} });
    expect(seen).toEqual(["queued", "running", "succeeded"]);
  });

  it("brings the journal back after a restart, and skips a line cut short", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "eh-ops-")), "control-ops.jsonl");
    const first = new OpLog(file);
    const o = first.create("purge", {});
    first.start(o);
    first.finish(o, { ok: true, result: { deployedFilesAfter: 0 } });
    fs.appendFileSync(file, '{"opId":"op-broken","ver');
    expect(readOpsJournal(file, 10).map((x) => x.opId)).toEqual([o.opId]);
    expect(new OpLog(file).get(o.opId)?.status).toBe("succeeded");
  });
});
