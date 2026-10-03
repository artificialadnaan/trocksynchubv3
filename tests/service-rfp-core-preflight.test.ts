// =============================================================================
// The outbox table is asserted at STARTUP, loudly, because its absence is otherwise silent.
//
// WHAT HAPPENED. `service_rfp_core_outbox` is created by migration 0025 and NOTHING migrates this database
// on deploy, so the table was absent on a service whose code, secret and CORE_INGRESS_BASE_URL were all
// correctly provisioned. `handOffServiceRfpApprovalToCore` is deliberately fail-open — its catch-all
// swallows the failed insert, returns `skipped`, and the approval proceeds to Procore exactly as before —
// so every approved service RFP would have been dropped with no outbox row, no retry and no alert. The
// feature reported healthy and did nothing.
//
// These tests pin the report, not the recovery: the worker must still start (a boot that died here would
// take the Procore automation down with it), and the operator must be told which migration to run.
// =============================================================================

import { afterEach, describe, expect, it, vi } from "vitest";

const dbExecuteMock = vi.hoisted(() => vi.fn());
const logMock = vi.hoisted(() => vi.fn());

vi.mock("../server/db.ts", () => ({
  db: { execute: dbExecuteMock },
  pool: { query: vi.fn(async () => ({ rows: [] })) },
}));
vi.mock("../server/index.ts", () => ({ log: logMock }));

/** Everything the worker's own logging emits, joined — the operator's actual view. */
function logged(): string {
  return logMock.mock.calls.map((c) => String(c[0])).join("\n");
}

afterEach(async () => {
  const { stopServiceRfpCoreOutboxWorker } = await import("../server/sync/service-rfp-core-outbox.ts");
  stopServiceRfpCoreOutboxWorker();
  vi.clearAllMocks();
  vi.resetModules();
});

describe("service-RFP outbox startup preflight", () => {
  it("reports a PROVISIONING ERROR naming the migration when the table is absent", async () => {
    // to_regclass answers NULL for a relation that does not exist — the exact shape of the real failure.
    dbExecuteMock.mockResolvedValue({ rows: [{ rc: null }] });
    const { startServiceRfpCoreOutboxWorker } = await import("../server/sync/service-rfp-core-outbox.ts");

    startServiceRfpCoreOutboxWorker(60_000);
    await vi.waitFor(() => expect(logged()).toContain("PROVISIONING ERROR"));

    const out = logged();
    // The operator must learn the CONSEQUENCE, not just the fact — a missing table reads as harmless
    // otherwise, precisely because the approval still succeeds.
    expect(out).toContain("service_rfp_core_outbox");
    expect(out).toMatch(/silently|no retry|no alert/i);
    // …and the fix, by name. A report that does not say what to run leaves the same gap open.
    expect(out).toContain("0025_create_service_rfp_core_outbox.sql");
    // The worker still STARTED: failing the boot here would trade a silent gap for an outage.
    expect(out).toContain("Worker started");
  });

  it("says NOTHING when the table is present — the check must not become routine noise", async () => {
    dbExecuteMock.mockResolvedValue({ rows: [{ rc: "service_rfp_core_outbox" }] });
    const { preflightOutboxTable } = await import("../server/sync/service-rfp-core-outbox.ts");

    // AWAIT THE PROBE ITSELF. Waiting for `Worker started` — logged synchronously while the preflight ran
    // fire-and-forget — could finish before the probe had run at all, so this assertion passed whether or
    // not the present-table guard worked [Codex #75 confirmed it survived deleting `if (present) return`].
    // The verdict is the observable completion, so silence here is now silence AFTER a real answer.
    await expect(preflightOutboxTable()).resolves.toBe("present");

    expect(logged()).not.toContain("PROVISIONING ERROR");
  });

  it("RETRIES after an inconclusive probe, so a boot-time outage does not bury the diagnosis", async () => {
    // The case this exists for: the database is briefly unreachable at startup AND the table is genuinely
    // missing. A one-shot probe logs its generic verification failure once and never speaks again, leaving
    // only the raw `relation ... does not exist` tick noise the preflight was written to replace.
    dbExecuteMock.mockRejectedValueOnce(new Error("connection terminated"));
    dbExecuteMock.mockResolvedValue({ rows: [{ rc: null }] });
    const { startServiceRfpCoreOutboxWorker, resetServiceRfpPreflightForTests } = await import(
      "../server/sync/service-rfp-core-outbox.ts"
    );
    resetServiceRfpPreflightForTests();

    // A short interval so the second probe lands inside the test rather than 30 s later.
    startServiceRfpCoreOutboxWorker(20);
    await vi.waitFor(() => expect(logged()).toContain("Could not verify"));
    // …and the retry reaches the conclusive answer.
    await vi.waitFor(() => expect(logged()).toContain("PROVISIONING ERROR"), { timeout: 3000 });
  });

  it("does not claim the table is missing when the PROBE ITSELF fails", async () => {
    // A probe that cannot run is not evidence of absence. Reporting it as a provisioning error would send
    // an operator to re-apply a migration that is already there, and would cry wolf on every blip.
    dbExecuteMock.mockRejectedValue(new Error("connection terminated"));
    const { startServiceRfpCoreOutboxWorker } = await import("../server/sync/service-rfp-core-outbox.ts");

    startServiceRfpCoreOutboxWorker(60_000);
    await vi.waitFor(() => expect(logged()).toContain("Could not verify"));

    expect(logged()).not.toContain("PROVISIONING ERROR");
    expect(logged()).toContain("Worker started");
  });
});
