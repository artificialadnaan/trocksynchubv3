import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The renderer is pure, but its module imports escapeHtml (and the shared orchestrator) from
// bidboard-crm-alert, which pulls in ../db and ../email-service at load. Stub the chain, not the
// escaping — the point of this suite is the exact WORDING an operator receives.
//
// bidboard-crm-alert itself is REAL here, so the serialization test below exercises the actual
// read-decide-send-upsert state machine rather than a double of it.
const poolMock = vi.hoisted(() => ({ query: vi.fn(async () => ({ rows: [] as any[] })) }));
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));
vi.mock("../server/db.ts", () => ({ pool: poolMock }));
vi.mock("../server/email-service.ts", () => ({ sendEmail: vi.fn(async () => ({ success: true })) }));

const { renderServiceRfpCoreAlertEmail, serviceRfpCoreAlertOffice, recordServiceRfpCoreDelivery } = await import(
  "../server/sync/service-rfp-core-alert.ts"
);

const NOW = new Date("2026-08-28T19:00:00.000Z");
const KINDS = ["request_rejected", "terminal_failure", "unconfirmed", "recovered"] as const;

/**
 * Phrases that belong to the OTHER stream sharing this debounce. Every one of them is an instruction:
 * a Core failure rendered with the Bid Board → CRM copy sends an operator to a table that holds no row
 * for this incident and to a secret that had nothing to do with it. (Codex P2 — Core-specific copy.)
 */
const BID_BOARD_WORDING = [
  "Bid Board",
  "bid_board_ingestion_inbox",
  "BID_BOARD_SYNC_SECRET",
  "Idempotency key",
  "Export file",
  "25MB",
];

function render(kind: (typeof KINDS)[number]) {
  return renderServiceRfpCoreAlertEmail({
    kind,
    office: "service-rfp-core:dallas",
    attempts: 6,
    status: 503,
    error: "Core ingress returned 503",
    now: NOW,
  });
}

describe("renderServiceRfpCoreAlertEmail", () => {
  it("never sends an operator to the Bid Board → CRM push's table, secret or artefacts", () => {
    for (const kind of KINDS) {
      const { subject, htmlBody } = render(kind);
      for (const phrase of BID_BOARD_WORDING) {
        expect(`${subject}\n${htmlBody}`, `${kind} must not mention ${phrase}`).not.toContain(phrase);
      }
    }
  });

  it("names TROCK Core, in every kind, in the subject line an operator triages on", () => {
    for (const kind of KINDS) {
      expect(render(kind).subject, kind).toContain("TROCK Core");
    }
  });

  it("points a dead-lettered delivery at the configuration that actually failed", () => {
    const { subject, htmlBody } = render("terminal_failure");

    expect(subject).toMatch(/DEAD-LETTERED/i);
    // The three things that actually stop a delivery, and the row that records it.
    expect(htmlBody).toContain("SERVICE_RFP_INGRESS_SECRET_CURRENT");
    expect(htmlBody).toContain("CORE_INGRESS_BASE_URL");
    expect(htmlBody).toContain("service_rfp_core_outbox");
  });

  it("tells the reader a refusal did NOT cost the Procore create, because it did not", () => {
    const { htmlBody } = render("request_rejected");

    expect(htmlBody).toContain("service_rfp_core_outbox");
    expect(htmlBody).toMatch(/Procore/);
  });

  it("shows the plain office, not the alert-state namespace key", () => {
    // The namespace exists to keep two streams off one primary key; it is machinery, and an operator
    // reading "service-rfp-core:dallas" in a subject line learns nothing from the prefix.
    const { subject, htmlBody } = render("recovered");
    expect(subject).toContain("dallas");
    expect(`${subject}\n${htmlBody}`).not.toContain("service-rfp-core:dallas");
  });

  it("escapes the error field like every other ops email in the repo", () => {
    const { htmlBody } = renderServiceRfpCoreAlertEmail({
      kind: "terminal_failure",
      office: "service-rfp-core:dallas",
      error: '<script>alert("x")</script>',
      now: NOW,
    });

    expect(htmlBody).not.toContain("<script>");
    expect(htmlBody).toContain("&lt;script&gt;");
  });

  it("does not claim the Procore create has already run", () => {
    // The inline handoff alert is rendered BEFORE createBidBoardProjectFromDeal is called, and that
    // create can itself fail. Telling an operator it "ran regardless" reports an outcome nobody has
    // observed yet, and invites them to assume a Procore project exists when it may not.
    for (const kind of ["request_rejected", "terminal_failure", "unconfirmed"] as const) {
      const { htmlBody } = render(kind);
      expect(htmlBody, kind).not.toMatch(/create (ran|succeeded|completed|went ahead)/i);
      expect(htmlBody, kind).toMatch(/proceeds|attempted|independently/i);
    }
  });
});

describe("recordServiceRfpCoreDelivery concurrency", () => {
  const OLD_RECIPIENT = process.env.BIDBOARD_CRM_ALERT_RECIPIENT;

  beforeEach(() => {
    // Without a recipient the orchestrator is inert and never reaches the DB at all.
    process.env.BIDBOARD_CRM_ALERT_RECIPIENT = "ops@trock.test";
    poolMock.query.mockReset();
  });

  afterEach(() => {
    if (OLD_RECIPIENT === undefined) delete process.env.BIDBOARD_CRM_ALERT_RECIPIENT;
    else process.env.BIDBOARD_CRM_ALERT_RECIPIENT = OLD_RECIPIENT;
  });

  it("serializes the read-decide-write transition per office", async () => {
    // recordPushOutcomeAndMaybeAlert takes no lock and documents why: its original caller, the
    // stage-sync cycle, is already serialized by bidboardStageSyncRunning. THIS caller is not —
    // approvals are fire-and-forget behind a 202, and DFW is the only Core tenant, so every Core alert
    // in flight contends for one row. Interleaved, two failures both read 'ok' and both send a
    // "first failure" email.
    const order: string[] = [];
    poolMock.query.mockImplementation(async (text: string) => {
      order.push(/CREATE TABLE/i.test(text) ? "ensure" : /^\s*SELECT/i.test(text) ? "read" : "write");
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { rows: [] };
    });

    await Promise.all([
      recordServiceRfpCoreDelivery({ office: "dallas", ok: false, attempts: 1, error: "a", terminal: true }),
      recordServiceRfpCoreDelivery({ office: "dallas", ok: false, attempts: 1, error: "b", terminal: true }),
    ]);

    expect(order).toEqual(["ensure", "read", "write", "ensure", "read", "write"]);
  });

  it("does not serialize across DIFFERENT offices", async () => {
    // The contention is on one primary-key row; two offices share nothing, and making them queue would
    // be a self-inflicted bottleneck.
    let concurrent = 0;
    let observedOverlap = false;
    poolMock.query.mockImplementation(async () => {
      concurrent += 1;
      if (concurrent > 1) observedOverlap = true;
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrent -= 1;
      return { rows: [] };
    });

    await Promise.all([
      recordServiceRfpCoreDelivery({ office: "dallas", ok: false, attempts: 1, error: "a", terminal: true }),
      recordServiceRfpCoreDelivery({ office: "atlanta", ok: false, attempts: 1, error: "b", terminal: true }),
    ]);

    expect(observedOverlap).toBe(true);
  });
});

describe("serviceRfpCoreAlertOffice", () => {
  it("namespaces the state key so a Core failure cannot suppress the CRM push's recovery email", () => {
    expect(serviceRfpCoreAlertOffice("dallas")).toBe("service-rfp-core:dallas");
    expect(serviceRfpCoreAlertOffice(null)).toBe("service-rfp-core:unmapped");
  });
});

/**
 * [Codex #75] A REQUEST REJECTION MUST NOT BECOME A CHANNEL STATE.
 *
 * `rejected` means one request was refused deterministically — a 409, a missing identity, a bad body. It
 * needs its own manual action and says nothing about whether the channel can reach Core. Folding it into
 * the health machine marked the whole office `failing`, and the next UNRELATED success then read that as a
 * recovery, emailed an all-clear and closed the incident while the rejected row was still terminal.
 *
 * The alert was never the problem; the false recovery was. Driven through the REAL orchestrator (this file
 * mocks only the pool/email chain), so these exercise the actual read-decide-send-write transition.
 */
describe("a rejected approval alerts without claiming the office is unhealthy", () => {
  const OLD_RECIPIENT = process.env.BIDBOARD_CRM_ALERT_RECIPIENT;

  beforeEach(() => {
    process.env.BIDBOARD_CRM_ALERT_RECIPIENT = "ops@trock.test";
    poolMock.query.mockReset();
  });
  afterEach(() => {
    if (OLD_RECIPIENT === undefined) delete process.env.BIDBOARD_CRM_ALERT_RECIPIENT;
    else process.env.BIDBOARD_CRM_ALERT_RECIPIENT = OLD_RECIPIENT;
  });

  /** Serve `priorState` to the SELECT and capture what the UPSERT persists. */
  function stubPool(priorState: string | null): { written: () => string[] } {
    const writes: string[] = [];
    poolMock.query.mockImplementation(async (text: string, params?: any[]) => {
      if (/CREATE TABLE/i.test(text)) return { rows: [] };
      if (/^\s*SELECT/i.test(text)) {
        return priorState === null
          ? { rows: [] }
          : { rows: [{ state: priorState, last_alerted_at: null, last_success_at: null }] };
      }
      // The upsert: the persisted state is whichever parameter carries it.
      writes.push(JSON.stringify(params ?? []));
      return { rows: [] };
    });
    return { written: () => writes };
  }

  it("leaves the channel state untouched for a REJECTION (prior 'ok' stays 'ok')", async () => {
    const { written } = stubPool("ok");
    await recordServiceRfpCoreDelivery({
      office: "dallas",
      ok: false,
      attempts: 1,
      error: "409 live_project",
      terminal: true,
    });
    // The operator is told, but the channel is not marked failing — so nothing can later "recover" it.
    expect(written().join(" ")).toContain("ok");
    expect(written().join(" ")).not.toContain("failing");
  });

  it("does not emit a RECOVERY when an unrelated success follows a rejection", async () => {
    // Prior state is 'ok' because the rejection above refused to write 'failing'. A success therefore
    // finds nothing to recover from — which is the whole point: the rejected row is still terminal.
    stubPool("ok");
    const after = await recordServiceRfpCoreDelivery({
      office: "dallas",
      ok: true,
      attempts: 1,
      status: 201,
    });
    expect(after).toEqual({ action: "none" });
  });

  it("still marks the channel FAILING for a real transport failure — the machine is otherwise unchanged", async () => {
    const { written } = stubPool("ok");
    await recordServiceRfpCoreDelivery({
      office: "dallas",
      ok: false,
      attempts: 3,
      error: "ECONNREFUSED",
      terminal: false,
    });
    expect(written().join(" ")).toContain("failing");
  });
});
