/**
 * A refusal the retry pass undid must not stay on screen as a failure.
 *
 * Ivy Rev 29 on EH 0.2.128: Rapport's FOMOD refused ("File 'anatomy.esp' is
 * Active") before Anatomy was in, then Overture and Chemistry for Rapport.esp.
 * The retry pass installed all three, and Vortex's three red "Installer
 * reported errors" notifications stayed, so the player read them as failed.
 *
 * Vortex gives those notifications random ids (addNotification -> shortid),
 * so they are attributed by difference around each attempt.
 */
import { describe, expect, it, vi } from "vitest";

import * as fs from "fs";
import * as path from "path";

import {
  INSTALLER_ERRORS_TITLE,
  dismissNotices,
  installerErrorNoticeIds,
  noticesRaisedSince,
} from "./quietNotifications";

/** As Vortex's showError stores it: title + message = the attempt's mod id. */
const notice = (id: string, title = INSTALLER_ERRORS_TITLE, message = "Rapport 0.2.27 NuqDBFpLF") => ({
  id,
  type: "error",
  title,
  message,
});

const apiWith = (notifications: unknown[], dismiss = vi.fn()) =>
  ({
    getState: () => ({ session: { notifications: { notifications } } }),
    dismissNotification: dismiss,
  }) as never;

describe("Vortex's installer-error notifications", () => {
  it("finds only the ones titled 'Installer reported errors'", () => {
    const ids = installerErrorNoticeIds(
      apiWith([notice("a"), notice("b", "Deploy hiccup"), { id: "c", message: INSTALLER_ERRORS_TITLE }]),
    );
    expect([...ids]).toEqual(["a"]);
  });

  it("an unrecognised state shape is no notices, never a throw", () => {
    expect(installerErrorNoticeIds({ getState: () => undefined } as never).size).toBe(0);
    expect(installerErrorNoticeIds({ getState: () => { throw new Error("x"); } } as never).size).toBe(0);
  });

  it("attributes to an attempt only what it raised, not what was already there", () => {
    const before = new Set(["old"]);
    expect(noticesRaisedSince(before, new Set(["old", "new1", "new2"]))).toEqual(["new1", "new2"]);
    expect(noticesRaisedSince(before, new Set(["old"]))).toEqual([]);
  });

  it("dismisses exactly the given ids and never throws", () => {
    const dismiss = vi.fn();
    expect(dismissNotices(apiWith([], dismiss), ["new1"])).toBe(1);
    expect(dismiss).toHaveBeenCalledWith("new1");
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(dismissNotices({ dismissNotification: () => { throw new Error("x"); } } as never, ["a"])).toBe(0);
    expect(dismissNotices({} as never, ["a"])).toBe(0);
  });
});

describe("the driver wires it around the first attempt and the retry", () => {
  const src = fs.readFileSync(path.join(__dirname, "runInstall.ts"), "utf8");

  it("snapshots before the first-pass attempt", () => {
    const snap = src.indexOf("const noticesBefore = installerErrorNoticeIds(ctx.api);");
    expect(snap).toBeGreaterThan(-1);
    expect(src.indexOf("installEntry = await executeDecision({", snap)).toBeGreaterThan(snap);
  });

  it("records what the failed attempt raised, keyed by compareKey", () => {
    expect(src).toContain(
      "const raised = noticesRaisedSince(noticesBefore, installerErrorNoticeIds(ctx.api));",
    );
    expect(src).toContain("installerErrorNotices.set(resolution.compareKey, raised);");
  });

  it("dismisses them only where the retry put the mod on disk", () => {
    const ok = src.indexOf('"install.retry.mod.ok"');
    const dismiss = src.indexOf("installerErrorNotices.get(entry.compareKey)");
    const recovered = src.indexOf("recoveredKeys.push(entry.compareKey);");
    expect(dismiss).toBeGreaterThan(recovered);
    expect(dismiss).toBeLessThan(ok);
    // and never on the retry's failure branch
    const failed = src.indexOf('"install.retry.mod.failed"');
    expect(src.slice(ok, failed)).not.toContain("dismissNotices(");
  });
});
