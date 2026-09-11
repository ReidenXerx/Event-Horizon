/**
 * The primitives are where the design lives, so they are not allowed to
 * carry it inline. A `style={{…}}` in a primitive is a decision nobody can
 * find from the theme, and Modal, Toast and DataTable each had a dozen.
 *
 * The one permitted shape is a CSS custom property passthrough —
 * `style={{ ["--eh-ring-size" as string]: … }}` — because that IS the way
 * a component hands a number to the stylesheet.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const COMPONENTS = __dirname;

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsxFiles(full, out);
    else if (full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** The `style={…}` expression, by brace matching. */
function styleExpression(text: string, from: number): string {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  return text.slice(from);
}

export function inlineStyles(text: string): number[] {
  const lines: number[] = [];
  for (const m of text.matchAll(/style=\{/g)) {
    const expr = styleExpression(text, (m.index ?? 0) + "style=".length);
    // Allowed: an object whose every key is an `--eh-*` custom property (the
    // way a component hands a number to the stylesheet). A plain CSS key
    // anywhere in the expression — `color: "red"` — is a real inline style,
    // even beside a custom property.
    const hasCustomProp = /\[\s*"--eh-[a-z0-9-]+"\s+as\s+string\s*\]/.test(expr);
    const hasPlainKey = /[{,]\s*[a-zA-Z]+\s*:/.test(expr);
    if (hasCustomProp && !hasPlainKey) continue;
    lines.push(text.slice(0, m.index).split("\n").length);
  }
  return lines;
}

describe("primitives carry no inline styles", () => {
  it("every component under src/ui/components is class-driven", () => {
    const offenders: string[] = [];
    for (const file of tsxFiles(COMPONENTS)) {
      const text = readFileSync(file, "utf8");
      for (const line of inlineStyles(text)) {
        offenders.push(`${file.slice(COMPONENTS.length + 1).split("\\").join("/")}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("would catch one", () => {
    expect(inlineStyles('<div style={{ color: "red" }} />')).toEqual([1]);
    expect(inlineStyles('<div style={{ ["--eh-x" as string]: 1 }} />')).toEqual([]);
    // A custom property does not launder a plain key beside it.
    expect(inlineStyles('<div style={{ color: "red", ["--eh-x" as string]: 1 }} />')).toEqual([1]);
    // Nor does one that merely appears later in the file.
    expect(
      inlineStyles('<div style={{ color: "red" }} /><i style={{ ["--eh-x" as string]: 1 }} />'),
    ).toEqual([1]);
    // A conditional whose only key is a custom property is still a passthrough.
    expect(
      inlineStyles('<div style={p.min !== undefined ? ({ ["--eh-grid-min" as string]: p.min }) : undefined} />'),
    ).toEqual([]);
  });
});
