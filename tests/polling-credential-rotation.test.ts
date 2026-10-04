import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Codex R1 on #97: credentials live in oauth_tokens, not the polling row, so a reconnect did not move the version the
// auth-expiry compare-and-set checks, and a cycle still running on the OLD token could disable a freshly reconnected
// job on its 401. A person rotating credentials (Procore OAuth callback, HubSpot OAuth callback, a saved HubSpot
// token) now moves the polling row's version. Routine refreshes inside a cycle do not, or a cycle's own refresh would
// supersede its legitimate disable.
const mocks = vi.hoisted(() => ({
  storage: {
    getAutomationConfig: vi.fn(async () => undefined),
    upsertOAuthToken: vi.fn(async (d: any) => d),
    upsertAutomationConfig: vi.fn(async (d: any) => d),
    createAuditLog: vi.fn(async () => ({})),
    bumpAutomationConfigVersion: vi.fn(async () => {}),
  },
  axiosPost: vi.fn(async () => ({ data: { access_token: "a", refresh_token: "r", expires_in: 3600 } })),
  exchangeHubSpotCode: vi.fn(async () => ({ accessToken: "a", refreshToken: "r", expiresIn: 3600 })),
}));

vi.mock("../server/storage.ts", () => ({ storage: mocks.storage }));
vi.mock("axios", () => ({ default: { post: mocks.axiosPost } }));
vi.mock("../server/hubspot.ts", () => ({
  exchangeHubSpotCode: mocks.exchangeHubSpotCode,
  testHubSpotConnection: vi.fn(),
  runFullHubSpotSync: vi.fn(),
  syncHubSpotPipelines: vi.fn(),
}));
vi.mock("../server/hubspot-procore-sync.ts", () => ({
  syncHubspotCompanyToProcore: vi.fn(),
  syncHubspotContactToProcore: vi.fn(),
  runBulkHubspotToProcoreSync: vi.fn(),
  testMatchingForCompany: vi.fn(),
  testMatchingForContact: vi.fn(),
  triggerPostSyncProcoreUpdates: vi.fn(),
}));

async function withApp(register: (app: express.Express) => void, fn: (base: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  register(app);
  const server = app.listen(0);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server");
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
const passAuth = (_req: any, _res: any, next: any) => next();

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("a credential rotation moves the polling row's version", () => {
  it("the Procore OAuth callback bumps procore_polling", async () => {
    const { registerOAuthRoutes } = await import("../server/routes/oauth.ts");
    await withApp((app) => registerOAuthRoutes(app, passAuth), async (base) => {
      await fetch(`${base}/api/oauth/procore/callback?code=abc`, { redirect: "manual" });
    });
    expect(mocks.storage.upsertOAuthToken).toHaveBeenCalledWith(expect.objectContaining({ provider: "procore" }));
    expect(mocks.storage.bumpAutomationConfigVersion).toHaveBeenCalledWith("procore_polling");
  });

  it("the HubSpot OAuth callback bumps hubspot_polling", async () => {
    const { registerOAuthRoutes } = await import("../server/routes/oauth.ts");
    await withApp((app) => registerOAuthRoutes(app, passAuth), async (base) => {
      await fetch(`${base}/api/oauth/hubspot/callback?code=abc`, { redirect: "manual" });
    });
    expect(mocks.storage.upsertOAuthToken).toHaveBeenCalledWith(expect.objectContaining({ provider: "hubspot" }));
    expect(mocks.storage.bumpAutomationConfigVersion).toHaveBeenCalledWith("hubspot_polling");
  });

  it("saving a HubSpot token bumps hubspot_polling", async () => {
    const { registerHubSpotRoutes } = await import("../server/routes/hubspot.ts");
    await withApp((app) => registerHubSpotRoutes(app, passAuth), async (base) => {
      const res = await fetch(`${base}/api/integrations/hubspot/save`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessToken: "pat-new", portalId: "123" }),
      });
      expect(res.status).toBeLessThan(500);
    });
    expect(mocks.storage.bumpAutomationConfigVersion).toHaveBeenCalledWith("hubspot_polling");
  });

  it("a failed bump never fails the reconnect", async () => {
    mocks.storage.bumpAutomationConfigVersion.mockRejectedValueOnce(new Error("db blip"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { registerOAuthRoutes } = await import("../server/routes/oauth.ts");
    await withApp((app) => registerOAuthRoutes(app, passAuth), async (base) => {
      const res = await fetch(`${base}/api/oauth/procore/callback?code=abc`, { redirect: "manual" });
      expect(res.status).toBe(302);
    });
    expect(mocks.storage.createAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "oauth_connect" }));
  });
});
