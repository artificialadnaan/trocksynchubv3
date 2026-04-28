import crypto from "crypto";
import path from "path";
import { log } from "../index";
import type { BidBoardExcelRow } from "./bidboard-stage-sync";

export interface BuildBidBoardCrmPayloadInput {
  rows: BidBoardExcelRow[];
  sourceFilename: string;
  extractedAt: string;
  officeSlug?: string;
}

export interface PushBidBoardRowsInput extends BuildBidBoardCrmPayloadInput {
  retryDelaysMs?: number[];
}

export function buildBidBoardCrmPayload(input: BuildBidBoardCrmPayloadInput) {
  return {
    office_slug: input.officeSlug ?? process.env.CRM_BID_BOARD_SYNC_OFFICE_SLUG ?? "dallas",
    provenance: {
      sourceFilename: path.basename(input.sourceFilename),
      extractedAt: input.extractedAt,
      rowCount: input.rows.length,
    },
    rows: input.rows,
  };
}

export function signBidBoardCrmPayload(body: string, secret: string) {
  return `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pushBidBoardRowsToCrm(input: PushBidBoardRowsInput): Promise<{
  ok: boolean;
  attempts: number;
  skipped?: boolean;
  status?: number;
  error?: string;
}> {
  const url = process.env.CRM_BID_BOARD_SYNC_URL;
  const secret = process.env.BID_BOARD_SYNC_SECRET;
  if (!url || !secret) {
    log(
      "[BidBoardCRM] CRM_BID_BOARD_SYNC_URL or BID_BOARD_SYNC_SECRET missing; skipping CRM ingestion push",
      "sync"
    );
    return {
      ok: false,
      attempts: 0,
      skipped: true,
      error: "CRM Bid Board sync is not configured",
    };
  }

  const payload = buildBidBoardCrmPayload(input);
  const body = JSON.stringify(payload);
  const retryDelays = input.retryDelaysMs ?? [1000, 5000];
  let attempts = 0;
  let lastStatus: number | undefined;
  let lastError: string | undefined;

  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    attempts++;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-bid-board-sync-signature": signBidBoardCrmPayload(body, secret),
        },
        body,
      });
      lastStatus = response.status;
      if (response.ok) {
        log(`[BidBoardCRM] Posted ${input.rows.length} Bid Board rows to CRM`, "sync");
        return { ok: true, attempts, status: response.status };
      }
      lastError = `CRM responded ${response.status}: ${await response.text().catch(() => "")}`;
      log(`[BidBoardCRM] Push attempt ${attempts} failed: ${lastError}`, "sync");
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log(`[BidBoardCRM] Push attempt ${attempts} failed: ${lastError}`, "sync");
    }

    const waitMs = retryDelays[attempt];
    if (waitMs != null) await delay(waitMs);
  }

  log(`[BidBoardCRM] Giving up after ${attempts} attempts; extraction remains successful`, "sync");
  return { ok: false, attempts, status: lastStatus, error: lastError };
}
