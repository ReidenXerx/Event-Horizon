/**
 * The table of promises, and the check that it is still telling the truth.
 *
 * `manifestFieldFates.ts` says, per shipped field, whether anything on the
 * user's side acts on it. The mapped type over `Required<>` makes the compiler
 * demand an entry for every field — that half is free.
 *
 * This is the other half, and it is the half that matters. A claim about
 * behaviour rots: this repo shipped a build warning telling curators that INI
 * tweaks were never applied while `applyIniTweaks.ts` sat beside it applying
 * them, and testers were sent to redo by hand what the driver had already
 * done. The comment was true when written and nobody re-checked it.
 *
 * So every `applied` entry names a file, and this opens that file and looks.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MANIFEST_FATES,
  MOD_INSTALL_STATE_FATES,
  PLUGIN_ENTRY_FATES,
  NATIVE_PLUGIN_FATES,
  type FieldFate,
} from "./manifestFieldFates";

const SRC = join(__dirname, "..", "..");

const entries = (table: Record<string, FieldFate>): [string, FieldFate][] =>
  Object.entries(table);

const ALL = [
  ...entries(MOD_INSTALL_STATE_FATES),
  ...entries(MANIFEST_FATES),
  ...entries(PLUGIN_ENTRY_FATES),
  ...entries(NATIVE_PLUGIN_FATES),
];

/** Files that act on a mod's install state on the user's machine. */
const READ_SIDE = [
  "core/installer/runInstall.ts",
  "core/installer/applyModTypes.ts",
  "core/installer/applyIniTweaks.ts",
  "core/installer/applyLoadOrder.ts",
  "core/installer/applyGameIni.ts",
  "core/installer/verifyModInstall.ts",
  "core/resolver/resolveInstallPlan.ts",
];

/**
 * Does `src` read `.state.<field>` as a whole property name?
 *
 * Written without regex escaping on purpose. The first version of this check
 * built its pattern in a template literal, where the intended word boundary
 * became a literal backspace character — so it matched nothing and passed for
 * the wrong reason. A test that cannot fail is worse than no test, so the
 * matcher below is itself exercised in both directions further down.
 */
/** Source with comments removed, so a mention in prose is not evidence. */
function stripComments(src: string): string {
  const noBlock = src.split(/\/\*[\s\S]*?\*\//).join(" ");
  return noBlock
    .split("\n")
    .map((line) => {
      // Not a URL: only strip `//` that is not preceded by a colon.
      const at = line.search(/(^|[^:])\/\//);
      return at === -1 ? line : line.slice(0, at === 0 ? 0 : at + 1);
    })
    .join("\n");
}

/**
 * Does this source actually READ the field — as `x.field` or `{ field }`?
 *
 * Deliberately stricter than a substring and deliberately looser than
 * `readsStateField`: manifest fields are reached through many receivers
 * (`manifest.plugins`, `plan.manifest.rules`, a destructured `{ mods }`), so
 * pinning the receiver would produce false failures. Requiring a property
 * access or a binding is what separates "reads it" from "says it".
 */
function accessesField(src: string, field: string): boolean {
  const body = stripComments(src);
  const wordChar = /[A-Za-z0-9_]/;

  // `x.field`, where what follows is not more identifier — the same
  // prefix trap `readsStateField` guards (`plugins` vs `pluginsExtra`).
  const dotted = `.${field}`;
  for (let at = body.indexOf(dotted); at !== -1; at = body.indexOf(dotted, at + 1)) {
    const next = body.charAt(at + dotted.length);
    if (next === "" || !wordChar.test(next)) return true;
  }

  // `const { field } = manifest`, or `{ field, ... }`.
  for (let at = body.indexOf(field); at !== -1; at = body.indexOf(field, at + 1)) {
    const before = body.slice(0, at).trimEnd();
    const after = body.slice(at + field.length).trimStart();
    const opener = before.charAt(before.length - 1);
    const closer = after.charAt(0);
    const bound = opener === "{" || opener === ",";
    const ends = closer === "," || closer === "}" || closer === ":" || closer === "=";
    if (bound && ends && !wordChar.test(body.charAt(at - 1))) return true;
  }

  return false;
}

function readsStateField(src: string, field: string): boolean {
  const needle = `.state.${field}`;
  const wordChar = /[A-Za-z0-9_]/;
  let at = src.indexOf(needle);
  while (at !== -1) {
    const next = src.charAt(at + needle.length);
    // `.state.enabled` is a prefix of `.state.enabledINITweaks`; only a
    // non-identifier character after it means this field was the one read.
    if (next === "" || !wordChar.test(next)) return true;
    at = src.indexOf(needle, at + 1);
  }
  return false;
}

describe("the whole-name matcher can actually fail", () => {
  it("sees a real read", () => {
    expect(
      readsStateField("const x = mod.state.deploymentPriority;", "deploymentPriority"),
    ).toBe(true);
  });

  it("does not mistake a longer field for a shorter one", () => {
    expect(readsStateField("mod.state.enabledINITweaks ?? []", "enabled")).toBe(
      false,
    );
  });

  it("still sees the longer field under its own name", () => {
    expect(
      readsStateField("mod.state.enabledINITweaks ?? []", "enabledINITweaks"),
    ).toBe(true);
  });
});

describe("the matcher behind the applied check", () => {
  it("does not accept a mention in a comment", () => {
    // The exact false pass that let `externalDependencies` claim to be
    // applied while nothing consumed it.
    expect(accessesField("// externalDependencies are verified later", "externalDependencies")).toBe(false);
    expect(accessesField("/* about externalDependencies */", "externalDependencies")).toBe(false);
  });

  it("accepts a real property access or a destructure", () => {
    expect(accessesField("manifest.externalDependencies.map(x)", "externalDependencies")).toBe(true);
    expect(accessesField("const { rules } = manifest;", "rules")).toBe(true);
    expect(accessesField("plan.manifest.plugins.order", "plugins")).toBe(true);
  });

  it("does not mistake a longer identifier for the field", () => {
    expect(accessesField("x.loadOrderEntries", "loadOrder")).toBe(false);
    expect(accessesField("x.loadOrder;", "loadOrder")).toBe(true);
  });
});

describe("every applied field really is applied", () => {
  const applied = ALL.filter(([, f]) => f.kind === "applied") as [
    string,
    Extract<FieldFate, { kind: "applied" }>,
  ][];

  it("names a reader for a real number of fields", () => {
    // Guards against the table being emptied and this suite passing vacuously.
    expect(applied.length).toBeGreaterThan(10);
  });

  it("points at files that exist", () => {
    const missing = applied
      .filter(([, f]) => !existsSync(join(SRC, f.by)))
      .map(([field, f]) => `${field} -> ${f.by}`);
    expect(missing).toEqual([]);
  });

  it("points at files that ACCESS the field, not ones that mention it", () => {
    /**
     * ─── A SUBSTRING MATCH IS NOT EVIDENCE OF A READER ─────────────────
     * This was `readFileSync(...).includes(field)`, which passes when the
     * field name appears anywhere at all — in a comment, an import, an
     * unrelated identifier that merely contains it. `resolveInstallPlan.ts`
     * says "externalDependencies" in prose, so the table's claim that it was
     * APPLIED passed this check for as long as it was false.
     *
     * Forty lines above, `readsStateField` was already doing this properly,
     * and it was wired to the ModInstallState table only. The manifest half —
     * the whole shipped format — had the weak one. So the guard was strong
     * exactly where it had never been needed and cosmetic where it was.
     *
     * Comments are stripped first, then the field must appear as an actual
     * property access or a destructured binding.
     */
    const silent = applied
      .filter(([field, f]) => !accessesField(readFileSync(join(SRC, f.by), "utf8"), field))
      .map(([field, f]) => `${f.by} never reads ${field}, it only mentions it`);
    expect(silent).toEqual([]);
  });
});

describe("every unread field says why", () => {
  it("gives a reason long enough to be one", () => {
    // "recorded only" with no reason is how a gap becomes permanent: the next
    // reader cannot tell a decision from an oversight.
    const thin = ALL.filter(
      ([, f]) =>
        f.kind !== "applied" && (f as { why: string }).why.trim().length < 40,
    ).map(([field]) => field);
    expect(thin).toEqual([]);
  });
});

describe("no unread field has quietly grown a reader", () => {
  it("finds nothing acting on a field the table calls unread", () => {
    const sources = READ_SIDE.map((rel) => readFileSync(join(SRC, rel), "utf8"));
    const surprises: string[] = [];
    for (const [field, fate] of entries(MOD_INSTALL_STATE_FATES)) {
      if (fate.kind !== "recorded-only") continue;
      sources.forEach((src, i) => {
        if (readsStateField(src, field)) {
          surprises.push(`${READ_SIDE[i]} reads .state.${field}`);
        }
      });
    }
    // A hit is GOOD news about the code and bad news about the table:
    // something started applying a field recorded here as unread.
    expect(surprises).toEqual([]);
  });
});
