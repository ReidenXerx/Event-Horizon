import { describe, expect, it } from "vitest";

import { annotateMasters, describeBasic, describeModuleConfig, publicDescription, renderDependencies } from "./installerDescribe";
import { parseXml } from "../manifest/miniXml";

/** A patch hub the way the owner met one: patches for mods Ivy has, and one for a mod it does not. */
const XML = `<?xml version="1.0" encoding="utf-8"?>
<config>
  <moduleName>Necessity Patch Hub</moduleName>
  <requiredInstallFiles><file source="core/NPH.esp" destination="NPH.esp"/></requiredInstallFiles>
  <installSteps>
    <installStep name="Game">
      <optionalFileGroups>
        <group name="F4SE" type="SelectExactlyOne">
          <plugins>
            <plugin name="OG">
              <description>For 1.10.163</description>
              <conditionFlags><flag name="ae">Off</flag></conditionFlags>
              <typeDescriptor><type name="Recommended"/></typeDescriptor>
            </plugin>
            <plugin name="AE">
              <conditionFlags><flag name="ae">On</flag></conditionFlags>
              <typeDescriptor><type name="Optional"/></typeDescriptor>
            </plugin>
          </plugins>
        </group>
      </optionalFileGroups>
    </installStep>
    <installStep name="Patches">
      <optionalFileGroups>
        <group name="Patches" type="SelectAny">
          <plugins>
            <plugin name="Faction Reinforcements">
              <files><file source="patches/FR/NPH_FR.esp" destination="NPH_FR.esp"/></files>
              <typeDescriptor>
                <dependencyType>
                  <defaultType name="Optional"/>
                  <patterns><pattern><dependencies><fileDependency file="FactionReinforcements.esp" state="Missing"/></dependencies><type name="NotUsable"/></pattern></patterns>
                </dependencyType>
              </typeDescriptor>
            </plugin>
            <plugin name="Loose textures">
              <files><folder source="patches/tex" destination="textures"/></files>
              <typeDescriptor><type name="Optional"/></typeDescriptor>
            </plugin>
            <plugin name="PRP">
              <files><folder source="patches/PRP" destination=""/></files>
              <typeDescriptor><type name="Optional"/></typeDescriptor>
            </plugin>
          </plugins>
        </group>
      </optionalFileGroups>
    </installStep>
    <installStep name="AE extras">
      <visible><flagDependency flag="ae" value="On"/></visible>
      <optionalFileGroups><group name="Extras" type="SelectAny"><plugins><plugin name="Nothing"><typeDescriptor><type name="Optional"/></typeDescriptor></plugin></plugins></group></optionalFileGroups>
    </installStep>
  </installSteps>
  <conditionalFileInstalls><patterns><pattern>
    <dependencies operator="And"><flagDependency flag="ae" value="On"/></dependencies>
    <files><file source="ae/NPH_AE.esp" destination="NPH_AE.esp"/></files>
  </pattern></patterns></conditionalFileInstalls>
</config>`;

const LISTING = [
  "Hub/fomod/ModuleConfig.xml",
  "Hub/core/NPH.esp",
  "Hub/patches/FR/NPH_FR.esp",
  "Hub/patches/tex/a.dds",
  "Hub/patches/tex/b.dds",
  "Hub/patches/PRP/NPH_PRP.esp",
  "Hub/patches/PRP/meshes/x.nif",
  "Hub/ae/NPH_AE.esp",
];

describe("describeModuleConfig", () => {
  const d = describeModuleConfig(XML, "Hub/fomod/ModuleConfig.xml", LISTING);

  it("reads the root inside a wrapper folder, the module, required files and their plugins", () => {
    expect(d).toMatchObject({ kind: "fomod", moduleName: "Necessity Patch Hub", root: "Hub", requiredFiles: { files: 1, plugins: ["NPH.esp"] } });
  });

  it("keeps descriptions, flags and option types, including a type that conditions change", () => {
    const og = d.steps[0]!.groups[0]!.options[0]!;
    expect(og).toMatchObject({ name: "OG", description: "For 1.10.163", type: "Recommended", flags: { ae: "Off" } });
    const fr = d.steps[1]!.groups[0]!.options[0]!;
    expect(fr.type).toBe("Optional");
    expect(fr.typeWhen).toEqual([{ when: '"FactionReinforcements.esp" is Missing', type: "NotUsable" }]);
  });

  it("names the plugins each option installs, expanding folders; a subfolder plugin does not load", () => {
    const [fr, tex, prp] = d.steps[1]!.groups[0]!.options;
    expect(fr).toMatchObject({ plugins: ["NPH_FR.esp"], files: 1 });
    expect(tex).toMatchObject({ plugins: [], files: 2 });
    expect(prp).toMatchObject({ plugins: ["NPH_PRP.esp"], files: 2 });
  });

  it("says when a step shows, and what a conditional install needs", () => {
    expect(d.steps[2]!.visibleWhen).toBe('flag "ae" is "On"');
    expect(d.conditionalInstalls).toEqual([expect.objectContaining({ when: 'flag "ae" is "On"', plugins: ["NPH_AE.esp"] })]);
  });

  it("keeps archive paths internal", () => {
    expect(JSON.stringify(publicDescription(d))).not.toContain("pluginEntries");
  });
});

describe("annotateMasters", () => {
  it("marks the option whose plugin needs a master nobody has: the Faction Reinforcements case", () => {
    const d = describeModuleConfig(XML, "Hub/fomod/ModuleConfig.xml", LISTING);
    const masters = new Map<string, string[]>([
      ["Hub/core/NPH.esp", ["Fallout4.esm"]],
      ["Hub/patches/FR/NPH_FR.esp", ["Fallout4.esm", "NPH.esp", "FactionReinforcements.esp"]],
      ["Hub/patches/PRP/NPH_PRP.esp", ["Fallout4.esm", "prp.esp", "NPH_AE.esp"]],
    ]);
    const out = annotateMasters(d, masters, new Set(["fallout4.esm", "prp.esp"]));
    const [fr, , prp] = out.steps[1]!.groups[0]!.options;
    expect(fr!.missingMasters).toEqual(["FactionReinforcements.esp"]);
    expect(prp!.missingMasters).toBeUndefined();
    expect(prp!.mastersFromOtherOptions).toEqual([{ master: "NPH_AE.esp", from: 'when flag "ae" is "On"' }]);
  });
});

describe("describeBasic / renderDependencies", () => {
  it("lists top-level folders and root plugins of a package with no FOMOD", () => {
    expect(describeBasic(["Main/Data/a.esp", "Optional/b.esp", "c.esp"])).toEqual({
      kind: "basic",
      topLevel: ["Main", "Optional"],
      files: 3,
      plugins: ["b.esp", "c.esp"],
    });
  });

  it("renders an Or with a nested group", () => {
    const node = parseXml(
      '<dependencies operator="Or"><flagDependency flag="a" value="1"/><dependencies><fileDependency file="x.esm" state="Active"/><gameDependency version="1.10"/></dependencies></dependencies>',
    );
    expect(renderDependencies(node)).toBe('flag "a" is "1" or ("x.esm" is Active and game version ≥ 1.10)');
  });
});
