/**
 * One definition of "was this an abort?".
 *
 * The class docblock says the codebase relies on `name === "AbortError"`
 * checks at abort-handling sites, and then exported no way to perform one — so
 * the predicate was hand-written at 27 sites in three shapes that are NOT
 * equivalent:
 *
 *   (err as Error)?.name === "AbortError"
 *   err instanceof AbortError
 *   (err as Error).name === "AbortError" || ctx.abortSignal?.aborted === true
 *
 * Which one a site used decided what the user was told. Getting it wrong is
 * expensive in both directions: an abort reported as a failure writes a scary
 * receipt for something they did on purpose, and a failure reported as an
 * abort hides a real fault behind "cancelled".
 */
import { describe, expect, it } from "vitest";

import { AbortError, isAbort } from "./abortError";

describe("isAbort", () => {
  it("recognises our own class", () => {
    expect(isAbort(new AbortError())).toBe(true);
  });

  it("recognises anything wearing the same name", () => {
    /**
     * The case `instanceof` misses, and the reason the class documents being
     * interchangeable with `DOMException`. A native `AbortSignal` is what
     * `fs.promises` throws on, and it is not an instance of anything we own.
     */
    const domLike = Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
    });
    expect(isAbort(domLike)).toBe(true);
  });

  it("calls an ordinary failure a failure", () => {
    // The direction that hides real faults. A tester's ENOENT must not be
    // reported to them as "you cancelled this".
    expect(isAbort(new Error("ENOENT: no such file or directory"))).toBe(false);
    expect(isAbort(undefined)).toBe(false);
    expect(isAbort(null)).toBe(false);
    expect(isAbort("just a string")).toBe(false);
  });

  it("counts anything thrown after the signal fired", () => {
    /**
     * The distinction the compound form was reaching for, and the reason this
     * takes a signal rather than only an error. A call that fails WHILE
     * unwinding from a stop carries its own name — a half-deleted temp dir, a
     * cancelled Vortex install — and naming that as the cause sends the reader
     * after a fault that exists only because they pressed Stop.
     */
    const controller = new AbortController();
    controller.abort();
    expect(isAbort(new Error("ENOENT"), controller.signal)).toBe(true);
  });

  it("does not treat a live signal as an abort", () => {
    // Present but not fired. Without this the predicate would call every
    // failure in an abortable operation a cancellation.
    const controller = new AbortController();
    expect(isAbort(new Error("ENOENT"), controller.signal)).toBe(false);
  });

  it("answers from the error alone when there is no signal", () => {
    expect(isAbort(new AbortError(), undefined)).toBe(true);
    expect(isAbort(new Error("boom"), undefined)).toBe(false);
  });
});
