import { describe, expect, it } from "vitest";
import type { types } from "vortex-api";

import { describePickCountProblem, pickCountProblems, type FomodDescription } from "./installerDescribe";
import { keepPluginsOff } from "./verbs";

// Fallout-collection, 2026-11-06: Vehicle Overhaul Continued 1.3.3, "Previs Plugins" answered with [].
const opt = (name: string, type: string, typeNow?: string) => ({
  name,
  type,
  ...(typeNow !== undefined ? { typeNow } : {}),
  flags: {},
  files: 1,
  plugins: [],
});
const voc: FomodDescription = {
  kind: "fomod",
  root: "",
  requiredFiles: { files: 0, plugins: [] },
  conditionalInstalls: [],
  steps: [
    { index: 0, name: "Main Files", groups: [{ name: "Plugins", type: "SelectExactlyOne", options: [opt("Vehicle Overhaul Continued", "Recommended")] }] },
    {
      index: 1,
      name: "Previs",
      groups: [
        {
          name: "Previs Plugins",
          type: "SelectExactlyOne",
          options: [opt("Bethesda Previs", "Optional", "Optional"), opt("PRP v81 Previs", "NotUsable", "Recommended")],
        },
      ],
    },
    { index: 2, name: "Hidden", visibleWhen: 'flag "X" is "On"', groups: [{ name: "Only One", type: "SelectExactlyOne", options: [opt("A", "Optional")] }] },
    { index: 3, name: "Extras", groups: [{ name: "Pick one or none", type: "SelectAtMostOne", options: [opt("B", "Optional"), opt("C", "Optional")] }] },
  ],
};

describe("pickCountProblems", () => {
  it("refuses an empty answer to an exactly-one group and names each option's type on this setup", () => {
    const p = pickCountProblems(voc, [
      { step: "Main Files", group: "Plugins", options: ["Vehicle Overhaul Continued"] },
      { step: "Previs", group: "Previs Plugins", options: [] },
    ]);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ step: "Previs", group: "Previs Plugins", got: 0 });
    const text = describePickCountProblem(p[0]!);
    expect(text).toContain('"PRP v81 Previs" (Recommended)');
    expect(text).toContain("exactly one option; got 0");
  });

  it("finds the group without a step name, and checks at-most-one groups", () => {
    const p = pickCountProblems(voc, [
      { group: "previs plugins", options: ["Bethesda Previs", "PRP v81 Previs"] },
      { group: "Pick one or none", options: ["B", "C"] },
      { group: "Pick one or none", options: [] },
    ]);
    expect(p.map((x) => `${x.group}:${x.got}`)).toEqual(["Previs Plugins:2", "Pick one or none:2"]);
  });

  it("leaves steps that may never show, and numeric picks, to the wizard", () => {
    expect(pickCountProblems(voc, [{ step: "Hidden", group: "Only One", options: [] }])).toEqual([]);
    expect(pickCountProblems(voc, [{ step: 1, group: "Previs Plugins", options: [] }])).toEqual([]);
    expect(pickCountProblems(voc, [{ group: 4, options: [] }])).toEqual([]);
  });
});

describe("keepPluginsOff", () => {
  it("unticks again only the restored mod's plugins that were off before the install", async () => {
    const state = {
      session: {
        plugins: {
          pluginList: {
            "voc.esp": { modId: "voc-132" },
            "voc_previs.esp": { modId: "voc-132" },
            "voc_pond.esp": { modId: "voc-132" },
            "other.esp": { modId: "other" },
          },
        },
      },
      loadOrder: {
        "voc.esp": { name: "VOC.esp", enabled: true },
        "voc_previs.esp": { name: "VOC_Previs.esp", enabled: true },
        "voc_pond.esp": { name: "VOC_Pond.esp", enabled: false },
        "other.esp": { name: "Other.esp", enabled: true },
      } as Record<string, { name: string; enabled: boolean }>,
    };
    const api = {
      getState: () => state,
      store: {
        dispatch: (a: { type: string; payload: { pluginName: string; enabled: boolean } }) => {
          if (a.type === "SET_PLUGIN_ENABLED") state.loadOrder[a.payload.pluginName.toLowerCase()]!.enabled = a.payload.enabled;
        },
      },
    } as unknown as types.IExtensionApi;
    const before = { "voc.esp": true, "voc_previs.esp": false, "voc_pond.esp": false, "other.esp": false };
    const kept = await keepPluginsOff(api, ["voc-132"], before, 0);
    expect(kept).toEqual(["VOC_Previs.esp"]);
    expect(state.loadOrder["voc_previs.esp"]!.enabled).toBe(false);
    expect(state.loadOrder["voc.esp"]!.enabled).toBe(true);
    // Not a restored mod: left as it is now.
    expect(state.loadOrder["other.esp"]!.enabled).toBe(true);
  });
});
