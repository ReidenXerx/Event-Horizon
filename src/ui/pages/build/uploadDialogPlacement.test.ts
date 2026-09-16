/**
 * The Nexus upload dialog is rendered BESIDE the Done card, never inside it.
 *
 * `.eh-card` is `position: relative` and a Modal is positioned against its
 * nearest positioned ancestor. Rendered inside the Done card, the dialog was
 * centred in a card thousands of pixels tall, below the fold, with page
 * scrolling locked by the modal: the curator pressed "Upload to Nexus…" and saw
 * a blurred page with nothing on it. The render harness photographs the dialog
 * on its own, so every screenshot looked right while the real page was broken.
 *
 * This renders the real Done panel with the dialog open and checks where the
 * backdrop landed in the markup.
 */
import { EventEmitter } from "events";

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DonePanel } from "./BuildPage";
import { ApiProvider } from "../../state/ApiContext";
import { ToastProvider } from "../../components/Toast";

/** [start, end) of the first `<div>` whose class list contains `className`. */
function divSpan(html: string, className: string): [number, number] | undefined {
  const open = new RegExp(`<div[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>`);
  const match = open.exec(html);
  if (match === null) return undefined;
  let depth = 0;
  const tag = /<div\b[^>]*>|<\/div>/g;
  tag.lastIndex = match.index;
  for (let m = tag.exec(html); m !== null; m = tag.exec(html)) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return [match.index, m.index + m[0].length];
  }
  return undefined;
}

const result = {
  outputPath: "C:/Users/x/AppData/Roaming/Vortex/event-horizon/collections/ivy-panties-1.0.29.zip",
  outputBytes: 871_800_000,
  outputSha256: "a".repeat(64),
  bundledCount: 11,
  modCount: 977,
  warnings: [],
  ruleCount: 0,
  loadOrderCount: 0,
  pluginOrderCount: 0,
  userlistPluginCount: 0,
  userlistGroupCount: 0,
  verificationLevel: "thorough",
  stagingFileCount: 0,
  postProcessingCandidates: [],
};

function render(initialUploadOpen: boolean): string {
  const api = { events: new EventEmitter(), getState: () => ({}) };
  return renderToStaticMarkup(
    React.createElement(ApiProvider, {
      api: api as never,
      children: React.createElement(ToastProvider, {
        children: React.createElement(DonePanel, {
          result: result as never,
          onBuildAnother: () => undefined,
          onGoHome: () => undefined,
          initialUploadOpen,
        }),
      } as never),
    } as never),
  );
}

describe("where the Nexus upload dialog is rendered", () => {
  it("opens beside the Done card, so it centres on the page rather than in the card", () => {
    const html = render(true);
    const card = divSpan(html, "eh-card");
    const backdrop = html.indexOf("eh-modal-backdrop");
    expect(card, "the Done card was not rendered").toBeDefined();
    expect(backdrop, "the upload dialog was not rendered").toBeGreaterThan(-1);
    const [start, end] = card!;
    expect(backdrop < start || backdrop >= end, "the upload dialog is inside the card").toBe(true);
  });

  it("is absent until asked for", () => {
    expect(render(false)).not.toContain("eh-modal-backdrop");
  });
});
