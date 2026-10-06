/**
 * OneDrive's Documents backup splits the game's My Games folder (azurestrand,
 * Ivy, 2026-10-06): the game reads the OneDrive copy, edits land in the plain
 * one, and online-only placeholders crash loading.
 */
import { describe, expect, it } from "vitest";

import { decideSettingsFolder } from "./environmentChecks";

const onedrive = [{ service: "OneDrive" as const, path: "C:/Users/p/OneDrive" }];

describe("decideSettingsFolder", () => {
  it("warns when the settings folder is inside OneDrive, and says what to turn off", () => {
    const c = decideSettingsFolder({
      gameName: "Fallout 4",
      iniDir: "C:/Users/p/OneDrive/Documents/My Games/Fallout4",
      plainDocuments: "C:/Users/p/Documents",
      documents: "C:/Users/p/OneDrive/Documents",
      syncedRoots: onedrive,
      otherCopyExists: true,
    });
    expect(c.status).toBe("warning");
    expect(c.title).toMatch(/in your OneDrive folder/);
    expect(c.lines.join(" ")).toMatch(/C:\/Users\/p\/Documents\/My Games\/Fallout4/);
    expect(c.steps.join(" ")).toMatch(/turn off backup for Documents/);
    expect(c.steps.join(" ")).toContain("Keep only one My Games" + String.fromCharCode(92) + "Fallout4 folder");
  });

  it("warns about a second copy even without a cloud folder", () => {
    const c = decideSettingsFolder({
      gameName: "Fallout 4",
      iniDir: "D:/Docs/My Games/Fallout4",
      plainDocuments: "C:/Users/p/Documents",
      documents: "D:/Docs",
      syncedRoots: [],
      otherCopyExists: true,
    });
    expect(c.status).toBe("warning");
    expect(c.title).toMatch(/two settings folders/);
  });

  it("is fine for one folder outside cloud backup", () => {
    const c = decideSettingsFolder({
      gameName: "Fallout 4",
      iniDir: "C:/Users/p/Documents/My Games/Fallout4",
      plainDocuments: "C:/Users/p/Documents",
      documents: "C:/Users/p/Documents",
      syncedRoots: onedrive,
      otherCopyExists: false,
    });
    expect(c.status).toBe("ok");
  });
});
