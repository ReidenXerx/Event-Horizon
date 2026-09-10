import { describe, expect, it } from "vitest";

import { extractReleaseNotes, toPlainChangelog } from "./changelog.mjs";

const md = `# Changelog

## [0.1.152] — 2026-09-12

### Added
- **Save logs** in the Doctor

## [0.1.151] — 2026-09-11

### Fixed
- A Creation Kit's Steam manifest no longer hides the game's files ([details](https://example.com))

## 0.1.0-alpha.94 — 2026-09-07
- Early alpha
`;

describe("extractReleaseNotes", () => {
  it("returns exactly the version's section", () => {
    expect(extractReleaseNotes(md, "0.1.151")).toBe(
      "### Fixed\n- A Creation Kit's Steam manifest no longer hides the game's files ([details](https://example.com))",
    );
    expect(extractReleaseNotes(md, "0.1.0-alpha.94")).toBe("- Early alpha");
  });

  it("does not match a version that only starts the same", () => {
    expect(extractReleaseNotes(md, "0.1.15")).toBeUndefined();
  });

  it("is undefined for a missing or empty section — a release without notes cannot ship", () => {
    expect(extractReleaseNotes(md, "9.9.9")).toBeUndefined();
    expect(extractReleaseNotes("## [1.0.0]\n\n## [0.9.0]\n- x", "1.0.0")).toBeUndefined();
  });
});

describe("toPlainChangelog", () => {
  it("renders Markdown as the plain text Nexus displays", () => {
    expect(toPlainChangelog(extractReleaseNotes(md, "0.1.152"))).toBe("Added:\n- Save logs in the Doctor");
    expect(toPlainChangelog("- press *Manage* in Vortex\n- 2 * 3 stays")).toBe("- press Manage in Vortex\n- 2 * 3 stays");
    expect(toPlainChangelog(extractReleaseNotes(md, "0.1.151"))).toBe(
      "Fixed:\n- A Creation Kit's Steam manifest no longer hides the game's files (details)",
    );
  });
});
