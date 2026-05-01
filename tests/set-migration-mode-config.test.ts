import { describe, expect, it } from "vitest";
import { deepSemanticEqual } from "../scripts/set-migration-mode-config";

describe("migration-mode config semantic equality", () => {
  it("treats objects with different key order as equal", () => {
    expect(deepSemanticEqual(
      { suppressHubSpotWrites: true, mode: "migration", enabled: true },
      { enabled: true, mode: "migration", suppressHubSpotWrites: true }
    )).toBe(true);
  });

  it("treats arrays with the same order as equal", () => {
    expect(deepSemanticEqual(["Contract", "Lost"], ["Contract", "Lost"])).toBe(true);
  });

  it("treats arrays with different order as not equal", () => {
    expect(deepSemanticEqual(["Lost", "Contract"], ["Contract", "Lost"])).toBe(false);
  });

  it("treats nested objects with shuffled keys as equal", () => {
    expect(deepSemanticEqual(
      {
        bidboard_stage_sync: {
          mode: "migration",
          suppressions: { hubspot: true, portfolio: true },
        },
        routes: [{ key: "stage_notify_bb_closed_won_contract", enabled: false }],
      },
      {
        routes: [{ enabled: false, key: "stage_notify_bb_closed_won_contract" }],
        bidboard_stage_sync: {
          suppressions: { portfolio: true, hubspot: true },
          mode: "migration",
        },
      }
    )).toBe(true);
  });

  it("treats different values as not equal", () => {
    expect(deepSemanticEqual(
      { mode: "migration", suppressHubSpotWrites: true },
      { mode: "migration", suppressHubSpotWrites: false }
    )).toBe(false);
  });

  it("distinguishes null, undefined, and missing keys", () => {
    expect(deepSemanticEqual(null, null)).toBe(true);
    expect(deepSemanticEqual(null, undefined)).toBe(false);
    expect(deepSemanticEqual({ value: null }, { value: undefined })).toBe(false);
    expect(deepSemanticEqual({ value: undefined }, {})).toBe(false);
  });
});
