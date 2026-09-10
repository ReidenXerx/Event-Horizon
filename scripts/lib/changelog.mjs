/**
 * CHANGELOG.md is the one place a release's notes are written. The release
 * script reads the version's section from it and publishes the same words to
 * the Nexus changelog and the GitHub Release — so what players read on either
 * site is what the repository says, and a release without notes cannot ship.
 *
 * Section headings follow Keep a Changelog: `## [0.1.151] — 2026-09-11`.
 */

const HEADING = /^##\s+\[?v?([0-9A-Za-z.-]+)\]?/;

/** The body of `version`'s section, trimmed; `undefined` when absent or empty. */
export function extractReleaseNotes(markdown, version) {
  const lines = String(markdown ?? "").split(/\r?\n/);
  const start = lines.findIndex((line) => {
    const m = HEADING.exec(line);
    return m !== null && m[1] === version;
  });
  if (start < 0) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end).join("\n").trim();
  return body.length > 0 ? body : undefined;
}

/**
 * The same notes as plain text for Nexus's changelog field, which renders
 * neither Markdown headings nor emphasis: `### Fixed` becomes `Fixed:`,
 * `**bold**` and `` `code` `` lose their markers, links keep their text.
 */
export function toPlainChangelog(markdown, limit = 65535) {
  let text = String(markdown ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^#{1,6}\s+(.*)$/, "$1:"))
    .join("\n")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/gm, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length > limit) text = `${text.slice(0, limit - 2)}\n…`;
  return text;
}
