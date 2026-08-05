import { describe, expect, it, vi } from "vitest";

// rfp-reports.ts imports ./db (throws without DATABASE_URL), ./storage, ./email-service.
// Everything exercised here is pure or dependency-injected, so stub those out.
vi.mock("../server/db", () => ({ db: {}, pool: {} }));
vi.mock("../server/storage", () => ({ storage: {} }));
vi.mock("../server/email-service", () => ({ sendEmail: vi.fn() }));

import {
  buildRfpReportEmailHtml,
  resolveMissingAmountsFromCrm,
  type RfpReportRow,
} from "../server/rfp-reports";
import {
  CRM_CURRENT_VALUES_MAX_DEAL_IDS,
  fetchCrmCurrentDealAmounts,
} from "../server/crm-deal-values";

const CRM_BASE = "https://crm.example.com";
const SECRET = "shared-secret";

/** A CRM-sourced RFP whose stored snapshot is blank — the production shape this work exists for. */
function blankCrmRow(overrides: Partial<RfpReportRow> = {}): RfpReportRow {
  return {
    id: 1,
    hubspotDealId: "",
    sourceSystem: "trock_crm",
    sourceDealId: "11111111-1111-4111-8111-111111111111",
    projectName: "Bristol Creek Apartments",
    projectNumber: "DFW-4-15626-ab",
    projectType: "Service",
    recipient: "owner@trockgc.com",
    dateSent: "2026-07-30T16:42:00.000Z",
    bidboardStage: "Linked",
    approvalStatus: "pending",
    changeCount: 0,
    amount: null,
    amountIsCurrent: false,
    requestedBy: "Jane Owner",
    approvedBy: null,
    declinedBy: null,
    bidBoardUrl: null,
    crmUrl: null,
    ...overrides,
  };
}

const renderEmail = (rfps: RfpReportRow[]) =>
  buildRfpReportEmailHtml({
    periodLabel: "Last 24 Hours",
    rfps,
    changes: [],
    approvalSummary: { pending: rfps.length, approved: 0, rejected: 0 },
    includeRfpLog: true,
    includeApprovalSummary: false,
    dashboardUrl: "https://synchub.example.com/settings",
  });

function okResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("resolveMissingAmountsFromCrm", () => {
  it("fills in the current value for a CRM row whose send-time snapshot is blank", async () => {
    const rows = [blankCrmRow()];
    const fetchAmounts = vi.fn(async () => new Map([["11111111-1111-4111-8111-111111111111", 248500]]));

    await resolveMissingAmountsFromCrm(rows, { fetchAmounts });

    expect(rows[0].amount).toBe(248500);
    expect(rows[0].amountIsCurrent).toBe(true);
  });

  it("makes ONE batch call for the whole report, not one per row", async () => {
    const rows = [
      blankCrmRow({ id: 1, sourceDealId: "11111111-1111-4111-8111-111111111111" }),
      blankCrmRow({ id: 2, sourceDealId: "22222222-2222-4222-8222-222222222222" }),
      blankCrmRow({ id: 3, sourceDealId: "33333333-3333-4333-8333-333333333333" }),
    ];
    const fetchAmounts = vi.fn(async (ids: string[]) => new Map(ids.map((id, i) => [id, (i + 1) * 1000])));

    await resolveMissingAmountsFromCrm(rows, { fetchAmounts });

    expect(fetchAmounts).toHaveBeenCalledTimes(1);
    expect(fetchAmounts.mock.calls[0][0]).toHaveLength(3);
    expect(rows.map((r) => r.amount)).toEqual([1000, 2000, 3000]);
  });

  it("never touches a row that already has a stored amount", async () => {
    const rows = [blankCrmRow({ amount: 4500 })];
    const fetchAmounts = vi.fn(async () => new Map([["11111111-1111-4111-8111-111111111111", 999999]]));

    await resolveMissingAmountsFromCrm(rows, { fetchAmounts });

    expect(fetchAmounts).not.toHaveBeenCalled();
    expect(rows[0].amount).toBe(4500);
    expect(rows[0].amountIsCurrent).toBe(false);
  });

  it("still backfills a row whose edited_fields merely carried a blank amount", async () => {
    // resolveRfpAmount reads `edited_fields.amount === ""` as null, and there is no way to tell a
    // deliberate clear from the approval form's own echo — processRfpApproval diffs every posted
    // field against dealData with `!==`, so it writes keys nobody typed. Skipping these rows would
    // fail CLOSED and silently suppress the very backfill this exists for. A blank is not a value.
    const rows = [blankCrmRow({ id: 7 })];
    const fetchAmounts = vi.fn(async () => new Map([["11111111-1111-4111-8111-111111111111", 248500]]));

    await resolveMissingAmountsFromCrm(rows, { fetchAmounts });

    expect(rows[0].amount).toBe(248500);
    expect(rows[0].amountIsCurrent).toBe(true);
  });

  it("ignores HubSpot-sourced rows — the CRM has nothing to say about them", async () => {
    const rows = [blankCrmRow({ sourceSystem: "hubspot", sourceDealId: "24680135791" })];
    const fetchAmounts = vi.fn(async () => new Map());

    await resolveMissingAmountsFromCrm(rows, { fetchAmounts });

    expect(fetchAmounts).not.toHaveBeenCalled();
    expect(rows[0].amount).toBeNull();
  });

  it("matches the CRM's canonical lower-case uuid even when the stored id is upper-case", async () => {
    const rows = [blankCrmRow({ sourceDealId: "11111111-1111-4111-8111-AAAAAAAAAAAA" })];
    // The CRM keys its answer on `row.id`, which Postgres always renders lower-case — whatever
    // casing it was asked with. So the lookup, not the request, is what has to normalize.
    const fetchAmounts = vi.fn(
      async () => new Map([["11111111-1111-4111-8111-aaaaaaaaaaaa", 248500]])
    );

    await resolveMissingAmountsFromCrm(rows, { fetchAmounts });

    expect(rows[0].amount).toBe(248500);
    expect(rows[0].amountIsCurrent).toBe(true);
  });

  it("keeps the em-dash when the CRM cannot resolve a particular deal", async () => {
    const rows = [blankCrmRow()];
    const fetchAmounts = vi.fn(async () => new Map([["some-other-deal", 1]]));

    await resolveMissingAmountsFromCrm(rows, { fetchAmounts });

    expect(rows[0].amount).toBeNull();
    expect(rows[0].amountIsCurrent).toBe(false);
  });

  it("fails soft: a throwing lookup is swallowed and every row is left exactly as it was", async () => {
    const rows = [blankCrmRow(), blankCrmRow({ id: 2, amount: 4500 })];
    const fetchAmounts = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });

    // The real fetcher never throws, but this runs on the scheduled-email path and must not
    // depend on that promise — a lookup can never be the reason the email does not send.
    await expect(resolveMissingAmountsFromCrm(rows, { fetchAmounts })).resolves.toBe(rows);
    expect(rows[0].amount).toBeNull();
    expect(rows[0].amountIsCurrent).toBe(false);
    expect(rows[1].amount).toBe(4500);
  });

  it("fails soft end-to-end: an unreachable CRM still yields a complete, sendable email", async () => {
    const rows = [blankCrmRow(), blankCrmRow({ id: 2, amount: 4500 })];
    const unreachable = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });

    await resolveMissingAmountsFromCrm(rows, { fetchAmounts: unreachable });
    const html = await renderEmail(rows);

    expect(html).toContain("Bristol Creek Apartments");
    expect(html).toContain("—");
    expect(html).toContain("$4,500");
    expect(html).not.toContain("Deal value as of today");
    expect(html).toContain("</html>");
  });
});

describe("precedence: reviewer edit > stored snapshot > live lookup", () => {
  it("applies exactly one source per row and only marks the live ones", async () => {
    const rows = [
      // Reviewer edited to 4500 — resolveRfpAmount already put it in `amount`, so it is not null
      // and can never reach the lookup. That is the whole mechanism by which reviewer edits win.
      blankCrmRow({ id: 1, amount: 4500, sourceDealId: "11111111-1111-4111-8111-111111111111" }),
      // Stored snapshot had a real value at send time.
      blankCrmRow({ id: 2, amount: 88000, sourceDealId: "22222222-2222-4222-8222-222222222222" }),
      // Blank snapshot — the only row eligible for a live value.
      blankCrmRow({ id: 3, sourceDealId: "33333333-3333-4333-8333-333333333333" }),
    ];
    const fetchAmounts = vi.fn(async () => new Map([["33333333-3333-4333-8333-333333333333", 248500]]));

    await resolveMissingAmountsFromCrm(rows, { fetchAmounts });

    expect(fetchAmounts).toHaveBeenCalledTimes(1);
    // Only the blank row was ever asked about — a reviewer edit is not even a candidate.
    expect(fetchAmounts.mock.calls[0][0]).toEqual(["33333333-3333-4333-8333-333333333333"]);
    expect(rows.map((r) => [r.amount, r.amountIsCurrent])).toEqual([
      [4500, false],
      [88000, false],
      [248500, true],
    ]);
  });
});

describe("fetchCrmCurrentDealAmounts", () => {
  const deps = (fetchImpl: any, extra: Record<string, unknown> = {}) => ({
    fetchImpl,
    baseUrl: CRM_BASE,
    secret: SECRET,
    logger: () => {},
    ...extra,
  });

  it("signs the batch with the shared secret the CRM already verifies", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({ values: [{ dealId: "deal-a", amount: 1000 }], maxDealIds: 500 })
    );

    const result = await fetchCrmCurrentDealAmounts(["deal-a"], deps(fetchImpl));

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${CRM_BASE}/api/internal/deals/current-values`);
    expect(init.method).toBe("POST");
    expect(init.headers["x-rfp-request-signature"]).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(JSON.parse(init.body)).toEqual({ dealIds: ["deal-a"] });
    expect(result.get("deal-a")).toBe(1000);
  });

  it("drops `amount: null` — a deal the CRM knows but that is still worth nothing keeps its em-dash", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({ values: [{ dealId: "deal-a", amount: null }, { dealId: "deal-b", amount: 0 }] })
    );

    const result = await fetchCrmCurrentDealAmounts(["deal-a", "deal-b"], deps(fetchImpl));

    expect(result.has("deal-a")).toBe(false);
    // 0 is a real answer and must survive.
    expect(result.get("deal-b")).toBe(0);
  });

  it("refuses values that only LOOK numeric once coerced", async () => {
    // Number(""), Number([]) and Number(false) are all a finite 0. Coercing first would put a
    // confident "$0 †" on a leadership email — strictly worse than the em-dash it replaced.
    const fetchImpl = vi.fn(async () =>
      okResponse({
        values: [
          { dealId: "blank", amount: "" },
          { dealId: "whitespace", amount: "   " },
          { dealId: "array", amount: [] },
          { dealId: "bool", amount: false },
          { dealId: "object", amount: {} },
          { dealId: "words", amount: "not a number" },
          { dealId: "missing" },
          // Genuinely numeric, including a numeric string, must still get through.
          { dealId: "num", amount: 248500 },
          { dealId: "numeric-string", amount: "1234.5" },
          { dealId: "real-zero", amount: 0 },
        ],
      })
    );

    const result = await fetchCrmCurrentDealAmounts(["x"], deps(fetchImpl));

    expect([...result.keys()].sort()).toEqual(["num", "numeric-string", "real-zero"]);
    expect(result.get("num")).toBe(248500);
    expect(result.get("numeric-string")).toBe(1234.5);
    expect(result.get("real-zero")).toBe(0);
  });

  it("lower-cases the keys it returns so the contract does not depend on the CRM", async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({ values: [{ dealId: "11111111-1111-4111-8111-AAAAAAAAAAAA", amount: 248500 }] })
    );

    const result = await fetchCrmCurrentDealAmounts(["11111111-1111-4111-8111-aaaaaaaaaaaa"], deps(fetchImpl));

    expect(result.get("11111111-1111-4111-8111-aaaaaaaaaaaa")).toBe(248500);
  });

  it("fails soft on a non-2xx CRM response without trusting its body", async () => {
    // Deliberately a body that WOULD parse into usable values. Status is the authority: a 503 from a
    // proxy serving a stale payload, or the CRM's own 422 for an over-cap batch, must not be read as
    // an answer. Asserting the map is empty is not enough — a body with no `values` would make that
    // pass either way — so also prove we never even looked.
    const json = vi.fn(async () => ({ values: [{ dealId: "deal-a", amount: 999999 }] }));
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 503, json }) as unknown as Response);

    await expect(fetchCrmCurrentDealAmounts(["deal-a"], deps(fetchImpl))).resolves.toEqual(new Map());
    expect(json).not.toHaveBeenCalled();

    const json422 = vi.fn(async () => ({ error: "too_many_deal_ids", maxDealIds: 500 }));
    const over = vi.fn(async () => ({ ok: false, status: 422, json: json422 }) as unknown as Response);
    await expect(fetchCrmCurrentDealAmounts(["deal-a"], deps(over))).resolves.toEqual(new Map());
    expect(json422).not.toHaveBeenCalled();
  });

  it("fails soft on a 401 — a rotated secret must not break the report", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ success: false, error: "invalid_signature" }, 401));
    await expect(fetchCrmCurrentDealAmounts(["deal-a"], deps(fetchImpl))).resolves.toEqual(new Map());
  });

  it("fails soft on a network error or timeout", async () => {
    const thrown = vi.fn(async () => {
      throw new Error("Request to … timed out after 5000ms");
    });
    await expect(fetchCrmCurrentDealAmounts(["deal-a"], deps(thrown))).resolves.toEqual(new Map());
  });

  it(
    "bounds the BODY read, not just the headers",
    async () => {
      // A CRM (or proxy) that sends 200 OK and then stalls mid-JSON. The repo's fetchWithTimeout
      // helper clears its abort timer the moment fetch() resolves — i.e. on headers — which would
      // leave this response.json() completely unbounded and hang the scheduled email. The deadline
      // has to still be armed here.
      let aborted = false;
      const stalled = vi.fn(async (_url: string, init: any) => {
        init.signal.addEventListener("abort", () => {
          aborted = true;
        });
        return {
          ok: true,
          status: 200,
          json: () =>
            new Promise((_resolve, reject) => {
              init.signal.addEventListener("abort", () =>
                reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
              );
            }),
        } as unknown as Response;
      });

      await expect(
        fetchCrmCurrentDealAmounts(["deal-a"], deps(stalled, { timeoutMs: 50 }))
      ).resolves.toEqual(new Map());
      expect(aborted).toBe(true);
    },
    2000
  );

  it("clears its deadline on the happy path so the process can exit", async () => {
    const fetchImpl = vi.fn(async (_url: string, init: any) => {
      expect(init.signal.aborted).toBe(false);
      return okResponse({ values: [{ dealId: "deal-a", amount: 1 }] });
    });

    const result = await fetchCrmCurrentDealAmounts(["deal-a"], deps(fetchImpl, { timeoutMs: 50 }));

    expect(result.get("deal-a")).toBe(1);
    // If the timer were left armed, this would still be pending 50ms from now.
    await new Promise((r) => setTimeout(r, 80));
  });

  it("fails soft on a malformed response body", async () => {
    const badShape = vi.fn(async () => okResponse({ notValues: 1 }));
    await expect(fetchCrmCurrentDealAmounts(["deal-a"], deps(badShape))).resolves.toEqual(new Map());

    const badJson = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    }) as unknown as Response);
    await expect(fetchCrmCurrentDealAmounts(["deal-a"], deps(badJson))).resolves.toEqual(new Map());
  });

  it("does not call out at all when the CRM is not configured", async () => {
    const fetchImpl = vi.fn();
    await expect(
      fetchCrmCurrentDealAmounts(["deal-a"], { fetchImpl, baseUrl: "", secret: SECRET, logger: () => {} })
    ).resolves.toEqual(new Map());
    await expect(
      fetchCrmCurrentDealAmounts(["deal-a"], { fetchImpl, baseUrl: CRM_BASE, secret: "", logger: () => {} })
    ).resolves.toEqual(new Map());
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stays inside the CRM's documented id cap", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ values: [] }));
    const ids = Array.from({ length: CRM_CURRENT_VALUES_MAX_DEAL_IDS + 25 }, (_, i) => `deal-${i}`);

    await fetchCrmCurrentDealAmounts(ids, deps(fetchImpl));

    // One call, trimmed — never a second round trip, never a 422 that loses the whole batch.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).dealIds).toHaveLength(
      CRM_CURRENT_VALUES_MAX_DEAL_IDS
    );
  });

  it("de-duplicates ids and skips the call entirely when there is nothing to ask", async () => {
    const fetchImpl = vi.fn(async () => okResponse({ values: [] }));

    await fetchCrmCurrentDealAmounts(["deal-a", "deal-a", " deal-a "], deps(fetchImpl));
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).dealIds).toEqual(["deal-a"]);

    fetchImpl.mockClear();
    await fetchCrmCurrentDealAmounts(["", "   "], deps(fetchImpl));
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("RFP report email — labelling a current value honestly", () => {
  it("marks the AMOUNT ITSELF, so the marker cannot be mistaken for a stray footnote", async () => {
    const html = await renderEmail([blankCrmRow({ amount: 248500, amountIsCurrent: true })]);

    // The dagger must hang off the number, not merely exist somewhere on the page.
    expect(html).toMatch(/\$248,500<span[^>]*>&nbsp;&dagger;<\/span>/);
    // Marker + footnote, and nothing else claiming to be one.
    expect(html.match(/&dagger;/g)).toHaveLength(2);
    expect(html).toContain("Deal value as of today");
    expect(html).toContain("no estimate existed when the RFP was sent");
  });

  it("does NOT mark a snapshot amount, and prints no footnote when nothing is marked", async () => {
    const html = await renderEmail([blankCrmRow({ amount: 88000, amountIsCurrent: false })]);

    expect(html).toContain("$88,000");
    expect(html).not.toMatch(/\$88,000<span[^>]*>&nbsp;&dagger;<\/span>/);
    expect(html).not.toContain("&dagger;");
    expect(html).not.toContain("Deal value as of today");
  });

  it("marks only the live rows when a report mixes both kinds", async () => {
    const html = await renderEmail([
      blankCrmRow({ id: 1, projectName: "Snapshot Row", amount: 88000, amountIsCurrent: false }),
      blankCrmRow({ id: 2, projectName: "Live Row", amount: 248500, amountIsCurrent: true }),
    ]);

    expect(html).not.toMatch(/\$88,000<span[^>]*>&nbsp;&dagger;<\/span>/);
    expect(html).toMatch(/\$248,500<span[^>]*>&nbsp;&dagger;<\/span>/);
    expect(html.match(/&dagger;/g)).toHaveLength(2);
  });

  it("still renders an em-dash — and no footnote — when the lookup resolved nothing", async () => {
    const html = await renderEmail([blankCrmRow()]);

    expect(html).toContain("—");
    expect(html).not.toContain("&dagger;");
    expect(html).not.toContain("Deal value as of today");
  });

  it("footnotes only what the reader can actually see (the first 30 cards)", async () => {
    // 30 plain rows, then one marked row beyond the render cut-off.
    const rows = [
      ...Array.from({ length: 30 }, (_, i) => blankCrmRow({ id: i + 1, amount: 1000 + i })),
      blankCrmRow({ id: 99, amount: 248500, amountIsCurrent: true }),
    ];

    const html = await renderEmail(rows);

    expect(html).toContain("Showing 30 of 31 RFPs");
    expect(html).not.toContain("Deal value as of today");
  });
});
