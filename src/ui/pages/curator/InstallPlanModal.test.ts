/**
 * The preview says, before anything downloads, when the plan will leave the
 * mod it was opened for disabled.
 */
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { InstallPlan, PlannedFile, PlannedInstall } from "../../../core/curator/installPlan";
import { InstallPlanModal } from "./InstallPlanModal";

const noop = (): void => undefined;
const step: PlannedInstall = {
  key: "skyrimspecialedition:1",
  name: "Needs A File",
  nexusModId: 1,
  gameDomain: "skyrimspecialedition",
  vortexGameId: "skyrimse",
  neededBy: ["Root Mod"],
  depth: 1,
};
const plan: InstallPlan = { steps: [step], toEnable: [], external: [], unfetched: [], truncated: false };

function render(files: PlannedFile[], enablesAfter?: string[]): string {
  return renderToStaticMarkup(
    React.createElement(InstallPlanModal, {
      open: true,
      rootName: "Root Mod",
      plan,
      files,
      picked: {},
      onPick: noop,
      onOpenPage: noop,
      onConfirm: noop,
      onClose: noop,
      ...(enablesAfter === undefined ? {} : { enablesAfter }),
    }),
  );
}

describe("InstallPlanModal", () => {
  it("names the mod that will stay disabled, and why", () => {
    const html = render([{ step, choice: { kind: "none" } }], ["Root Mod"]);
    expect(html).toContain("Root Mod will stay disabled after this runs, because no file to install for Needs A File");
  });

  it("still names the gap when the plan was not opened from Enable", () => {
    const html = render([{ step, choice: { kind: "none" } }]);
    expect(html).toContain("This plan leaves gaps: no file to install for Needs A File");
  });

  it("warns about nothing when the plan covers the chain", () => {
    const html = render([{ step, choice: { kind: "one", file: { file_id: 5, name: "Main" } } }], ["Root Mod"]);
    expect(html).not.toContain("stay disabled");
    expect(html).not.toContain("leaves gaps");
  });
});
