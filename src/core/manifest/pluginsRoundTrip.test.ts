/**
 * ──────────────────────────────────────────────────────────────────────
 * The plugin data has to survive the whole journey, byte for byte.
 *
 * Three defects shipped through this path at once, and each was invisible to
 * the tests that existed, because every one of those tests built its fixture
 * in memory as `{ name, enabled }` objects. Nothing ever went through a real
 * `plugins.txt`, and nothing ever went through the parser of the shipped
 * format — there was no `parseManifest` test at all.
 *
 *   1. `parseManifest` dropped `light` entirely. The curator captured 573 ESL
 *      flags, wrote them into the package, and the user's machine parsed them
 *      away. The e2e tests passed because they construct the manifest in
 *      memory and never round-trip it through the parser.
 *   2. plugins.txt was read as utf8. Vortex writes it as latin1, so any
 *      non-ASCII name became U+FFFD and the real plugin was silently pushed
 *      to the end of the load order.
 *   3. The `*` prefix was assumed for every game, but the "original" format
 *      has no prefix — so every plugin parsed as disabled, and the installer
 *      then disabled the player's entire list.
 *
 * All three are the same shape: a value that is destroyed in transit while
 * both ends still agree, so every comparison says "matches". These tests
 * exist to make that shape impossible to reintroduce.
 * ──────────────────────────────────────────────────────────────────────
 */
import { describe, expect, it } from "vitest";

import { parseManifest } from "./parseManifest";
import {
  getCurrentPluginsTxtPath,
  parsePluginsTxt,
  supportsPluginsTxt,
} from "../comparePlugins";

/** A manifest skeleton the strict parser accepts, so a test can vary one thing. */
function manifestWith(order: unknown[], pluginsExtra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    package: {
      id: "123e4567-e89b-12d3-a456-426614174000",
      name: "p",
      version: "1.0.0",
      createdAt: "2026-01-01T00:00:00Z",
      verification: "thorough",
      author: "a",
      strictMissingMods: false,
    },
    game: {
      id: "skyrimse",
      name: "Skyrim SE",
      version: "1.6.640",
      versionPolicy: "minimum",
    },
    vortex: {
      version: "2.6.0",
      deploymentMethod: "hardlink",
      requiredExtensions: [],
    },
    mods: [],
    rules: [],
    plugins: { order, ...pluginsExtra },
    loadOrder: [],
    userlist: { plugins: [], groups: [] },
    gameIni: { files: [] },
    externalDependencies: [],
    iniTweaks: [],
  });
}

describe("the ESL flag survives the parser", () => {
  it("carries light through, in BOTH directions, and keeps absent absent", () => {
    /**
     * The three states are not two. `false` means "the curator's copy is not
     * light, clear the flag"; absent means "we could not read it, leave the
     * user's file alone". Collapsing absent to `false` would clear legitimate
     * flags on every plugin whose header the build could not read.
     */
    const parsed = parseManifest(
      manifestWith([
        { name: "Light.esp", enabled: true, light: true },
        { name: "Heavy.esp", enabled: true, light: false },
        { name: "Unknown.esp", enabled: true },
      ]),
    );

    const order = parsed.manifest.plugins.order;
    expect(order[0]?.light).toBe(true);
    expect(order[1]?.light).toBe(false);
    expect("light" in (order[2] ?? {})).toBe(false);
  });

  it("rejects a light that is not a boolean rather than coercing it", () => {
    // A truthy string would otherwise become "yes, flag it" and rewrite a
    // header bit off a typo.
    expect(() =>
      parseManifest(
        manifestWith([{ name: "A.esp", enabled: true, light: "yes" }]),
      ),
    ).toThrow(/light must be a boolean/);
  });

  it("keeps every field of a fully-populated entry", () => {
    /**
     * The guard against the NEXT one of these. `manifestFieldFates` only
     * covers the manifest's top-level keys, so a field added inside
     * `plugins.order[]` has nothing watching it — which is exactly how
     * `light` was shipped, written, and never read. If someone adds a field
     * to `EhcollPluginEntry`, this fails until the parser carries it.
     */
    const full = { name: "A.esp", enabled: true, light: true };
    const parsed = parseManifest(manifestWith([full]));
    expect(parsed.manifest.plugins.order[0]).toEqual(full);
  });

});

describe("the bit the light values came from survives the parser", () => {
  /**
   * Dropped here, a Starfield package built correctly would read as one from
   * before flags were per game, and the installer would refuse every flag the
   * curator recorded. Absent must stay absent: that IS the legacy signal.
   */
  it("carries lightFlagBit through, and keeps it absent when it was absent", () => {
    const withBit = parseManifest(
      manifestWith([{ name: "A.esm", enabled: true, light: true }], { lightFlagBit: 0x100 }),
    );
    expect(withBit.manifest.plugins.lightFlagBit).toBe(0x100);

    const without = parseManifest(manifestWith([{ name: "A.esm", enabled: true, light: true }]));
    expect("lightFlagBit" in without.manifest.plugins).toBe(false);
  });

  it("rejects a value that is not a single header bit", () => {
    for (const bad of [0x300, "0x100", 0, -256]) {
      expect(() =>
        parseManifest(manifestWith([{ name: "A.esm", enabled: true }], { lightFlagBit: bad })),
      ).toThrow(/lightFlagBit must be a single header bit/);
    }
  });
});

describe("plugins.txt is latin1, the way Vortex writes it", () => {
  /**
   * A byte-level fixture, not a string literal. The bug was an ENCODING, so a
   * fixture that is already a JS string cannot express it — the bytes have to
   * be what Vortex actually put on disk.
   */
  const VORTEX_BYTES = Buffer.from(
    "# Automatically generated by Vortex\r\n" +
      "*Skyrim.esm\r\n" +
      "*Träume.esp\r\n" +
      "Disabled.esp\r\n",
    "latin1",
  );

  it("reads a non-ASCII plugin name back exactly", () => {
    const entries = parsePluginsTxt(VORTEX_BYTES.toString("latin1"));
    expect(entries.map((e) => e.name)).toEqual([
      "Skyrim.esm",
      "Träume.esp",
      "Disabled.esp",
    ]);
  });

  it("would mangle that name if read as utf8 — the defect, pinned", () => {
    // Kept as a test rather than a comment so the claim stays checkable: this
    // is what the old code did, and why the drift check stayed silent about
    // it (both sides mangled identically, so they "matched").
    const wrong = parsePluginsTxt(VORTEX_BYTES.toString("utf8"));
    expect(wrong[1]?.name).not.toBe("Träume.esp");
    expect(wrong[1]?.name).toContain("�");
  });

  it("keeps the * prefix meaning enabled, and strips the header and CRLF", () => {
    const entries = parsePluginsTxt(VORTEX_BYTES.toString("latin1"));
    expect(entries.map((e) => e.enabled)).toEqual([true, true, false]);
  });
});

describe("the original plugins.txt format is refused, not guessed at", () => {
  it("refuses Skyrim LE by name and says why", () => {
    // Skyrim LE lists only enabled plugins with NO prefix. Parsing it with
    // the fallout4 rule made every plugin read as disabled, and the installer
    // then disabled the player's whole list and had Vortex write that out.
    expect(supportsPluginsTxt("skyrim")).toBe(false);
    expect(() => getCurrentPluginsTxtPath("skyrim")).toThrow(/original/);
    expect(() => getCurrentPluginsTxtPath("skyrim")).toThrow(/loadorder\.txt/);
  });

  it("refuses the other original-format games too", () => {
    for (const id of ["fallout3", "falloutnv", "oblivion"]) {
      expect(supportsPluginsTxt(id)).toBe(false);
      expect(() => getCurrentPluginsTxtPath(id)).toThrow(/original/);
    }
  });

  it("still supports the fallout4-format games", () => {
    for (const id of ["skyrimse", "fallout4", "skyrimvr", "fallout4vr"]) {
      expect(supportsPluginsTxt(id)).toBe(true);
      expect(getCurrentPluginsTxtPath(id)).toContain("plugins.txt");
    }
  });

  it("still refuses a game it has never heard of", () => {
    expect(supportsPluginsTxt("morrowind")).toBe(false);
    expect(() => getCurrentPluginsTxtPath("morrowind")).toThrow(/Unsupported/);
  });
});
