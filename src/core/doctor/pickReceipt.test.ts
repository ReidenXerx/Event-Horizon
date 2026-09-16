import { describe, expect, it } from "vitest";

import { pickDoctorReceipt } from "./pickReceipt";

/**
 * The numbers below are a real machine's, from the log bundle that reported
 * "on esl card it says no esl actions recorded". Keeping them verbatim is the
 * point: the bug needs a package id that sorts BEFORE the newer one, and a
 * fixture with tidy ids ("a", "b") would have passed against the old code.
 */
const OLD = {
  packageId: "351ac575-9db1-43d3-bfca-28667aee18f2",
  installedAt: "2026-09-03T19:53:37.291Z",
  vortexProfileId: "a9dd28e0-d5c9-4ade-892a-c69e7fa0455b",
};
const NEW = {
  packageId: "b4715cae-a0d4-4f7e-83e2-1540f9971c6a",
  installedAt: "2026-09-15T23:32:32.480Z",
  vortexProfileId: "af5a786a-7a86-4f10-b1ed-b0313ebccdda",
};
/** `readdir` order: sorted by the uuid, which puts the OLD one first. */
const AS_LISTED = [OLD, NEW];

describe("which collection the Doctor opens on", () => {
  it("picks the one installed into the active profile, not the first listed", () => {
    // The whole bug: taking receipts[0] diagnosed a 12-day-old collection,
    // then offered to switch Vortex onto its profile — which the player
    // accepted, moving them off the collection they had just installed.
    expect(pickDoctorReceipt(AS_LISTED, NEW.vortexProfileId)).toBe(NEW);
  });

  it("still picks it when the active profile's receipt is listed first", () => {
    // Guards the mirror case, so the test cannot pass by preferring the LAST
    // entry — which would be just as wrong, and just as invisible.
    expect(pickDoctorReceipt(AS_LISTED, OLD.vortexProfileId)).toBe(OLD);
  });

  it("falls back to the newest install when no receipt claims the active profile", () => {
    expect(pickDoctorReceipt(AS_LISTED, "some-vanilla-profile")).toBe(NEW);
  });

  it("falls back to the newest install when the active profile cannot be read", () => {
    expect(pickDoctorReceipt(AS_LISTED, undefined)).toBe(NEW);
  });

  it("takes the newer of two collections installed into one profile", () => {
    const older = { ...OLD, vortexProfileId: NEW.vortexProfileId };
    expect(pickDoctorReceipt([older, NEW], NEW.vortexProfileId)).toBe(NEW);
    // Order-independent: the same answer when the newer one is listed first.
    expect(pickDoctorReceipt([NEW, older], NEW.vortexProfileId)).toBe(NEW);
  });

  it("sorts a receipt with an unreadable date last instead of letting NaN win", () => {
    const undated = { ...OLD, installedAt: "not a date" };
    expect(pickDoctorReceipt([undated, NEW], undefined)).toBe(NEW);
    expect(pickDoctorReceipt([NEW, undated], undefined)).toBe(NEW);
  });

  it("returns undefined only for an empty list", () => {
    expect(pickDoctorReceipt([], "anything")).toBeUndefined();
  });
});
