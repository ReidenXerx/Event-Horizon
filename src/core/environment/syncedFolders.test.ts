/**
 * Where OneDrive and Dropbox upload from, read the way each documents it:
 * OneDrive's environment variables, Dropbox's info.json.
 */
import { describe, expect, it } from "vitest";

import { syncedFolderRoots } from "./syncedFolders";

const files = (map: Record<string, string>) => (file: string): string | undefined => map[file];

describe("syncedFolderRoots", () => {
  it("reads every OneDrive account from its environment variables, once per folder", () => {
    const roots = syncedFolderRoots(
      {
        OneDrive: "C:\\Users\\x\\OneDrive",
        OneDriveConsumer: "c:\\users\\x\\onedrive\\",
        OneDriveCommercial: "C:\\Users\\x\\OneDrive - Contoso",
      },
      files({}),
    );
    expect(roots).toEqual([
      { service: "OneDrive", path: "C:\\Users\\x\\OneDrive" },
      { service: "OneDrive", path: "C:\\Users\\x\\OneDrive - Contoso" },
    ]);
  });

  it("reads Dropbox's personal and business folders from info.json under either AppData folder", () => {
    const roots = syncedFolderRoots(
      { APPDATA: "C:\\Users\\x\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" },
      files({
        "C:\\Users\\x\\AppData\\Local\\Dropbox\\info.json": JSON.stringify({
          personal: { path: "D:\\Dropbox", host: 1, is_team: false },
          business: { path: "D:\\Dropbox (Contoso)", host: 2, is_team: true },
        }),
      }),
    );
    expect(roots).toEqual([
      { service: "Dropbox", path: "D:\\Dropbox" },
      { service: "Dropbox", path: "D:\\Dropbox (Contoso)" },
    ]);
  });

  it("reports nothing when no client is set up, and skips an info.json it cannot parse", () => {
    expect(syncedFolderRoots({}, files({}))).toEqual([]);
    expect(
      syncedFolderRoots(
        { APPDATA: "C:\\A", OneDrive: "" },
        files({ "C:\\A\\Dropbox\\info.json": "{ not json" }),
      ),
    ).toEqual([]);
    expect(syncedFolderRoots({ APPDATA: "C:\\A" }, files({ "C:\\A\\Dropbox\\info.json": "[1, null]" }))).toEqual([]);
  });
});
