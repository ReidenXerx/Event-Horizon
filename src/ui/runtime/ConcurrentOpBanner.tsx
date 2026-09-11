/**
 * Inline banner shown at the top of a wizard when the OTHER pipeline
 * is currently running. Keeps the user informed without forbidding
 * the operation outright — they may know exactly what they're doing.
 */

import * as React from "react";

import { Callout } from "../components/Callout";
import { useEHRuntime } from "./useEHRuntime";

export type Pipeline = "build" | "install";

export interface ConcurrentOpBannerProps {
  /** Which pipeline this page is showing. We hide if it matches. */
  self: Pipeline;
}

export function ConcurrentOpBanner(
  props: ConcurrentOpBannerProps,
): JSX.Element | null {
  const { buildBusy, installBusy } = useEHRuntime();

  const otherBusy =
    (props.self === "build" && installBusy) ||
    (props.self === "install" && buildBusy);

  if (!otherBusy) return null;

  const otherLabel = props.self === "build" ? "install" : "build";

  return (
    <Callout
      tone="warning"
      title={`A ${otherLabel} is in progress on the other tab.`}
    >
      Both pipelines read Vortex state at the same time. You can continue, but a
      snapshot taken now may not match the disk once the {otherLabel} finishes.
    </Callout>
  );
}
