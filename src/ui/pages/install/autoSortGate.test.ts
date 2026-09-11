/**
 * The auto-sort prompt, driven through the real session.
 *
 * "Turn it off and install" dispatched an action type no reducer handled,
 * logged `install.auto-sort-disabled`, and went on. The setting stayed ON, so
 * the install's own re-pin was liable to be re-sorted, and the gate — which
 * re-reads the setting — had nothing recording that the user had answered.
 *
 * Properties:
 *   - it installs only once Vortex's state reads autoSort false
 *   - a disable that did not land is SAID, and the install waits for the
 *     user's second answer instead of proceeding as though it were off
 *   - an answer is recorded, so the gate does not ask the same question again
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../core/installer/probeDeployment", () => ({
  probeDeploymentMethod: () => ({ kind: "ok", methodId: "hardlink_activator" }),
  describeDeploymentBlock: () => ({ title: "", body: "" }),
}));

vi.mock("../../../core/installer/runInstall", () => ({
  runInstall: () => new Promise(() => undefined),
  buildAbortedResult: () => ({ kind: "aborted" }),
}));

import { getInstallSession } from "./installSession";
import type { PreviewBundle } from "./state";

const bundle = (): PreviewBundle =>
  ({
    zipPath: "C:/x.ehcoll",
    ehcoll: { manifest: { package: { name: "Ivy 2" } } },
    receipt: undefined,
    plan: {
      modResolutions: [],
      manifest: { game: { id: "fallout4" }, plugins: { order: [{ name: "a.esp" }] } },
    },
    appDataPath: "C:/appdata",
  }) as unknown as PreviewBundle;

function confirmSession(): ReturnType<typeof getInstallSession> {
  const s = getInstallSession();
  (s as unknown as { installInFlight: boolean }).installInFlight = false;
  (s as unknown as { installController?: unknown }).installController = undefined;
  (s as unknown as { autoSortAnsweredFor?: unknown }).autoSortAnsweredFor = undefined;
  const b = bundle();
  (s as unknown as { environmentClearedFor: unknown }).environmentClearedFor = b.plan;
  (s as unknown as { state: unknown }).state = {
    kind: "confirm",
    bundle: b,
    decisions: { conflictChoices: {}, orphanChoices: {} },
  };
  return s;
}

const kindOf = (s: unknown): string => (s as { state: { kind: string } }).state.kind;

/** A Vortex whose store honours only the bundle's real action type — or none. */
function vortex(opts: { honours: boolean; answers: string[] }): {
  api: never;
  titles: string[];
  dispatched: string[];
} {
  let autoSort = true;
  const titles: string[] = [];
  const dispatched: string[] = [];
  const answers = [...opts.answers];
  return {
    titles,
    dispatched,
    api: {
      getState: () => ({ settings: { plugins: { autoSort } } }),
      store: {
        dispatch: (a: { type: string; payload: unknown }): void => {
          dispatched.push(a.type);
          if (opts.honours && a.type === "GAMEBRYO_SET_AUTOSORT_ENABLED") autoSort = a.payload as boolean;
        },
      },
      showDialog: (_type: string, title: string) => {
        titles.push(title);
        // Out of scripted answers: the dialog stays open. A re-asking loop
        // then shows up as an extra title right away, instead of spinning on
        // microtasks until the test times out.
        if (answers.length === 0) return new Promise(() => undefined);
        return Promise.resolve({ action: answers.shift() });
      },
    } as never,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("startInstall — auto-sort prompt", () => {
  it("installs once the setting reads back off", async () => {
    const v = vortex({ honours: true, answers: ["Turn it off and install"] });
    const s = confirmSession();
    s.startInstall(v.api);
    await settle();
    expect(v.dispatched).toEqual(["GAMEBRYO_SET_AUTOSORT_ENABLED"]);
    expect(kindOf(s)).toBe("installing");
    expect(v.titles).toEqual(["Turn off automatic plugin sorting?"]);
  });

  it("does not proceed as though it were off when Vortex ignored the change", async () => {
    // The second dialog is dismissed: the install must still be waiting.
    const v = vortex({ honours: false, answers: ["Turn it off and install", "Cancel"] });
    const s = confirmSession();
    s.startInstall(v.api);
    await settle();
    expect(v.titles).toEqual(["Turn off automatic plugin sorting?", "Automatic sorting is still on"]);
    expect(kindOf(s)).toBe("confirm");
  });

  it("installs with sorting on only when the user says so, and does not ask again", async () => {
    const v = vortex({ honours: false, answers: ["Turn it off and install", "Install anyway"] });
    const s = confirmSession();
    s.startInstall(v.api);
    await settle();
    expect(kindOf(s)).toBe("installing");
    expect(v.titles).toHaveLength(2);
  });

  it("'Leave it on' installs instead of re-opening the same question", async () => {
    const v = vortex({ honours: true, answers: ["Leave it on", "Leave it on"] });
    const s = confirmSession();
    s.startInstall(v.api);
    await settle();
    expect(v.titles).toEqual(["Turn off automatic plugin sorting?"]);
    expect(kindOf(s)).toBe("installing");
  });
});
