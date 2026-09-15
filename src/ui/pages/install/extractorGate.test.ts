/**
 * The gate that stops an install Vortex cannot possibly complete.
 *
 * A tester's log showed sevenzip.preflight kind=broken at 13:53 and a 963-mod
 * install starting at 13:57. The verdict existed four minutes before the run
 * and was thrown away after a notification, so nothing stopped it.
 *
 * Two properties, and the second matters as much as the first:
 *   - a FATAL extractor blocks the install and explains itself
 *   - it does NOT block when nothing needs unpacking, because a collection
 *     that is entirely already-installed is still legitimately installable
 */
import { describe, expect, it, vi } from "vitest";

// The two non-blocking cases legitimately proceed into the driver. Without
// this they reach runInstall with a deliberately minimal fixture and reject in
// the background, so the file passes while emitting unhandled rejections.
// Stubbing it keeps the assertions about the GATE and nothing else.
vi.mock("../../../core/installer/runInstall", () => ({
  runInstall: () => new Promise(() => undefined),
  buildAbortedResult: () => ({ kind: "aborted" }),
}));

import { getInstallSession } from "./installSession";
import type { PreviewBundle } from "./state";

const bundle = (
  extractorBlocked?: PreviewBundle["extractorBlocked"],
): PreviewBundle =>
  ({
    zipPath: "C:/x.ehcoll",
    ehcoll: { manifest: { package: { name: "Ivy 2" } } },
    receipt: undefined,
    plan: { modResolutions: [] },
    appDataPath: "C:/appdata",
    ...(extractorBlocked !== undefined ? { extractorBlocked } : {}),
  }) as unknown as PreviewBundle;

type Sess = ReturnType<typeof getInstallSession>;

function confirmSession(b: PreviewBundle): Sess {
  // The session is a module SINGLETON, so state leaks between cases. The
  // stubbed runInstall never settles, which leaves installInFlight true and
  // makes the next startInstall return early — a false pass that looks like
  // the gate firing. Reset both explicitly.
  const s = getInstallSession();
  (s as unknown as { installInFlight: boolean }).installInFlight = false;
  (s as unknown as { installController?: unknown }).installController =
    undefined;
  // Drive it to `confirm` through the reducer, which is the only state
  // startInstall acts from.
  (s as unknown as { state: unknown }).state = {
    kind: "confirm",
    bundle: b,
    decisions: { conflictChoices: {}, orphanChoices: {} },
  };
  return s;
}

const fakeApi = (): { api: never; dialogs: unknown[][] } => {
  const dialogs: unknown[][] = [];
  return {
    api: {
      showDialog: (...args: unknown[]) => {
        dialogs.push(args);
        return Promise.resolve({});
      },
    } as never,
    dialogs,
  };
};

const kindOf = (s: unknown): string => {
  const st = (s as { state: { kind: string; readyToStart?: boolean } }).state;
  // A passing gate stops at the "Hands off" warning; the install itself starts
  // on its "Understood" (startWarning.test.ts).
  return st.kind === "confirm" && st.readyToStart === true ? "ready" : st.kind;
};

describe("startInstall — fatal extractor gate", () => {
  it("refuses to start, and says how many mods would have failed", () => {
    const { api, dialogs } = fakeApi();
    const s = confirmSession(
      bundle({ message: "7z is dead", steps: ["fix it"], toUnpack: 673 }),
    );
    s.startInstall(api);

    expect(dialogs).toHaveLength(1);
    expect(String(dialogs[0]?.[1])).toMatch(/cannot unpack/i);
    expect(String(JSON.stringify(dialogs[0]))).toMatch(/673/);
    // Still in confirm: the install never started.
    expect(kindOf(s)).toBe("confirm");
  });

  it("does NOT block when nothing needs unpacking", () => {
    const { api, dialogs } = fakeApi();
    const s = confirmSession(
      bundle({ message: "7z is dead", steps: ["fix it"], toUnpack: 0 }),
    );
    s.startInstall(api);
    expect(dialogs).toHaveLength(0);
    // Positive assertion, not just the absence of a dialog: it really started.
    expect(kindOf(s)).toBe("ready");
  });

  it("does not block when the extractor is healthy", () => {
    const { api, dialogs } = fakeApi();
    const s = confirmSession(bundle(undefined));
    s.startInstall(api);
    expect(dialogs).toHaveLength(0);
    expect(kindOf(s)).toBe("ready");
  });
});
