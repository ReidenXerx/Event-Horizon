import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { DEFAULT_PREFERENCES, loadPreferences, parsePreferences, updatePreferences } from "./preferences";

const tmp = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "eh-prefs-")), "preferences.json");

describe("preferences", () => {
  it("defaults to the control channel OFF when there is no file", () => {
    expect(loadPreferences(tmp())).toEqual(DEFAULT_PREFERENCES);
    expect(DEFAULT_PREFERENCES.controlChannel.enabled).toBe(false);
  });

  it("falls back to the defaults on a broken file instead of throwing", () => {
    const f = tmp();
    fs.writeFileSync(f, "{ not json");
    expect(loadPreferences(f).controlChannel.enabled).toBe(false);
  });

  it("only a literal true turns the channel on", () => {
    expect(parsePreferences({ controlChannel: { enabled: "yes" } }).controlChannel.enabled).toBe(false);
    expect(parsePreferences({ controlChannel: { enabled: 1 } }).controlChannel.enabled).toBe(false);
    expect(parsePreferences({ controlChannel: { enabled: true } }).controlChannel.enabled).toBe(true);
  });

  it("keeps a one-time flag across an unrelated update", () => {
    const f = tmp();
    updatePreferences((p) => ({ ...p, shownOnce: { ...p.shownOnce, promo: true } }), f);
    updatePreferences((p) => ({ ...p, controlChannel: { enabled: true } }), f);
    const back = loadPreferences(f);
    expect(back.shownOnce).toEqual({ promo: true });
    expect(back.controlChannel.enabled).toBe(true);
  });
});
