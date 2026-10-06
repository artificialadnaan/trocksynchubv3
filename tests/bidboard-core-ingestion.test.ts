import crypto from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const logMock = vi.hoisted(() => vi.fn());
vi.mock("../server/index.ts", () => ({ log: logMock }));

const { BID_BOARD_EXPORT_CONTRACT_VERSION, pushBidBoardRowsToCore, resolveCoreBidBoardExportConfig } = await import(
  "../server/sync/bidboard-core-ingestion.ts"
);
const { buildBidBoardCrmPayload } = await import("../server/sync/bidboard-crm-ingestion.ts");

const SECRET = "k".repeat(40);
const ENV = {
  ENABLE_CORE_BID_BOARD_EXPORT: "true",
  CORE_INGRESS_BASE_URL: "https://core.example.com/",
  CORE_BID_BOARD_INGRESS_SECRET_CURRENT: SECRET,
} as NodeJS.ProcessEnv;
const INPUT = {
  rows: [{ "Project #": "ATL-4-27526-aa", Name: "Bristol Creek", Status: "Estimate Sent to Client" }] as any,
  sourceFilename: "/tmp/ProjectList.xlsx",
  extractedAt: "2026-10-06T14:26:00.000Z",
};

/** Core's own check: HMAC-SHA256 over domain ‖ NUL ‖ POST ‖ NUL ‖ path ‖ NUL ‖ body. */
function coreSignature(path: string, raw: string): string {
  const NUL = Buffer.from([0]);
  const preimage = Buffer.concat([
    Buffer.from(BID_BOARD_EXPORT_CONTRACT_VERSION), NUL, Buffer.from("POST"), NUL, Buffer.from(path), NUL, Buffer.from(raw),
  ]);
  return `sha256=${crypto.createHmac("sha256", SECRET).update(preimage).digest("hex")}`;
}

function answer(status: number, body = "") {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, text: async () => body }) as unknown as Response);
}

describe("the Bid Board export's Core target (trock-core #1836)", () => {
  beforeEach(() => logMock.mockReset());

  it("is DARK unless the flag is exactly 'true', and inert on any unusable setting", async () => {
    for (const env of [
      {},
      { ...ENV, ENABLE_CORE_BID_BOARD_EXPORT: "1" },
      { ...ENV, CORE_INGRESS_BASE_URL: "http://core.example.com" },
      { ...ENV, CORE_INGRESS_BASE_URL: "https://core.example.com?x=1" },
      { ...ENV, CORE_BID_BOARD_INGRESS_SECRET_CURRENT: "short" },
      { ...ENV, CORE_BID_BOARD_OFFICE: "Dallas!" },
    ]) {
      expect(resolveCoreBidBoardExportConfig(env as NodeJS.ProcessEnv)).toBeNull();
      const fetchImpl = answer(200);
      expect(await pushBidBoardRowsToCore(INPUT, { env: env as NodeJS.ProcessEnv, fetchImpl })).toEqual({ ok: false, skipped: true });
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it("posts the CRM's own payload to the Core office, signed the way Core verifies, never following a redirect", async () => {
    const fetchImpl = answer(200, JSON.stringify({ rows: 1, matched: 1, created: 0, lanesMoved: 1, failed: 0, names: "never logged" }));
    expect(await pushBidBoardRowsToCore(INPUT, { env: ENV, fetchImpl })).toEqual({ ok: true, status: 200 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://core.example.com/webhooks/synchub/dallas/bid-board-export/v1");
    // Byte-for-byte the CRM's builder output, addressed to the Core office: the same snapshot to both targets.
    expect(init.body).toBe(JSON.stringify(buildBidBoardCrmPayload({ ...INPUT, officeSlug: "dallas" })));
    expect((init.headers as Record<string, string>)["x-trock-signature"]).toBe(
      coreSignature("/webhooks/synchub/dallas/bid-board-export/v1", String(init.body)),
    );
    expect(init.redirect).toBe("manual");
    const logged = logMock.mock.calls.flat().join(" ");
    expect(logged).toContain("matched=1 created=0 lanesMoved=1");
    expect(logged).not.toContain("Bristol");
    expect(logged).not.toContain("never logged");
  });

  it("answers a redirect, a refusal, a 500 and an unreachable host as a failure, and never throws", async () => {
    for (const [status, expected] of [
      [307, "redirected"],
      [404, "returned 404"],
      [503, "returned 503"],
      [500, "returned 500"],
    ] as const) {
      const result = await pushBidBoardRowsToCore(INPUT, { env: ENV, fetchImpl: answer(status) });
      expect(result.ok).toBe(false);
      expect(result.error).toContain(expected);
    }
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await pushBidBoardRowsToCore(INPUT, { env: ENV, fetchImpl: down as never })).toEqual({
      ok: false,
      error: "Core ingress unreachable: TypeError",
    });
  });

  it("uses the configured Core office", async () => {
    const fetchImpl = answer(200, "{}");
    await pushBidBoardRowsToCore(INPUT, { env: { ...ENV, CORE_BID_BOARD_OFFICE: "atlanta" }, fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://core.example.com/webhooks/synchub/atlanta/bid-board-export/v1");
    expect(JSON.parse(String(init.body)).office_slug).toBe("atlanta");
  });
});
