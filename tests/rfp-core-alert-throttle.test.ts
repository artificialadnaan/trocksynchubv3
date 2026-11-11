import { beforeEach, describe, expect, it, vi } from "vitest";

// CodeRabbit 4534112641 on #127: raiseRfpCoreAlert passed signatureChanged: true for every code, which bypasses the shared
// re-alert window (decideAlertTransition), so a standing condition such as core_tables_missing re-emailed on every request.
// Synthetic data only (I7).
const recordMock = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({})));
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));
vi.mock("../server/log.ts", () => ({ log: vi.fn() }));
vi.mock("../server/sync/bidboard-crm-alert.ts", () => ({ recordPushOutcomeAndMaybeAlert: recordMock, escapeHtml: (s: string) => s }));
const { raiseRfpCoreAlert } = await import("../server/sync/rfp-core-alert.ts");

beforeEach(() => recordMock.mockClear());

describe("raiseRfpCoreAlert and the re-alert window (CodeRabbit 4534112641)", () => {
  it("core_tables_missing never bypasses the re-alert window: repeats are not flagged as a new incident (signatureChanged false)", async () => {
    await raiseRfpCoreAlert("core_tables_missing", { preflight: "missing" });
    await raiseRfpCoreAlert("core_tables_missing", { preflight: "missing" });
    expect(recordMock).toHaveBeenCalledTimes(2);
    for (const call of recordMock.mock.calls) {
      expect(call[0]).toMatchObject({ officeSlug: "rfp-core:core_tables_missing", signatureChanged: false });
    }
  });
  it("core_footprint_check_failed repeats fall under the re-alert window (signatureChanged false); its needs_manual escalation alerts each time (CodeRabbit 4534600249)", async () => {
    await raiseRfpCoreAlert("core_footprint_check_failed" as any, { commandId: 1, failures: 1 });
    await raiseRfpCoreAlert("core_footprint_check_needs_manual" as any, { commandId: 1, failures: 3 });
    expect(recordMock.mock.calls[0][0]).toMatchObject({ officeSlug: "rfp-core:core_footprint_check_failed", signatureChanged: false });
    expect(recordMock.mock.calls[1][0]).toMatchObject({ officeSlug: "rfp-core:core_footprint_check_needs_manual", signatureChanged: true });
  });
  it("(guard) every other code still alerts each distinct event (signatureChanged true), as today", async () => {
    await raiseRfpCoreAlert("core_create_dead", { attempts: 6 });
    expect(recordMock.mock.calls[0][0]).toMatchObject({ officeSlug: "rfp-core:core_create_dead", signatureChanged: true });
  });
});

describe("raiseRfpCoreAlert reports delivery (CodeRabbit 4536104331 on #130)", () => {
  it("resolves true only when the alert email was sent; false when it was not, when nothing was configured, or when the push threw", async () => {
    recordMock.mockResolvedValueOnce({ action: "alert_failure", sent: true });
    recordMock.mockResolvedValueOnce({ action: "alert_failure", sent: false });
    recordMock.mockResolvedValueOnce({ action: "none" });
    recordMock.mockRejectedValueOnce(new Error("synthetic alert store down"));
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await raiseRfpCoreAlert("crm_signing_refused" as any, { signer: "bidboard_callbacks", reason: "url_refused" }));
    expect(results).toEqual([true, false, false, false]);
  });
});
