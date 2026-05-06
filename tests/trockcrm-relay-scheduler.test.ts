import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const processBatch = vi.fn();

vi.mock("../server/trockcrm-relay.ts", () => ({
  processTrockCrmRelayOutboxBatch: processBatch,
}));

describe("TrockCRM relay scheduler", () => {
  let originalSecret: string | undefined;
  let originalEnabled: string | undefined;
  let consoleLog: ReturnType<typeof vi.spyOn>;
  let consoleWarn: ReturnType<typeof vi.spyOn>;
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalSecret = process.env.SYNCHUB_RELAY_SECRET;
    originalEnabled = process.env.TROCKCRM_RELAY_ENABLED;
    vi.useFakeTimers();
    vi.clearAllMocks();
    consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    const { stopTrockCrmRelayScheduler } = await import("../server/cron/trockcrmRelayScheduler.ts");
    stopTrockCrmRelayScheduler();
    vi.useRealTimers();
    if (originalSecret === undefined) {
      delete process.env.SYNCHUB_RELAY_SECRET;
    } else {
      process.env.SYNCHUB_RELAY_SECRET = originalSecret;
    }
    if (originalEnabled === undefined) {
      delete process.env.TROCKCRM_RELAY_ENABLED;
    } else {
      process.env.TROCKCRM_RELAY_ENABLED = originalEnabled;
    }
    consoleLog.mockRestore();
    consoleWarn.mockRestore();
    consoleError.mockRestore();
  });

  it("does not start when relay is disabled", async () => {
    process.env.TROCKCRM_RELAY_ENABLED = "false";
    process.env.SYNCHUB_RELAY_SECRET = "secret";

    const { startTrockCrmRelayScheduler } = await import("../server/cron/trockcrmRelayScheduler.ts");
    startTrockCrmRelayScheduler();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(processBatch).not.toHaveBeenCalled();
    expect(consoleLog).toHaveBeenCalledWith("[TrockCRMRelay] Scheduler disabled by TROCKCRM_RELAY_ENABLED=false");
  });

  it("starts with a warning when signing secret is missing so pending rows can be marked failed", async () => {
    delete process.env.TROCKCRM_RELAY_ENABLED;
    delete process.env.SYNCHUB_RELAY_SECRET;
    processBatch.mockResolvedValue({ processed: 1, sent: 0, failed: 1, abandoned: 0 });

    const { startTrockCrmRelayScheduler } = await import("../server/cron/trockcrmRelayScheduler.ts");
    startTrockCrmRelayScheduler();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(processBatch).toHaveBeenCalledWith({ limit: 25 });
    expect(consoleWarn).toHaveBeenCalledWith("[TrockCRMRelay] SYNCHUB_RELAY_SECRET missing; relay outbox processing will mark rows failed until configured");
  });

  it("processes outbox entries every minute when configured", async () => {
    delete process.env.TROCKCRM_RELAY_ENABLED;
    process.env.SYNCHUB_RELAY_SECRET = "secret";
    processBatch.mockResolvedValue({ processed: 2, sent: 1, failed: 1, abandoned: 0 });

    const { startTrockCrmRelayScheduler } = await import("../server/cron/trockcrmRelayScheduler.ts");
    startTrockCrmRelayScheduler();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(processBatch).toHaveBeenCalledWith({ limit: 25 });
    expect(consoleLog).toHaveBeenCalledWith("[TrockCRMRelay] processed=2 sent=1 failed=1 abandoned=0");
  });

  it("logs processor errors without stopping future runs", async () => {
    delete process.env.TROCKCRM_RELAY_ENABLED;
    process.env.SYNCHUB_RELAY_SECRET = "secret";
    processBatch
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce({ processed: 0, sent: 0, failed: 0, abandoned: 0 });

    const { startTrockCrmRelayScheduler } = await import("../server/cron/trockcrmRelayScheduler.ts");
    startTrockCrmRelayScheduler();

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(processBatch).toHaveBeenCalledTimes(2);
    expect(consoleError).toHaveBeenCalledWith("[TrockCRMRelay] Outbox processing failed:", "database unavailable");
  });
});
