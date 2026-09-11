import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MIN_RESUME_MS,
  createToastTimers,
  findDuplicateToast,
  toastDedupKey,
  type ToastTimers,
} from "./toastModel";

describe("toast timers", () => {
  let expired: number[];
  let timers: ToastTimers;

  beforeEach(() => {
    vi.useFakeTimers();
    expired = [];
    timers = createToastTimers((id) => expired.push(id));
  });
  afterEach(() => {
    timers.dispose();
    vi.useRealTimers();
  });

  it("dismisses on its own after the pointer has been over it and left", () => {
    // The review's probe: show → hover at 1 s → leave at 3 s. The toast used
    // to have no timer at all after leaving and was still there at 63 s.
    timers.arm(1, 4000);
    vi.advanceTimersByTime(1000);
    timers.hold(1, "hover");
    vi.advanceTimersByTime(2000);
    expect(expired).toEqual([]);
    timers.release(1, "hover");
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(2999);
    expect(expired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(expired).toEqual([1]);
  });

  it("does not run while held, however long the hold", () => {
    timers.arm(1, 4000);
    timers.hold(1, "hover");
    vi.advanceTimersByTime(60_000);
    expect(expired).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a toast open while keyboard focus is inside it, even after the pointer leaves", () => {
    timers.arm(1, 4000);
    timers.hold(1, "hover");
    timers.hold(1, "focus");
    timers.release(1, "hover");
    vi.advanceTimersByTime(60_000);
    expect(expired).toEqual([]);
    timers.release(1, "focus");
    vi.advanceTimersByTime(4000);
    expect(expired).toEqual([1]);
  });

  it("a second hold does not shrink the time left", () => {
    timers.arm(1, 4000);
    vi.advanceTimersByTime(1000);
    timers.hold(1, "hover"); // 3 s left
    vi.advanceTimersByTime(2500);
    timers.hold(1, "focus"); // must still be 3 s, not max(500, due - now)
    timers.release(1, "focus");
    timers.release(1, "hover");
    vi.advanceTimersByTime(2999);
    expect(expired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(expired).toEqual([1]);
  });

  it("gives a toast left at its last moment enough time to be seen leaving", () => {
    timers.arm(1, 4000);
    vi.advanceTimersByTime(3990);
    timers.hold(1, "hover");
    timers.release(1, "hover");
    vi.advanceTimersByTime(MIN_RESUME_MS - 1);
    expect(expired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(expired).toEqual([1]);
  });

  it("re-showing a held toast extends what resumes instead of restarting under the cursor", () => {
    timers.arm(1, 4000);
    vi.advanceTimersByTime(3000);
    timers.hold(1, "hover"); // 1 s left
    timers.arm(1, 4000); // the same toast shown again
    expect(vi.getTimerCount()).toBe(0);
    timers.release(1, "hover");
    vi.advanceTimersByTime(3999);
    expect(expired).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(expired).toEqual([1]);
  });

  it("never dismisses a sticky toast, hovered or not", () => {
    timers.arm(1, 0);
    timers.hold(1, "hover");
    timers.release(1, "hover");
    vi.advanceTimersByTime(600_000);
    expect(expired).toEqual([]);
  });

  it("forgets a dismissed toast's clock", () => {
    timers.arm(1, 4000);
    timers.forget(1);
    vi.advanceTimersByTime(10_000);
    expect(expired).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("toast de-duplication", () => {
  it("merges the same text", () => {
    const a = toastDedupKey({ intent: "success", title: "Saved", message: "receipt.json" });
    const b = toastDedupKey({ intent: "success", title: "Saved", message: ["receipt", ".json"] });
    expect(a).toBeDefined();
    expect(a).toBe(b);
    expect(findDuplicateToast([{ id: 1, key: a }], b)).toEqual({ id: 1, key: a });
  });

  it("keeps different text apart", () => {
    const a = toastDedupKey({ intent: "info", title: "a", message: "bc" });
    const b = toastDedupKey({ intent: "info", title: "ab", message: "c" });
    expect(a).not.toBe(b);
    expect(toastDedupKey({ intent: "info", message: "x" })).not.toBe(
      toastDedupKey({ intent: "danger", message: "x" }),
    );
  });

  it("never merges two different element messages", () => {
    // Both used to hash to "[node]" and the second toast was dropped.
    const first = toastDedupKey({
      intent: "success",
      message: React.createElement("span", null, "Installed ", React.createElement("code", null, "SKSE")),
    });
    const second = toastDedupKey({
      intent: "success",
      message: React.createElement("span", null, "Installed ", React.createElement("code", null, "USSEP")),
    });
    const shown = [{ id: 1, key: first }];
    expect(findDuplicateToast(shown, second)).toBeUndefined();
  });

  it("never merges a message that mixes text and an element", () => {
    const mixed = ["Saved to ", React.createElement("code", { key: "p" }, "C:\\a")];
    const shown = [{ id: 1, key: toastDedupKey({ message: mixed }) }];
    expect(findDuplicateToast(shown, toastDedupKey({ message: mixed }))).toBeUndefined();
    const titled = [{ id: 2, key: toastDedupKey({ title: React.createElement("b"), message: "x" }) }];
    expect(findDuplicateToast(titled, toastDedupKey({ title: React.createElement("i"), message: "x" }))).toBeUndefined();
  });
});
