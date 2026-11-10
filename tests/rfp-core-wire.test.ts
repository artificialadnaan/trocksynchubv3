import crypto from "crypto";
import { describe, expect, it, vi } from "vitest";

// S1a (CONTRACT v2.4 §5 / §6 / §7 / §10): the wire of the RFP Core path with no I/O: the golden vectors, the E1 → E2
// mapping (incl. the company_missing pre-refusal and the property / contact null rules), the E4 / E5 / N1 bodies, every
// classifier branch, the 30 s / 2 m / 10 m / 30 m / 2 h (6-attempt) schedule, E5's never-dead schedule, the stable N1
// noticeId, the secret / base-URL guards, the operator re-drive marker, and the two signed POSTs. Wire details follow the
// counterparts (Core 3e13ff2e rfp-bid-create.contract.ts / .routes.ts; CRM PR-B 5f1109d8 core-bid-created-service.ts).
// Synthetic data only (I7).
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));

const wire = await import("../server/sync/rfp-core-wire.ts");
const http = await import("../server/sync/rfp-core-http.ts");

const GOLDEN_KEY = "rfp2-golden-vector-key-synthetic-0123456789";
const GOLDEN_BODY = '{"golden":"vector","n":1}';
const DEAL = "00000000-0000-4000-8000-0000000000a1";
const COMPANY = "00000000-0000-4000-8000-0000000000c1";
const PROPERTY = "00000000-0000-4000-8000-0000000000f1";
const BID = "00000000-0000-4000-8000-0000000000b1";
const KEY = "crm:rfp-vote:approved:round-7";
const OCCURRED = "2026-11-10T12:00:00.000Z";

/** Core's exact key sets (rfp-bid-create.contract.ts BODY_KEYS / DEAL_KEYS) and the CRM's E4 / N1 strict keys. */
const CORE_BODY_KEYS = ["version", "office", "occurredAt", "sourceEventId", "approvalKind", "approval", "crmDealId", "deal",
  "company", "property", "contact", "attachments", "attachmentsOmitted", "crmActivityLog"];
const CORE_DEAL_KEYS = ["name", "projectNumber", "projectType", "amount", "estimator", "estimatorEmail", "ownerName",
  "ownerEmail", "ownerSource", "scopeTitle", "description", "dueDate", "workflowRoute"];
const CRM_E4_KEYS = ["sourceSystem", "sourceDealId", "sourceEventId", "approvalKind", "office", "coreBidId", "coreCreatedAt",
  "projectNumber", "warnings"];
const N1_KEYS = ["sourceSystem", "sourceDealId", "sourceEventId", "office", "kind", "reason", "coreBidId", "noticeId", "occurredAt"];
const sorted = (keys: string[]) => [...keys].sort();

function framed(domain: string, path: string, body: string, key: string): string {
  const NUL = Buffer.from([0]);
  const pre = Buffer.concat([Buffer.from(domain), NUL, Buffer.from("POST"), NUL, Buffer.from(path), NUL, Buffer.from(body)]);
  return `sha256=${crypto.createHmac("sha256", key).update(pre).digest("hex")}`;
}

function e1(o: Record<string, any> = {}, deal: Record<string, any> = {}): any {
  return {
    sourceSystem: "trock_crm", sourceDealId: DEAL, sourceEventId: KEY, decision: "approved",
    approvalKind: "vote", office: "dallas",
    approval: { roundEventId: "round-7", approvals: 2, rejections: 0, invitedVoterCount: 3, decidedAt: "2026-11-01T15:00:00.000Z" },
    attachmentsOmitted: 1,
    attachments: [{ name: "plans.pdf", url: "https://files.example.test/plans.pdf?sig=abc", contentType: "application/pdf" }],
    ...o,
    deal: {
      name: "Synthetic Tower Reroof", projectNumber: "DFW-2-12345-ab", projectType: "2", amount: 125000.5, estimator: "Pat Example",
      ownerName: "Riley Rep", ownerEmail: "riley.rep@example.test", ownerSource: "assigned_rep",
      companyId: COMPANY, companyName: "Synthetic Builders LLC",
      companyBillAddress: { address: "100 Sample Way", city: "Plano", state: "TX", zip: "75024" },
      propertyId: PROPERTY, propertyName: "Sample Plaza",
      contactName: "Sam Synthetic", clientEmail: "sam@example.test", clientPhone: "555-0100",
      address: { street: "1 Example St", city: "Dallas", state: "TX", zip: "75001", country: "US" },
      description: "Replace the roof membrane.", crmActivityLog: "Call: walked the site.",
      dueDate: "2026-11-20T17:00:00-06:00", workflowRoute: "normal", scopeTitle: "Roof replacement",
      ...deal,
    },
  };
}

const EXPECTED_E2 = {
  version: "trock.crm.rfp-bid-create.v1",
  office: "dallas",
  occurredAt: OCCURRED,
  sourceEventId: KEY,
  approvalKind: "vote",
  approval: { roundEventId: "round-7", approvals: 2, rejections: 0, invitedVoterCount: 3, decidedAt: "2026-11-01T15:00:00.000Z" },
  crmDealId: DEAL,
  deal: {
    name: "Synthetic Tower Reroof", projectNumber: "DFW-2-12345-ab", projectType: "2", amount: 125000.5, estimator: "Pat Example",
    estimatorEmail: null, ownerName: "Riley Rep", ownerEmail: "riley.rep@example.test", ownerSource: "assigned_rep",
    scopeTitle: "Roof replacement", description: "Replace the roof membrane.", dueDate: "2026-11-20T23:00:00.000Z",
    workflowRoute: "normal",
  },
  company: { id: COMPANY, name: "Synthetic Builders LLC", billAddress: { address: "100 Sample Way", city: "Plano", state: "TX", zip: "75024" } },
  property: { id: PROPERTY, name: "Sample Plaza", address: { street: "1 Example St", city: "Dallas", state: "TX", zip: "75001", country: "US" } },
  contact: { name: "Sam Synthetic", email: "sam@example.test", phone: "555-0100" },
  attachments: [{ name: "plans.pdf", url: "https://files.example.test/plans.pdf?sig=abc", contentType: "application/pdf" }],
  attachmentsOmitted: 1,
  crmActivityLog: "Call: walked the site.",
};

const build = (input: any, approvalKind: string | null = "vote") => wire.buildRfpBidCreateBody(input, { occurredAt: OCCURRED, approvalKind });

describe("golden vectors (§5; Core signs and verifies the same two)", () => {
  it("V1: the E2 signer over POST /webhooks/crm/dallas/rfp-bid-create/v1 and the 25-byte golden body gives the contract's value", () => {
    expect(wire.signRfpBidCreate({ path: "/webhooks/crm/dallas/rfp-bid-create/v1", rawBody: GOLDEN_BODY, secret: GOLDEN_KEY }))
      .toBe("sha256=2b86bd4c7e8d41b4b6d7990ec858ad12ac60b511e456861edd4fee67b2be09f1");
    expect(Buffer.byteLength(GOLDEN_KEY, "utf8")).toBe(43);
    expect(Buffer.byteLength(GOLDEN_BODY, "utf8")).toBe(25);
    expect(wire.RFP_BID_CREATE_DOMAIN).toBe("trock.crm.rfp-bid-create.v1");
    expect(wire.RFP_BID_CREATE_PATH).toBe("/webhooks/crm/dallas/rfp-bid-create/v1");
  });
  it("V2: the E5 signer (domain …-linked.v1, path …/v1/linked) over the same body gives the contract's value", () => {
    expect(wire.signRfpBidCreateLinked({ path: "/webhooks/crm/dallas/rfp-bid-create/v1/linked", rawBody: GOLDEN_BODY, secret: GOLDEN_KEY }))
      .toBe("sha256=06e6635bb6345af5162586d5e9b21b5f00551dc369344f6f2fab5860532c12de");
    expect(wire.RFP_BID_CREATE_LINKED_DOMAIN).toBe("trock.crm.rfp-bid-create-linked.v1");
    expect(wire.RFP_BID_CREATE_LINKED_PATH).toBe("/webhooks/crm/dallas/rfp-bid-create/v1/linked");
  });
});

describe("E1 → E2 mapping (§5)", () => {
  it("builds Core's strict body from the stored E1: every key, office dallas, estimator NAME, estimatorEmail null, dueDate UTC", () => {
    const r = build(e1());
    expect(r).toEqual({ ok: true, body: EXPECTED_E2 });
    if (!r.ok) return;
    expect(sorted(Object.keys(r.body))).toEqual(sorted(CORE_BODY_KEYS));
    expect(sorted(Object.keys(r.body.deal))).toEqual(sorted(CORE_DEAL_KEYS));
  });
  it("companyId null, blank or absent ⇒ the company_missing pre-refusal (nothing to send)", () => {
    for (const companyId of [null, "", "   "]) {
      expect(build(e1({}, { companyId })), String(companyId)).toEqual({ ok: false, reason: "company_missing" });
    }
    const absent = e1();
    delete absent.deal.companyId;
    expect(build(absent)).toEqual({ ok: false, reason: "company_missing" });
  });
  it("property is null when propertyId is null (an address alone is not a property); else E1's address keys verbatim; no address ⇒ address null", () => {
    expect(build(e1({}, { propertyId: null }))).toMatchObject({ ok: true, body: { property: null } });
    expect(build(e1({}, { propertyId: "" }))).toMatchObject({ ok: true, body: { property: null } });
    expect(build(e1({}, { address: null }))).toMatchObject({ ok: true, body: { property: { id: PROPERTY, name: "Sample Plaza", address: null } } });
    expect(build(e1({}, { address: { street: "9 Other Rd", city: "Frisco", state: "TX", zip: "75034", country: "" } }))).toMatchObject({
      ok: true,
      body: { property: { id: PROPERTY, address: { street: "9 Other Rd", city: "Frisco", state: "TX", zip: "75034", country: null } } },
    });
  });
  it("contact is null unless clientEmail is a valid email", () => {
    expect(build(e1({}, { clientEmail: null }))).toMatchObject({ ok: true, body: { contact: null } });
    expect(build(e1({}, { clientEmail: "not-an-email" }))).toMatchObject({ ok: true, body: { contact: null } });
    expect(build(e1({}, { clientEmail: "", contactName: "Sam Synthetic" }))).toMatchObject({ ok: true, body: { contact: null } });
    expect(build(e1({}, { clientPhone: null }))).toMatchObject({
      ok: true, body: { contact: { name: "Sam Synthetic", email: "sam@example.test", phone: null } },
    });
  });
  it("company.billAddress is sent only when all four parts meet Core's rules; otherwise the key is absent", () => {
    const partial = build(e1({}, { companyBillAddress: { address: "100 Sample Way", city: "Plano", state: "Texas", zip: "75024" } }));
    expect(partial).toMatchObject({ ok: true, body: { company: { id: COMPANY, name: "Synthetic Builders LLC" } } });
    if (!partial.ok) return;
    expect("billAddress" in partial.body.company).toBe(false);
    const none = build(e1({}, { companyBillAddress: null }));
    expect(none.ok && "billAddress" in none.body.company).toBe(false);
  });
  it("blank nullable strings read as null, dueDate null stays null, another offset converts to UTC", () => {
    expect(build(e1({}, { estimator: "", ownerName: "  ", scopeTitle: "", workflowRoute: "", dueDate: null }))).toMatchObject({
      ok: true, body: { deal: { estimator: null, estimatorEmail: null, ownerName: null, scopeTitle: null, workflowRoute: null, dueDate: null } },
    });
    expect(build(e1({}, { dueDate: "2026-12-01T09:30:00+05:30" }))).toMatchObject({ ok: true, body: { deal: { dueDate: "2026-12-01T04:00:00.000Z" } } });
  });
  it("approval verbatim (absent ⇒ null); approvalKind is the command row's stamp, else E1's", () => {
    expect(build(e1({ approval: undefined }))).toMatchObject({ ok: true, body: { approval: null } });
    expect(build(e1({ approvalKind: undefined }), "vote")).toMatchObject({ ok: true, body: { approvalKind: "vote" } });
    expect(build(e1(), null)).toMatchObject({ ok: true, body: { approvalKind: "vote" } });
  });
  it("attachments verbatim, attachmentsOmitted defaults to 0, a blank crmActivityLog ⇒ null", () => {
    expect(build(e1({ attachments: [], attachmentsOmitted: undefined }, { crmActivityLog: "   " }))).toMatchObject({
      ok: true, body: { attachments: [], attachmentsOmitted: 0, crmActivityLog: null },
    });
  });
});

describe("E4 / E5 / N1 bodies and the stable noticeId", () => {
  it("E4 has exactly the CRM's 9 strict keys, sourceSystem trock_crm", () => {
    const body = wire.buildCrmLinkBody({
      sourceDealId: DEAL, sourceEventId: KEY, approvalKind: "vote", office: "dallas", coreBidId: BID,
      coreCreatedAt: "2026-11-10T12:00:01.000Z", projectNumber: "DFW-2-12345-ab", warnings: ["owner_not_found"],
    });
    expect(body).toEqual({
      sourceSystem: "trock_crm", sourceDealId: DEAL, sourceEventId: KEY, approvalKind: "vote", office: "dallas", coreBidId: BID,
      coreCreatedAt: "2026-11-10T12:00:01.000Z", projectNumber: "DFW-2-12345-ab", warnings: ["owner_not_found"],
    });
    expect(sorted(Object.keys(body))).toEqual(sorted(CRM_E4_KEYS));
  });
  it("E5 has exactly Core's 6 strict keys, version trock.crm.rfp-bid-create-linked.v1", () => {
    expect(wire.buildCoreConfirmBody({ occurredAt: OCCURRED, sourceEventId: KEY, crmDealId: DEAL, coreBidId: BID, crmResult: "replay" })).toEqual({
      version: "trock.crm.rfp-bid-create-linked.v1", occurredAt: OCCURRED, sourceEventId: KEY, crmDealId: DEAL, coreBidId: BID, crmResult: "replay",
    });
  });
  it("noticeId = rfp-core-notice:<table name>:<row id>:<kind>", () => {
    expect(wire.rfpCoreNoticeId("rfp_core_followup_outbox", 17, "core_bid_orphan")).toBe("rfp-core-notice:rfp_core_followup_outbox:17:core_bid_orphan");
    expect(wire.rfpCoreNoticeId("rfp_core_followup_outbox", 3, "core_link_confirm_pending"))
      .toBe("rfp-core-notice:rfp_core_followup_outbox:3:core_link_confirm_pending");
    expect(wire.RFP_CORE_NOTICE_TABLE).toBe("rfp_core_followup_outbox");
  });
  it("N1 has the strict 9 keys; reason = the 409 code for link_refused, 'stale' for orphan, null for the confirm kinds", () => {
    const base = { sourceDealId: DEAL, sourceEventId: KEY, office: "dallas", coreBidId: BID, noticeId: "rfp-core-notice:rfp_core_followup_outbox:9:x", occurredAt: OCCURRED };
    const refused = wire.buildRfpCoreNoticeBody({ ...base, kind: "core_bid_link_refused", reason: "deal_on_procore" });
    expect(refused).toEqual({ sourceSystem: "trock_crm", ...base, kind: "core_bid_link_refused", reason: "deal_on_procore" });
    expect(sorted(Object.keys(refused))).toEqual(sorted(N1_KEYS));
    expect(wire.buildRfpCoreNoticeBody({ ...base, kind: "core_bid_orphan", reason: null }).reason).toBe("stale");
    expect(wire.buildRfpCoreNoticeBody({ ...base, kind: "core_link_confirm_pending", reason: "anything" }).reason).toBeNull();
    expect(wire.buildRfpCoreNoticeBody({ ...base, kind: "core_link_confirmed", reason: "anything" }).reason).toBeNull();
    expect(wire.buildRfpCoreNoticeBody({ ...base, kind: "core_link_confirmed", reason: null, coreBidId: null }).coreBidId).toBeNull();
  });
});

describe("E3 classifier (§5 / §10)", () => {
  const receipt = (result: string, o: Record<string, unknown> = {}) => ({
    version: "trock.crm.rfp-bid-create.v1", result, coreBidId: BID, boardStage: { code: "in-progress", status: "invited" },
    createdAt: "2026-11-10T12:00:01.000Z", warnings: ["owner_not_found"], ...o,
  });
  it("201 created / 200 replay / 200 updated ⇒ sent, carrying coreBidId, createdAt and warnings", () => {
    expect(wire.classifyCoreCreateResponse(201, receipt("created"))).toEqual({
      kind: "sent", status: 201, result: "created", coreBidId: BID, createdAt: "2026-11-10T12:00:01.000Z", warnings: ["owner_not_found"],
    });
    expect(wire.classifyCoreCreateResponse(200, receipt("replay"))).toMatchObject({ kind: "sent", status: 200, result: "replay", coreBidId: BID });
    expect(wire.classifyCoreCreateResponse(200, receipt("updated", { warnings: [] }))).toMatchObject({ kind: "sent", result: "updated", warnings: [] });
  });
  it("a 2xx without a usable receipt is retried (Core committed; the retry replays with the id)", () => {
    expect(wire.classifyCoreCreateResponse(201, {})).toMatchObject({ kind: "retry", status: 201 });
    expect(wire.classifyCoreCreateResponse(200, receipt("replay", { coreBidId: "not-a-uuid" }))).toMatchObject({ kind: "retry", status: 200 });
  });
  it("409 ⇒ refused with Core's reason verbatim (unknown when absent)", () => {
    expect(wire.classifyCoreCreateResponse(409, { error: "rfp_bid_create_conflict", reason: "live_project" })).toEqual({ kind: "refused", status: 409, reason: "live_project" });
    expect(wire.classifyCoreCreateResponse(409, {})).toEqual({ kind: "refused", status: 409, reason: "unknown" });
  });
  it("400 / 401 ⇒ terminal (and every other deterministic 4xx: 403 / 413 / 415 / 422)", () => {
    expect(wire.classifyCoreCreateResponse(400, { error: "bad_request", reason: "invalid_payload", field: "deal.amount" })).toMatchObject({ kind: "terminal", status: 400 });
    expect((wire.classifyCoreCreateResponse(400, { error: "bad_request", reason: "source_event_reused" }) as any).error).toContain("source_event_reused");
    for (const s of [401, 403, 413, 415, 422]) expect(wire.classifyCoreCreateResponse(s, {}), String(s)).toMatchObject({ kind: "terminal", status: s });
  });
  it("404 (dark) / 408 / 429 / 5xx ⇒ retry", () => {
    for (const s of [404, 408, 429, 500, 502, 503, 504]) expect(wire.classifyCoreCreateResponse(s, {}), String(s)).toMatchObject({ kind: "retry", status: s });
  });
});

describe("E4 classifier (§6 / §10; decided on `result`, linked / claimed are optional extras)", () => {
  it("result linked (no extras, claimed:true, or link-only claimed:false) and replay ⇒ linked", () => {
    expect(wire.classifyCrmLinkResponse(200, { result: "linked" })).toEqual({ kind: "linked", crmResult: "linked", result: "linked" });
    expect(wire.classifyCrmLinkResponse(200, { result: "linked", linked: true, claimed: true })).toEqual({ kind: "linked", crmResult: "linked", result: "linked" });
    expect(wire.classifyCrmLinkResponse(200, { result: "linked", linked: true, claimed: false })).toEqual({ kind: "linked", crmResult: "linked", result: "link_only" });
    expect(wire.classifyCrmLinkResponse(200, { result: "replay", linked: true, extra: 1 })).toEqual({ kind: "linked", crmResult: "replay", result: "replay" });
  });
  it("result stale ⇒ stale; 409 {error} ⇒ link_refused with the code", () => {
    expect(wire.classifyCrmLinkResponse(200, { result: "stale" })).toEqual({ kind: "stale" });
    expect(wire.classifyCrmLinkResponse(409, { error: "deal_claimed_by_other_bid" })).toEqual({ kind: "link_refused", status: 409, reason: "deal_claimed_by_other_bid" });
    expect(wire.classifyCrmLinkResponse(409, {})).toEqual({ kind: "link_refused", status: 409, reason: "unknown" });
  });
  it("an unknown or missing result on a 2xx ⇒ retry (E4 is idempotent), never linked", () => {
    expect(wire.classifyCrmLinkResponse(200, { result: "claimed_elsewhere" })).toMatchObject({ kind: "retry", status: 200 });
    expect(wire.classifyCrmLinkResponse(200, { linked: true, claimed: false })).toMatchObject({ kind: "retry", status: 200 });
    expect(wire.classifyCrmLinkResponse(200, {})).toMatchObject({ kind: "retry", status: 200 });
  });
  it("503 (dark / deal_busy) / 408 / 429 / 5xx ⇒ retry; 400 / 401 / 404 / 422 ⇒ terminal", () => {
    for (const s of [503, 500, 502, 408, 429]) expect(wire.classifyCrmLinkResponse(s, {}), String(s)).toMatchObject({ kind: "retry", status: s });
    for (const s of [400, 401, 404, 422]) expect(wire.classifyCrmLinkResponse(s, { error: "invalid_payload" }), String(s)).toMatchObject({ kind: "terminal", status: s });
  });
});

describe("E5 and N1 classifiers", () => {
  it("E5: 200 {confirmed:true} ⇒ confirmed; EVERY other answer ⇒ retry (never terminal, never dead)", () => {
    expect(wire.classifyCoreConfirmResponse(200, { confirmed: true })).toEqual({ kind: "confirmed" });
    for (const s of [404, 409, 400, 401, 500, 503]) expect(wire.classifyCoreConfirmResponse(s, {}), String(s)).toMatchObject({ kind: "retry", status: s });
    expect((wire.classifyCoreConfirmResponse(409, { error: "rfp_bid_create_conflict", reason: "deal_mismatch" }) as any).error).toContain("deal_mismatch");
    expect(wire.classifyCoreConfirmResponse(200, {})).toMatchObject({ kind: "retry", status: 200 });
  });
  it("N1: 2xx recorded | replay ⇒ sent; 503 / 5xx ⇒ retry; 422 / 404 / 401 ⇒ terminal", () => {
    expect(wire.classifyCrmNoticeResponse(200, { result: "recorded" })).toEqual({ kind: "sent", result: "recorded" });
    expect(wire.classifyCrmNoticeResponse(200, { result: "replay" })).toEqual({ kind: "sent", result: "replay" });
    for (const s of [503, 500]) expect(wire.classifyCrmNoticeResponse(s, {}), String(s)).toMatchObject({ kind: "retry", status: s });
    for (const s of [422, 404, 401]) expect(wire.classifyCrmNoticeResponse(s, {}), String(s)).toMatchObject({ kind: "terminal", status: s });
  });
});

describe("the schedule (§10) and E5's never-dead schedule (§7)", () => {
  it("E2 / E4 / N1: attempts 1-5 wait 30 s / 2 m / 10 m / 30 m / 2 h; attempt 6 (and later) ⇒ dead", () => {
    const waits = ["30 seconds", "2 minutes", "10 minutes", "30 minutes", "2 hours"];
    waits.forEach((delay, i) => expect(wire.retryDisposition(i + 1), String(i + 1)).toEqual({ kind: "retry", delay }));
    expect(wire.retryDisposition(6)).toEqual({ kind: "dead" });
    expect(wire.retryDisposition(7)).toEqual({ kind: "dead" });
    expect(wire.RFP_CORE_MAX_ATTEMPTS).toBe(6);
  });
  it("E5: the same five waits, then every 2 h forever; the pending notice from attempt 6; the delayed alert at 6, then daily (18, 30)", () => {
    const waits = ["30 seconds", "2 minutes", "10 minutes", "30 minutes", "2 hours"];
    waits.forEach((delay, i) =>
      expect(wire.coreConfirmDisposition(i + 1), String(i + 1)).toEqual({ delay, pendingNotice: false, delayedAlert: false }));
    expect(wire.coreConfirmDisposition(6)).toEqual({ delay: "2 hours", pendingNotice: true, delayedAlert: true });
    expect(wire.coreConfirmDisposition(7)).toEqual({ delay: "2 hours", pendingNotice: true, delayedAlert: false });
    expect(wire.coreConfirmDisposition(17).delayedAlert).toBe(false);
    expect(wire.coreConfirmDisposition(18)).toEqual({ delay: "2 hours", pendingNotice: true, delayedAlert: true });
    expect(wire.coreConfirmDisposition(19).delayedAlert).toBe(false);
    expect(wire.coreConfirmDisposition(30).delayedAlert).toBe(true);
    expect(wire.coreConfirmDisposition(500).delay).toBe("2 hours");
  });
});

describe("secret, targets and the operator re-drive marker", () => {
  it("the E2 / E5 secret is RFP_BID_CREATE_INGRESS_SECRET_CURRENT, at least 32 bytes; never the service-RFP key", () => {
    expect(wire.resolveRfpBidCreateIngressSecret({ RFP_BID_CREATE_INGRESS_SECRET_CURRENT: "s".repeat(32) } as any)).toBe("s".repeat(32));
    expect(wire.resolveRfpBidCreateIngressSecret({ RFP_BID_CREATE_INGRESS_SECRET_CURRENT: "s".repeat(31) } as any)).toBeNull();
    expect(wire.resolveRfpBidCreateIngressSecret({} as any)).toBeNull();
    expect(wire.resolveRfpBidCreateIngressSecret({ SERVICE_RFP_INGRESS_SECRET_CURRENT: "s".repeat(40) } as any)).toBeNull();
  });
  it("targets: https Core base + the E2 / E5 paths; an http, query-bearing or unset base ⇒ null; CRM base + internal path", () => {
    expect(wire.buildRfpBidCreateTargetUrl("https://core.example.test/")).toBe("https://core.example.test/webhooks/crm/dallas/rfp-bid-create/v1");
    expect(wire.buildRfpBidCreateLinkedTargetUrl("https://core.example.test")).toBe("https://core.example.test/webhooks/crm/dallas/rfp-bid-create/v1/linked");
    expect(wire.buildRfpBidCreateTargetUrl("http://core.example.test")).toBeNull();
    expect(wire.buildRfpBidCreateTargetUrl("https://core.example.test?x=1")).toBeNull();
    expect(wire.buildRfpBidCreateTargetUrl("")).toBeNull();
    expect(wire.buildRfpBidCreateLinkedTargetUrl("")).toBeNull();
    expect(wire.buildCrmInternalTargetUrl("/api/internal/core-bid-created", "https://crm.example.test/")).toBe("https://crm.example.test/api/internal/core-bid-created");
    expect(wire.buildCrmInternalTargetUrl("/api/internal/rfp-core-notice", "  ")).toBeNull();
  });
  it("isOperatorRedrive: ONLY a non-empty string at payload.operatorRedrive.go", () => {
    expect(wire.isOperatorRedrive({ operatorRedrive: { reason: "operator_redrive", go: "GO-SYN-0001" } })).toBe(true);
    expect(wire.isOperatorRedrive({ operatorRedrive: { reason: "operator_redrive", go: "" } })).toBe(false);
    expect(wire.isOperatorRedrive({ operatorRedrive: { reason: "operator_redrive", go: "   " } })).toBe(false);
    expect(wire.isOperatorRedrive({ operatorRedrive: { reason: "operator_redrive" } })).toBe(false);
    expect(wire.isOperatorRedrive({ operatorRedrive: { go: 7 } })).toBe(false);
    expect(wire.isOperatorRedrive({ operatorRedrive: true })).toBe(false);
    expect(wire.isOperatorRedrive(null)).toBe(false);
    expect(wire.isOperatorRedrive({})).toBe(false);
  });
});

describe("the signed POSTs (rfp-core-http.ts)", () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  it("postCoreSigned: ONE POST, x-trock-signature over domain ‖ POST ‖ the requested path ‖ body, redirect 'error', the JSON answer returned", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: any) => json(201, { result: "created" }));
    const url = "https://core.example.test/edge/webhooks/crm/dallas/rfp-bid-create/v1";
    const r = await http.postCoreSigned({ targetUrl: url, domain: "trock.crm.rfp-bid-create.v1", rawBody: GOLDEN_BODY, secret: GOLDEN_KEY }, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchImpl.mock.calls[0]!;
    expect(calledUrl).toBe(url);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.body).toBe(GOLDEN_BODY);
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-trock-signature")).toBe(framed("trock.crm.rfp-bid-create.v1", "/edge/webhooks/crm/dallas/rfp-bid-create/v1", GOLDEN_BODY, GOLDEN_KEY));
    expect(r).toEqual({ kind: "response", status: 201, body: { result: "created" } });
  });
  it("postCrmSigned: x-rfp-request-signature = sha256=HMAC-SHA256(raw body) under the CRM secret, redirect 'error'", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: any) => json(200, { result: "linked" }));
    const raw = JSON.stringify({ sourceSystem: "trock_crm", sourceDealId: DEAL });
    const r = await http.postCrmSigned({ targetUrl: "https://crm.example.test/api/internal/core-bid-created", rawBody: raw, secret: "synthetic-crm-secret" }, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]![1];
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("x-rfp-request-signature"))
      .toBe(`sha256=${crypto.createHmac("sha256", "synthetic-crm-secret").update(raw).digest("hex")}`);
    expect(r).toEqual({ kind: "response", status: 200, body: { result: "linked" } });
  });
  it("never throws: a transport failure is { kind: 'transport' }, a non-JSON answer reads as {}", async () => {
    const boom = vi.fn(async () => { throw new TypeError("fetch failed: redirect mode is error"); });
    const r1 = await http.postCrmSigned({ targetUrl: "https://crm.example.test/x", rawBody: "{}", secret: "k" }, { fetchImpl: boom as any });
    expect(boom).toHaveBeenCalledTimes(1);
    expect(r1).toMatchObject({ kind: "transport" });
    const html = vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 }));
    const r2 = await http.postCoreSigned({ targetUrl: "https://core.example.test/p", domain: "d", rawBody: "{}", secret: "k" }, { fetchImpl: html as any });
    expect(html).toHaveBeenCalledTimes(1);
    expect(r2).toEqual({ kind: "response", status: 502, body: {} });
  });
});
