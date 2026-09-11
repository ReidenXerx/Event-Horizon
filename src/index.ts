import * as path from "path";
import { util, type types } from "@nexusmods/vortex-api";

import createExportModsAction from "./actions/exportModsAction";
import createCompareModsAction from "./actions/compareModsAction";
import { createComparePluginsAction } from "./actions/comparePluginsAction";
import createInstallCollectionAction from "./actions/installCollectionAction";
import { EventHorizonMainPage } from "./ui";
import { ehLog, getLogFilePath } from "./core/logging/ehLog";
import {
  probeInstallerApi,
  watchInstallCalls,
} from "./core/installer/probeInstallerApi";
import { probeNexusAccount } from "./core/installer/checkNexusAccount";
import { EXTENSION_VERSION } from "./ui/version";

/**
 * Symbol id of the Event Horizon glyph inside our SVG sprite.
 * Must match the `<symbol id="...">` in `assets/icons/event-horizon.svg`.
 *
 * Vortex's <Icon name=...> component walks all installed icon sets and
 * resolves the first matching symbol id, so a unique-by-prefix name
 * (`event-horizon-logo`) avoids any collisions with the bundled
 * font-awesome / nucleo sets.
 */
const EH_SIDEBAR_ICON = "event-horizon-logo";

/**
 * Lazily install the monochrome SVG sprite used for the sidebar tab.
 * Called once on first context render — failure is non-fatal: we just
 * fall back to the default font-awesome glyph (`compare`) so the page
 * is still reachable even when the asset is missing.
 *
 * Resolves __dirname relative to the compiled extension entry point.
 * In production Vortex copies the extension folder verbatim, so the
 * sprite lives at `<extDir>/assets/icons/event-horizon.svg`.
 */
function installEventHorizonIconSet(): void {
  try {
    const setPath = path.join(
      __dirname,
      "..",
      "assets",
      "icons",
      "event-horizon.svg",
    );
    void util.installIconSet("event-horizon", setPath).catch((err: unknown) => {
      // Best-effort — never crash extension load over a missing icon.
      // eslint-disable-next-line no-console
      console.warn("[Event Horizon] failed to install icon set:", err);
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[Event Horizon] icon set install threw:", err);
  }
}

function init(context: types.IExtensionContext): boolean {
  const exportModsAction = createExportModsAction(context);
  const compareModsAction = createCompareModsAction(context);
  const comparePluginsAction = createComparePluginsAction(context);
  const installCollectionAction = createInstallCollectionAction(context);

  // Install our custom sidebar glyph BEFORE registering the main page —
  // the icon registry must contain the symbol id by the time Vortex
  // first resolves the sidebar tab.
  installEventHorizonIconSet();
  // Register the Event Horizon mainPage. Vortex renders this in its
  // sidebar under the "global" group (visible regardless of which
  // game profile is active). Phase 5.0 wires up the shell, nav,
  // animated logo, and placeholder pages; later slices fill in the
  // install / collections / build flows.
  // The `props` callback runs every time Vortex re-renders the main
  // page; we use it to inject the live `IExtensionApi` so our React
  // tree can call into Vortex (file pickers, dispatch, getState,
  // showDialog fallbacks, ...) without us hand-threading it everywhere.
  // First line of every session. Establishes that the extension loaded at all,
  // which build it is, and where the rest of the log is going.
  ehLog("info", "extension.init", {
    version: EXTENSION_VERSION,
    logFile: getLogFilePath(),
  });

  context.registerMainPage(
    EH_SIDEBAR_ICON,
    "Event Horizon",
    EventHorizonMainPage,
    {
      id: "event-horizon",
      group: "global",
      priority: 50,
      props: () => ({ api: context.api }),
    },
  );

  context.registerAction(
    "mod-icons",
    100,
    "show",
    {},
    "Export Mods To JSON",
    () => {
      void exportModsAction();
    },
  );

  context.registerAction(
    "mod-icons",
    101,
    "show",
    {},
    "Compare Current Mods With JSON",
    () => {
      void compareModsAction();
    },
  );

  context.registerAction(
    "gamebryo-plugin-icons",
    150,
    "show",
    {},
    "Compare Plugins With TXT",
    () => {
      void comparePluginsAction();
    },
  );

  /**
   * ─── THE BUILD DIALOG IS GONE, AND THAT IS THE FIX ────────────────────
   * There were two doors into the build, and every rule added since had to be
   * ported by hand into both. Twice nobody did:
   *
   *  - The missing-master gate guarded the page only, so this action shipped
   *    packages a user could not install (fixed by extracting `gateOnMasters`).
   *  - The bundled-archive resolver was two copies that had diverged (fixed by
   *    extracting `resolveBundledArchives`).
   *
   * Four test files exist purely to police that divergence, and 83f10e0
   * already concluded the approach cannot hold: "a regex over source text can
   * only police the rules somebody remembered to enumerate." At deletion time
   * the action was still missing FIVE more — no ESL flags recorded
   * (`pluginLightFlags` had exactly one call site, the page), no preflight
   * refusal, no self-checks, no post-processed declarations, no mirror
   * payload. All silent: the output is a real `.ehcoll` through the same
   * `buildManifest` → `packageEhcoll` pipeline, byte-indistinguishable from a
   * correct one until somebody installs it.
   *
   * Its own header called it transitional scaffolding. One door now, so the
   * seventh divergence cannot be written.
   *
   * The INSTALL fallback below stays: it has one gate, not a growing set, and
   * it is genuinely useful for scripted testing.
   */

  // Toolbar fallback — kept so power users can hit the install flow outside
  // the Event Horizon main page (handy for CI / scripted testing). The
  // mainPage is the recommended UX.
  context.registerAction(
    "global-icons",
    103,
    "show",
    {},
    "Event Horizon: Install (legacy dialog)",
    () => {
      void installCollectionAction();
    },
  );

  // Vortex's events are untyped and `start-install` is absent from the
  // published typings, so the only way to learn what the installer accepts is
  // to ask the running app. Deferred to `once` so every extension has
  // registered its handlers before we look.
  context.once(() => {
    probeInstallerApi(context.api);
    watchInstallCalls(context.api);
    // The curator's load order is undone by Vortex's own sort, silently;
    // this is the one thing that says so without opening Doctor.
    void import("./core/doctor/loadOrderWatcher").then(({ startLoadOrderWatcher }) => startLoadOrderWatcher(context.api));
    // Whether this account can download at all is the other thing the
    // typings cannot answer. Logged for the same reason: so a check that
    // never works is visible as that, rather than as silence.
    probeNexusAccount(context.api);
  });

  return true;
}

export default init;
