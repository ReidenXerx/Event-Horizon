/**
 * One requirement of a "Make it work" plan: what a refusal turns into, and
 * what Stop does while Vortex is installing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { installRequirementStep, type RequirementStepInput } from "./requirementStep";
import type { InstallEvents } from "./updateOneMod";

function emitter(): InstallEvents & { emit: (event: string, ...args: unknown[]) => void; count: () => number } {
  const handlers = new Map<string, Set<(...a: unknown[]) => void>>();
  return {
    on: (event, handler) => {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
    },
    removeListener: (event, handler) => {
      handlers.get(event)?.delete(handler);
    },
    emit: (event, ...args) => {
      for (const h of [...(handlers.get(event) ?? [])]) h(...args);
    },
    count: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
  };
}

const MIN = 60_000;

function input(over: Partial<RequirementStepInput> = {}): RequirementStepInput {
  return {
    events: emitter(),
    gameId: "skyrimse",
    vortexGameId: "skyrimse",
    name: "SKSE Plugin",
    nexusModId: 42,
    file: { file_id: 500, file_name: "plugin-500.7z" },
    premium: true,
    readInstalled: () => ({ nexusModId: 42, nexusFileId: 500 }),
    download: async () => "dl-1",
    openPage: () => undefined,
    pageDownloadIds: () => [],
    signal: new AbortController().signal,
    premiumTimeoutMs: 15 * MIN,
    guidedTimeoutMs: 60 * MIN,
    ...over,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a refused direct download", () => {
  it("becomes the guided wait: any file of the page, on the guided clock", async () => {
    // An expired login or a lapsed Premium resolves undefined. The page opens
    // and the USER picks the file from then on, so a different file of the
    // page is the answer, and it may take longer than the direct clock.
    vi.useFakeTimers();
    const events = emitter();
    const openPage = vi.fn();
    const promise = installRequirementStep(
      input({
        events,
        download: async () => undefined,
        openPage,
        readInstalled: () => ({ nexusModId: 42, nexusFileId: 777 }),
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(openPage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20 * MIN);
    events.emit("did-install-mod", "skyrimse", "arc", "picked-on-page");

    await expect(promise).resolves.toEqual({ ok: true, newModId: "picked-on-page", via: "guided" });
  });

  it("still fails honestly when nothing arrives on the guided clock either", async () => {
    vi.useFakeTimers();
    const promise = installRequirementStep(input({ download: async () => undefined }));
    await vi.advanceTimersByTimeAsync(61 * MIN);
    await expect(promise).resolves.toMatchObject({ ok: false, refused: true, stopped: false });
  });
});

describe("Stop means after this one", () => {
  it("keeps waiting for the install of a download this step started", async () => {
    // Vortex cannot cancel an install from outside and loses files when two
    // run at once. Letting go here freed the page mid-install.
    const events = emitter();
    const stop = new AbortController();
    const promise = installRequirementStep(
      input({ events, signal: stop.signal, download: () => new Promise<string | undefined>(() => undefined) }),
    );
    stop.abort();
    events.emit("did-install-mod", "skyrimse", "arc", "landed");
    await expect(promise).resolves.toEqual({ ok: true, newModId: "landed", via: "download" });
  });

  it("keeps waiting in a guided step once a download for the page has appeared", async () => {
    const events = emitter();
    const stop = new AbortController();
    let ids: string[] = [];
    const promise = installRequirementStep(
      input({ events, premium: false, signal: stop.signal, pageDownloadIds: () => ids }),
    );
    ids = ["user-clicked"];
    stop.abort();
    events.emit("did-install-mod", "skyrimse", "arc", "landed");
    await expect(promise).resolves.toMatchObject({ ok: true, newModId: "landed", via: "guided" });
  });

  it("ends a guided wait at once while nothing has started", async () => {
    const events = emitter();
    const stop = new AbortController();
    const promise = installRequirementStep(input({ events, premium: false, signal: stop.signal }));
    stop.abort();
    await expect(promise).resolves.toMatchObject({ ok: false, stopped: true });
    expect(events.count()).toBe(0);
  });

  it("ends the wait when the download it deferred for turns out to be refused", async () => {
    let refuse: (v: string | undefined) => void = () => undefined;
    const stop = new AbortController();
    const openPage = vi.fn();
    const promise = installRequirementStep(
      input({
        signal: stop.signal,
        openPage,
        download: () => new Promise<string | undefined>((r) => (refuse = r)),
      }),
    );
    stop.abort();
    refuse(undefined);
    await expect(promise).resolves.toMatchObject({ ok: false, stopped: true, refused: true });
    expect(openPage).not.toHaveBeenCalled();
  });
});
