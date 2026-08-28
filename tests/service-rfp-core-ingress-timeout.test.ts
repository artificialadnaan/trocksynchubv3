import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  SERVICE_RFP_CONTRACT_VERSION,
  SERVICE_RFP_INGRESS_TIMEOUT_MS,
  postServiceRfpApproved,
  type ServiceRfpApprovedBody,
} from "../server/sync/core-ingress-client.ts";

/**
 * The five-second bound on the Core handoff, proved against a REAL socket.
 *
 * Nothing here is mocked, and that is the point. The defect this suite closes lives in the seam
 * between "the Response resolved" and "the body finished arriving": fetchWithTimeout clears its abort
 * timer the moment fetch() resolves, which is when the HEADERS land, so a Core that answers 200 and
 * then stalls mid-body left `response.json()` awaiting undici's five-MINUTE body timeout. A fake
 * fetch cannot reproduce that — a hand-made Response would have to implement the abort wiring itself,
 * and the test would then be proving the double honours a signal rather than that the code does. So
 * the server below is an actual http server that writes headers and never writes a body.
 *
 * Why it matters more than the other findings: the inline handoff is awaited BEFORE the Playwright
 * Bid Board create, so an unbounded read does not merely delay Core — it parks the entire email
 * approval behind a stalled socket.
 */

const SECRET = "s".repeat(32);

const BODY: ServiceRfpApprovedBody = {
  version: SERVICE_RFP_CONTRACT_VERSION,
  office: "dallas",
  occurredAt: "2026-08-28T12:00:00.000Z",
  rfp: { requestId: 77, approvedAt: "2026-08-28T12:00:00.000Z" },
  deal: { id: "9f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f", rfpProjectNumber: "DFW-4-12345-aa" },
  company: { id: "11111111-2222-4333-8444-555555555555", name: "Acme Retail" },
  primaryContact: { name: "Dana Ruiz", email: "dana@acme.example", businessPhone: null },
  bid: { title: "Roof leak triage", estimatedValue: null, dueAt: null, description: null, notes: null },
  property: { id: "66666666-7777-4888-8999-aaaaaaaaaaaa", name: "1200 Main St", address: null },
};

const sockets = new Set<Socket>();
let server: http.Server;
let baseUrl = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume(); // drain the POST body; no route here reads it
    if (req.url === "/stall") {
      // Headers now, body NEVER. undici resolves the Response as soon as these land, so by this point
      // fetchWithTimeout's own timer has already been cleared in its finally block.
      res.writeHead(200, { "content-type": "application/json" });
      res.flushHeaders();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ outcome: "created", bidId: "bid-live-1" }));
  });
  // Tracked so a stalled connection cannot keep the worker process alive after the suite ends.
  server.on("connection", (socket) => sockets.add(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("postServiceRfpApproved over a real socket", () => {
  it("reads a complete response body and reports Core's bid id", async () => {
    const outcome = await postServiceRfpApproved({ targetUrl: `${baseUrl}/ok`, body: BODY, secret: SECRET });

    expect(outcome).toEqual({ kind: "sent", status: 200, bidId: "bid-live-1" });
  });

  it("gives up inside the bound when Core sends headers and then stalls mid-body", async () => {
    const startedAt = Date.now();
    const outcome = await postServiceRfpApproved({ targetUrl: `${baseUrl}/stall`, body: BODY, secret: SECRET });
    const elapsed = Date.now() - startedAt;

    // The whole promise of the inline handoff. Without a deadline spanning the body read this call
    // does not resolve here at all — it resolves when undici gives up five minutes later.
    expect(elapsed).toBeLessThan(SERVICE_RFP_INGRESS_TIMEOUT_MS * 3);
    // ...and it was the DEADLINE that ended it, not an unrelated instant failure.
    expect(elapsed).toBeGreaterThanOrEqual(SERVICE_RFP_INGRESS_TIMEOUT_MS - 500);
    // Core answered 200 on the status line, so the delivery IS an acceptance and must not be re-POSTed
    // as a second bid; the body that never arrived costs only the bid id.
    expect(outcome).toEqual({ kind: "sent", status: 200, bidId: null });
  }, 20_000);
});
