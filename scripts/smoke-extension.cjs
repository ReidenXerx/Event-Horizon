/**
 * Load the BUILT extension with Vortex stubbed out and run `init()`.
 *
 * Why: `@nexusmods/vortex-api` is types-only — it has no runtime `main`, and the
 * real module is injected by Vortex's own loader (`extensionRequire.ts`). So
 * nothing outside Vortex ever executes this code, and a module-level throw or a
 * bad `registerAction` argument is invisible until the extension is loaded in the
 * app. This stubs the host just enough to answer one question: does it load and
 * wire itself up?
 *
 * WHAT THIS DOES NOT DO: it does not test behaviour. Every Vortex call is a stub,
 * so a green run means "the extension loads and registers what it claims", NOT
 * "export/build/install work". Real determinism coverage is still outstanding.
 *
 * Run after a build:  npm run smoke
 */
const Module = require("module");
const path = require("path");

const registered = { mainPages: [], actions: [] };
const iconSets = [];

const vortexApiStub = {
  util: {
    installIconSet: (name, p) => {
      iconSets.push({ name, path: p });
      return Promise.resolve();
    },
    getVortexPath: (k) => path.join(process.env.TEMP || "/tmp", "vortex-stub", k),
    getManifest: () => ({}),
    removeMods: () => Promise.resolve(),
    SevenZip: function SevenZip() {},
  },
  selectors: {
    activeGameId: () => "skyrimse",
    installPathForGame: () => "/stub/install",
    downloadPathForGame: () => "/stub/downloads",
  },
  actions: {
    setModEnabled: () => ({ type: "STUB" }),
    setLoadOrder: () => ({ type: "STUB" }),
    addModRule: () => ({ type: "STUB" }),
    removeModRule: () => ({ type: "STUB" }),
    setNextProfile: () => ({ type: "STUB" }),
    setProfile: () => ({ type: "STUB" }),
  },
  types: {},
  log: () => {},
};

/**
 * Vortex resolves `react` (and other host packages) for extension code through
 * `webpackRequireHack` in extensionRequire.ts, pulling them out of its own bundle
 * — NOT from a node_modules beside the extension. A deployed plugin folder has no
 * node_modules at all, so stub react here too. Without this the script only works
 * from the repo, which is the copy that matters least.
 *
 * init() registers; it does not render. A shallow stub is enough.
 */
const reactStub = new Proxy(
  {
    createElement: () => null,
    Fragment: "Fragment",
    createContext: () => ({ Provider: null, Consumer: null }),
    memo: (c) => c,
    forwardRef: (c) => c,
    Component: function Component() {},
    PureComponent: function PureComponent() {},
    useState: (v) => [typeof v === "function" ? v() : v, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
    useMemo: (f) => f(),
    useCallback: (f) => f,
    useContext: () => ({}),
    useReducer: (_r, i) => [i, () => {}],
  },
  { get: (t, k) => (k in t ? t[k] : () => {}) },
);

const electronStub = {
  remote: undefined,
  dialog: { showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }) },
  clipboard: { writeText: () => {} },
};

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (
    request === "@nexusmods/vortex-api" ||
    request === "vortex-api" ||
    request === "electron" ||
    request === "react" ||
    request === "react-dom"
  ) {
    return request; // handled by the load hook below
  }
  return origResolve.call(this, request, ...rest);
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "@nexusmods/vortex-api" || request === "vortex-api") return vortexApiStub;
  if (request === "electron") return electronStub;
  if (request === "react" || request === "react-dom") return reactStub;
  return origLoad.call(this, request, ...rest);
};

let mod;
try {
  mod = require(path.resolve(process.argv[2] || ".", "dist/index.js"));
} catch (err) {
  console.error("FAIL: module-level crash while loading dist/index.js");
  console.error("  " + (err && err.stack ? err.stack.split("\n").slice(0, 6).join("\n  ") : err));
  process.exit(1);
}

const init = typeof mod === "function" ? mod : mod.default;
console.log("entry export     :", typeof init === "function" ? "function (ok)" : "NOT A FUNCTION");
if (typeof init !== "function") process.exit(1);

const context = {
  api: {
    getState: () => ({ settings: { profiles: { activeProfileId: "p1" } }, persistent: {}, session: {} }),
    store: { dispatch: () => {}, getState: () => ({}) },
    sendNotification: () => {},
    showDialog: () => Promise.resolve({ action: "Cancel", input: {} }),
    events: { on: () => {}, emit: () => {} },
select: () => {},
  },
  registerMainPage: (icon, title, comp, opts) => registered.mainPages.push({ icon, title, opts }),
  registerAction: (group, pos, icon, opts, title) => registered.actions.push({ group, pos, title }),
  registerReducer: () => {},
  registerSettings: () => {},
  once: () => {},
};

let ret;
try {
  ret = init(context);
} catch (err) {
  console.error("FAIL: init() threw");
  console.error("  " + (err && err.stack ? err.stack.split("\n").slice(0, 8).join("\n  ") : err));
  process.exit(1);
}

console.log("init() returned  :", ret);
console.log("icon sets        :", iconSets.map((i) => i.name).join(", ") || "(none)");
console.log("main pages       :", registered.mainPages.length);
for (const p of registered.mainPages) {
  console.log(`   icon=${p.icon} title=${JSON.stringify(p.title)} group=${p.opts && p.opts.group} priority=${p.opts && p.opts.priority} id=${p.opts && p.opts.id}`);
}
console.log("actions          :", registered.actions.length);
for (const a of registered.actions) {
  console.log(`   ${a.group.padEnd(24)} ${String(a.pos).padEnd(4)} ${a.title}`);
}

// sanity assertions
let bad = 0;
if (ret !== true) { console.error("WARN: init() did not return true"); bad++; }
if (registered.mainPages.length !== 1) { console.error("WARN: expected exactly 1 main page"); bad++; }
// Four since the legacy BUILD dialog was deleted. It was the second door into
// the build, and every gate added since had to be ported into it by hand;
// twice nobody did, and by the time it went it was missing five of them.
// The legacy INSTALL fallback stays — one gate, not a growing set.
if (registered.actions.length !== 4) { console.error("WARN: expected 4 actions"); bad++; }
const dupes = new Map();
for (const a of registered.actions) {
  const key = a.group + "#" + a.pos;
  if (dupes.has(key)) { console.error(`WARN: duplicate toolbar slot ${key}`); bad++; }
  dupes.set(key, true);
}
/**
 * ─── THE MODULE GRAPH, NOT JUST THE ENTRY POINT ─────────────────────────────
 * Everything above proves `index.js` loads and registers what it should. That
 * is not the same as proving the code behind it RESOLVES, and the difference
 * shipped:
 *
 *     Couldn't read meridia-panties-1.0.10.ehcoll, so there is nothing to
 *     compare against: (0 , paths_1.toPosix) is not a function
 *
 * `src/core/paths.ts` had become the directory `src/core/paths/`, and `tsc`
 * left the old `dist/core/paths.js` behind. Node resolves `require("../paths")`
 * to the FILE before the DIRECTORY, so every path helper in the project bound
 * to a module that no longer had them. `tsc` was clean, 2,110 tests passed —
 * they run from `src/` — and this smoke test said SMOKE OK, because requiring
 * a module never calls into it.
 *
 * So: reach into the built graph and CALL something. These are cheap, pure,
 * and each one is a binding that a stale or shadowed module would break.
 */
const graphChecks = [
  {
    module: "../dist/core/paths",
    fn: (m) => m.toPosix("a\\b"),
    expect: "a/b",
    why: "the path service — shadowed by a stale dist/core/paths.js once",
  },
  {
    module: "../dist/core/paths",
    fn: (m) => m.basenameOf("a/b/c.txt"),
    expect: "c.txt",
  },
  {
    module: "../dist/core/paths",
    fn: (m) => m.pathKey("A/B.TXT", "insensitive"),
    expect: "a/b.txt",
  },
  {
    module: "../dist/core/volatileFiles",
    fn: (m) => String(m.isVolatileFile("Thumbs.db")),
    expect: "true",
    why: "imports the path service; proves the barrel resolves for consumers",
  },
  {
    module: "../dist/core/manifest/storeCompatibility",
    fn: (m) => String(m.isScriptExtenderPlugin("SKSE/Plugins/x.dll")),
    expect: "true",
  },
];

for (const check of graphChecks) {
  let actual;
  try {
    actual = check.fn(require(check.module));
  } catch (err) {
    console.error(
      `FAIL: ${check.module} — ${err && err.message ? err.message : err}` +
        (check.why ? `\n      (${check.why})` : ""),
    );
    bad++;
    continue;
  }
  if (actual !== check.expect) {
    console.error(
      `FAIL: ${check.module} returned ${JSON.stringify(actual)}, expected ${JSON.stringify(check.expect)}`,
    );
    bad++;
  }
}
console.log("module graph     :", `${graphChecks.length} binding(s) called`);

console.log(bad === 0 ? "\nSMOKE OK" : `\nSMOKE finished with ${bad} warning(s)`);
if (bad > 0) process.exit(1);
