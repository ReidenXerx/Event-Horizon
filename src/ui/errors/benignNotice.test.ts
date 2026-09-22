/**
 * ──────────────────────────────────────────────────────────────────────
 * A BROWSER NOTICE IS NOT A FAILURE, AND MUST NOT BE DRESSED AS ONE.
 *
 * Reported from Discord, 2026-09-22:
 *
 *     Title:    Something went wrong
 *     Severity: error
 *     Class:    string
 *     Message:  ResizeObserver loop completed with undelivered notifications.
 *     Hints:    This kind of error usually points to a non-Error value being
 *               thrown — please copy the report and tell us.
 *     filename: file:///F:/Vortex/resources/app.asar/index.html  line 0 col 0
 *
 * The user copied the report and told us, because the dialog asked them to.
 * Nothing had gone wrong: Chromium defers ResizeObserver deliveries it cannot
 * fit in one frame and announces the deferral through the error channel.
 *
 * It reached us because `isForeignError` needs a stack to disown anything and
 * this event has none — a deliberate policy ("anything ambiguous stays ours")
 * that is right for real errors and is NOT what this changes. What changes is
 * that a notice is no longer presented as a failure at all.
 *
 * The balance to keep: swallowing a real error is the expensive direction, so
 * the list is closed and exact rather than a rule about shapes.
 * ──────────────────────────────────────────────────────────────────────
 */
import { describe, expect, it } from "vitest";

import { isBenignBrowserNotice } from "./benignNotice";

describe("what the browser tells us that is not an error", () => {
  it("recognises the message the user was shown, verbatim", () => {
    expect(
      isBenignBrowserNotice(
        "ResizeObserver loop completed with undelivered notifications.",
      ),
    ).toBe(true);
  });

  it("recognises the older Chromium wording too", () => {
    // Still shipped by older Electron builds, and Vortex carries whichever
    // its Electron has.
    expect(isBenignBrowserNotice("ResizeObserver loop limit exceeded")).toBe(true);
  });

  it("recognises it when Chromium does hand over an Error object", () => {
    // The reported case had none (Class: string), but the wording is the
    // fact being matched, not the shape it arrived in.
    expect(
      isBenignBrowserNotice(
        new Error("ResizeObserver loop completed with undelivered notifications."),
      ),
    ).toBe(true);
  });

  it("is not fooled by surrounding whitespace", () => {
    expect(isBenignBrowserNotice("  ResizeObserver loop limit exceeded  ")).toBe(true);
  });
});

describe("what it must never swallow", () => {
  it("keeps a real error that merely mentions the observer", () => {
    /**
     * The anchor matters. Dropping anything containing "ResizeObserver" would
     * hide a genuine fault in code that uses one — and swallowing a real
     * error is the expensive direction, the same reasoning that makes
     * `isForeignError` err towards "ours".
     */
    expect(
      isBenignBrowserNotice(new Error("Failed to construct ResizeObserver: bad target")),
    ).toBe(false);
    expect(
      isBenignBrowserNotice("Cannot read properties of undefined (reading 'ResizeObserver')"),
    ).toBe(false);
  });

  it("keeps every ordinary failure", () => {
    for (const err of [
      new Error("ENOENT: no such file or directory"),
      new TypeError("x is not a function"),
      "Something went wrong",
      "Unknown window error",
    ]) {
      expect(isBenignBrowserNotice(err)).toBe(false);
    }
  });

  it("keeps values that are not a string or an Error", () => {
    // A richer thrown value is a real one. `undefined` and `null` in
    // particular must not read as benign, since they are what a badly
    // constructed throw produces.
    for (const err of [undefined, null, {}, { message: "ResizeObserver loop limit exceeded" }, 42]) {
      expect(isBenignBrowserNotice(err)).toBe(false);
    }
  });

  it("keeps an empty message", () => {
    expect(isBenignBrowserNotice("")).toBe(false);
    expect(isBenignBrowserNotice(new Error(""))).toBe(false);
  });
});

/**
 * ──────────────────────────────────────────────────────────────────────
 * THE PREDICATE PASSING IS NOT THE HANDLER DROPPING IT.
 *
 * `healingBlockedReason` had six green unit tests while the real caller passed
 * a shape none of them modelled, and every repair in the Doctor was disabled
 * for as long as that line existed. The unit tests above have the same blind
 * spot: they prove the predicate answers correctly, and say nothing about
 * whether `ErrorProvider` asks it.
 *
 * There is no DOM in this suite — no jsdom, no happy-dom, and the extension
 * deliberately carries no runtime dependencies — so the window handler cannot
 * be mounted and driven. This is the repo's other pattern for a seam that
 * cannot be executed: assert the source, and prove every anchor exists first
 * so a rename fails loudly instead of going vacuous (GP-7).
 * ──────────────────────────────────────────────────────────────────────
 */
import * as fs from "fs";
import * as path from "path";

describe("the window handler consults it", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "ErrorContext.tsx"),
    "utf8",
  );

  it("has every anchor this test locates", () => {
    expect(source).toContain("const onError = (event: ErrorEvent): void => {");
    expect(source).toContain("isBenignBrowserNotice(err)");
    expect(source).toContain("report(err, {");
  });

  it("checks for a benign notice BEFORE reporting, and returns", () => {
    const start = source.indexOf("const onError = (event: ErrorEvent): void => {");
    const check = source.indexOf("isBenignBrowserNotice(err)", start);
    const reported = source.indexOf("report(err, {", start);

    expect(check).toBeGreaterThan(start);
    expect(reported).toBeGreaterThan(check);
    // The early return is what makes the order matter.
    expect(source.slice(check, reported)).toContain("return;");
  });

  it("leaves the REJECTION path alone", () => {
    /**
     * These notices are only ever delivered as error events. Consulting the
     * list on rejections would widen a deliberately closed filter onto a
     * channel that cannot produce one — all risk, no benefit.
     */
    const rejection = source.indexOf("const onRejection =");
    expect(rejection).toBeGreaterThan(-1);
    const body = source.slice(rejection, rejection + 500);
    expect(body).not.toContain("isBenignBrowserNotice");
  });

  it("still logs it, so a notice that turns out to matter left a trail", () => {
    const start = source.indexOf("const onError = (event: ErrorEvent): void => {");
    const check = source.indexOf("isBenignBrowserNotice(err)", start);
    const reported = source.indexOf("report(err, {", start);
    expect(source.slice(check, reported)).toContain("ui.window-error.benign-notice");
  });
});
