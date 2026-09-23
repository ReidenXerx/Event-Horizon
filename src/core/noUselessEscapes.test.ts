/**
 * ──────────────────────────────────────────────────────────────────────
 * A BACKSLASH THAT IS NOT AN ESCAPE DISAPPEARS WITHOUT A WORD.
 *
 * Inside a JavaScript string or template literal, `\S`, `\W`, `\s`, `\d` and
 * `\.` are not escape sequences. The backslash is dropped and the letter
 * stays: no compiler error, no runtime error, just a different string.
 *
 * Here that has produced answers that read as findings:
 *  • `\s` in a template-built RegExp matched nothing, so a registry value
 *    that was there read as "runtime not installed" (nodePrereqDeps.ts).
 *  • `${WINDIR ?? "C:\Windows"}\System32` built `C:\WINDOWSSystem32`. The
 *    DirectX 9 probe looked for d3dx9_43.dll in a folder that does not exist,
 *    so the Doctor reported the runtime missing on every machine, offered to
 *    install it, and after the install re-checked the same wrong folder and
 *    said missing again. Every log bundle carried the same false line.
 *  • Three test fixtures spelled Windows paths the same way and fed the code
 *    "C:UsersmeDownloadsmod.7z" and an f4se.log with no separators, while
 *    reading, to anyone looking at them, like real paths (GP-4).
 *
 * What this cannot see: a VALID escape used by mistake. `${hive}\${key}`
 * escapes the dollar and builds the literal text "HKLM${key}"; that one is
 * guarded where it lives.
 *
 * Not scanned, on purpose: regex literals (there `\s` means whitespace),
 * `String.raw` templates (they keep backslashes), and JSX attribute strings
 * (JSX does not process escapes at all).
 * ──────────────────────────────────────────────────────────────────────
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC = path.join(__dirname, "..");

/** What may follow a backslash in a string or template literal and still mean something. */
const MEANINGFUL = new Set([
  "'", '"', "\\", "b", "f", "n", "r", "t", "v", "0", "x", "u",
  // A backslash before a line break continues the line.
  "\n", "\r", "\u2028", "\u2029",
]);
/** Templates also escape their own delimiters. */
const MEANINGFUL_IN_TEMPLATES = new Set(["`", "$"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const TEMPLATE_PARTS = new Set([
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
]);

/** A template part inside `tag\`...\`` — String.raw keeps its backslashes by design. */
function isTagged(node: ts.Node): boolean {
  let at: ts.Node | undefined = node.parent;
  while (at !== undefined && (ts.isTemplateSpan(at) || ts.isTemplateExpression(at))) at = at.parent;
  return at !== undefined && ts.isTaggedTemplateExpression(at);
}

/** Every useless escape in one file, as `path:line  \X  in <context>`. */
function uselessEscapes(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];

  const visit = (node: ts.Node): void => {
    const isTemplate = TEMPLATE_PARTS.has(node.kind);
    const isString = ts.isStringLiteral(node) && !ts.isJsxAttribute(node.parent);
    if ((isString || isTemplate) && !(isTemplate && isTagged(node))) {
      const raw = node.getText(sf);
      for (let i = 0; i < raw.length - 1; i += 1) {
        if (raw[i] !== "\\") continue;
        const next = raw[i + 1]!;
        if (!MEANINGFUL.has(next) && !(isTemplate && MEANINGFUL_IN_TEMPLATES.has(next))) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf) + i);
          const context = raw.slice(Math.max(0, i - 20), i + 12).replace(/\s+/g, " ");
          found.push(`${path.relative(SRC, file)}:${line + 1}  \\${next}  in ${context}`);
        }
        i += 1; // the escaped character is consumed either way
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe("string and template literals", () => {
  it("contain no backslash that JavaScript silently drops", () => {
    const found = sourceFiles(SRC).flatMap(uselessEscapes);
    // Write a real backslash as \\ — or use String.raw, or path.win32.join.
    expect(found).toEqual([]);
  }, 60_000);

  it("the scanner itself sees the shape it exists for", () => {
    // A detector that finds nothing anywhere has never been shown to look.
    // The probe lives outside src/, so a crashed run cannot leave it in the tree.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eh-escape-probe-"));
    const probe = path.join(dir, "probe.ts");
    const body = [
      "const a = `${process.env.WINDIR}" + "\\System32`;",
      "const b = \"C:" + "\\Windows\";",
      "const c = /\\s+/;",
      "const d = String.raw`C:" + "\\Windows`;",
      "const e = \"C:\\\\Windows\";",
    ].join("\n");
    fs.writeFileSync(probe, body);
    try {
      const hits = uselessEscapes(probe).map((h) => h.split("  ")[1]);
      // `\S` in the template and `\W` in the string, and nothing else: the
      // regex literal, the String.raw template and the doubled backslash are
      // all correct.
      expect(hits).toEqual(["\\S", "\\W"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
