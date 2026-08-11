import { describe, expect, it, vi } from "vitest";

// Same stubs as rfp-report-email.test.ts: rfp-reports.ts imports ./db (which throws without
// DATABASE_URL), ./storage and ./email-service. The builder under test is pure.
vi.mock("../server/db", () => ({ db: {}, pool: {} }));
vi.mock("../server/storage", () => ({ storage: {} }));
vi.mock("../server/email-service", () => ({ sendEmail: vi.fn() }));

import { buildRfpReportEmailHtml } from "../server/rfp-reports";
import {
  fetchCrmEstimatesSent,
  formatEstimateAmount,
  resendLabel,
  type CrmEstimateSent,
  type CrmEstimatesSentResult,
} from "../server/crm-estimates-sent";

function deal(overrides: Partial<CrmEstimateSent> = {}): CrmEstimateSent {
  return {
    dealId: "d-1",
    officeSlug: "dallas",
    name: "Elan at Bluffview",
    dealNumber: "DFW-1",
    projectNumber: "DFW-4-21826-ad",
    stageSlug: "estimate_sent_to_client",
    enteredAt: "2026-08-06T12:54:00.000Z",
    amount: "120000.55",
    ownerName: "Andrew Green",
    ownerEmail: "agreen@trockgc.com",
    priorEntryCount: 0,
    ...overrides,
  };
}

async function render(estimatesSent?: CrmEstimatesSentResult): Promise<string> {
  return buildRfpReportEmailHtml({
    periodLabel: "Last 24 Hours",
    rfps: [],
    changes: [],
    approvalSummary: { pending: 0, approved: 0, rejected: 0 },
    includeRfpLog: true,
    includeApprovalSummary: false,
    estimatesSent,
    dashboardUrl: "https://synchub.example.com/settings",
  });
}

describe("the Estimates Sent to Client section", () => {
  it("lists each deal with its amount and owner", async () => {
    const html = await render({ ok: true, deals: [deal()] });

    expect(html).toContain("Estimates Sent to Client — Last 24 Hours");
    expect(html).toContain("Elan at Bluffview");
    expect(html).toContain("Andrew Green");
    expect(html).toContain("DFW-4-21826-ad");
    // Rounded for display, from the exact decimal string the CRM sent.
    expect(html).toContain("$120,001");
  });

  it("counts the section in the stat chips", async () => {
    const html = await render({ ok: true, deals: [deal(), deal({ dealId: "d-2" })] });
    expect(html).toContain("2 Estimates Sent");
  });

  it("uses the singular for exactly one", async () => {
    const html = await render({ ok: true, deals: [deal()] });
    expect(html).toContain("1 Estimate Sent");
  });

  it("says plainly when nothing was sent", async () => {
    const html = await render({ ok: true, deals: [] });

    expect(html).toContain("No estimates sent to clients in this period.");
    expect(html).toContain("0 Estimates Sent");
  });
});

// The distinction the whole result type exists for. An email that silently omitted this section, or
// showed an empty one, would state that no estimates went out — a false claim, not a missing one, and
// indistinguishable from a genuinely quiet day.
describe("when the CRM lookup does not answer", () => {
  it("says the section could not be loaded rather than showing nothing", async () => {
    const html = await render({ ok: false, reason: "failed" });

    expect(html).toContain("Estimates Sent to Client");
    expect(html).toContain("Could not be loaded from the CRM this run");
    expect(html).not.toContain("No estimates sent to clients in this period.");
  });

  it("distinguishes an unconfigured deployment from a failure", async () => {
    const html = await render({ ok: false, reason: "not_configured" });
    expect(html).toContain("not connected to the CRM");
  });

  // A "0 Estimates Sent" chip after a failed lookup is a confidently wrong number in an email to
  // leadership — strictly worse than no chip at all.
  it("shows no count chip when the number is unknown", async () => {
    const html = await render({ ok: false, reason: "failed" });

    expect(html).not.toContain("0 Estimates Sent");
    expect(html).not.toContain("Estimates Sent</span>");
    // The RFP chip is untouched — this degrades one section, not the email.
    expect(html).toContain("0 RFPs Sent");
  });

  it("omits the section entirely for callers that never fetched it", async () => {
    const html = await render(undefined);

    expect(html).not.toContain("Estimates Sent to Client");
    expect(html).toContain("RFP Activity");
  });
});

describe("the re-send annotation", () => {
  it("marks a deal that has been sent before", async () => {
    const html = await render({ ok: true, deals: [deal({ priorEntryCount: 1 })] });
    expect(html).toContain("2nd time sent");
  });

  it("says nothing on a first send", async () => {
    const html = await render({ ok: true, deals: [deal({ priorEntryCount: 0 })] });
    expect(html).not.toContain("time sent");
  });

  it("builds the ordinal correctly, including the teens", () => {
    expect(resendLabel(0)).toBe("");
    expect(resendLabel(1)).toBe("2nd time sent");
    expect(resendLabel(2)).toBe("3rd time sent");
    expect(resendLabel(3)).toBe("4th time sent");
    expect(resendLabel(10)).toBe("11th time sent");
    expect(resendLabel(11)).toBe("12th time sent");
    expect(resendLabel(12)).toBe("13th time sent");
    expect(resendLabel(20)).toBe("21st time sent");
    expect(resendLabel(21)).toBe("22nd time sent");
  });

  it("treats a nonsense count as no annotation rather than crashing", () => {
    expect(resendLabel(Number.NaN)).toBe("");
    expect(resendLabel(-1)).toBe("");
  });
});

describe("amount formatting", () => {
  it("rounds the exact decimal string for display", () => {
    expect(formatEstimateAmount("120000.55")).toBe("$120,001");
    expect(formatEstimateAmount("250000.00")).toBe("$250,000");
  });

  // The CRM sends 0 for a deal with nothing set. Printing "$0" would assert the deal is worth
  // nothing; the em-dash matches how the RFP half already renders an unknown value.
  it("renders an em-dash rather than $0 for a deal with no value", () => {
    expect(formatEstimateAmount("0")).toBe("—");
    expect(formatEstimateAmount("")).toBe("—");
    expect(formatEstimateAmount("not-a-number")).toBe("—");
  });
});

describe("escaping", () => {
  it("escapes a deal name, so a project title cannot inject markup", async () => {
    const html = await render({
      ok: true,
      deals: [deal({ name: `<script>alert(1)</script>`, ownerName: `A & B "Co"` })],
    });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("A &amp; B &quot;Co&quot;");
  });
});

describe("the CRM client", () => {
  const WINDOW_FROM = new Date("2026-08-06T00:00:00.000Z");
  const WINDOW_TO = new Date("2026-08-07T00:00:00.000Z");

  function ok(body: unknown) {
    return async () =>
      ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
  }

  it("reports not_configured rather than failed when the CRM is not wired up", async () => {
    const result = await fetchCrmEstimatesSent(WINDOW_FROM, WINDOW_TO, {
      baseUrl: "",
      secret: "",
      logger: () => {},
    });

    expect(result).toEqual({ ok: false, reason: "not_configured" });
  });

  it("signs the body it actually sends", async () => {
    let seen: { url?: string; init?: RequestInit } = {};
    await fetchCrmEstimatesSent(WINDOW_FROM, WINDOW_TO, {
      baseUrl: "https://crm.example.com/",
      secret: "shhh",
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return { ok: true, status: 200, json: async () => ({ deals: [] }) } as unknown as Response;
      },
      logger: () => {},
    });

    expect(seen.url).toBe("https://crm.example.com/api/internal/estimates-sent");
    expect(String(seen.init?.body)).toBe(
      JSON.stringify({ from: WINDOW_FROM.toISOString(), to: WINDOW_TO.toISOString() })
    );
    const header = (seen.init?.headers as Record<string, string>)["x-rfp-request-signature"];
    expect(header).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("reports a failure on a non-2xx, rather than an empty day", async () => {
    const result = await fetchCrmEstimatesSent(WINDOW_FROM, WINDOW_TO, {
      baseUrl: "https://crm.example.com",
      secret: "shhh",
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) as unknown as Response,
      logger: () => {},
    });

    expect(result).toEqual({ ok: false, reason: "failed" });
  });

  it("reports a failure on an unexpected shape", async () => {
    const result = await fetchCrmEstimatesSent(WINDOW_FROM, WINDOW_TO, {
      baseUrl: "https://crm.example.com",
      secret: "shhh",
      fetchImpl: ok({ nope: true }),
      logger: () => {},
    });

    expect(result).toEqual({ ok: false, reason: "failed" });
  });

  it("reports a failure when the request throws, and never rejects", async () => {
    const result = await fetchCrmEstimatesSent(WINDOW_FROM, WINDOW_TO, {
      baseUrl: "https://crm.example.com",
      secret: "shhh",
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
      logger: () => {},
    });

    expect(result).toEqual({ ok: false, reason: "failed" });
  });

  it("drops a row it cannot render or order, and counts only what survived", async () => {
    const result = await fetchCrmEstimatesSent(WINDOW_FROM, WINDOW_TO, {
      baseUrl: "https://crm.example.com",
      secret: "shhh",
      fetchImpl: ok({
        deals: [
          { ...deal(), dealId: "" },
          { ...deal(), enteredAt: "not-a-date" },
          deal({ dealId: "keeps" }),
        ],
      }),
      logger: () => {},
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.deals).toHaveLength(1);
      expect(result.deals[0]!.dealId).toBe("keeps");
    }
  });

  // The exact-decimal choice made on the CRM side is undone if this coerces to a number.
  it("keeps the amount as the string the CRM sent", async () => {
    const result = await fetchCrmEstimatesSent(WINDOW_FROM, WINDOW_TO, {
      baseUrl: "https://crm.example.com",
      secret: "shhh",
      fetchImpl: ok({ deals: [deal({ amount: "120000.55" })] }),
      logger: () => {},
    });

    if (!result.ok) throw new Error("expected ok");
    expect(result.deals[0]!.amount).toBe("120000.55");
    expect(typeof result.deals[0]!.amount).toBe("string");
  });

  it("times out rather than hanging the scheduled email", async () => {
    const result = await fetchCrmEstimatesSent(WINDOW_FROM, WINDOW_TO, {
      baseUrl: "https://crm.example.com",
      secret: "shhh",
      timeoutMs: 10,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          (init?.signal as AbortSignal | undefined)?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
      logger: () => {},
    });

    expect(result).toEqual({ ok: false, reason: "failed" });
  });
});
