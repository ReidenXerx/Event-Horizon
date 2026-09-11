/**
 * A class name nothing declares is a silent no-op: `className="eh-stak"`
 * renders an unstyled div and neither the compiler nor any test notices.
 * This is the class-name twin of tokens.test.ts — it walks the real source,
 * collects every `eh-*` class a component asks for, and asserts the theme
 * declares a rule for it.
 *
 * Declared means "appears as `.eh-name` somewhere in a theme module". A class
 * that only ever serves as a JS hook (querySelector) still has to be declared
 * so its purpose is written down next to the others.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const UI = join(__dirname, "..");
const THEME = __dirname;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/**
 * `eh-…` identifiers that are NOT class names: Vortex notification and
 * dialog ids, an SVG gradient id. Listed here so a new one has to be named
 * rather than silently skipped.
 */
const NOT_A_CLASS = new Set([
  "eh-ring-gradient", // <linearGradient id> in ProgressRing
  "eh-doctor-collection", // Vortex notification id
  "eh-sevenzip-health",
  "eh-prereq-repair",
  "eh-mod-diff-file-select", // a Field's element id on the diff pages
  "eh-diff-file-select",
]);

/** A class named only in a comment is not declared and not referenced. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Every `.eh-…` selector and `@keyframes eh-…` name in the theme modules. */
export function declaredClasses(): Set<string> {
  const declared = new Set<string>();
  for (const file of readdirSync(THEME)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const text = stripComments(readFileSync(join(THEME, file), "utf8"));
    for (const m of text.matchAll(/(?:\.|@keyframes\s+)(eh-[a-z0-9]+(?:[_-]+[a-z0-9]+)*)/g)) {
      declared.add(m[1]!);
    }
  }
  return declared;
}

/** The CSS the theme modules ship: the contents of their template literals. */
export function themeCss(): { file: string; css: string }[] {
  const out: { file: string; css: string }[] = [];
  for (const file of readdirSync(THEME)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const text = stripComments(readFileSync(join(THEME, file), "utf8"));
    for (const m of text.matchAll(/`([^`]*)`/g)) out.push({ file, css: m[1]! });
  }
  return out;
}

type Rule = { selector: string; empty: boolean };

/**
 * Every rule block in a stylesheet, with whether its body is empty.
 *
 * Nested blocks (`@media { .eh-x { … } }`) are walked; a block that holds
 * other blocks is not empty. The selector is the text since the last `;`,
 * `{` or `}`, so a preceding `@import …;` does not become part of it.
 */
export function cssRules(css: string): Rule[] {
  const rules: Rule[] = [];
  const open: { selector: string; holdsRules: boolean }[] = [];
  let text = "";
  for (const ch of css) {
    if (ch === "{") {
      open.push({ selector: text.slice(text.lastIndexOf(";") + 1).trim(), holdsRules: false });
      text = "";
    } else if (ch === "}") {
      const rule = open.pop();
      if (rule !== undefined) {
        rules.push({ selector: rule.selector, empty: !rule.holdsRules && text.trim() === "" });
        const parent = open[open.length - 1];
        if (parent !== undefined) parent.holdsRules = true;
      }
      text = "";
    } else {
      text += ch;
    }
  }
  return rules;
}

/**
 * Rules that name an `eh-` class (or keyframes) and declare nothing.
 *
 * "Declared" above means the name appears; `.eh-bar__fill { }` passes that
 * and styles nothing, which is the same silent no-op as never declaring it.
 */
export function emptyEhRules(css: string): string[] {
  return cssRules(css)
    .filter((r) => r.empty && /(?:\.|@keyframes\s+)eh-[a-z0-9]/.test(r.selector))
    .map((r) => r.selector);
}

type Reference = { cls: string; file: string; line: number };

/**
 * Every `eh-…` class a component references, verbatim. Template classes
 * such as `eh-button--${intent}` are reported separately by
 * {@link templatedPrefixes}: a first version of this claimed to match their
 * static prefix and matched nothing at all, because the lookahead refused
 * the `-` before `${` — fifteen sites the audit never looked at.
 */
export function referencedClasses(): Reference[] {
  const found: Reference[] = [];
  for (const file of sourceFiles(UI)) {
    if (file.startsWith(THEME) || file.endsWith(".test.ts")) continue;
    const text = stripComments(readFileSync(file, "utf8"));
    for (const m of text.matchAll(/["'`\s](eh-[a-z0-9]+(?:[_-]+[a-z0-9]+)*)(?=[\s"'`$]|$)/g)) {
      found.push({
        cls: m[1]!,
        file: file.slice(UI.length + 1).split("\\").join("/"),
        line: text.slice(0, m.index).split("\n").length,
      });
    }
  }
  return found;
}

/**
 * `eh-block--${modifier}` sites: the base must be declared, and at least
 * one `eh-block--…` modifier must exist, or the template can only ever
 * produce classes nothing styles.
 */
export function templatedPrefixes(): Reference[] {
  const found: Reference[] = [];
  for (const file of sourceFiles(UI)) {
    if (file.startsWith(THEME) || file.endsWith(".test.ts")) continue;
    const text = stripComments(readFileSync(file, "utf8"));
    for (const m of text.matchAll(/(eh-[a-z0-9]+(?:[_-]+[a-z0-9]+)*)--\$\{/g)) {
      found.push({
        cls: m[1]!,
        file: file.slice(UI.length + 1).split("\\").join("/"),
        line: text.slice(0, m.index).split("\n").length,
      });
    }
  }
  return found;
}

describe("theme classes", () => {
  it("declares every class a component uses", () => {
    const declared = declaredClasses();
    const missing = referencedClasses().filter(
      (r) => !declared.has(r.cls) && !NOT_A_CLASS.has(r.cls),
    );
    expect(missing.map((r) => `${r.cls} at ${r.file}:${r.line}`)).toEqual([]);
  });

  it("declares a base and at least one modifier for every templated class", () => {
    const declared = [...declaredClasses()];
    // A pure-modifier family (eh-tone--*) has no base class on purpose; what
    // must exist is at least one modifier the template can produce.
    const missing = templatedPrefixes().filter(
      (r) => !declared.some((d) => d.startsWith(`${r.cls}--`)),
    );
    expect(missing.map((r) => `${r.cls}--\${…} at ${r.file}:${r.line}`)).toEqual([]);
    // The check has to see the sites it exists for.
    expect(templatedPrefixes().length).toBeGreaterThan(8);
  });

  it("declares every modifier a union can produce", () => {
    // Per-component unions: the template above only proves ONE modifier
    // exists; this proves the ones the props allow.
    const declared = declaredClasses();
    const expected = [
      ...["success", "info", "warning", "danger"].map((i) => `eh-toast--${i}`),
      ...["primary", "ghost", "danger"].map((i) => `eh-button--${i}`),
      ...["success", "warning", "danger", "info"].map((i) => `eh-pill--${i}`),
      ...["info", "success", "warning", "danger"].map((i) => `eh-callout--${i}`),
      ...["quiet", "info", "success", "warning", "danger"].map((t) => `eh-stat--${t}`),
      ...["sm", "md", "lg", "xl"].map((s) => `eh-modal--${s}`),
      ...["info", "success", "warning", "danger"].map((t) => `eh-tone--${t}`),
    ];
    expect(expected.filter((c) => !declared.has(c))).toEqual([]);
  });

  it("ignores classes that only appear in comments", () => {
    expect(stripComments("/* .eh-ghost */ .eh-real {}")).not.toContain("eh-ghost");
    expect(stripComments("// eh-ghost\nconst x = \"eh-real\";")).not.toContain("eh-ghost");
    expect(stripComments("url(\"https://x/y\")")).toContain("https://x/y");
  });

  it("actually finds the classes and the references", () => {
    // Guards the assertion above from passing because both sides are empty —
    // a regex that silently stops matching would otherwise look like success.
    expect(declaredClasses().size).toBeGreaterThan(100);
    expect(referencedClasses().length).toBeGreaterThan(100);
  });

  it("declares nothing as an empty rule", () => {
    const empty = themeCss().flatMap(({ file, css }) =>
      emptyEhRules(css).map((selector) => `${selector} in ${file}`),
    );
    expect(empty).toEqual([]);
  });

  it("actually parses the theme's rules, and would catch an emptied one", () => {
    // The check above passes on a parser that finds no rules at all.
    const rules = themeCss().flatMap(({ css }) => cssRules(css));
    expect(rules.length).toBeGreaterThan(300);
    expect(rules.filter((r) => /\.eh-[a-z]/.test(r.selector) && !r.empty).length).toBeGreaterThan(300);

    expect(emptyEhRules(".eh-bar__fill { }")).toEqual([".eh-bar__fill"]);
    expect(emptyEhRules(".eh-bar__fill {\n  \n}")).toEqual([".eh-bar__fill"]);
    expect(emptyEhRules(".eh-bar__fill { width: 1px; }")).toEqual([]);
    // Inside an at-rule, and without a parent being mistaken for empty.
    expect(emptyEhRules("@media (max-width: 1px) { .eh-a { } }")).toEqual([".eh-a"]);
    expect(emptyEhRules("@media (max-width: 1px) { .eh-a { color: red; } }")).toEqual([]);
    expect(emptyEhRules("@keyframes eh-spin { }")).toEqual(["@keyframes eh-spin"]);
    expect(emptyEhRules("@keyframes eh-spin { to { transform: none; } }")).toEqual([]);
    // One emptied rule among full ones, in a comma list, after a statement.
    expect(
      emptyEhRules('@import url("x");\n.eh-a { color: red; }\n.eh-b,\n.eh-c { }\n.eh-d { top: 0; }'),
    ).toEqual([".eh-b,\n.eh-c"]);
    // A rule naming no eh- class is not this check's business.
    expect(emptyEhRules("body { }")).toEqual([]);
  });

  it("catches an undeclared class", () => {
    // The check itself must be able to fail, or it proves nothing.
    const declared = declaredClasses();
    expect(declared.has("eh-definitely-not-a-class")).toBe(false);
    expect(declared.has("eh-stack")).toBe(true);
    expect(declared.has("eh-modal__body")).toBe(true);
  });
});
