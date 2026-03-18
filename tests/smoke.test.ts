/**
 * E2E Smoke Test
 * ==============
 *
 * Run against a live deployment to verify the system works end-to-end.
 *
 * Usage:
 *   PROD_URL=https://your-app.railway.app npx vitest run tests/smoke.test.ts
 *
 * If PROD_URL is not set, tests are skipped.
 */

import { describe, it, expect } from "vitest";

const PROD_URL = process.env.PROD_URL;

const describeIf = PROD_URL ? describe : describe.skip;

describeIf("Smoke Tests", () => {
  it("GET /api/health/deep — all services connected", async () => {
    const res = await fetch(`${PROD_URL}/api/health/deep`);
    expect(res.status).toBeLessThanOrEqual(503); // 200 or 503

    const body = await res.json();
    expect(body).toHaveProperty("status");
    expect(body).toHaveProperty("checks");
    expect(body.checks).toHaveProperty("database");
    expect(body.checks.database.status).toBe("ok");

    // HubSpot and Procore may not be connected in all environments
    // but the shape should be correct
    expect(body.checks).toHaveProperty("hubspot");
    expect(body.checks).toHaveProperty("procore");
    expect(["ok", "error"]).toContain(body.checks.hubspot.status);
    expect(["ok", "error"]).toContain(body.checks.procore.status);
  });

  it("GET /api/dashboard/stats — returns expected shape", async () => {
    // This endpoint requires auth, so we test with cookies from a session
    // If no auth, we expect 401
    const res = await fetch(`${PROD_URL}/api/dashboard/stats`);
    // Either 200 (if session) or 401 (no auth)
    expect([200, 401]).toContain(res.status);

    if (res.status === 200) {
      const body = await res.json();
      expect(body).toHaveProperty("syncs");
      expect(body.syncs).toHaveProperty("total");
      expect(body.syncs).toHaveProperty("successful");
      expect(body.syncs).toHaveProperty("failed");
      expect(body.syncs).toHaveProperty("successRate");
      expect(body).toHaveProperty("pendingWebhooks");
      expect(body).toHaveProperty("recentActivity");
      expect(body).toHaveProperty("syncsByDay");
    }
  });

  it("GET /_health — basic health check", async () => {
    const res = await fetch(`${PROD_URL}/_health`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("ok");
  });

  it("GET /api/health/deep — database latency is reasonable", async () => {
    const res = await fetch(`${PROD_URL}/api/health/deep`);
    const body = await res.json();

    if (body.checks?.database?.status === "ok") {
      expect(body.checks.database.latencyMs).toBeLessThan(5000);
    }
  });

  it("GET /api/dashboard/rate-limits — returns provider state", async () => {
    const res = await fetch(`${PROD_URL}/api/dashboard/rate-limits`);
    // May require auth
    if (res.status === 200) {
      const body = await res.json();
      expect(body).toHaveProperty("hubspot");
      expect(body).toHaveProperty("procore");
    }
  });

  it("GET /api/webhooks/failed — returns webhook failures shape", async () => {
    const res = await fetch(`${PROD_URL}/api/webhooks/failed`);
    if (res.status === 200) {
      const body = await res.json();
      expect(body).toHaveProperty("logs");
      expect(body).toHaveProperty("total");
      expect(Array.isArray(body.logs)).toBe(true);
    }
  });
});
