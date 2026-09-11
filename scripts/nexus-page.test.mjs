/**
 * The page writer's two contracts with the curator's browser and the page:
 * it works in a tab of its own (the first version navigated whichever tab the
 * browser listed first), and "verified" means the page holds the same text
 * (it used to mean the lengths were within 64 characters). No browser here:
 * the DevTools HTTP endpoint is a fake that throws on anything unexpected.
 */
import { describe, expect, it } from "vitest";

import { firstDifference, withNewTab } from "./nexus-page.mjs";

function fakeDevtools() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    calls.push(`${method} ${u.pathname}${u.search}`);
    if (u.pathname === "/json/list") {
      return new Response(JSON.stringify([{ id: "USER-TAB", type: "page", url: "https://mail.example/inbox", webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/USER-TAB" }]));
    }
    if (u.pathname === "/json/new" && method === "PUT") {
      return new Response(JSON.stringify({ id: "NEW-TAB", type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/NEW-TAB" }));
    }
    if (u.pathname === "/json/close/NEW-TAB") return new Response("Target is closing");
    return new Response("unexpected", { status: 404 });
  };
  return { fetchImpl, calls };
}

describe("withNewTab", () => {
  it("opens its own tab, never one of the user's, and closes it afterwards", async () => {
    const { fetchImpl, calls } = fakeDevtools();
    const used = await withNewTab({ base: "http://127.0.0.1:9222", fetchImpl }, async (tab) => tab.id);
    expect(used).toBe("NEW-TAB");
    expect(calls).toEqual(["PUT /json/new?about:blank", "GET /json/close/NEW-TAB"]);
  });

  it("closes the tab when the work fails", async () => {
    const { fetchImpl, calls } = fakeDevtools();
    await expect(
      withNewTab({ base: "http://127.0.0.1:9222", fetchImpl }, async () => {
        throw new Error("not on the edit page");
      }),
    ).rejects.toThrow(/not on the edit page/);
    expect(calls).toContain("GET /json/close/NEW-TAB");
  });

  it("says so when the tab could not be closed", async () => {
    const warnings = [];
    const fetchImpl = async (url, init = {}) =>
      new URL(url).pathname === "/json/new" && init.method === "PUT"
        ? new Response(JSON.stringify({ id: "NEW-TAB", webSocketDebuggerUrl: "ws://x" }))
        : new Response("gone", { status: 500 });
    await withNewTab({ base: "http://127.0.0.1:9222", fetchImpl, warn: (m) => warnings.push(m) }, async () => undefined);
    expect(warnings).toEqual(["Could not close the tab this script opened (HTTP 500); close it by hand."]);
  });
});

describe("firstDifference", () => {
  const written = "[size=5]Event Horizon[/size]\nInstall 0.1.152 first.\n[list]\n[*]one\n[/list]\n";

  it("accepts the same text with other line endings and trailing whitespace", () => {
    expect(firstDifference(written, written.replace(/\n/g, "\r\n").replace("first.", "first.  "))).toBeUndefined();
  });

  it("names the line of a one-character change that leaves the length the same", () => {
    expect(firstDifference(written, written.replace("0.1.152", "0.1.153"))).toEqual({
      line: 2,
      expected: "Install 0.1.152 first.",
      actual: "Install 0.1.153 first.",
    });
  });

  it("catches text missing from the end", () => {
    expect(firstDifference(written, "[size=5]Event Horizon[/size]\nInstall 0.1.152 first.\n[list]\n[*]one")).toEqual({
      line: 5,
      expected: "[/list]",
      actual: "(end of text)",
    });
  });
});
