/**
 * Which plugins does this installer ask the game about?
 *
 * ─── THE RUN THIS COMES FROM ────────────────────────────────────────────────
 * Eleven identical failures across every tester log, one mod, mod 801 of 979:
 *
 *   AAF_VanillaKinkyCreatureAnimations_Themes
 *   "Installer Prerequisits not fulfilled:
 *    File 'aaf.esm' is Active OR File 'aaf.esp' is Active"
 *
 * AAF is IN the collection. The mod failed only because it installed before
 * AAF's plugin was active — a coin toss decided by manifest position.
 *
 * ─── WHY PARSING THIS IS THE FIX AND THE RETRY IS NOT ───────────────────────
 * `<moduleDependencies>` refuses, loudly, so the retry pass catches it. The
 * same `<fileDependency>` inside a step's `<visible>` or in
 * `<conditionalFileInstalls>` does not refuse — it takes a DIFFERENT BRANCH
 * and installs a different file set, with no failure and therefore no retry.
 *
 * That is not hypothetical. Read out of Vortex's shipped bundle:
 * `getAllPlugins(activeOnly)` is registered unconditionally on every FOMOD
 * install and reads `loadOrder[name].enabled`, and `choices` is one argument
 * among six with no flag that disables condition evaluation. Pre-filling the
 * curator's answers does NOT skip the conditions.
 *
 * So the build has to see them. Before this, `<moduleDependencies>` was never
 * parsed at all — zero references in the whole tree — and the one place a
 * `<fileDependency>` was noticed threw the FILENAME away, keeping the literal
 * string "fileDependency" so the replay could exclude that pattern.
 */
import { describe, expect, it } from "vitest";

import { parseModuleConfig } from "./parseModuleConfig";

const parse = async (xml: string) =>
  (await parseModuleConfig(xml)).script.pluginStateDependencies;

describe("plugins a FOMOD script asks the game about", () => {
  it("finds the real one: an Or of two prerequisites", async () => {
    /**
     * The exact shape from the tester logs. `moduleDependencies` was invisible
     * to this parser, and the nested `<dependencies operator="Or">` means a
     * flat scan of the top level would have found nothing either.
     */
    const deps = await parse(`<config>
      <moduleDependencies operator="And">
        <dependencies operator="Or">
          <fileDependency file="aaf.esm" state="Active"/>
          <fileDependency file="aaf.esp" state="Active"/>
        </dependencies>
      </moduleDependencies>
      <requiredInstallFiles><folder source="core" destination=""/></requiredInstallFiles>
    </config>`);

    expect(deps).toEqual(["aaf.esm", "aaf.esp"]);
  });

  it("finds one hiding a step, which never fails and never retries", async () => {
    // The silent class. The step is simply not shown, its files are not
    // installed, nothing throws, and verification later reports the mod as
    // "could not be reproduced" while blaming the archive.
    const deps = await parse(`<config>
      <installSteps order="Explicit">
        <installStep name="Patches">
          <visible>
            <fileDependency file="Skyrim.esm" state="Active"/>
          </visible>
          <optionalFileGroups order="Explicit">
            <group name="G" type="SelectAny"><plugins order="Explicit">
              <plugin name="P"><files><folder source="p" destination=""/></files></plugin>
            </plugins></group>
          </optionalFileGroups>
        </installStep>
      </installSteps>
    </config>`);

    expect(deps).toEqual(["skyrim.esm"]);
  });

  it("finds one in a conditional install, whose NAME was being discarded", async () => {
    const deps = await parse(`<config>
      <conditionalFileInstalls><patterns>
        <pattern>
          <dependencies><fileDependency file="Dawnguard.esm" state="Active"/></dependencies>
          <files><folder source="dg" destination=""/></files>
        </pattern>
      </patterns></conditionalFileInstalls>
    </config>`);

    expect(deps).toEqual(["dawnguard.esm"]);
  });

  it("finds one in a plugin's typeDescriptor", async () => {
    // Changes Required / Recommended / NotUsable, so it changes what a
    // pre-filled answer even means.
    const deps = await parse(`<config>
      <installSteps order="Explicit">
        <installStep name="S">
          <optionalFileGroups order="Explicit">
            <group name="G" type="SelectAny"><plugins order="Explicit">
              <plugin name="P">
                <files><folder source="p" destination=""/></files>
                <typeDescriptor><dependencyType>
                  <patterns><pattern>
                    <dependencies><fileDependency file="Update.esm" state="Active"/></dependencies>
                    <type name="Recommended"/>
                  </pattern></patterns>
                </dependencyType></typeDescriptor>
              </plugin>
            </plugins></group>
          </optionalFileGroups>
        </installStep>
      </installSteps>
    </config>`);

    expect(deps).toEqual(["update.esm"]);
  });

  it("says nothing for the overwhelming majority, which ask nothing", async () => {
    /**
     * Most mods have no conditions at all, and a field that is present on
     * every entry of a 950-mod manifest is 950 lines saying nothing. Empty
     * here is what keeps it off them.
     */
    const deps = await parse(`<config>
      <requiredInstallFiles><folder source="core" destination=""/></requiredInstallFiles>
      <installSteps order="Explicit">
        <installStep name="S">
          <optionalFileGroups order="Explicit">
            <group name="G" type="SelectAny"><plugins order="Explicit">
              <plugin name="P"><files><folder source="p" destination=""/></files></plugin>
            </plugins></group>
          </optionalFileGroups>
        </installStep>
      </installSteps>
    </config>`);

    expect(deps).toEqual([]);
  });

  it("ignores a dependency on a LOOSE file, which ordering cannot help", async () => {
    /**
     * A dependency on a script or a texture is satisfied by EXTRACTION, which
     * has already happened for anything installed before this mod. Only a
     * plugin has an activation step that install order can get wrong, so
     * deferring a mod for a loose-file dependency would buy nothing and cost
     * it a place in the second pass.
     */
    const deps = await parse(`<config>
      <moduleDependencies>
        <fileDependency file="Scripts/foo.pex" state="Active"/>
        <fileDependency file="textures/bar.dds" state="Missing"/>
      </moduleDependencies>
    </config>`);

    expect(deps).toEqual([]);
  });

  it("does not care WHICH state is required", async () => {
    // Active, Inactive and Missing all mean the same thing for this question:
    // the answer depends on WHEN the mod installs.
    const deps = await parse(`<config>
      <moduleDependencies>
        <fileDependency file="A.esm" state="Active"/>
        <fileDependency file="B.esp" state="Inactive"/>
        <fileDependency file="C.esl" state="Missing"/>
      </moduleDependencies>
    </config>`);

    expect(deps).toEqual(["a.esm", "b.esp", "c.esl"]);
  });

  it("deduplicates and sorts, so the manifest field is stable", async () => {
    // It is written into a package and diffed between builds; an unstable
    // order would report a change the curator did not make.
    const deps = await parse(`<config>
      <moduleDependencies>
        <fileDependency file="zeta.esm" state="Active"/>
        <fileDependency file="Alpha.esm" state="Active"/>
        <fileDependency file="ALPHA.ESM" state="Active"/>
      </moduleDependencies>
    </config>`);

    expect(deps).toEqual(["alpha.esm", "zeta.esm"]);
  });
});
