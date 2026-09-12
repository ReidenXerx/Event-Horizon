/**
 * Render the real UI to static HTML so it can be LOOKED AT.
 *
 * Not a test — a rendering harness that happens to live under vitest, because
 * vitest is the only place `@nexusmods/vortex-api` resolves (to the stub) and
 * therefore the only place these components can be imported at all outside a
 * running Vortex.
 *
 * Every screen is RENDERED on every `vitest run` — a screen that throws is a
 * screen nobody can look at, and four of them had rotted that way unnoticed
 * because the whole file used to be skipped without EH_RENDER. Writing the
 * HTML to disk is the only part that stays opt-in:
 *
 *   EH_RENDER=1 EH_RENDER_OUT=.scratch-render/ui npx vitest run src/ui/__render__/renderScreens.test.ts
 *   node scripts/ui/screenshot-screens.mjs .scratch-render/ui .scratch-render/shots
 *
 * (`npm run ui:shots` does both.) Then read the images. The data
 * below is modelled on the real 963-mod Fallout 4 collection rather than
 * invented, because a screen that looks calm with three mods is exactly how
 * this UI's problems stayed invisible.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, it } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The SAME stylesheet the extension ships, in the same order. The harness used
// to concatenate the modules itself and put utilities BEFORE components, so a
// utility that overrides a component's spacing won in Vortex and lost here —
// and a screenshot then showed a layout the user never sees.
import { COMBINED_CSS } from "../theme/EventHorizonStyles";
import {
  ConfirmStep,
  DecisionsStep,
  DoneStep,
  InstallingStep,
  LinkFetchingStep,
  LinkManualStep,
  LoadingStep,
  PickStep,
  PreviewStep,
} from "../pages/install/steps";
import { AboutPage } from "../pages/AboutPage";
import { ApiProvider } from "../state/ApiContext";
import { ToastProvider } from "../components/Toast";
import {
  AvailabilityPanel,
  BuildDiffView,
  DecisionsGate,
  DonePanel,
  FormPanel,
} from "../pages/build/BuildPage";
import { summarizeAvailability } from "../../core/build/nexusAvailability";
import { DraftCard, PublishedCard, RecentlyBuiltCard } from "../pages/build/BuildDashboard";
import { DashboardBody, Hero } from "../pages/HomePage";
import {
  FailedAttempts,
  InterruptedInstalls,
} from "../pages/CollectionsPage";
import { DoctorPanel } from "../pages/doctor/DoctorPanel";
import { CuratorPanel } from "../pages/curator/CuratorPage";
import { RequirementsPanel } from "../pages/curator/RequirementsPanel";
import { DiskCleanupView } from "../pages/curator/DiskCleanupView";
import { PluginsView } from "../pages/curator/PluginsView";
import { InstallPlanModal } from "../pages/curator/InstallPlanModal";
import { LoadOrderCard } from "../pages/doctor/LoadOrderCard";
import { assessLoadOrder, previewRepin } from "../../core/doctor/loadOrderStatus";
import { DownloadsView } from "../pages/curator/DownloadsView";
import { planCleanup } from "../../core/curator/cleanupPlan";
import { buildPluginRows, pluginCapabilityFor, type PluginHeader } from "../../core/curator/pluginView";
import { readPluginList } from "../../core/curator/pluginPool";
import { readDownloads } from "../../core/curator/runCleanup";
import { getCuratorSession } from "../pages/curator/curatorSession";
import { readCuratorMods, readEnabledModIds } from "../../core/curator/readProfile";
import {
  addMasterRequirements,
  makeModUid,
  nexusDomainOf,
  resolveNexusRequirements,
  uidsFor,
} from "../../core/curator/requirements";
import { evaluateHealth, healingBlockedReason } from "../../core/doctor/health";

/**
 * Where the rendered screens land.
 *
 * This was an absolute path hardcoded to one machine, one user and one agent
 * session id — so it wrote nowhere useful for anybody else, and it carried the
 * project's old name long after the rename. Set `EH_RENDER_OUT` to steer it;
 * otherwise it goes to a per-run temp directory, which is right for a harness
 * whose output you look at once.
 */
const OUT =
  process.env.EH_RENDER_OUT ??
  path.join(os.tmpdir(), "event-horizon-render", "ui");

const CSS = COMBINED_CSS;

/**
 * The real tree nests every page inside `.eh-app > .eh-app__inner >
 * .eh-app__main` (EventHorizonMainPage), and that wrapper carries the base
 * typography, background and content width. Rendering a step without it
 * produces unstyled dark-on-dark text that says nothing about the real UI —
 * which is exactly what the first attempt at this harness captured.
 */
const page = (title: string, body: string): string => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>${CSS}</style>
<style>
  html,body{margin:0;background:var(--eh-void);}
  /* Animations would capture mid-flight and make every screenshot differ.
     They are jumped to their END rather than removed: removing them also
     removed the transform an entrance animation leaves behind, and the
     screenshots then certified a modal layout Vortex never draws. */
  *,*::before,*::after{animation-delay:-60s !important;transition:none !important;}
  /* .eh-stagger > * starts at opacity:0 and is revealed BY its animation.
     Killing animations above left every staggered child invisible - which
     photographed as a large empty band where the quick-action cards are, and
     read as a missing UI section rather than a harness artefact. */
  .eh-stagger > *{opacity:1 !important;}

  /* The shell is position:absolute + inset:0 + overflow:hidden because Vortex
     renders it into a positioned pane, and eh-app__main scrolls inside it.
     A screenshot of that captures one viewport and CLIPS the rest - which is
     what the first attempts here produced: a Done screen that looked four
     cards long because everything past the fold was cut, not laid out.
     Unpinning it lets the page grow so a tall window photographs all of it.
     (No backticks in here: this whole block lives inside a template literal,
     and one backtick silently ends the string.) */
  .eh-app{position:static !important;inset:auto !important;height:auto !important;
          overflow:visible !important;}
  .eh-app__inner,.eh-app__main{height:auto !important;max-height:none !important;
          overflow:visible !important;}
  /* Modal sizes itself as calc(100% - 32px) of the backdrop, and the backdrop
     is absolute:inset-0 inside .eh-app. With height:auto above, that resolves
     against the PAGE CONTENT rather than the window, so a modal renders
     clipped here and fine in Vortex. Give it a realistic window height so the
     screenshot shows what the user sees, not what the harness did. */
  .eh-app{min-height:780px !important;}
</style>
</head><body>
<div class="eh-app"><div class="eh-app__inner"><main class="eh-app__main">
${body}
</main></div></div>
</body></html>`;

const WRITE = process.env.EH_RENDER === "1";

/**
 * The providers every page has above it in Vortex (EventHorizonMainPage). A
 * screen that reaches for `useApi()` or `useToast()` — the Play button does —
 * throws without them, and it did: three screens were unrenderable for weeks.
 * A screen may wrap itself in a richer ApiProvider; the inner one wins.
 */
const fakeApi = {
  getState: (): unknown => ({}),
  store: { dispatch: (): undefined => undefined },
  events: { on: (): undefined => undefined, emit: (): undefined => undefined },
} as never;

const shell = (node: React.ReactElement): React.ReactElement =>
  React.createElement(ApiProvider, {
    api: fakeApi,
    children: React.createElement(ToastProvider, { children: node }),
  });

/** What the providers render on their own: a screen must add to this. */
const HOST_ONLY = renderToStaticMarkup(shell(React.createElement(React.Fragment)));

const write = (name: string, node: React.ReactElement): void => {
  const html = renderToStaticMarkup(shell(node));
  // Rendering is the check. The providers always emit the toast host, so an
  // empty-string test could never fire; compare against the host alone.
  if (html === HOST_ONLY) throw new Error(`${name}: rendered nothing`);
  if (!WRITE) return;
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${name}.html`), page(name, html), "utf8");
};

// ── data modelled on the real collection ────────────────────────────────
const manifest = {
  package: { id: "pkg", name: "Ivy 2", version: "1.0.10" },
  game: { id: "fallout4", version: "1.10.163.0" },
  // 115 of them carry FOMOD answers, as the real collection does — the screen
  // has to warn that Vortex will stop and ask.
  // 112 replayable + 3 that recorded an installer but answered nothing —
  // the real 963-mod split. The 3 ask the user in BOTH modes, so the copy has
  // to account for them and the fixture has to contain them.
  mods: Array.from({ length: 963 }, (_, i) => ({
    name: `Mod ${i}`,
    install:
      i < 112
        ? { fomodSelections: [{ name: "step", groups: [{ name: "g", choices: [{ name: "c", idx: 1 }] }] }] }
        : i < 115
          ? { fomodSelections: [{ name: "step", groups: [{ name: "g", choices: [] }] }] }
          : {},
  })),
  plugins: { order: Array.from({ length: 817 }, (_, i) => ({ name: `p${i}.esp` })) },
  rules: Array.from({ length: 291 }, () => ({})),
};

/**
 * The full PreviewBundle shape, not a convenient subset.
 *
 * Built from the type rather than by adding fields until the render stopped
 * throwing: a partial mock renders a screen that is missing whatever the
 * missing field drives, and that absence looks like a UI finding rather than a
 * hole in the fixture.
 */
const bundle = {
  zipPath:
    "C:/Users/x/AppData/Roaming/Vortex/event-horizon/collections/ivy-2-1.0.10.ehcoll",
  appDataPath: "C:/Users/x/AppData/Roaming/Vortex",
  ehcoll: { manifest, bundledArchives: [], warnings: [], errors: [] },
  receipt: undefined,
  plan: {
    manifest,
    installTarget: { kind: "fresh-profile", suggestedProfileName: "Ivy 2 v1.0.10" },
    summary: {
      totalMods: 963,
      alreadyInstalled: 0,
      willInstallSilently: 931,
      needsUserConfirmation: 27,
      missing: 5,
      orphans: 0,
      canProceed: true,
      ruleCount: 291,
      // Zero for Fallout 4 by design — the case that reads as failure.
      loadOrderCount: 0,
      pluginOrderCount: 817,
      userlistPluginCount: 29,
      userlistGroupCount: 0,
    },
    modResolutions: [],
    orphanedMods: [],
    externalDependencies: [],
    rulePlan: [],
    pluginOrder: { entries: [], warnings: [] },
    compatibility: { errors: [], warnings: [], canProceed: true },
    previousInstall: undefined,
  },
} as never;

/** Full shapes — DoneStep reads these fields unguarded. */
const RULES = {
  appliedRuleCount: 291,
  appliedLoadOrderCount: 0,
  overwrittenUserRuleCount: 14,
  skippedRules: [],
  skippedLoadOrderEntries: [],
  baselinePluginOrder: [],
} as never;

const USERLIST = {
  appliedRuleCount: 29,
  appliedGroupAssignmentCount: 12,
  appliedNewGroupCount: 0,
  appliedGroupRuleCount: 0,
  overwrittenGroupAssignmentCount: 3,
  skippedUserlistEntries: [],
} as never;

/**
 * DashboardData with EVERY field the panels actually read, enumerated from the
 * component source rather than added until the render stopped throwing. A
 * partial fixture renders a screen missing whatever the absent field drives,
 * and that absence reads as a UI defect instead of a hole in the mock.
 */
const dashboardData = {
  status: {
    gameId: "fallout4",
    gameIsSupported: true,
    gameLabel: "Fallout 4",
    profileId: "S1xCt4Cbj1x",
    profileName: "Ivy 2 v1.0.10",
    vortexVersion: "2.6.0",
    appDataPath: "C:/Users/DuduPhudu/AppData/Roaming/Vortex",
  },
  receipts: [
    {
      packageId: "0f6b1a2c-1d3e-4f50-9a1b-2c3d4e5f6071",
      packageName: "Ivy 2",
      packageVersion: "1.0.10",
      gameId: "fallout4",
      installedAt: Date.parse("2026-08-29T21:14:00Z"),
      installTargetMode: "fresh-profile",
      mods: Array.from({ length: 963 }, () => ({})),
    },
    {
      packageId: "1a7c2b3d-2e4f-5061-ab2c-3d4e5f607182",
      packageName: "Ivy 2",
      packageVersion: "1.0.9",
      gameId: "fallout4",
      installedAt: Date.parse("2026-08-24T18:02:00Z"),
      installTargetMode: "current-profile",
      mods: Array.from({ length: 954 }, () => ({})),
    },
  ],
  receiptErrors: [],
  curatorConfigs: [
    {
      slug: "ivy-2",
      configPath: "C:/Users/DuduPhudu/AppData/Roaming/Vortex/event-horizon/collections/ivy-2.json",
      modifiedAt: Date.parse("2026-08-30T09:31:00Z"),
      config: { externalMods: { a: {}, b: {}, c: {} } },
    },
  ],
  builtPackages: [
    {
      packagePath: "C:/…/collections/ivy-2-1.0.10.ehcoll",
      fileName: "ivy-2-1.0.10.ehcoll",
      modifiedAt: Date.parse("2026-08-30T09:33:00Z"),
      sizeBytes: 157_984_816,
    },
    {
      packagePath: "C:/…/collections/ivy-2-1.0.9.ehcoll",
      fileName: "ivy-2-1.0.9.ehcoll",
      modifiedAt: Date.parse("2026-08-24T17:58:00Z"),
      sizeBytes: 151_220_004,
    },
  ],
} as never;

describe("render", () => {
  // A machine with a half-installed collection and NO receipt — the exact
  // state a tester was in, where this page said "no collections" while 963
  // mods sat staged on his disk.
  it("collections-interrupted — the install that never finished", () => {
    write(
      "collections-interrupted",
      React.createElement(
        "div",
        { className: "eh-page" },
        React.createElement(FailedAttempts, {
          attempts: [
            {
              packageId: "pkg-1",
              packageName: "Ivy 2",
              packageVersion: "1.0.12",
              gameId: "fallout4",
              endedAt: new Date(Date.now() - 3600_000).toISOString(),
              outcome: "failed",
              phase: "installing-mods",
              installedCount: 963,
              totalMods: 967,
              error: "No deployment method active",
              profileId: "2be7648d",
            },
          ],
          onRetry: () => undefined,
        } as never),
        React.createElement(InterruptedInstalls, {
          markers: [
            {
              packageId: "pkg-1",
              packageName: "Ivy 2",
              startedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
              profileId: "2be7648d",
              gameId: "fallout4",
              totalMods: 967,
            },
          ],
          onResume: () => undefined,
        } as never),
      ),
    );
  });

  it("doctor — a collection with real problems", () => {
    // The interesting state, not the happy one: a screen of green cards tells
    // you nothing about whether the design works.
    const checks = evaluateHealth(
      {
        packageName: "Ivy 2",
        packageVersion: "1.0.10",
        vortexProfileId: "prof-1",
        mods: Array.from({ length: 963 }, (_, i) => ({
          vortexModId: `m${i}`,
          compareKey: `nexus:${i}:${i}`,
          name: `Mod ${i}`,
        })),
        rulesApplication: {
          appliedRuleCount: 291,
          baselinePluginOrder: ["a.esp", "b.esp", "c.esp", "d.esp"].map(
            (name) => ({ name, enabled: true }),
          ),
        },
        userlistApplication: { appliedRuleCount: 29 },
      },
      {
        existingProfileIds: ["prof-1"],
        activeProfileId: "other-profile",
        // three mods removed, two more disabled
        installedModIds: Array.from({ length: 960 }, (_, i) => `m${i}`),
        enabledModIds: Array.from({ length: 958 }, (_, i) => `m${i}`),
        driftedCompareKeys: ["nexus:5:5", "nexus:9:9"],
        currentPluginOrder: ["a.esp", "c.esp", "b.esp", "d.esp"].map((name) => ({
          name,
          enabled: true,
        })),
        currentModRuleCount: 280,
        currentUserlistRuleCount: 29,
      },
    );
    write(
      "doctor",
      React.createElement(
        "div",
        { className: "eh-page" },
        React.createElement(DoctorPanel, {
          packageName: "Ivy 2",
          packageVersion: "1.0.10",
          checks,
          onRecheck: () => undefined,
          onRunDeepScan: () => undefined,
          onHeal: () => undefined,
        } as never),
      ),
    );
  });

  // The state where the .ehcoll is gone: diagnosis still works, and the three
  // cures that re-run manifest-reading steps say why they cannot. Worth a
  // screenshot because "disabled with a reason" is only better than "hidden"
  // if the reason is actually legible on the button.
  it("doctor-no-package — cures needing the package, disabled with the reason", () => {
    const checks = evaluateHealth(
      {
        packageName: "Ivy 2",
        packageVersion: "1.0.10",
        vortexProfileId: "prof-1",
        mods: Array.from({ length: 963 }, (_, i) => ({
          vortexModId: `m${i}`,
          compareKey: `nexus:${i}:${i}`,
          name: `Mod ${i}`,
        })),
        rulesApplication: {
          appliedRuleCount: 291,
          baselinePluginOrder: ["a.esp", "b.esp", "c.esp", "d.esp"].map(
            (name) => ({ name, enabled: true }),
          ),
        },
        userlistApplication: { appliedRuleCount: 29 },
      },
      {
        existingProfileIds: ["prof-1"],
        activeProfileId: "other-profile",
        installedModIds: Array.from({ length: 960 }, (_, i) => `m${i}`),
        enabledModIds: Array.from({ length: 958 }, (_, i) => `m${i}`),
        driftedCompareKeys: ["nexus:5:5", "nexus:9:9"],
        currentPluginOrder: ["a.esp", "c.esp", "b.esp", "d.esp"].map((name) => ({
          name,
          enabled: true,
        })),
        currentModRuleCount: 280,
        currentUserlistRuleCount: 29,
      },
    );
    write(
      "doctor-no-package",
      React.createElement(
        "div",
        { className: "eh-page" },
        React.createElement(DoctorPanel, {
          packageName: "Ivy 2",
          packageVersion: "1.0.10",
          checks,
          onRecheck: () => undefined,
          onHeal: () => undefined,
          unavailableHeal: (action: string) =>
            action === "reapply-rules" ||
            action === "reapply-userlist" ||
            action === "reinstall-mods"
              ? "Needs the .ehcoll"
              : undefined,
        } as never),
      ),
    );
  });

  it("doctor — healing blocked because an install is running", () => {
    const checks = evaluateHealth(
      {
        packageName: "Ivy 2",
        packageVersion: "1.0.10",
        vortexProfileId: "prof-1",
        mods: Array.from({ length: 963 }, (_, i) => ({
          vortexModId: `m${i}`,
          compareKey: `nexus:${i}:${i}`,
          name: `Mod ${i}`,
        })),
        rulesApplication: {
          appliedRuleCount: 291,
          baselinePluginOrder: ["a.esp", "b.esp", "c.esp", "d.esp"].map(
            (name) => ({ name, enabled: true }),
          ),
        },
        userlistApplication: { appliedRuleCount: 29 },
      },
      {
        existingProfileIds: ["prof-1"],
        activeProfileId: "prof-1",
        installedModIds: Array.from({ length: 960 }, (_, i) => `m${i}`),
        enabledModIds: Array.from({ length: 960 }, (_, i) => `m${i}`),
        driftedCompareKeys: undefined,
        currentPluginOrder: ["a.esp", "c.esp", "b.esp", "d.esp"].map((name) => ({
          name,
          enabled: true,
        })),
        currentModRuleCount: 291,
        currentUserlistRuleCount: 29,
      },
    );
    write(
      "doctor-blocked",
      React.createElement(
        "div",
        { className: "eh-page" },
        React.createElement(DoctorPanel, {
          packageName: "Ivy 2",
          packageVersion: "1.0.10",
          checks,
          healingBlocked: healingBlockedReason({ kind: "installing" }),
          onRecheck: () => undefined,
          onHeal: () => undefined,
        } as never),
      ),
    );
  });

  it("main dashboard — the first screen anyone sees", () => {
    write(
      "dashboard-home",
      // The real tree is .eh-page > Hero + DashboardBody (see Dashboard).
      React.createElement(
        "div",
        { className: "eh-page" },
        React.createElement(Hero, null),
        React.createElement(DashboardBody, {
        data: dashboardData,
        onNavigate: () => undefined,
          onRefresh: () => undefined,
        } as never),
      ),
    );
  });


  it("build dashboard — the cards that ARE its content", () => {
    // The dashboard mounts loading and fills in from an effect, which static
    // rendering never runs, so capturing the page shows a skeleton. The cards
    // take their data as props, so they show the real screen without a DOM.
    //
    // Both states that matter: a published collection whose profile has NOT
    // changed since it shipped (Update suppressed), and one whose fingerprint
    // is unknown — which must still offer Update, because unknown is not the
    // same as up to date.
    const published = {
      slug: "ivy-2",
      packageId: "00000000-0000-4000-8000-000000000000",
      configPath: "C:/Users/x/AppData/Roaming/Vortex/event-horizon/collections/ivy-2.json",
      gameId: "fallout4",
      lastBuiltName: "Ivy 2",
      lastBuiltVersion: "1.0.10",
      lastBuiltAuthor: "DuduPhudu",
      lastBuiltAt: new Date(Date.now() - 42 * 60_000).toISOString(),
      lastBuiltProfileFingerprint: "dfe737127f8add3a",
    } as never;

    const draft = {
      key: "fallout4",
      updatedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      payload: {
        draftId: "d1",
        gameId: "fallout4",
        title: "Ivy 2",
        linkedSlug: "ivy-2",
        linkedPackageId: "00000000-0000-4000-8000-000000000000",
        verificationLevel: "thorough",
        reverifyEverything: false,
        changelog: "",
        readme: "",
        overrides: {},
        curator: { name: "Ivy 2", version: "1.0.11", author: "DuduPhudu", description: "" },
      },
    } as never;

    write(
      "build-dashboard",
      React.createElement(ToastProvider, {
        children: React.createElement(
          "div",
          { className: "eh-stack eh-stack--lg" },
          React.createElement(DraftCard, {
            env: draft,
            activeGameId: "fallout4",
            registrySessionStateKind: "idle",
            onOpen: () => undefined,
            onDiscard: () => undefined,
          } as never),
          // The reported case: a draft linked to a published collection whose
          // card is therefore hidden, on a profile that has since changed.
          // Before this the dashboard knew the profile had moved — its own log
          // said upToDate:false — and showed a card that mentioned none of it.
          React.createElement(DraftCard, {
            env: draft,
            activeGameId: "fallout4",
            registrySessionStateKind: "idle",
            linkedPublished: { builtVersion: "1.0.11", profileChanged: true },
            onOpen: () => undefined,
            onDiscard: () => undefined,
          } as never),
          React.createElement(PublishedCard, {
            summary: published,
            upToDate: true,
            knownSlugs: ["ivy-2"],
            onUpdate: () => undefined,
            onDelete: () => undefined,
          } as never),
          React.createElement(PublishedCard, {
            summary: { ...(published as object), lastBuiltProfileFingerprint: undefined },
            upToDate: false,
            knownSlugs: ["ivy-2"],
            onUpdate: () => undefined,
            onDelete: () => undefined,
          } as never),
        ),
      } as never),
    );
  });

  it("build done — the real v1.0.10 result and its 10 warnings", () => {
    // Verbatim from the actual build log: same counts, same sha256, same
    // warnings in the same order. This is the screen a curator reads after 28
    // minutes, and the only place those warnings are ever shown.
    const result = {
      outputPath:
        "C:/Users/x/AppData/Roaming/Vortex/event-horizon/collections/ivy-2-1.0.10.ehcoll",
      outputBytes: 157_837_710,
      outputSha256:
        "409721827a4c0097de4f2d33e2c45a789f7bdbdcf48df019423cc315b66dc276",
      bundledCount: 4,
      modCount: 963,
      warnings: [
        '"Liberty Wasteland Redux" is a Vortex collection installed in this profile, not a mod, so it was left out. Its staging folder holds copies of other mods\' files, which would have shipped them twice — and any INI tweaks it carries are not included either. The mods it installed are still in this collection in their own right.',
        "5 mods have no source archive and no Nexus source to fetch one from. They still ship — they are identified by the SHA-256 of their deployed files instead — but that identity is weaker: a user whose copy differs even slightly will not match it, and will be asked to supply the mod themselves. Re-importing their archives into Vortex would give them a real identity.",
        '2 external mods no longer match the archive they came from — files have been added or removed in the staging folder since. Right now the collection ships the ARCHIVE, so whoever installs it gets the original, not your version. Tick "bundle" on them to pack your actual files into the .ehcoll instead.\n  • "CC_enclave_textures": 766 staged file(s) are not in the archive (e.g. cc_enclave_textures.7z).\n  • "PorcOverlays_esl_02b": 1 staged file(s) are not in the archive.',
        "21 INI setting(s) describe your machine rather than this collection and were NOT shipped: bBorderless, bEnableAudio, bFull Screen, bMaximizeWindow, bTopMostWindow, fDefault1stPersonFOV, fDefaultWorldFOV, iAdapter, and 11 more.",
        '106 mod rule(s) reference 66 mod(s) that are not in this collection, so those rules were dropped: "1Optional - M1Garand", "2.1.0 CBBE BODY AND BODYSLIDES", and 60 more. This is normal on a profile that has been curated for a while.',
        "4382 contested file(s) recorded; 46205 file(s) are shipped by exactly one mod, so their deployment winner is that mod and was not written out.",
        '115 mod(s) were installed with FOMOD options you chose (e.g. "Weapon Mod Fixes"). Those choices are recorded here and replayed on install.',
        '"Ivy\'sPantiesSettings" is missing 7 file(s) that its archive contains and its own folders suggest should be there (e.g. F4SE/Plugins/BakaMaxPapyrusOps.toml). 13 of 21 files in "F4SE/Plugins" are installed (62%) — a partially extracted folder is what a lost write looks like. Worth opening before shipping.',
        '13 mod(s) have 885 staged file(s) that differ from their archives — most often "CC_enclave_textures" (766). This is normal if you repack BA2s, clean plugins, or run the game before building.',
        "9 mod(s) could not be checked against their archive (archive missing from disk, or unreadable).",
      ],
      // The decision panel, with the real shape of the finding: one mod that
      // is obviously generator output, one that is obviously NOT. If the
      // rendered page does not make those two look like different answers,
      // the copy has failed at the only job it has.
      postProcessingCandidates: [
        {
          modId: "mod-xlodgen",
          modName: "sse-xlodgen-output-pbr",
          unexplained: 1608,
          canMirror: true,
          files: [
            { path: "Textures/Terrain/Valefrost/Valefrost.Terrain.HeightMap.-27.-7.23.26.-256.452.dds", kind: "changed", delta: 24576 },
            { path: "Textures/Terrain/Tamriel/Tamriel.Terrain.HeightMap.4.-12.dds", kind: "added" },
            { path: "Meshes/Terrain/Tamriel/Objects/Tamriel.32.-32.-32.BTO", kind: "changed", delta: -2048 },
          ],
        },
        {
          modId: "mod-armour",
          modName: "Immersive Armours",
          unexplained: 2,
          canMirror: true,
          files: [
            { path: "Data/Meshes/armour/hide/patched_cuirass.nif", kind: "changed", delta: 24576 },
            { path: "Data/MyFix-Patch.esp", kind: "added" },
          ],
        },
        // Three more, taken from a real 57-mod report. Two candidates make
        // any layout look fine; the complaint this fixture exists to expose
        // is that consecutive mods ran together into one unreadable column,
        // which only shows up once there are several in a row.
        {
          modId: "mod-eeos",
          modName: "EEOS - Enemy Revolution of Skyrim-37228-2-02-1705594315",
          unexplained: 6,
          canMirror: true,
          files: [
            { path: "ApocalypseSpellsForNPCs_DISTR.ini", kind: "changed", delta: 24576 },
            { path: "GrowlPerksAndSpellsForNPCs_DISTR.ini", kind: "added" },
            { path: "ODINSpellsForNPCs_DISTR.ini", kind: "changed", delta: -2048 },
            { path: "PotionsForNPCs_DISTR.ini", kind: "changed", delta: -118 },
            { path: "TriumvirateShadowSpellsForNPCs_DISTR.ini", kind: "added" },
            { path: "VanillaShoutsForNPCs_DISTR.ini", kind: "changed", delta: -2048 },
          ],
        },
        {
          modId: "mod-junipers",
          modName: "3D Junipers - Trees and Berries-43852-0-2-1687771639",
          unexplained: 3,
          canMirror: true,
          files: [
            { path: "meshes/_byoh/plants/byohhouseingrdjuniper01.nif", kind: "changed", delta: 24576 },
            { path: "meshes/plants/florajuniper01.nif", kind: "added" },
            { path: "meshes/plants/juniper01.nif", kind: "changed", delta: -2048 },
          ],
        },
        {
          modId: "mod-grid",
          modName: "Grid Inventory 188733 1.4.1 2026-08-22T09-05Z L5WQbqhQB",
          unexplained: 2,
          canMirror: false,
          files: [
            { path: "SKSE/Plugins/GridInventory_icons.pak", kind: "changed", delta: 24576 },
            { path: "SKSE/Plugins/GridInventory_ui.ini", kind: "added" },
          ],
        },
      ],
    } as never;

    write(
      "build-done",
      React.createElement(ToastProvider, {
        children: React.createElement(DonePanel, {
          result,
          onBuildAnother: () => undefined,
          onGoHome: () => undefined,
          onDecidePostProcessing: async () => undefined,
        } as never),
      } as never),
    );
  });

  it("recently built - the way back into a finished build", () => {
    const base = {
      name: "Meridia Panties",
      version: "1.0.4",
      modCount: 1757,
      outputBytes: 1.1 * 1024 ** 3,
      builtAt: Date.now() - 7 * 60 * 1000,
    };
    write(
      "recently-built",
      React.createElement(
        "div",
        { className: "eh-stack eh-stack--md" },
        React.createElement(RecentlyBuiltCard, {
          key: "clean",
          built: { ...base, drift: { added: [], removed: [], toggled: [], changed: [] } },
          onOpen: () => undefined,
          onDismiss: () => undefined,
        } as never),
        React.createElement(RecentlyBuiltCard, {
          key: "moved",
          built: {
            ...base,
            name: "Ivy 2",
            version: "1.0.13",
            drift: {
              added: ["Skyland AIO"],
              removed: [],
              toggled: ["Wildcat - Combat of Skyrim", "Vanargand Animations"],
              changed: ["Apocalypse - Magic of Skyrim"],
            },
          },
          onOpen: () => undefined,
          onDismiss: () => undefined,
        } as never),
      ),
    );
  });

  it("decisions gate - the build held open for an answer", () => {
    const candidate = (
      modId: string,
      modName: string,
      unexplained: number,
      files: { path: string; kind: string; delta?: number }[],
      over: Record<string, unknown> = {},
    ): unknown => ({
      modId,
      modName,
      unexplained,
      files,
      canMirror: true,
      fingerprint: "fp",
      reopened: false,
      needsAnswer: true,
      ...over,
    });
    write(
      "decisions-gate",
      React.createElement(ToastProvider, {
        children: React.createElement(DecisionsGate, {
          state: {
            kind: "awaiting-decisions",
            ctx: { mods: [] },
            curator: { name: "Meridia Panties", version: "1.0.4" },
            progress: { phase: "inspecting-mods" },
            candidates: [
              candidate("lod", "DynDOLOD Output-1234-3-0-1700000000", 4212, [
                { path: "meshes/terrain/tamriel/objects/tamriel.4.-32.-32.bto", kind: "added" },
                { path: "textures/terrain/tamriel/tamriel.4.-32.-32.dds", kind: "added" },
                { path: "DynDOLOD.esm", kind: "added" },
              ]),
              // The re-ask: answered before, and the files moved since.
              candidate(
                "aos",
                "Audio Overhaul for Skyrim (4.1.3)-12466-4-1-3-1683940246",
                1,
                [{ path: "Audio Overhaul Skyrim.esp", kind: "changed", delta: -1843 }],
                { reopened: true },
              ),
              // Already answered, and the files have not moved. Listed with
              // its verdict rather than hidden, so it can be reviewed and
              // changed.
              candidate(
                "embers",
                "Embers XD-37085-3-2-2-1699000000",
                12,
                [{ path: "meshes/effects/fxembers01.nif", kind: "changed", delta: 2048 }],
                { needsAnswer: false, decision: "declare", canMirror: false },
              ),
            ],
          },
          onDecide: async () => undefined,
          onContinue: () => undefined,
          onCancel: () => undefined,
        } as never),
      } as never),
    );
  });

  it("build diff \u2014 what this rebuild would ship", () => {
    // The card a curator sees on the form, with a diff shaped like a real
    // revision: a handful added, a couple dropped, several bumped, one
    // toggled, and a majority untouched.
    const name = (n: number, w: string): { name: string; version?: string } => ({
      name: `${w} ${n}`,
      version: `1.${n}`,
    });
    write(
      "build-diff",
      React.createElement(BuildDiffView, {
        outcome: {
          kind: "diff",
          againstVersion: "1.0.3",
          fileName: "meridia-panties-1.0.3.ehcoll",
          diff: {
            added: [
              name(1, "Skyland AIO"),
              name(2, "Lux Orbis"),
              name(3, "Embers XD"),
            ],
            removed: [name(4, "Obsidian Weathers")],
            updated: [
              { name: "Apocalypse - Magic of Skyrim", fromVersion: "9.8", toVersion: "10.0" },
              { name: "Ordinator - Perks of Skyrim", fromVersion: "9.31", toVersion: "9.32" },
              { name: "SSE Display Tweaks", fromVersion: "0.5.16", toVersion: "0.5.25" },
            ],
            toggled: [{ name: "Wildcat - Combat of Skyrim", nowEnabled: false }],
            reconfigured: [
              { name: "Ordinator - Perks of Skyrim", version: "9.32", reason: "installer-options" },
              { name: "Lux", version: "6.5", reason: "staged-files" },
            ],
            unchanged: 1748,
            approximate: 29,
          },
        },
      } as never),
    );

    write(
      "build-diff-unreadable",
      React.createElement(BuildDiffView, {
        outcome: {
          kind: "unreadable",
          fileName: "meridia-panties-1.0.3.ehcoll",
          why: "end of central directory record not found",
        },
      } as never),
    );
  });

  // The fake Vortex store both curator screens render from.
  function curatorState(): Record<string, unknown> {
    const modsById: Record<string, unknown> = {
      "needs-update": {
        attributes: {
          name: "Apocalypse - Magic of Skyrim",
          version: "10.0.0",
          newestVersion: "10.1.0",
          modId: 1090,
          fileId: 400,
          newestFileId: 500,
        },
      },
      "frozen-ok": {
        attributes: {
          name: "SKSE64",
          version: "2.2.6",
          modId: 30379,
          fileId: 10,
          newestFileId: 44,
          eventHorizonFrozenAtVersion: "2.2.6",
          endorsed: "Endorsed",
        },
      },
      "frozen-broken": {
        attributes: {
          name: "Address Library for SKSE Plugins",
          version: "16.0",
          modId: 32444,
          eventHorizonFrozenAtVersion: "15.0",
        },
      },
      "dupe-a": {
        attributes: { name: "Embers XD", version: "3.2.2", modId: 37085, fileId: 900 },
      },
      "dupe-b": {
        attributes: { name: "Embers XD (older)", version: "3.1.0", modId: 37085, fileId: 880 },
      },
      // Two installs of ONE Nexus page, both with a newer file waiting. Only
      // the newer one may be offered an update — offering both would install
      // 8.2 twice. The older shows up under "older installs" instead.
      "shadow-old": {
        archiveId: "dl-shadow-old",
        attributes: {
          name: "Animated Armoury 7.0",
          fileName: "Animated Armoury-47213-7-0-1579138592.7z",
          version: "7.0",
          modId: 47213,
          fileId: 700,
          newestFileId: 820,
          newestVersion: "8.2",
        },
      },
      "shadow-new": {
        archiveId: "dl-shadow-new",
        attributes: {
          name: "Animated Armoury 8.1",
          fileName: "Animated Armoury-47213-8-1-1679138592.7z",
          version: "8.1",
          modId: 47213,
          fileId: 810,
          newestFileId: 820,
          newestVersion: "8.2",
        },
      },
      // Two different FILES on one page — the case that used to be offered
      // for deletion. They must land in the unproven group, never the first.
      "bp-cbbe": {
        archiveId: "dl-bp-cbbe",
        attributes: {
          name: "(2)Barbarian Bodypaints - CBBE-31826-1-0-1579138592",
          fileName: "Barbarian Bodypaints - CBBE-31826-1-0-1579138592.7z",
          version: "1.0",
          modId: 31826,
          fileId: 128100,
        },
      },
      "bp-male": {
        archiveId: "dl-bp-male",
        attributes: {
          name: "(3)Barbarian Bodypaints - Male-31826-1-0-1579138821",
          fileName: "Barbarian Bodypaints - Male-31826-1-0-1579138821.7z",
          version: "1.0",
          modId: 31826,
          fileId: 128101,
        },
      },
      "co-main": {
        archiveId: "dl-co-main",
        attributes: {
          name: "(3) Community Overlays 1 - Main - CBBE 2K-22487-1-0-1-1547251200",
          fileName: "Community Overlays 1 - Main - CBBE 2K-22487-1-0-1-1547251200.7z",
          version: "1.0.1",
          modId: 22487,
          fileId: 90001,
        },
      },
      "co-patch": {
        archiveId: "dl-co-patch",
        attributes: {
          name: "(Q) Community Overlays 1 - Bugfix Patch-22487-1-0-2-1548457200",
          fileName: "Community Overlays 1 - Bugfix Patch-22487-1-0-2-1548457200.7z",
          version: "1.0.2",
          modId: 22487,
          fileId: 90002,
        },
      },
      // A genuine old version: the same file, two versions, and Nexus's own
      // chain pointing from one to the other.
      "sky-old": {
        archiveId: "dl-sky-old",
        attributes: {
          name: "Skyland AIO 4.2",
          logicalFileName: "Skyland AIO",
          version: "4.2",
          modId: 34179,
          fileId: 600,
          newestFileId: 700,
        },
      },
      "sky-new": {
        archiveId: "dl-sky-new",
        attributes: {
          name: "Skyland AIO 4.7",
          logicalFileName: "Skyland AIO",
          version: "4.7",
          modId: 34179,
          fileId: 700,
        },
      },
    };

    // A real profile is ~1,900 mods, and every list on this page used to
    // render as one flat column of them. Five fixture mods is the shape that
    // made that look fine. These are the other 1,895.
    const WORDS = [
      "Cathedral", "Skyland", "Lux", "Embers", "JK's", "Obsidian", "Rudy",
      "Simplicity", "Wildcat", "Ordinator", "Apothecary", "Mysticism",
      "Bijin", "Pandorable", "Northbourne", "Vanargand", "Leviathan",
    ];
    const NOUNS = [
      "Weathers", "Landscapes", "Interiors", "Armory", "NPCs", "Animations",
      "Textures AIO", "Overhaul", "Patch", "Retexture", "Fixes", "Redux",
    ];
    for (let i = 0; i < 1895; i += 1) {
      const name =
        `${WORDS[i % WORDS.length]} ${NOUNS[(i >> 2) % NOUNS.length]} ` +
        `${1 + (i % 40)}`;
      const fileId = 1000 + i;
      modsById[`bulk-${i}`] = {
        archiveId: `dl-bulk-${i}`,
        attributes: {
          name,
          version: `${1 + (i % 9)}.${i % 10}`,
          modId: 100000 + i,
          fileId,
          // Roughly one in nine has an update waiting, which is the order of
          // magnitude a real profile shows after a Nexus re-check.
          ...(i % 9 === 0
            ? { newestFileId: fileId + 5, newestVersion: `${1 + (i % 9)}.${(i % 10) + 1}` }
            : { newestFileId: fileId }),
          ...(i % 5 === 0 ? { endorsed: "Endorsed" } : {}),
          ...(i % 23 === 0 ? { type: "dinput" } : {}),
        },
      };
    }
    /**
     * A download folder shaped like the real one: mostly archives an install
     * still points at, a long tail of superseded leftovers, and a handful of
     * things downloaded and never installed.
     */
    const files: Record<string, unknown> = {};
    const dl = (
      id: string,
      localPath: string,
      size: number,
      nexus?: { modId: number; fileId: number },
    ): void => {
      files[id] = {
        localPath,
        size,
        state: "finished",
        game: ["skyrimse"],
        ...(nexus === undefined
          ? {}
          : { modInfo: { nexus: { ids: { modId: nexus.modId, fileId: nexus.fileId } } } }),
      };
    };
    for (let i = 0; i < 1895; i += 1) {
      // In use — referenced by bulk-i, so never a candidate.
      dl(`dl-bulk-${i}`, `Mod ${i}-${100000 + i}-current.7z`, 40 * 1024 ** 2, {
        modId: 100000 + i,
        fileId: 1000 + i,
      });
      // Every third mod also has an older archive nobody points at any more.
      if (i % 3 === 0) {
        dl(
          `dl-old-${i}`,
          `Mod ${i}-${100000 + i}-older.7z`,
          (30 + (i % 200)) * 1024 ** 2,
          { modId: 100000 + i, fileId: 900 + i },
        );
      }
    }
    for (const [id, file, mid, fid] of [
      ["dl-bp-cbbe", "Barbarian Bodypaints - CBBE-31826-1-0-1579138592.7z", 31826, 128100],
      ["dl-bp-male", "Barbarian Bodypaints - Male-31826-1-0-1579138821.7z", 31826, 128101],
      ["dl-co-main", "Community Overlays 1 - Main - CBBE 2K-22487-1-0-1.7z", 22487, 90001],
      ["dl-co-patch", "Community Overlays 1 - Bugfix Patch-22487-1-0-2.7z", 22487, 90002],
      ["dl-sky-old", "Skyland AIO-34179-4-2.7z", 34179, 600],
      ["dl-sky-new", "Skyland AIO-34179-4-7.7z", 34179, 700],
    ] as [string, string, number, number][]) {
      dl(id, file, 900 * 1024 ** 2, { modId: mid, fileId: fid });
    }
    dl("dl-shadow-old", "Animated Armoury-47213-7-0.7z", 220 * 1024 ** 2, {
      modId: 47213,
      fileId: 700,
    });
    dl("dl-shadow-new", "Animated Armoury-47213-8-1.7z", 240 * 1024 ** 2, {
      modId: 47213,
      fileId: 810,
    });
    // Downloaded on purpose, never installed. Must never be pre-selected.
    dl("dl-never-1", "Skyrim Realistic Overhaul 1.8-968-1-8.part1.rar", 3.4 * 1024 ** 3);
    dl("dl-never-2", "Noble Skyrim Full Pack-15305-1-6.7z", 2.1 * 1024 ** 3);

    const state = {
      persistent: {
        mods: { skyrimse: modsById },
        downloads: { files },
        profiles: {
          p1: {
            gameId: "skyrimse",
            modState: Object.fromEntries(
              // Not all enabled: the State column is only worth filtering by
              // if it has both values in it.
              Object.keys(modsById).map((k, i) => [k, { enabled: i % 11 !== 0 }]),
            ),
          },
        },
      },
      settings: { profiles: { activeProfileId: "p1", activeGameId: "skyrimse" } },
      // Vortex's plugin management state: the list it found, and the active
      // profile's load order. One plugin per mod that ships one; a base-game
      // master; one plugin whose mod is disabled; one loose file.
      session: {
        plugins: {
          pluginList: {
            "Skyrim.esm": { isNative: true, filePath: "C:/Games/Skyrim/Data/Skyrim.esm" },
            "Update.esm": { isNative: true, filePath: "C:/Games/Skyrim/Data/Update.esm" },
            "Apocalypse - Magic of Skyrim.esp": { modId: "needs-update", filePath: "C:/staging/needs-update/Apocalypse - Magic of Skyrim.esp" },
            "Embers XD.esp": { modId: "dupe-a", filePath: "C:/staging/dupe-a/Embers XD.esp" },
            "Animated Armoury.esp": { modId: "shadow-new", filePath: "C:/staging/shadow-new/Animated Armoury.esp" },
            "Skyland AIO.esp": { modId: "sky-new", filePath: "C:/staging/sky-new/Skyland AIO.esp" },
            "Skyland Patch.esp": { modId: "sky-old", filePath: "C:/staging/sky-old/Skyland Patch.esp" },
            "Loose Tweak.esp": { filePath: "C:/Games/Skyrim/Data/Loose Tweak.esp" },
          },
        },
      },
      loadOrder: {
        "Skyrim.esm": { enabled: true, loadOrder: 0 },
        "Update.esm": { enabled: true, loadOrder: 1 },
        "Apocalypse - Magic of Skyrim.esp": { enabled: true, loadOrder: 2 },
        "Embers XD.esp": { enabled: true, loadOrder: 3 },
        "Animated Armoury.esp": { enabled: true, loadOrder: 4 },
        "Skyland AIO.esp": { enabled: true, loadOrder: 5 },
        "Skyland Patch.esp": { enabled: false, loadOrder: 6 },
        "Loose Tweak.esp": { enabled: true, loadOrder: 7 },
      },
    };
    return state;
  }

  // What reading the headers of the fixture's plugins would say.
  const pluginHeaders = (): Map<string, PluginHeader> =>
    new Map<string, PluginHeader>([
      ["Skyrim.esm", { masters: [], flags: { isLight: false, isMaster: true } }],
      ["Update.esm", { masters: ["Skyrim.esm"], flags: { isLight: false, isMaster: true } }],
      [
        "Apocalypse - Magic of Skyrim.esp",
        { masters: ["Skyrim.esm", "Update.esm", "Dawnguard.esm", "MysticOrdinator.esp"], flags: { isLight: false, isMaster: false } },
      ],
      ["Embers XD.esp", { masters: ["Skyrim.esm"], flags: { isLight: true, isMaster: false } }],
      ["Animated Armoury.esp", { masters: ["Skyrim.esm", "Update.esm"], flags: { isLight: false, isMaster: false } }],
      ["Skyland AIO.esp", { masters: ["Skyrim.esm"], flags: { isLight: true, isMaster: false } }],
      ["Skyland Patch.esp", { masters: ["Skyland AIO.esp"], flags: { isLight: true, isMaster: false } }],
      ["Loose Tweak.esp", { masters: ["Skyland Patch.esp", "Embers XD.esp"], unreadable: undefined, flags: { isLight: false, isMaster: false } }],
    ]);

  // The load order as its own instrument: drifted after a LOOT sort, with
  // the preview of what re-applying moves and auto-sort still on; and the
  // quiet state when it matches.
  it("load order — drifted after a sort", () => {
    const on = (...names: string[]): { name: string; enabled: boolean }[] => names.map((name) => ({ name, enabled: true }));
    const baseline = on("Skyrim.esm", "Unofficial Skyrim Special Edition Patch.esp", "SkyUI_SE.esp", "Ordinator.esp", "Apocalypse.esp", "Wintersun.esp");
    const current = on("Skyrim.esm", "SkyUI_SE.esp", "MyOwnTweak.esp", "Unofficial Skyrim Special Edition Patch.esp", "Wintersun.esp", "Apocalypse.esp", "Ordinator.esp");
    const natives = new Set(["skyrim.esm"]);
    write(
      "load-order-drifted",
      React.createElement(LoadOrderCard, {
        packageName: "Ivy 2 v1.0.11",
        status: assessLoadOrder({ baseline, current, natives }),
        preview: previewRepin(baseline, current),
        autoSortOn: true,
        busy: false,
        onReapply: () => undefined,
        onDisableAutoSort: () => undefined,
      }),
    );
  });

  it("load order — matches", () => {
    const on = (...names: string[]): { name: string; enabled: boolean }[] => names.map((name) => ({ name, enabled: true }));
    const baseline = on("Skyrim.esm", "A.esp", "B.esp", "C.esp");
    const current = on("Skyrim.esm", "A.esp", "Mine.esp", "B.esp", "C.esp");
    write(
      "load-order-matches",
      React.createElement(LoadOrderCard, {
        packageName: "Ivy 2 v1.0.11",
        status: assessLoadOrder({ baseline, current, natives: new Set(["skyrim.esm"]) }),
        preview: previewRepin(baseline, current),
        autoSortOn: false,
        busy: false,
        onReapply: () => undefined,
      }),
    );
  });

  // Settled: a curator plugin switched off is its own status — no Re-apply,
  // no blame on the sort.
  it("load order — a curator plugin switched off", () => {
    const baseline = [
      { name: "Skyrim.esm", enabled: true },
      { name: "A.esp", enabled: true },
      { name: "B.esp", enabled: true },
      { name: "C.esp", enabled: true },
    ];
    const current = [
      { name: "A.esp", enabled: true },
      { name: "B.esp", enabled: false },
      { name: "Mine.esp", enabled: true },
      { name: "C.esp", enabled: true },
    ];
    write(
      "load-order-plugins-off",
      React.createElement(LoadOrderCard, {
        packageName: "Ivy 2 v1.0.11",
        status: assessLoadOrder({ baseline, current, natives: new Set(["skyrim.esm"]) }),
        autoSortOn: false,
        busy: false,
        onReapply: () => undefined,
      }),
    );
  });

  // Vortex holds one order, the active profile's: another profile's receipt
  // gets no verdict and no Re-apply.
  it("load order — installed in another profile", () => {
    const on = (...names: string[]): { name: string; enabled: boolean }[] => names.map((name) => ({ name, enabled: true }));
    write(
      "load-order-other-profile",
      React.createElement(LoadOrderCard, {
        packageName: "Ivy 2 v1.0.11",
        status: assessLoadOrder({
          baseline: on("A.esp", "B.esp"),
          current: on("B.esp", "A.esp"),
          standing: { kind: "other-profile", profileName: "Ivy 2 v1.0.11" },
        }),
        autoSortOn: true,
        busy: false,
        onReapply: () => undefined,
      }),
    );
  });

  it("curator tools — the profile-wide actions", () => {
    // A fake Vortex store shaped like the real one: a mod needing an update,
    // one frozen and holding, one whose freeze was broken from outside, and
    // two installs of the same Nexus page.
    const state = curatorState();
    write(
      "curator-tools",
      React.createElement(ApiProvider, {
        api: { getState: () => state, store: { dispatch: () => undefined } },
        children: React.createElement(ToastProvider, {
          children: React.createElement(CuratorPanel, {}),
        } as never),
      } as never),
    );
  });

  // The same page with three mods ticked: the action bar, which only exists
  // while something is ticked and so had never been photographed — its
  // "Kind" label sat wedged against Remove (curator's screenshot of 0.1.156).
  it("curator tools — rows ticked, the action bar", () => {
    const state = curatorState();
    const mods = readCuratorMods(state as never, "skyrimse", readEnabledModIds(state as never, "skyrimse"));
    write(
      "curator-tools-ticked",
      React.createElement(ApiProvider, {
        api: { getState: () => state, store: { dispatch: () => undefined } },
        children: React.createElement(ToastProvider, {
          children: React.createElement(CuratorPanel, { initialSelected: mods.slice(0, 3).map((m) => m.id) }),
        } as never),
      } as never),
    );
  });

  // The Disk cleanup view: orphaned archives and superseded installs, with
  // the unproven same-page group kept apart. Nothing is pre-ticked.
  it("curator tools — disk cleanup", () => {
    const state = curatorState();
    const mods = readCuratorMods(state as never, "skyrimse", readEnabledModIds(state as never, "skyrimse"));
    write(
      "curator-disk-cleanup",
      React.createElement(DiskCleanupView, {
        mods,
        downloads: readDownloads(state as never, "skyrimse"),
        busy: false,
        confirm: async () => false,
        applyCleanup: async () => undefined,
      }),
    );
  });

  // The Plugins view with headers read: a disabled master (Skyland Patch is
  // off, Loose Tweak needs it), a missing one (MysticOrdinator), light flags
  // and the regular-slot count.
  it("curator tools — plugins", () => {
    const state = curatorState();
    const mods = readCuratorMods(state as never, "skyrimse", readEnabledModIds(state as never, "skyrimse"));
    const rows = buildPluginRows({
      plugins: readPluginList(state),
      headers: pluginHeaders(),
      mods,
      isBaseGame: (m) => /^(skyrim|update|dawnguard|hearthfires|dragonborn)\.esm$/i.test(m),
    });
    write(
      "curator-plugins",
      React.createElement(PluginsView, {
        rows,
        headersRead: true,
        onFocus: () => undefined,
        onSetEnabled: () => undefined,
        busy: false,
        // The fixture is Skyrim SE: light plugins and the 254-slot counter apply.
        capability: pluginCapabilityFor("skyrimse")!,
      }),
    );
  });

  // Downloads with no installed version: the archives Disk cleanup refuses
  // to touch, offered for install instead.
  it("curator tools — downloads not installed", () => {
    const state = curatorState();
    const mods = readCuratorMods(state as never, "skyrimse", readEnabledModIds(state as never, "skyrimse"));
    const downloads = readDownloads(state as never, "skyrimse");
    const notInstalled = planCleanup({ mods, downloads }).unclearOrphans.map((o) => o.entry);
    write(
      "curator-downloads",
      React.createElement(DownloadsView, { downloads: notInstalled, busy: false, onInstall: () => undefined }),
    );
  });

  // "Make it work": the closure preview — one page ready, one where the
  // curator must choose between two current files, one with no file, one
  // for a game this Vortex does not manage, plus an enable and an off-Nexus
  // link. Everything the modal can say, on one screen.
  it("curator tools — install plan preview", () => {
    const step = (key: string, name: string, nexusModId: number, neededBy: string[], depth: number, vortexGameId?: string) => ({
      key,
      name,
      nexusModId,
      gameDomain: key.split(":")[0]!,
      neededBy,
      depth,
      ...(vortexGameId === undefined ? {} : { vortexGameId }),
    });
    const steps = [
      step("skyrimspecialedition:53000", "MCM Helper", 53000, ["SkyUI"], 2, "skyrimse"),
      step("skyrimspecialedition:12604", "SkyUI", 12604, ["Apocalypse - Magic of Skyrim"], 1, "skyrimse"),
      step("skyrimspecialedition:22854", "Papyrus Extender", 22854, ["Apocalypse - Magic of Skyrim"], 1, "skyrimse"),
      step("fallout4:999", "Some FO4 page", 999, ["SkyUI"], 2),
    ];
    write(
      "curator-install-plan",
      React.createElement(InstallPlanModal, {
        open: true,
        rootName: "Apocalypse - Magic of Skyrim",
        plan: {
          steps,
          toEnable: [{ id: "addr", name: "Address Library for SKSE Plugins", enabled: false, modType: "" }],
          external: [{ source: "nexus", status: "external", name: "ENB Series", url: "http://enbdev.com", satisfiedBy: [] }],
          unfetched: ["Some FO4 page"],
          truncated: false,
        },
        files: [
          { step: steps[0]!, choice: { kind: "one", file: { file_id: 1, category_id: 1, name: "MCM Helper 1.5.0", version: "1.5.0" } } },
          {
            step: steps[1]!,
            choice: {
              kind: "choose",
              candidates: [
                { file_id: 2, category_id: 1, name: "SkyUI 5.2 SE", version: "5.2SE" },
                { file_id: 3, category_id: 1, name: "SkyUI 5.2 SE (AE build)", version: "5.2SE-AE" },
              ],
            },
          },
          { step: steps[2]!, choice: { kind: "none" } },
          { step: steps[3]!, choice: { kind: "one", file: { file_id: 9, category_id: 1, name: "x" } } },
        ],
        picked: {},
        onPick: () => undefined,
        onOpenPage: () => undefined,
        onConfirm: () => undefined,
        onClose: () => undefined,
      }),
    );
  });

  // The same profile after "Read requirements": the Requires column fills,
  // the "Missing requirements" chip appears, and the details panel shows one
  // mod with every requirement state at once — satisfied, installed but
  // disabled, missing, off-Nexus, and a plugin master. The report is built
  // through the real resolver from a Nexus-shaped answer, not hand-typed.
  it("curator tools — requirements read", () => {
    const state = curatorState();
    const mods = readCuratorMods(state as never, "skyrimse", readEnabledModIds(state as never, "skyrimse"));
    // Vortex says "skyrimse"; Nexus's games cache says "skyrimspecialedition".
    const games = new Map([["skyrimspecialedition", 1704]]);
    const { uidByMod, noUid } = uidsFor(mods, games, "skyrimse", nexusDomainOf);
    const node = (modId: number, modName: string, notes?: string): Record<string, unknown> => ({
      id: `${1704}-${modId}`,
      gameId: 1704,
      modId,
      modName,
      notes: notes ?? null,
      url: `https://www.nexusmods.com/skyrimspecialedition/mods/${modId}`,
    });
    const fetched = new Map<string, Record<string, unknown>>([
      [
        makeModUid(1704, 1090),
        {
          nexusRequirements: {
            totalCount: 5,
            nodes: [
              node(30379, "SKSE64", "Hard requirement"),
              node(32444, "Address Library for SKSE Plugins"),
              node(37085, "Embers XD", "For the fire visuals"),
              node(12604, "SkyUI", "For the MCM"),
              { id: "ext-1", externalRequirement: true, modName: "ENB Series", url: "http://enbdev.com" },
            ],
          },
        },
      ],
      [makeModUid(1704, 30379), { nexusRequirements: { totalCount: 0, nodes: [] } }],
      [makeModUid(1704, 32444), { nexusRequirements: { totalCount: 1, nodes: [node(30379, "SKSE64")] } }],
      [makeModUid(1704, 47213), { nexusRequirements: { totalCount: 1, nodes: [node(32444, "Address Library for SKSE Plugins")] } }],
    ]);
    const nexusOnly = resolveNexusRequirements({
      mods,
      activeGame: "skyrimse",
      games,
      uidByMod,
      fetched: fetched as never,
      noUid,
      toDomain: nexusDomainOf,
      knownGameIds: ["skyrimse"],
    });
    const report = addMasterRequirements(nexusOnly, {
      mods,
      owners: [{ plugin: "Apocalypse - Magic of Skyrim.esp", modId: "needs-update" }],
      masters: new Map([["Apocalypse - Magic of Skyrim.esp", ["Skyrim.esm", "Update.esm", "Dawnguard.esm", "MysticOrdinator.esp"]]]),
      isBaseGame: (m) => /^(skyrim|update|dawnguard|hearthfires|dragonborn)\.esm$/i.test(m),
    });
    const session = getCuratorSession();
    session.setRequirements({
      gameId: "skyrimse",
      fetchedAt: Date.now(),
      load: {
        report,
        games,
        asked: uidByMod.size,
        answered: fetched.size,
        mastersRead: 1,
        mastersUnreadable: 0,
        plugins: readPluginList(state),
        headers: pluginHeaders(),
        stopped: false,
      },
    });
    try {
      write(
        "curator-requirements",
        React.createElement(ApiProvider, {
          api: { getState: () => state, store: { dispatch: () => undefined } },
          children: React.createElement(ToastProvider, {
            // The page's own split: the list left, the inspector sticky on the right.
            children: React.createElement(
              "div",
              { className: "eh-split" },
              React.createElement("div", { className: "eh-stack" }, React.createElement(CuratorPanel, {})),
              React.createElement(
                "aside",
                { className: "eh-split__aside" },
                React.createElement(RequirementsPanel, {
                mod: mods.find((m) => m.id === "needs-update")!,
                mods,
                report,
                entry: report.byMod.get("needs-update"),
                busy: false,
                canInstall: true,
                onClose: () => undefined,
                onEnable: () => undefined,
                onInstall: () => undefined,
                onInstallAll: () => undefined,
                onOpenPage: () => undefined,
                onFocus: () => undefined,
                onSaveNote: () => undefined,
                }),
              ),
            ),
          } as never),
        } as never),
      );
    } finally {
      session.setRequirements(undefined);
    }
  });

  it("preview — what the plan will do", () => {
    write(
      "preview",
      React.createElement(PreviewStep, {
        bundle,
        onContinue: () => undefined,
        onCancel: () => undefined,
      } as never),
    );
  });

  it("decisions — the mods needing a human answer", () => {
    // 27 of them on the real plan. This is the screen where a user with no
    // context has to make choices about mods they have never heard of.
    const base = bundle as unknown as { plan: Record<string, unknown> };
    const conflictBundle = {
      ...(bundle as unknown as Record<string, unknown>),
      plan: {
        ...base.plan,
        modResolutions: Array.from({ length: 27 }, (_, i) => ({
          compareKey: `ext:${i}`,
          name: `External Mod ${i}`,
          decision: {
            kind: "external-prompt-user",
            reason: "no bundled archive and no download link",
            // The real field, not a lookalike: the screen printed "undefined"
            // in its copy for as long as this fixture spelled it `fileName`.
            expectedFilename: `ExternalMod${i}.7z`,
          },
        })),
      },
    } as never;

    // DecisionsStep uses useApi() (not the optional variant), because picking
    // a local file needs a real Vortex to open a dialog. A minimal provider is
    // enough for a static render.
    write(
      "decisions",
      // `children` goes in the props object rather than as createElement's
      // third argument: ApiProvider declares it required, and the positional
      // form does not satisfy that.
      React.createElement(ApiProvider, {
        api: { getState: () => ({}) } as never,
        children: React.createElement(DecisionsStep, {
          state: {
            kind: "decisions",
            bundle: conflictBundle,
            conflictChoices: {},
            orphanChoices: {},
          },
          dispatch: () => undefined,
          onContinue: () => undefined,
        } as never),
      }),
    );
  });


  // The curator-side availability check. Rendered with a result that has
  // something wrong in it — a panel screenshotted in its happy state shows
  // the layout that never needed checking.
  // The curator's FIRST REAL RUN, verbatim: 2 blocked (both file-gone, both
  // with a replacement), 21 old-version, 8 unchecked. Invented round numbers
  // would have hidden the wording bug this reproduces — "2 of those… 2 of
  // these…" only looks wrong when the two counts are the same two mods.
  it("build-availability — the curator's real first run", () => {
    const finding = (
      modId: number,
      fileId: number,
      name: string,
      status: string,
      replacement?: { fileId: number; version: string },
    ) => ({
      compareKey: `nexus:${modId}:${fileId}`,
      name,
      modId,
      fileId,
      status,
      ...(replacement !== undefined ? { replacement } : {}),
    });
    const findings = [
      finding(69882, 406478, "Reapers Robco Munitions Patches-69882-5-2-1759089401", "file-missing", { fileId: 409332, version: "6.2" }),
      finding(4598, 270951, "Unofficial Fallout 4 Patch-4598-2-1-5-1679096028", "file-missing", { fileId: 407774, version: "2.2.2a" }),
      ...Array.from({ length: 21 }, (_, i) =>
        finding(50000 + i, 300000 + i, `Old version mod ${i}`, "old-version"),
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        finding(60000 + i, 310000 + i, `Unchecked mod ${i}`, "unknown"),
      ),
      ...Array.from({ length: 895 }, (_, i) =>
        finding(70000 + i, 320000 + i, `Fine mod ${i}`, "available"),
      ),
    ];
    write(
      "build-availability",
      React.createElement(AvailabilityPanel, {
        onCheck: () => undefined,
        onTreatAsExternal: () => undefined,
        externalModIds: new Set(["4598:270951"]),
        result: {
          checkedAt: new Date().toISOString(),
          findings,
          summary: summarizeAvailability(findings as never),
        },
      } as never),
    );
  });

  it("confirm — the last screen before an hour of work", () => {
    write(
      "confirm",
      React.createElement(ConfirmStep, {
        state: {
          kind: "confirm",
          bundle,
          decisions: { fomodReplayMode: "silent" } as never,
          conflictChoices: {},
          orphanChoices: {},
        },
        onInstall: () => undefined,
        onBack: () => undefined,
        onSetFomodMode: () => undefined,
      } as never),
    );
  });

  // The modal is what the Install button opens, and it is the only place the
  // question is asked — so it is the screen that actually needs looking at.
  // Rendered via ConfirmStep rather than in isolation so the real counts,
  // real copy and real Modal chrome all participate.
  it("confirm-asking — the modal, which cannot be dismissed into a default", () => {
    write(
      "confirm-asking",
      React.createElement(ConfirmStep, {
        state: {
          kind: "confirm",
          bundle,
          decisions: {} as never,
          conflictChoices: {},
          orphanChoices: {},
        },
        onInstall: () => undefined,
        onBack: () => undefined,
        onSetFomodMode: () => undefined,
        // Test-only: opens the modal at render time. Without it a static
        // render shows the closed state and the copy goes unlooked-at.
        __openModalForRender: true,
      } as never),
    );
  });

  it("installing — mid-run", () => {
    write(
      "installing",
      React.createElement(InstallingStep, {
        state: {
          kind: "installing",
          bundle,
          decisions: {} as never,
          progress: {
            phase: "installing-mods",
            currentStep: 412,
            totalSteps: 963,
            message: '[412/963] Installing "Tumba Gunner Collection"...',
          },
        } as never,
        onCancel: () => undefined,
        cancelPending: false,
      }),
    );
  });

  it("done — a install with everything to say", () => {
    // Deliberately the loud case: every notice present at once. This is what
    // a Proton tester's first run actually looks like, and the screen has to
    // stay readable in it.
    const result = {
      kind: "success",
      profileName: "Ivy 2 v1.0.10",
      installTargetMode: "fresh-profile",
      durationMs: 96 * 60_000 + 14_000,
      installedModIds: Array.from({ length: 958 }, (_, i) => `m${i}`),
      installedMods: Array.from({ length: 958 }, (_, i) => ({
        compareKey: `k${i}`,
        name: `Mod ${i}`,
        fromDecision: i < 931 ? "nexus-download" : "external-prompt-user",
      })),
      removedMods: [],
      carriedMods: [],
      skippedMods: [
        { compareKey: "s1", name: "Alex's Attach Points", reason: "no archive and no Nexus source" },
      ],
      verifications: [
        ...Array.from({ length: 940 }, (_, i) => ({
          kind: "ok",
          vortexModId: `v${i}`,
          compareKey: `k${i}`,
          name: `Mod ${i}`,
          level: "thorough",
          verifiedFileCount: 42,
          extraFileCount: 0,
        })),
        {
          kind: "fail",
          vortexModId: "v999",
          compareKey: "k999",
          name: "Ivy'sPantiesSettings",
          level: "thorough",
          expectedFileCount: 21,
          missingFileCount: 7,
          sizeMismatchCount: 0,
          hashMismatchCount: 0,
          examples: [{ bucket: "missing", path: "F4SE/Plugins/BakaMaxPapyrusOps.toml" }],
          retryAttempted: true,
        },
      ],
      pluginFlagNotice: [
        "Restored the collection's ESL (light) flag on 6 plugin(s). These do not use a regular load-order slot, which is what lets a collection this size load at all.",
      ],
      damagedArchiveNotice: [
        '"Point Lookout" — The archive on this machine is damaged — no reader can open it (no end of central directory record), and its bytes do not match what the collection was built from. This is a corrupted or incomplete download rather than anything wrong with the collection.',
      ],
      rulesPurgeNotice: [
        "The collection's conflict and load-order rules are now the only ones in place, so what loads is exactly what the curator tested. 14 mod rule(s) across 9 mod(s) were removed, and your LOOT rules were cleared.",
        "A copy of everything removed was saved to: C:/Users/x/AppData/Roaming/Vortex/event-horizon/rule-backups/rules-fallout4-2026-08-30T01-12-04-000Z.json",
      ],
      modTypeNotice: [
        "2 mod(s) installed as a different KIND of mod than the curator had, which means Vortex will deploy their files to a different folder. They are installed and their files are correct — they are in the wrong place, so the game may not load them.",
        '  • "F4SE": the curator had "dinput", this installed as a normal mod.',
        "Reinstalling the mod through Vortex usually re-detects the right kind. A script extender is the one that matters most: it must sit next to the game executable, not in Data.",
      ],
      pluginOrderNotice: [
        "Your plugin order differs from the curator's in 3 place(s).",
        "  • CompanionIvy.esm loads 4 positions later here.",
      ],
      stagingDriftNotice: [
        "2 mods on this machine changed since the collection last installed them, and they are unchanged in this version of the collection. That usually means something edited them in between — you, a tool, or the game itself. Nothing here is necessarily wrong.",
        "  - Enhanced Vanilla Water",
        "  - DriedBlood",
        "Reinstalling any of these returns it to the collection's version; leaving it keeps what is on disk. Event Horizon has changed nothing.",
      ],
      iniTweakNotice: [
        "3 INI tweak(s) are enabled across 2 mod(s). They are recorded in this collection, but the installer does not apply INI tweaks yet.",
      ],
      gameIniNotice: [
        "390 game setting(s) were written to Fallout4.ini, Fallout4Prefs.ini and Fallout4Custom.ini. 21 of your own settings were kept.",
      ],
      externalArchiveNotice: [
        '"Bodyslide" installed from a file you supplied that is not the one the collection was built from.',
      ],
      curatorReports: [
        "Event Horizon — mod could not be reproduced\n\nCollection: Ivy 2 v1.0.10\nMod: Ivy'sPantiesSettings\nMod id: external:9f2c...\n\nWhat happened\nAfter installing, this mod's files did not match what the collection recorded, and they do not match its archive either.\n\nMissing (7) — recorded, not installed:\n  - F4SE/Plugins/BakaMaxPapyrusOps.toml",
      ],
      rulesApplication: RULES,
      userlistApplication: USERLIST,
    } as never;

    write(
      "done-loud",
      React.createElement(DoneStep, {
        result,
        bundle,
        onStartOver: () => undefined,
        onGoCollections: () => undefined,
        onSwitchProfile: () => undefined,
      } as never),
    );
  });

  it("done — the quiet, everything-worked case", () => {
    const result = {
      kind: "success",
      profileName: "Ivy 2 v1.0.10",
      installTargetMode: "fresh-profile",
      durationMs: 96 * 60_000 + 14_000,
      installedModIds: Array.from({ length: 963 }, (_, i) => `m${i}`),
      installedMods: Array.from({ length: 963 }, (_, i) => ({
        compareKey: `k${i}`,
        name: `Mod ${i}`,
        fromDecision: "nexus-download",
      })),
      removedMods: [],
      carriedMods: [],
      skippedMods: [],
      verifications: Array.from({ length: 963 }, (_, i) => ({
        kind: "ok",
        vortexModId: `v${i}`,
        compareKey: `k${i}`,
        name: `Mod ${i}`,
        level: "thorough",
        verifiedFileCount: 42,
        extraFileCount: 0,
      })),
      rulesApplication: RULES,
      userlistApplication: USERLIST,
    } as never;

    write(
      "done-quiet",
      React.createElement(DoneStep, {
        result,
        bundle,
        onStartOver: () => undefined,
        onGoCollections: () => undefined,
        onSwitchProfile: () => undefined,
      } as never),
    );
  });

  it("pick — the first step, and the drop zone", () => {
    write("pick", React.createElement(PickStep, { onPick: () => undefined, onLink: () => undefined }));
  });

  it("link — a pasted link being fetched, and the hand-off when Nexus will not issue one", () => {
    write(
      "link-fetching",
      React.createElement(LinkFetchingStep, {
        state: {
          kind: "link-fetching",
          link: "https://www.nexusmods.com/skyrimspecialedition/mods/191460",
          source: "nexus",
          phase: "waiting-for-vortex",
          fileName: "meridia-panties-1.0.15.ehcoll",
          received: 4_200_000_000,
          total: 10_679_496_477,
        },
        onCancel: () => undefined,
      }),
    );
    write(
      "link-manual",
      React.createElement(LinkManualStep, {
        state: {
          kind: "link-manual",
          link: "https://www.nexusmods.com/fallout4/mods/108944",
          pageUrl: "https://www.nexusmods.com/fallout4/mods/108944?tab=files&file_id=410973",
          fileName: "ivy-panties-1.0.19.ehcoll",
          size: 3_430_197_672,
          version: "1.0.19",
          why: "Nexus hands direct download links to Premium accounts only. Without one, download the file yourself from its page:",
        },
        onPickDownloaded: () => undefined,
        onBack: () => undefined,
      }),
    );
  });

  it("loading — the hashing pass, which is what a user stares at", () => {
    write(
      "loading-hashing",
      React.createElement(LoadingStep, {
        phase: "hashing-mods",
        hashCount: 963,
        hashDone: 412,
        hashCurrent: "Tumba Gunner Collection-12345-1-0-1700000000.7z",
        onCancel: () => undefined,
      }),
    );
    write(
      "loading-phase",
      React.createElement(LoadingStep, { phase: "resolving-plan", onCancel: () => undefined }),
    );
  });

  it("about — the page nobody screenshots and everybody links to", () => {
    write("about", React.createElement(AboutPage, null));
  });

  it("build form — the curator's whole workbench", () => {
    // The largest form in the UI, converted to primitives without ever having
    // been rendered outside Vortex. Two external mods, one prerequisite, two
    // scope warnings and a validation error: the states that draw the parts.
    const ctx = {
      gameId: "skyrimse",
      gameVersion: "1.6.1170.0",
      configPath: "C:/Users/x/AppData/Roaming/Vortex/event-horizon/collections/.config/meridia.json",
      configCreated: false,
      collectionConfig: { externalDependencies: {} },
      mods: Array.from({ length: 1755 }, (_, i) => ({
        id: `mod-${i}`,
        name: `Mod ${i}`,
        nexusModId: String(1000 + i),
        nexusFileId: String(5000 + i),
      })),
      externalMods: [
        {
          id: "ext-1",
          name: "Meridia's Custom Follower Patch",
          installationPath: "C:/staging/meridia-follower",
          archiveSha256: "",
        },
        {
          id: "ext-2",
          name: "xLODGen Output",
          installationPath: "C:/staging/xlodgen",
          archiveSha256: "abc",
        },
      ],
      externalHints: new Map([
        ["ext-2", { via: "download-url", url: "https://example.com/xlodgen-output.7z" }],
      ]),
      scopeWarnings: [
        "9 external mods no longer match the archives they came from — their staging folders were edited after install.",
        "2 mods have no archive on disk; they can still be bundled from their staging folders.",
      ],
      rootFolderReview: [
        "Two mods install outside Data and will be deployed to the game root:",
        "  • SKSE64 (dinput)",
        "  • ENB Helper (engine injector)",
      ],
      detectedDependencies: [
        {
          id: "skse64",
          name: "SKSE64",
          version: "2.2.6",
          files: [{ path: "skse64_loader.exe" }, { path: "skse64_1_6_1170.dll" }],
          instructions: "Download the AE build and copy it next to SkyrimSE.exe.",
          instructionsUrl: "https://skse.silverlock.org/",
        },
      ],
    };
    write(
      "build-form",
      React.createElement(FormPanel, {
        state: {
          ctx,
          curator: {
            name: "Meridia's Panties",
            version: "1.0.4",
            author: "DuduPhudu",
            description: "",
            gameVersion: "1.6.1170.0",
            gameVersionPolicy: "exact",
          },
          overrides: { "ext-1": { treatAsExternal: true, url: "example.com/no-scheme" } },
          readme: "",
          changelog: "",
          validationError: "Version must be semver: 1.0.4a is not.",
          restoredAt: new Date(Date.now() - 12 * 60_000).toISOString(),
          reverifyEverything: false,
        },
        title: "Skyrim — main",
        onTitleChange: () => undefined,
        onChange: () => undefined,
        onBuild: () => undefined,
        onRefresh: () => undefined,
        refreshing: false,
        refreshedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
        onDiscardDraft: () => undefined,
        onDismissDraftBanner: () => undefined,
        recoverableCount: 2,
        onRecoverArchives: () => undefined,
        onCheckAvailability: () => undefined,
      } as never),
    );
  });
});
