/**
 * A misspelled CSS custom property does not throw, does not warn, and does not
 * show up in a typecheck or in any other test. `var(--eh-nope)` resolves to
 * nothing, and the browser then discards the ENTIRE declaration it appears in
 * — so `border: 1px solid var(--eh-nope)` is not a wrong-coloured border, it is
 * no border at all.
 *
 * That is how BuildPage's "included" and "reverify" toggles came to render
 * identically in both states: `--eh-border` and `--eh-accent` were never
 * defined, so the selected outline that was supposed to distinguish them never
 * drew. Four call sites, two pages, invisible to every check we had.
 *
 * This walks the real source and asserts that every token the UI asks for is
 * one the theme actually ships.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "..");
const TOKENS_FILE = join(__dirname, "tokens.ts");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** Tokens the theme declares, e.g. `--eh-cyan: #4cc9f0;`. */
function declaredTokens(): Set<string> {
  const text = readFileSync(TOKENS_FILE, "utf8");
  return new Set(
    [...text.matchAll(/^\s*(--eh-[a-z0-9-]+)\s*:/gm)].map((m) => m[1]),
  );
}

/**
 * A reference is only a bug when it has NO fallback. `var(--x, 64px)` is the
 * legitimate way to read a value set inline on an element (ProgressRing sets
 * `--eh-ring-size` that way), so those are excluded deliberately rather than
 * by accident.
 */
type Reference = { token: string; file: string; line: number };

function referencesWithoutFallback(): Reference[] {
  const found: Reference[] = [];
  for (const file of sourceFiles(SRC)) {
    if (file === TOKENS_FILE || file.endsWith(".test.ts")) continue;
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/var\(\s*(--eh-[a-z0-9-]+)\s*([,)])/g)) {
      if (m[2] === ",") continue; // has a fallback
      found.push({
        token: m[1],
        file: file.slice(SRC.length + 1).split("\\").join("/"),
        line: text.slice(0, m.index).split("\n").length,
      });
    }
  }
  return found;
}

describe("theme tokens", () => {
  it("declares every token the UI reads without a fallback", () => {
    const declared = declaredTokens();
    const undeclared = referencesWithoutFallback().filter(
      (r) => !declared.has(r.token),
    );
    expect(
      undeclared.map((r) => `${r.token} at ${r.file}:${r.line}`),
    ).toEqual([]);
  });

  it("actually finds the tokens and the references", () => {
    // Guards the assertion above from passing because both sides are empty —
    // a regex that silently stops matching would otherwise look like success.
    expect(declaredTokens().size).toBeGreaterThan(50);
    expect(referencesWithoutFallback().length).toBeGreaterThan(50);
  });

  /**
   * The mirror of the assertion above, and the half that was missing.
   *
   * That one asks "is every token the UI reads declared?", which cannot fail
   * on a token nobody reads — so a token retuned by a repaint for a consumer
   * that no longer exists looked exactly like a live one. Two were found that
   * way (--eh-warning-soft, --eh-text-4xl), both edited in a commit whose
   * described effect they could not have.
   */
  it("declares no token that nothing reads", () => {
    const declared = declaredTokens();
    // Any reference at all counts here, fallback or not: the question is
    // whether the token is live, not whether the reference is safe.
    const read = new Set<string>();
    for (const file of sourceFiles(SRC)) {
      // tokens.ts INCLUDED: a token composed into another token (the disk
      // gradient is built from five of them) is live, and excluding the file
      // reported the whole palette as dead.
      for (const m of readFileSync(file, "utf8").matchAll(/var\(\s*(--eh-[a-z0-9-]+)/g)) {
        read.add(m[1]);
      }
    }
    /**
     * A SCALE is exempt: `--eh-sp-*`, the radii, the type sizes, the z-layers,
     * the easings and the durations are declared as complete ladders, and a
     * rung nobody stands on today is not a defect. Everything else is a named
     * thing that exists for a consumer, so no consumer means no reason.
     */
    const SCALE = /^--eh-(sp|radius|text|z|easing|dur|leading|tracking|font)-/;
    const dead = [...declared].filter((t) => !read.has(t) && !SCALE.test(t));
    expect(dead).toEqual([]);
  });

  it("declares no shadow token that cannot compose in a list", () => {
    /*
     * "box-shadow: none, <shadow>" is a parse error, so a token whose value
     * is the bare keyword none silently deletes every declaration that
     * composes it. --eh-shadow-button did exactly that to the primary
     * button's glow, and both tests above passed.
     */
    const text = readFileSync(TOKENS_FILE, "utf8");
    const offenders = [...text.matchAll(/^\s*(--eh-[a-z0-9-]*(?:shadow|glow)[a-z0-9-]*)\s*:\s*([^;]+);/gm)]
      .filter((m) => m[2].trim() === "none")
      .map((m) => m[1]);
    expect(offenders).toEqual([]);
  });

  it("catches an undeclared token", () => {
    // The check itself must be able to fail, or it proves nothing.
    const declared = declaredTokens();
    expect(declared.has("--eh-definitely-not-a-token")).toBe(false);
    expect(declared.has("--eh-accent")).toBe(true);
  });
});
