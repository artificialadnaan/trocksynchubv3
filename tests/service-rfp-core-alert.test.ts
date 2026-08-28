import { describe, expect, it, vi } from "vitest";

// The renderer is pure, but its module imports escapeHtml (and the shared orchestrator) from
// bidboard-crm-alert, which pulls in ../db and ../email-service at load. Stub the chain, not the
// escaping — the point of this suite is the exact WORDING an operator receives.
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));
vi.mock("../server/db.ts", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock("../server/email-service.ts", () => ({ sendEmail: vi.fn(async () => ({ success: true })) }));

const { renderServiceRfpCoreAlertEmail, serviceRfpCoreAlertOffice } = await import(
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
});

describe("serviceRfpCoreAlertOffice", () => {
  it("namespaces the state key so a Core failure cannot suppress the CRM push's recovery email", () => {
    expect(serviceRfpCoreAlertOffice("dallas")).toBe("service-rfp-core:dallas");
    expect(serviceRfpCoreAlertOffice(null)).toBe("service-rfp-core:unmapped");
  });
});
