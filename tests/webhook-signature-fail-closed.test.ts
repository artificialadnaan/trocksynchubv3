import crypto from "crypto";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyHubspotWebhook, verifyProcoreWebhook } from "../server/webhooks/signature.ts";

// H5 (security rotation, 2026-10-22): webhook verification FAILS CLOSED. A blank secret used to skip verification and a request with no
// signature header was processed even with a secret set; now the first answers 503 and the second 401, and only a valid signature over the
// exact raw bytes is processed. The pure verifiers are tested with independently computed signatures; the routes through a real express app.

const SECRET = "test-secret-not-real-0123456789";
const URL_ = "https://synchub.example/webhooks/hubspot";
const hmac = (enc: "hex" | "base64", data: string) => crypto.createHmac("sha256", SECRET).update(data, "utf8").digest(enc);

describe("verifyHubspotWebhook", () => {
  const body = JSON.stringify([{ subscriptionType: "deal.propertyChange", objectId: 1 }]);
  const now = 1_700_000_000_000;
  const v3 = (ts: number, uri = URL_, b = body) => ({ "x-hubspot-signature-v3": hmac("base64", `POST${uri}${b}${ts}`), "x-hubspot-request-timestamp": String(ts) });

  it("a blank or missing secret refuses with 503, whatever the request carries", () => {
    for (const secret of [undefined, ""]) {
      expect(verifyHubspotWebhook({ secret, method: "POST", url: URL_, rawBody: body, headers: v3(now), nowMs: now })).toEqual({ ok: false, status: 503, reason: "secret_not_configured" });
    }
  });
  it("no signature header at all refuses with 401 (a secret alone never admits an unsigned request)", () => {
    expect(verifyHubspotWebhook({ secret: SECRET, method: "POST", url: URL_, rawBody: body, headers: {}, nowMs: now })).toEqual({ ok: false, status: 401, reason: "signature_missing" });
  });
  it("accepts a valid v3 signature over method + URL + raw body + timestamp", () => {
    expect(verifyHubspotWebhook({ secret: SECRET, method: "POST", url: URL_, rawBody: body, headers: v3(now), nowMs: now })).toEqual({ ok: true, scheme: "hubspot-v3" });
  });
  it("refuses a v3 signature for another URL, another body, or a stale or missing timestamp", () => {
    const h = v3(now);
    expect(verifyHubspotWebhook({ secret: SECRET, method: "POST", url: "https://evil.example/webhooks/hubspot", rawBody: body, headers: h, nowMs: now }).ok).toBe(false);
    expect(verifyHubspotWebhook({ secret: SECRET, method: "POST", url: URL_, rawBody: body + " ", headers: h, nowMs: now }).ok).toBe(false);
    expect(verifyHubspotWebhook({ secret: SECRET, method: "POST", url: URL_, rawBody: body, headers: v3(now - 6 * 60_000), nowMs: now })).toMatchObject({ ok: false, reason: "timestamp_invalid" });
    expect(verifyHubspotWebhook({ secret: SECRET, method: "POST", url: URL_, rawBody: body, headers: { "x-hubspot-signature-v3": h["x-hubspot-signature-v3"] }, nowMs: now })).toMatchObject({ ok: false, reason: "timestamp_invalid" });
  });
  it("accepts a valid v1 signature (sha256 of secret + body) and refuses a wrong one", () => {
    const v1 = crypto.createHash("sha256").update(SECRET + body, "utf8").digest("hex");
    expect(verifyHubspotWebhook({ secret: SECRET, method: "POST", url: URL_, rawBody: body, headers: { "x-hubspot-signature": v1 } })).toEqual({ ok: true, scheme: "hubspot-v1" });
    expect(verifyHubspotWebhook({ secret: SECRET, method: "POST", url: URL_, rawBody: body, headers: { "x-hubspot-signature": "0".repeat(64) } })).toMatchObject({ ok: false, status: 401 });
  });
});

describe("verifyProcoreWebhook", () => {
  const body = JSON.stringify({ resource_name: "Projects", resource_id: 7 });
  it("a blank secret refuses with 503; no signature refuses with 401", () => {
    expect(verifyProcoreWebhook({ secret: "", rawBody: body, headers: { "x-procore-signature": hmac("hex", body) } })).toMatchObject({ ok: false, status: 503 });
    expect(verifyProcoreWebhook({ secret: SECRET, rawBody: body, headers: {} })).toMatchObject({ ok: false, status: 401, reason: "signature_missing" });
  });
  it("accepts the HMAC over the raw body (either header, optional sha256= prefix) and refuses a tampered body", () => {
    expect(verifyProcoreWebhook({ secret: SECRET, rawBody: body, headers: { "x-procore-signature": hmac("hex", body) } }).ok).toBe(true);
    expect(verifyProcoreWebhook({ secret: SECRET, rawBody: body, headers: { "x-webhook-signature": `sha256=${hmac("hex", body)}` } }).ok).toBe(true);
    expect(verifyProcoreWebhook({ secret: SECRET, rawBody: body + "x", headers: { "x-procore-signature": hmac("hex", body) } })).toMatchObject({ ok: false, status: 401, reason: "signature_invalid" });
  });
});

// ---- the routes ---------------------------------------------------------------------------------------------------------------------
vi.mock("../server/storage.ts", () => ({ storage: {} }));
vi.mock("../server/procore.ts", () => ({ syncProcoreRoleAssignments: vi.fn() }));
vi.mock("../server/hubspot.ts", () => ({ updateHubSpotDealStage: vi.fn() }));
vi.mock("../server/email-notifications.ts", () => ({ sendStageChangeEmail: vi.fn() }));
vi.mock("../server/deal-project-number.ts", () => ({ processNewDealWebhook: vi.fn() }));
vi.mock("../server/hubspot-procore-sync.ts", () => ({ processHubspotWebhookForProcore: vi.fn() }));
vi.mock("../server/procore-hubspot-sync.ts", () => ({ mapProcoreStageToHubspot: vi.fn(), resolveHubspotStageId: vi.fn(), findOrCreateMappingByProjectNumber: vi.fn(), getTerminalStageGuard: vi.fn() }));
vi.mock("../server/webhooks/procore-webhook.ts", () => ({ handleProcoreProjectWebhook: vi.fn() }));
vi.mock("../server/webhooks/migration-mode.ts", () => ({ evaluateWebhookPortfolioPhase2Gate: vi.fn(), getWebhookMigrationModeConfig: vi.fn(), isMigrationMode: vi.fn(), logWebhookSuppressedAction: vi.fn() }));
vi.mock("../server/routes/settings.ts", () => ({ recordWebhookRoleEvent: vi.fn() }));
vi.mock("../server/procore-rate-limiter.ts", () => ({ markProjectWebhookUpdated: vi.fn() }));
vi.mock("../server/lib/async-handler.ts", () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock("../server/db.ts", () => ({ db: {} }));

async function withApp(fn: (base: string) => Promise<void>) {
  const { registerWebhookRoutes } = await import("../server/routes/webhooks.ts");
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf; } }));
  registerWebhookRoutes(app);
  const server = app.listen(0);
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server");
  try {
    await fn(`http://127.0.0.1:${addr.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}
const post = (base: string, path: string, body: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

describe("the webhook routes fail closed", () => {
  const prior = { h: process.env.HUBSPOT_CLIENT_SECRET, p: process.env.PROCORE_WEBHOOK_SECRET };
  beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => undefined); vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => {
    if (prior.h === undefined) delete process.env.HUBSPOT_CLIENT_SECRET; else process.env.HUBSPOT_CLIENT_SECRET = prior.h;
    if (prior.p === undefined) delete process.env.PROCORE_WEBHOOK_SECRET; else process.env.PROCORE_WEBHOOK_SECRET = prior.p;
    vi.restoreAllMocks();
  });

  it("POST /webhooks/hubspot: blank secret → 503, unsigned → 401, bad signature → 401, valid signature → past verification (400 for the empty payload)", async () => {
    await withApp(async (base) => {
      const body = JSON.stringify({});
      delete process.env.HUBSPOT_CLIENT_SECRET;
      expect((await post(base, "/webhooks/hubspot", body)).status).toBe(503);
      process.env.HUBSPOT_CLIENT_SECRET = SECRET;
      expect((await post(base, "/webhooks/hubspot", body)).status).toBe(401);
      expect((await post(base, "/webhooks/hubspot", body, { "x-hubspot-signature": "0".repeat(64) })).status).toBe(401);
      const v1 = crypto.createHash("sha256").update(SECRET + body, "utf8").digest("hex");
      expect((await post(base, "/webhooks/hubspot", body, { "x-hubspot-signature": v1 })).status).toBe(400); // verified, then the payload validation refuses {}
    });
  });

  it("POST /webhooks/procore: blank secret → 503, unsigned → 401, tampered → 401, valid signature → past verification (400 for the empty payload)", async () => {
    await withApp(async (base) => {
      const body = JSON.stringify({});
      delete process.env.PROCORE_WEBHOOK_SECRET;
      expect((await post(base, "/webhooks/procore", body)).status).toBe(503);
      process.env.PROCORE_WEBHOOK_SECRET = SECRET;
      expect((await post(base, "/webhooks/procore", body)).status).toBe(401);
      expect((await post(base, "/webhooks/procore", body, { "x-procore-signature": hmac("hex", body + "x") })).status).toBe(401);
      expect((await post(base, "/webhooks/procore", body, { "x-procore-signature": hmac("hex", body) })).status).toBe(400);
    });
  });
});
