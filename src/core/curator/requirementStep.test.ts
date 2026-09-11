/**
 * One requirement of a "Make it work" plan: the archive already in
 * Downloads, what a refusal turns into, and what Stop does while Vortex is
 * installing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { installRequirementStep, type RequirementStepInput, type StepEvents } from "./requirementStep";

function emitter(
  onEmit: (event: string, args: unknown[], fire: (event: string, ...args: unknown[]) => void) => void = () => undefined,
): StepEvents & { fire: (event: string, ...args: unknown[]) => void; count: () => number; emitted: unknown[][] } {
  const handlers = new Map<string, Set<(...a: unknown[]) => void>>();
  const emitted: unknown[][] = [];
  const fire = (event: string, ...args: unknown[]): void => {
    for (const h of [...(handlers.get(event) ?? [])]) h(...args);
  };
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
      emitted.push([event, ...args]);
      onEmit(event, args, fire);
    },
    fire,
    emitted,
    count: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
  };
}

const MIN = 60_000;
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

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
    existingArchive: async () => undefined,
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

describe("the planned file already in Downloads", () => {
  it("is installed from that archive, and Vortex is not asked to download it", async () => {
    // Vortex's downloadFile hands back an existing download's id and installs
    // nothing; asking it would have waited out the whole clock.
    const events = emitter((event, args, fire) => {
      if (event === "start-install-download") fire("did-install-mod", "skyrimse", args[0], "from-disk");
    });
    const download = vi.fn(async () => "dl-new");
    const result = await installRequirementStep(input({ events, download, existingArchive: async () => "dl-old" }));
    expect(result).toEqual({ ok: true, newModId: "from-disk", via: "existing-download" });
    expect(download).not.toHaveBeenCalled();
    expect(events.emitted[0]!.slice(0, 2)).toEqual(["start-install-download", "dl-old"]);
  });

  it("needs no Premium: a guided account installs from disk without opening the page", async () => {
    const events = emitter((event, _args, fire) => {
      if (event === "start-install-download") fire("did-install-mod", "skyrimse", "dl-old", "from-disk");
    });
    const openPage = vi.fn();
    const result = await installRequirementStep(
      input({ events, premium: false, openPage, existingArchive: async () => "dl-old" }),
    );
    expect(result).toMatchObject({ ok: true, via: "existing-download" });
    expect(openPage).not.toHaveBeenCalled();
  });

  it("reports Vortex's own refusal from the install callback instead of waiting it out", async () => {
    const events = emitter((event, args) => {
      if (event === "start-install-download") {
        const callback = args[2] as (err: Error | null) => void;
        queueMicrotask(() => callback(new Error("Download not finished (state: paused), cannot install")));
      }
    });
    const result = await installRequirementStep(input({ events, existingArchive: async () => "dl-old" }));
    expect(result).toMatchObject({ ok: false, why: "Download not finished (state: paused), cannot install" });
    expect(events.count()).toBe(0);
  });
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
    events.fire("did-install-mod", "skyrimse", "arc", "picked-on-page");

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
    const download = vi.fn(() => new Promise<string | undefined>(() => undefined));
    const promise = installRequirementStep(input({ events, signal: stop.signal, download }));
    await tick();
    expect(download).toHaveBeenCalled();
    stop.abort();
    events.fire("did-install-mod", "skyrimse", "arc", "landed");
    await expect(promise).resolves.toEqual({ ok: true, newModId: "landed", via: "download" });
  });

  it("keeps waiting in a guided step once a download for the page has appeared", async () => {
    const events = emitter();
    const stop = new AbortController();
    let ids: string[] = [];
    const promise = installRequirementStep(
      input({ events, premium: false, signal: stop.signal, pageDownloadIds: () => ids }),
    );
    await tick();
    ids = ["user-clicked"];
    stop.abort();
    events.fire("did-install-mod", "skyrimse", "arc", "landed");
    await expect(promise).resolves.toMatchObject({ ok: true, newModId: "landed", via: "guided" });
  });

  it("ends a guided wait at once while nothing has started", async () => {
    const events = emitter();
    const stop = new AbortController();
    const promise = installRequirementStep(input({ events, premium: false, signal: stop.signal }));
    await tick();
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
    await tick();
    stop.abort();
    refuse(undefined);
    await expect(promise).resolves.toMatchObject({ ok: false, stopped: true, refused: true });
    expect(openPage).not.toHaveBeenCalled();
  });
});
