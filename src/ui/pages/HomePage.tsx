/**
 * Event Horizon home.
 *
 * ─── WHAT THIS USED TO BE ───────────────────────────────────────────────
 * A status strip, three cards that linked to other pages, and two lists that
 * repeated what those pages already showed. It navigated; it measured
 * nothing. Everything a player might want to know about the collection they
 * are about to launch — is it whole, does it still match what was installed,
 * will its script-extender plugins load on this game — lived one or two
 * clicks away, on screens nobody opens unless something has already broken.
 *
 * It is now a dashboard: the collection's own artwork, the numbers that
 * describe it, and one button to play it, with the curator's side behind a
 * switch (owner, 2026-09-22).
 *
 * The work is split so the screen can be photographed without Vortex:
 *   - `DashboardView`     — presentational, takes a finished view model
 *   - `useDashboardView`  — the sources, and `toViewModel`, which is pure
 *   - `DashboardPage`     — the container: state, Vortex, disk, Nexus
 */

import * as React from "react";

import { ErrorBoundary, useErrorReporterFormatted } from "../errors";
import { DashboardPage } from "./dashboard/DashboardPage";
import type { EventHorizonRoute } from "../routes";

export interface HomePageProps {
  onNavigate: (route: EventHorizonRoute) => void;
}

export function HomePage(props: HomePageProps): JSX.Element {
  const reportFormatted = useErrorReporterFormatted();
  return (
    <ErrorBoundary where="HomePage" variant="page" onReport={reportFormatted}>
      <DashboardPage onNavigate={props.onNavigate} />
    </ErrorBoundary>
  );
}
