import crypto from "crypto";
import { describe, expect, it, vi } from "vitest";

// Same stubs as rfp-report-email.test.ts: rfp-reports.ts imports ./db (which throws without
// DATABASE_URL), ./storage and ./email-service. The builder under test is pure.
vi.mock("../server/db", () => ({ db: {}, pool: {} }));
vi.mock("../server/storage", () => ({ storage: {} }));
vi.mock("../server/email-service", () => ({ sendEmail: vi.fn() }));

import { buildRfpReportEmailHtml } from "../server/rfp-reports";
import { EMAIL_CARD_BUDGET, shareCardBudget } from "../server/rfp-reports";
import {
  clampEstimatesSentWindow,
  fetchCrmEstimatesSent,
  formatEstimateAmount,
  MAX_ESTIMATES_SENT_ROWS,
  MAX_ESTIMATES_SENT_REQUESTS,
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
    const html = await render({ ok: true, deals: [deal()], total: 1, coveredFrom: "2026-08-01T00:00:00.000Z" });

    expect(html).toContain("Estimates Sent to Client — Last 24 Hours");
    expect(html).toContain("Elan at Bluffview");
    expect(html).toContain("Andrew Green");
    expect(html).toContain("DFW-4-21826-ad");
    // Rounded for display, from the exact decimal string the CRM sent.
    expect(html).toContain("$120,001");
  });

  it("counts the section in the stat chips", async () => {
    const html = await render({ ok: true, deals: [deal(), deal({ dealId: "d-2" })], total: 2 });
    expect(html).toContain("2 Estimates Sent");
  });

  it("uses the singular for exactly one", async () => {
    const html = await render({ ok: true, deals: [deal()], total: 1, coveredFrom: "2026-08-01T00:00:00.000Z" });
    expect(html).toContain("1 Estimate Sent");
  });

  it("says plainly when nothing was sent", async () => {
    const html = await render({ ok: true, deals: [], total: 0, coveredFrom: "2026-08-01T00:00:00.000Z" });

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
    const html = await render({ ok: true, deals: [deal({ priorEntryCount: 1 })], total: 1 });
    expect(html).toContain("2nd time sent");
  });

  it("says nothing on a first send", async () => {
    const html = await render({ ok: true, deals: [deal({ priorEntryCount: 0 })], total: 1 });
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

describe("the row cap and ordering the email relies on", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      deal({
        dealId: `d-${String(i).padStart(4, "0")}`,
        // Deliberately ASCENDING, so an unsorted client would hand the renderer the OLDEST 30.
        enteredAt: new Date(Date.UTC(2026, 7, 1, 0, i % 1000)).toISOString(),
      })
    );

  it("returns rows newest first, so the email's first 30 really are the newest", async () => {
    const result = await fetchCrmEstimatesSent(new Date("2026-08-01T00:00:00Z"), new Date("2026-08-07T00:00:00Z"), {
      baseUrl: "https://crm.example.com",
      secret: "shhh",
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ deals: many(50) }) }) as unknown as Response,
      logger: () => {},
    });

    if (!result.ok) throw new Error("expected ok");
    const times = result.deals.map((d) => Date.parse(d.enteredAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("enforces the declared cap instead of documenting one it never applied", async () => {
    const result = await fetchCrmEstimatesSent(new Date("2026-08-01T00:00:00Z"), new Date("2026-08-07T00:00:00Z"), {
      baseUrl: "https://crm.example.com",
      secret: "shhh",
      fetchImpl: async () =>
        ({ ok: true, status: 200, json: async () => ({ deals: many(MAX_ESTIMATES_SENT_ROWS + 25) }) }) as unknown as Response,
      logger: () => {},
    });

    if (!result.ok) throw new Error("expected ok");
    expect(result.deals).toHaveLength(MAX_ESTIMATES_SENT_ROWS);
    // …and the TRUE total survives the cap, so the email never prints an exact-looking 500 for a
    // period that held more.
    expect(result.total).toBe(MAX_ESTIMATES_SENT_ROWS + 25);
  });

  it("counts the real total in the chip, and says only the list is capped", async () => {
    const html = await render({
      ok: true,
      deals: many(MAX_ESTIMATES_SENT_ROWS),
      total: MAX_ESTIMATES_SENT_ROWS + 25,
    });

    expect(html).toContain(`${MAX_ESTIMATES_SENT_ROWS + 25} Estimates Sent`);
    expect(html).toContain(`Showing ${EMAIL_CARD_BUDGET} of ${MAX_ESTIMATES_SENT_ROWS + 25} estimates sent.`);
    expect(html).toContain(`Only the ${MAX_ESTIMATES_SENT_ROWS} most recent are listed.`);
  });

  it("says nothing about the list cap when the total is under it", async () => {
    const html = await render({ ok: true, deals: many(40), total: 40, coveredFrom: "2026-08-01T00:00:00.000Z" });
    expect(html).not.toContain("most recent are listed");
  });

  it("renders the truncation note with the real total", async () => {
    const html = await render({ ok: true, deals: many(40), total: 40, coveredFrom: "2026-08-01T00:00:00.000Z" });
    // With no RFPs competing for the budget, the estimates section gets the whole of it.
    expect(html).toContain(`Showing ${EMAIL_CARD_BUDGET} of 40 estimates sent.`);
  });

  it("says nothing about truncation when everything fits", async () => {
    const html = await render({ ok: true, deals: many(5), total: 5, coveredFrom: "2026-08-01T00:00:00.000Z" });
    expect(html).not.toContain("estimates sent.");
  });
});

// A monthly run sets dateFrom to MIDNIGHT one month back while dateTo keeps the current time, so after a
// 31-day month the span exceeds the CRM's 31-day limit by however long the report has been running —
// a 422, and "could not be loaded" every single month.
describe("the request window", () => {
  it("leaves an ordinary window alone", () => {
    const from = new Date("2026-08-06T00:00:00Z");
    const to = new Date("2026-08-07T00:00:00Z");
    expect(clampEstimatesSentWindow(from, to)).toEqual({ from, to });
  });

  it("keeps an EXACTLY 31-day window intact", () => {
    // The CRM rejects only `> 31 days`, and the bounds travel as serialized timestamps — nothing drifts
    // in transit. An earlier version shaved a second off as a margin against skew that cannot happen,
    // and so silently dropped the first second of every clamped window.
    const to = new Date("2026-08-06T08:00:00Z");
    const from = new Date(to.getTime() - 31 * 24 * 60 * 60 * 1000);
    expect(clampEstimatesSentWindow(from, to)).toEqual({ from, to });
  });

  it("clamps a monthly window that midnight-rounding pushed over the limit", () => {
    // 31 days back, rounded to midnight, from a 08:00 send.
    const to = new Date("2026-08-06T08:00:00Z");
    const from = new Date("2026-07-06T00:00:00Z");
    expect(to.getTime() - from.getTime()).toBeGreaterThan(31 * 24 * 60 * 60 * 1000);

    const clamped = clampEstimatesSentWindow(from, to);
    expect(clamped.to).toEqual(to);
    expect(clamped.to.getTime() - clamped.from.getTime()).toBe(31 * 24 * 60 * 60 * 1000);
  });

  it("sends the clamped window, not the requested one", async () => {
    let body = "";
    await fetchCrmEstimatesSent(new Date("2026-07-06T00:00:00Z"), new Date("2026-08-06T08:00:00Z"), {
      baseUrl: "https://crm.example.com",
      secret: "shhh",
      fetchImpl: async (_url, init) => {
        body = String(init?.body);
        return { ok: true, status: 200, json: async () => ({ deals: [] }) } as unknown as Response;
      },
      logger: () => {},
    });

    const sent = JSON.parse(body) as { from: string; to: string };
    expect(Date.parse(sent.to) - Date.parse(sent.from)).toBeLessThanOrEqual(31 * 24 * 60 * 60 * 1000);
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
      total: 1,
      coveredFrom: "2026-08-01T00:00:00.000Z",
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
    // The DIGEST, not its shape. Any HMAC over any input is 64 hex characters, so a format check passes
    // even if the module signed the wrong payload, used the wrong secret, or signed a re-serialised body
    // whose key order differs from the one actually sent. Signature correctness is the whole boundary.
    const header = (seen.init?.headers as Record<string, string>)["x-rfp-request-signature"];
    const expected = `sha256=${crypto.createHmac("sha256", "shhh").update(String(seen.init?.body)).digest("hex")}`;
    expect(header).toBe(expected);
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

  // Dropping the bad rows and returning ok:true presented the survivors as a COMPLETE answer — an
  // understated count, or "No estimates sent" if every row was affected. That defeats the discriminator
  // during schema drift, which is exactly when it matters.
  it("reports a failure rather than presenting the surviving rows as the whole answer", async () => {
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

    expect(result).toEqual({ ok: false, reason: "failed" });
  });

  it("still succeeds when every row is well-formed", async () => {
    const result = await fetchCrmEstimatesSent(WINDOW_FROM, WINDOW_TO, {
      baseUrl: "https://crm.example.com",
      secret: "shhh",
      fetchImpl: ok({ deals: [deal({ dealId: "a" }), deal({ dealId: "b" })] }),
      logger: () => {},
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.deals).toHaveLength(2);
      expect(result.total).toBe(2);
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


// Gmail clips an HTML message at roughly 102 KB, and this service sends through Gmail. A 30-card RFP
// section is already ~98 KB; an independent 30 estimate cards took a measured build to ~155 KB, so the
// BUSIEST reports lost most of the estimates section, the approval summary and the footer behind a
// "[Message clipped]" link. The two sections are not independent — it is their sum that gets clipped.
describe("the shared card budget", () => {
  it("never exceeds the budget, however busy both sections are", () => {
    const split = shareCardBudget(500, 500);
    expect(split.rfp + split.estimates).toBe(EMAIL_CARD_BUDGET);
  });

  it("guarantees each section its half when both can fill it", () => {
    const split = shareCardBudget(100, 100);
    expect(split.rfp).toBe(EMAIL_CARD_BUDGET / 2);
    expect(split.estimates).toBe(EMAIL_CARD_BUDGET / 2);
  });

  // A quiet day on one side should not waste the headroom on the other.
  it("lets one section use what the other does not need", () => {
    expect(shareCardBudget(100, 0)).toEqual({ rfp: EMAIL_CARD_BUDGET, estimates: 0 });
    expect(shareCardBudget(0, 100)).toEqual({ rfp: 0, estimates: EMAIL_CARD_BUDGET });
    expect(shareCardBudget(2, 100)).toEqual({ rfp: 2, estimates: EMAIL_CARD_BUDGET - 2 });
  });

  it("asks for nothing when there is nothing to show", () => {
    expect(shareCardBudget(0, 0)).toEqual({ rfp: 0, estimates: 0 });
  });

  it("never asks for more cards than a section actually has", () => {
    const split = shareCardBudget(3, 4);
    expect(split.rfp).toBe(3);
    expect(split.estimates).toBe(4);
  });

  // A section that will not RENDER must not reserve anything. With includeRfpLog off there are no RFP
  // cards at all, and counting them anyway trimmed a busy estimates list to half a budget that was
  // entirely free.
  it("gives the whole budget to estimates when the RFP log is switched off", async () => {
    const html = await buildRfpReportEmailHtml({
      periodLabel: "Last 24 Hours",
      rfps: [],
      changes: [],
      approvalSummary: { pending: 0, approved: 0, rejected: 0 },
      includeRfpLog: false,
      includeApprovalSummary: false,
      estimatesSent: {
        ok: true,
        deals: Array.from({ length: 40 }, (_, i) =>
          deal({ dealId: `x-${i}`, enteredAt: new Date(Date.UTC(2026, 7, 1, 0, i)).toISOString() })
        ),
        total: 40,
        coveredFrom: "2026-08-01T00:00:00.000Z",
      },
      dashboardUrl: "https://synchub.example.com/settings",
    });

    expect(html).toContain(`Showing ${EMAIL_CARD_BUDGET} of 40 estimates sent.`);
  });
});

// A catch-up after a disabled schedule or a long outage used to lose everything older than 31 days —
// and because the scheduler advances lastSentAt on a successful send, those estimates would never have
// appeared in ANY later report either, while the lookup reported ok.
describe("covering a long catch-up interval", () => {
  function countingFetch(seen: string[][]) {
    return async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { from: string; to: string };
      seen.push([body.from, body.to]);
      return { ok: true, status: 200, json: async () => ({ deals: [] }) } as unknown as Response;
    };
  }

  it("splits a 90-day gap into endpoint-sized requests instead of dropping the oldest 59 days", async () => {
    const seen: string[][] = [];
    const to = new Date("2026-08-06T00:00:00Z");
    const from = new Date(to.getTime() - 90 * 24 * 60 * 60 * 1000);

    const result = await fetchCrmEstimatesSent(from, to, {
      baseUrl: "https://crm.example.com",
      secret: "shhh",
      fetchImpl: countingFetch(seen),
      logger: () => {},
    });

    expect(seen.length).toBeGreaterThan(1);
    // Contiguous, newest first: each chunk starts where the previous one ended.
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]![1]).toBe(seen[i - 1]![0]);
    }
    if (!result.ok) throw new Error("expected ok");
    expect(Date.parse(result.coveredFrom)).toBe(from.getTime());
  });

  it("makes ONE request for an ordinary window", async () => {
    const seen: string[][] = [];
    await fetchCrmEstimatesSent(new Date("2026-08-05T00:00:00Z"), new Date("2026-08-06T00:00:00Z"), {
      baseUrl: "https://crm.example.com",
      secret: "shhh",
      fetchImpl: countingFetch(seen),
      logger: () => {},
    });

    expect(seen).toHaveLength(1);
  });

  // Past the request budget the reach is stated rather than silently shortened.
  it("reports how far back it actually reached when the gap exceeds the budget", async () => {
    const to = new Date("2026-08-06T00:00:00Z");
    const from = new Date(to.getTime() - 400 * 24 * 60 * 60 * 1000);

    const result = await fetchCrmEstimatesSent(from, to, {
      baseUrl: "https://crm.example.com",
      secret: "shhh",
      fetchImpl: countingFetch([]),
      logger: () => {},
    });

    if (!result.ok) throw new Error("expected ok");
    expect(Date.parse(result.coveredFrom)).toBeGreaterThan(from.getTime());
    expect(Date.parse(result.coveredFrom)).toBe(
      to.getTime() - MAX_ESTIMATES_SENT_REQUESTS * 31 * 24 * 60 * 60 * 1000
    );
  });
});

// priorEntryCount drives the re-send badge. Coercing a missing or malformed value to 0 does not degrade
// gracefully — it presents a revised estimate as new business, the one thing the annotation prevents.
describe("a malformed resend count", () => {
  it("makes the row unusable rather than silently reading as a first send", async () => {
    for (const bad of [undefined, null, "2", -1, 1.5, Number.NaN]) {
      const result = await fetchCrmEstimatesSent(new Date("2026-08-05T00:00:00Z"), new Date("2026-08-06T00:00:00Z"), {
        baseUrl: "https://crm.example.com",
        secret: "shhh",
        fetchImpl: async () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({ deals: [{ ...deal(), priorEntryCount: bad }] }),
          }) as unknown as Response,
        logger: () => {},
      });

      expect(result, `priorEntryCount=${String(bad)}`).toEqual({ ok: false, reason: "failed" });
    }
  });

  it("accepts a genuine zero", async () => {
    const result = await fetchCrmEstimatesSent(new Date("2026-08-05T00:00:00Z"), new Date("2026-08-06T00:00:00Z"), {
      baseUrl: "https://crm.example.com",
      secret: "shhh",
      fetchImpl: async () =>
        ({ ok: true, status: 200, json: async () => ({ deals: [deal({ priorEntryCount: 0 })] }) }) as unknown as Response,
      logger: () => {},
    });

    expect(result.ok).toBe(true);
  });
});

// After a pause or an outage the estimates window is the whole catch-up interval, so captioning it with
// the report's cadence label ("Last 7 Days") over a three-week count is a false statement about the data.
describe("the section captions its own span", () => {
  it("labels the estimates section with the interval it actually queried", async () => {
    const html = await buildRfpReportEmailHtml({
      periodLabel: "Last 7 Days",
      rfps: [],
      changes: [],
      approvalSummary: { pending: 0, approved: 0, rejected: 0 },
      includeRfpLog: true,
      includeApprovalSummary: false,
      estimatesSent: { ok: true, deals: [deal()], total: 1, coveredFrom: "2026-07-16T00:00:00.000Z" },
      estimatesPeriod: { from: new Date("2026-07-16T00:00:00Z"), to: new Date("2026-08-06T00:00:00Z") },
      dashboardUrl: "https://synchub.example.com/settings",
    });

    // The RFP half keeps the cadence label; the estimates half states its real span.
    //
    // Rendered in CENTRAL time, like every other timestamp in this email, so a UTC-midnight bound shows
    // as the previous Central day. Asserted as the Central rendering rather than the UTC one, because
    // Central is what the reader sees everywhere else in the message.
    expect(html).toContain("RFP Activity — Last 7 Days");
    expect(html).toContain("Estimates Sent to Client — Jul 15, 2026 – Aug 5, 2026");
  });

  // A zero over a PARTIALLY covered interval is not a whole-period zero.
  it("warns about partial coverage even when the covered portion is empty", async () => {
    const html = await buildRfpReportEmailHtml({
      periodLabel: "Last 7 Days",
      rfps: [],
      changes: [],
      approvalSummary: { pending: 0, approved: 0, rejected: 0 },
      includeRfpLog: true,
      includeApprovalSummary: false,
      // Asked for a year, only the most recent stretch was reachable.
      estimatesSent: { ok: true, deals: [], total: 0, coveredFrom: "2026-04-06T00:00:00.000Z" },
      estimatesPeriod: { from: new Date("2025-08-06T00:00:00Z"), to: new Date("2026-08-06T00:00:00Z") },
      dashboardUrl: "https://synchub.example.com/settings",
    });

    expect(html).toContain("No estimates sent to clients in this period.");
    expect(html).toContain("were checked — earlier ones in this interval were not");
  });

  it("says nothing about partial coverage when the whole interval was covered", async () => {
    const html = await buildRfpReportEmailHtml({
      periodLabel: "Last 24 Hours",
      rfps: [],
      changes: [],
      approvalSummary: { pending: 0, approved: 0, rejected: 0 },
      includeRfpLog: true,
      includeApprovalSummary: false,
      estimatesSent: { ok: true, deals: [], total: 0, coveredFrom: "2026-08-05T00:00:00.000Z" },
      estimatesPeriod: { from: new Date("2026-08-05T00:00:00Z"), to: new Date("2026-08-06T00:00:00Z") },
      dashboardUrl: "https://synchub.example.com/settings",
    });

    expect(html).not.toContain("earlier ones in this interval were not");
  });
});
