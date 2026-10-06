// The Procore Bid Board export, posted to TROCK CORE as a SECOND target (trock-core #1836: the Service Board follows the
// Bid Board). The CRM push (bidboard-crm-ingestion.ts) is untouched and runs first; this one is independent of it,
// best-effort, and DARK unless ENABLE_CORE_BID_BOARD_EXPORT is exactly "true".
//
// What Core receives is the CRM's own payload (buildBidBoardCrmPayload: the same rows, the same provenance, the same
// extractedAt), addressed to the Core office. Core applies it per bid, newest-wins on provenance.extractedAt, so a repost
// or a missed cycle needs no bookkeeping here: the next export (~19 min) supersedes it.
//
// Authentication is Core's ingress scheme (core-ingress-client.ts), not the CRM's: the `x-trock-signature` header over
// the DOMAIN-SEPARATED preimage (trock.synchub.bid-board-export.v1 ‖ POST ‖ path ‖ body), its own key
// (CORE_BID_BOARD_INGRESS_SECRET_CURRENT, at least 32 bytes), and the office in the signed path. Nothing about the body,
// the signature or the key is logged.
import { log } from "../index";
import { fetchWithTimeout } from "../lib/fetch-with-timeout";
import { buildBidBoardCrmPayload, type BuildBidBoardCrmPayloadInput } from "./bidboard-crm-ingestion";
import { MIN_INGRESS_SECRET_BYTES, signCoreIngress, validCoreIngressBase } from "./core-ingress-client";

export const BID_BOARD_EXPORT_CONTRACT_VERSION = "trock.synchub.bid-board-export.v1";
export const CORE_BID_BOARD_EXPORT_FLAG = "ENABLE_CORE_BID_BOARD_EXPORT";
/** Core applies the export inline, one short transaction per matched bid; a full export is ~1k rows. */
export const CORE_BID_BOARD_EXPORT_TIMEOUT_MS = 60_000;

export interface CoreBidBoardExportConfig {
  targetUrl: string;
  secret: string;
  office: string;
}

/** The config, or null (the feature is inert) when the flag is off or any setting is missing or unusable. */
export function resolveCoreBidBoardExportConfig(env: NodeJS.ProcessEnv = process.env): CoreBidBoardExportConfig | null {
  if (env[CORE_BID_BOARD_EXPORT_FLAG] !== "true") return null;
  const base = validCoreIngressBase(env.CORE_INGRESS_BASE_URL);
  const secret = (env.CORE_BID_BOARD_INGRESS_SECRET_CURRENT ?? "").trim();
  const office = (env.CORE_BID_BOARD_OFFICE ?? "dallas").trim();
  if (!base || Buffer.byteLength(secret, "utf8") < MIN_INGRESS_SECRET_BYTES || !/^[a-z][a-z0-9_]*$/.test(office)) {
    return null;
  }
  return { targetUrl: `${base}/webhooks/synchub/${encodeURIComponent(office)}/bid-board-export/v1`, secret, office };
}

export interface PushBidBoardRowsToCoreResult {
  ok: boolean;
  /** Dark or unconfigured: nothing was sent. */
  skipped?: boolean;
  status?: number;
  error?: string;
}

/**
 * POST the export to Core. Never throws: Core being down, dark (404), unconfigured (503) or slow must never disturb
 * the stage sync that called it. One attempt per cycle; the next export carries newer data anyway.
 */
export async function pushBidBoardRowsToCore(
  input: BuildBidBoardCrmPayloadInput,
  deps: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetchWithTimeout } = {},
): Promise<PushBidBoardRowsToCoreResult> {
  const config = resolveCoreBidBoardExportConfig(deps.env ?? process.env);
  if (!config) return { ok: false, skipped: true };
  const fetchImpl = deps.fetchImpl ?? fetchWithTimeout;
  const rawBody = JSON.stringify(buildBidBoardCrmPayload({ ...input, officeSlug: config.office }));
  // The path actually requested is the one signed (a base URL with a path prefix signs what Core sees).
  const path = new URL(config.targetUrl).pathname;
  // ONE deadline over the whole exchange, headers AND body read (fetchWithTimeout's own timer stops at the headers).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CORE_BID_BOARD_EXPORT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(
      config.targetUrl,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-trock-signature": signCoreIngress({ domain: BID_BOARD_EXPORT_CONTRACT_VERSION, path, rawBody, secret: config.secret }),
        },
        body: rawBody,
        // A redirect is never followed: it would carry the signed body somewhere that is not Core's ingress.
        redirect: "manual",
        signal: controller.signal,
      },
      CORE_BID_BOARD_EXPORT_TIMEOUT_MS,
    );
    const text = await response.text().catch(() => "");
    if (response.ok) {
      log(`[BidBoardCore] Core applied the export: ${summarize(text)}`, "sync");
      return { ok: true, status: response.status };
    }
    const error =
      response.status >= 300 && response.status < 400
        ? `Core ingress redirected (${response.status}); refused`
        : `Core ingress returned ${response.status}${response.status === 500 ? ` (${summarize(text)})` : ""}`;
    log(`[BidBoardCore] ${error}`, "sync");
    return { ok: false, status: response.status, error };
  } catch (err) {
    const error = controller.signal.aborted ? "Core ingress timed out" : `Core ingress unreachable: ${err instanceof Error ? err.name : "UnknownError"}`;
    log(`[BidBoardCore] ${error}`, "sync");
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
  }
}

/** Core's counts only (matched, created, lanesMoved, failed...): never a row, a name or a number. */
function summarize(text: string): string {
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    return ["rows", "matched", "created", "lanesMoved", "coreOwnsStage", "held", "stale", "failed"]
      .filter((k) => typeof body[k] === "number")
      .map((k) => `${k}=${body[k]}`)
      .join(" ");
  } catch {
    return "no counts";
  }
}
