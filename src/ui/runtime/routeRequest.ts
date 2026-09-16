/**
 * A route Event Horizon should open, asked for from OUTSIDE React.
 *
 * ─── WHY THIS EXISTS ───────────────────────────────────────────────────
 * The shell's route is local React state (`AppShell`'s `useState`), so
 * anything outside the component tree can put Event Horizon's page in front
 * of the user but cannot say WHICH page. The collection interceptor is
 * exactly that: it runs inside Vortex's installer callback, hands the archive
 * to the install session, brings our page forward — and without this, lands
 * the user on Home while an install loads invisibly behind it.
 *
 * ─── WHY IT IS ONE-SHOT ────────────────────────────────────────────────
 * `take()` clears as it reads. A request is an instruction to navigate ONCE,
 * not a mode: leaving it set would drag the user back to the same page every
 * time the shell re-rendered or remounted, and a navigation the user cannot
 * escape is worse than one that never happened.
 *
 * Deliberately NOT folded into {@link getEHRuntime}: that tracks whether a
 * build or install is busy, and a boolean "are we working" is a different
 * thing from "go here next". Sharing one object would make both meanings
 * vaguer for the sake of one fewer file.
 */

import type { EventHorizonRoute } from "../routes";

export type RouteRequestListener = (route: EventHorizonRoute) => void;

class RouteRequest {
  private pending: EventHorizonRoute | undefined;
  private readonly listeners = new Set<RouteRequestListener>();

  /**
   * Ask for a route.
   *
   * Notifies a mounted shell immediately AND holds the request, because the
   * caller cannot know whether Event Horizon's page exists yet: the
   * interceptor may fire while the user has never opened our page this
   * session, in which case the shell mounts afterwards and reads it then.
   */
  request(route: EventHorizonRoute): void {
    this.pending = route;
    for (const listener of this.listeners) {
      try {
        listener(route);
      } catch {
        /* one bad subscriber must not swallow the navigation for the rest */
      }
    }
  }

  /** The pending route, cleared as it is read. Undefined when there is none. */
  take(): EventHorizonRoute | undefined {
    const route = this.pending;
    this.pending = undefined;
    return route;
  }

  /**
   * Called for requests made while the shell is already mounted. The returned
   * function unsubscribes; the listener does NOT clear the request, so a
   * shell that remounts mid-flight still finds it with `take()`.
   */
  subscribe(listener: RouteRequestListener): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }
}

let singleton: RouteRequest | undefined;

export function getRouteRequest(): RouteRequest {
  if (singleton === undefined) singleton = new RouteRequest();
  return singleton;
}
