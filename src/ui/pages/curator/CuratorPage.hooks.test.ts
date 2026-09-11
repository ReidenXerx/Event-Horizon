/**
 * The curator page must call the same hooks, in the same order, on every
 * render — whether or not a game is active.
 *
 * React keys hook state by call position. A component that returns early
 * before some of its hooks renders fewer of them when the condition flips,
 * and React throws "Rendered fewer hooks than expected" — here, the moment
 * the active game toggles while the page is open (a profile switch from
 * Vortex's toolbar, a game being unmanaged).
 *
 * There is no DOM in this suite (no jsdom), so React's hooks are replaced by
 * a recorder that counts calls per render, the way React's own dispatcher
 * checks them. The component function is called directly; nothing is mounted.
 */

import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  api: undefined as unknown,
}));

vi.mock("react", async (importOriginal) => {
  const R = await importOriginal<typeof import("react")>();
  const next = (): number => h.cursor++;
  const hooks = {
    useState: (init: unknown) => {
      const k = next();
      if (!(k in h.slots)) h.slots[k] = typeof init === "function" ? (init as () => unknown)() : init;
      return [h.slots[k], (v: unknown) => {
        h.slots[k] = typeof v === "function" ? (v as (p: unknown) => unknown)(h.slots[k]) : v;
      }];
    },
    useMemo: (fn: () => unknown) => {
      next();
      return fn();
    },
    useCallback: (fn: unknown) => {
      next();
      return fn;
    },
    useRef: (init: unknown) => {
      const k = next();
      if (!(k in h.slots)) h.slots[k] = { current: init };
      return h.slots[k];
    },
    useEffect: () => {
      next();
    },
    useLayoutEffect: () => {
      next();
    },
    useContext: () => {
      next();
      return h.api;
    },
  };
  const merged = { ...R, ...hooks };
  return { ...merged, default: merged };
});

import { CuratorPanel } from "./CuratorPage";

/** One render: the number of hooks the component called. */
function hooksCalled(component: (props: object) => unknown): number {
  h.cursor = 0;
  component({});
  return h.cursor;
}

describe("CuratorPage hook order", () => {
  it("calls the same number of hooks with and without an active game", () => {
    let state: unknown = {
      settings: { profiles: { activeProfileId: "p1", activeGameId: "skyrimse" } },
      persistent: {
        profiles: { p1: { gameId: "skyrimse", modState: {} } },
        mods: { skyrimse: { a: { id: "a", attributes: { name: "A" }, type: "" } } },
        downloads: { files: {} },
      },
    };
    h.api = { getState: () => state, store: { dispatch: () => undefined } };
    // CuratorPanel renders <CuratorBody/>; its `type` is the page component.
    const body = (CuratorPanel() as unknown as { type: (props: object) => unknown }).type;

    const withGame = hooksCalled(body);
    // Vortex stops managing a game while the page is open.
    state = {};
    const withoutGame = hooksCalled(body);
    // …and the game comes back.
    state = {
      settings: { profiles: { activeProfileId: "p1", activeGameId: "skyrimse" } },
      persistent: { profiles: { p1: { gameId: "skyrimse", modState: {} } }, mods: { skyrimse: {} }, downloads: { files: {} } },
    };
    const again = hooksCalled(body);

    expect(withGame).toBeGreaterThan(10);
    expect(withoutGame).toBe(withGame);
    expect(again).toBe(withGame);
  });
});
