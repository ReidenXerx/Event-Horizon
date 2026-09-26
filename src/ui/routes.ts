/**
 * Internal route table for the Event Horizon mainPage.
 *
 * We deliberately do NOT use `react-router` — Vortex hosts our page
 * inside its own electron-router and adding another router would
 * fight the host. Instead we use a tiny `useState`-backed route hook
 * (see `EventHorizonMainPage.tsx`).
 *
 * Routes are flat (no params) for Phase 5.0; the install wizard in
 * Phase 5.1 will overlay state on top of the `install` route via a
 * sub-state machine, not via URL segments.
 */

export type EventHorizonRoute =
  | "home"
  | "install"
  | "collections"
  | "doctor"
  | "build"
  | "curator"
  | "plugin-diffs"
  | "mod-diffs"
  | "agents"
  | "about";

export interface RouteDescriptor {
  id: EventHorizonRoute;
  label: string;
  description: string;
  /**
   * Vortex icon name (rendered via `<Icon name="..." />`). We pick
   * names that exist in Vortex's bundled icon set.
   */
  icon: string;
  /**
   * If true, the nav item is hidden until that route is feature-flagged
   * on. Used to soft-launch unfinished pages.
   */
  hidden?: boolean;
}

export const ROUTES: RouteDescriptor[] = [
  {
    id: "home",
    label: "Dashboard",
    description: "Overview, system status, and recent activity",
    icon: "home",
  },
  {
    id: "install",
    label: "Install",
    description: "Install an Event Horizon collection",
    icon: "download",
  },
  {
    id: "collections",
    label: "My Collections",
    description: "Installed collections and receipts",
    icon: "layers",
  },
  {
    id: "doctor",
    label: "Doctor",
    description: "Check an installed collection is still intact, and repair it",
    // UNVERIFIED: this is the one icon name here not confirmed against
    // Vortex's bundled set — that set could not be read on the machine this
    // was written on. If the nav item renders without a glyph, that is why;
    // any name already used above is known to work.
    icon: "health",
  },
  {
    id: "build",
    label: "Build",
    description: "Package your current setup as a collection",
    icon: "save",
  },
  {
    id: "curator",
    label: "Curator Tools",
    description: "Profile-wide actions: updates, freezes, endorsements, duplicates",
    // Same caveat as `doctor` above — not confirmed against Vortex's bundled
    // icon set. If the nav item renders without a glyph, that is why.
    icon: "tools",
  },
  {
    id: "plugin-diffs",
    label: "Plugin Diffs",
    description: "Review plugin comparison reports",
    icon: "compare",
  },
  {
    id: "mod-diffs",
    label: "Mod Diffs",
    description: "Review mod snapshot comparison reports",
    icon: "collection",
  },
  {
    id: "agents",
    label: "Agents",
    description: "Let AI agents on this PC drive Vortex (off until you turn it on)",
    icon: "settings",
  },
  {
    id: "about",
    label: "About",
    description: "About Event Horizon",
    icon: "about",
  },
];
