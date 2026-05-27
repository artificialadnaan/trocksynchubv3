# SyncHub RFP Decline Callback Sender

## Investigation Findings

### Denial Path

The existing RFP denial path is `processRfpDecline()` in `server/rfp-approval.ts`.

Before this change it:

- loaded the request by token,
- required `status === "pending"`,
- rejected expired links,
- wrote `status: "declined"`, `declinedBy`, and `declinedAt` to `rfp_approval_requests`,
- wrote audit logs,
- returned success.

It did not notify TRCRM.

### Approval Callback Mechanism Mirrored

The existing approval callback path builds a `bidboard_callback_outbox` row in `server/rfp-approval.ts` and delivers it from `server/sync/bidboard-callback-worker.ts`.

Mechanism:

- Base URL: `TROCK_CRM_BASE_URL`
- Existing approval endpoint: `/api/internal/bid-board-created`
- Shared secret: `RFP_REQUEST_SYNC_SECRET`
- Signature: HMAC-SHA256 over the raw JSON body
- Header: `x-rfp-request-signature: sha256=<hex>`
- Delivery: existing `bidboard_callback_outbox` worker
- Failure handling: retry/backoff, then dead-letter after max attempts

The decline callback reuses this same outbox table, worker, signing header, shared secret, base URL resolution, and retry/dead-letter behavior.

### TRCRM Decline Contract

The current TRCRM `origin/main` receiver exposes:

- `POST /api/internal/rfp-declined`
- Raw JSON body
- Header `x-rfp-request-signature`

Accepted payload fields:

- `sourceDealId`: CRM deal UUID
- `rfpApprovalRequestId`: finite integer
- `denialReason`: optional string
- `reason`: optional fallback alias accepted by TRCRM
- `declinedAt`: optional ISO timestamp; TRCRM defaults to receipt time when omitted

SyncHub's decline UI currently collects only `declinerEmail`; it does not collect a denial reason. The sender therefore sends `sourceDealId`, `rfpApprovalRequestId`, and `declinedAt`; `denialReason` is included only if a future caller supplies one.

## Change Made

Added a strictly additive decline callback sender:

- `buildRfpDeclinedCallbackTargetUrl()` in `server/sync/bidboard-callback-worker.ts`
- `RfpDeclinedCallbackPayload` type in `server/sync/bidboard-callback-worker.ts`
- `buildRfpDeclinedCallbackData()` in `server/rfp-approval.ts`
- `declineRfpApprovalRequestWithOptionalCallback()` in `server/storage.ts`

For CRM-sourced RFP requests only (`sourceSystem === "trock_crm"`), `processRfpDecline()` now creates the declined-state update and callback outbox row together, mirroring the approval path's durable state+callback pattern. HubSpot-sourced declines remain local-only and do not enqueue a TRCRM callback.

No approval-callback behavior was changed.

## Failure Handling

Remote callback delivery failure is handled by the existing outbox worker:

- pending row is claimed,
- request is signed and POSTed,
- non-2xx responses are retried with existing backoff,
- rows are marked `dead` after max attempts.

The decline request is not coupled to TRCRM availability once the outbox row is created. A duplicate callback is safe because TRCRM's endpoint is idempotent, and SyncHub's outbox remains unique by `rfp_approval_request_id`.

## Review Rounds

Round 1 finding: the first implementation updated the request and inserted the callback in separate awaits, which could lose the callback if the process died between them.

Fix: added a storage helper that updates the declined state and inserts the callback outbox row in one database transaction.

Round 2 finding: callback failure semantics needed to distinguish outbox delivery failure from outbox enqueue failure; the endpoint and optional denial reason were checked against TRCRM.

Fix: confirmed the actual merged TRCRM route is `/api/internal/rfp-declined`; delivery failure is handled by the existing worker. No denial reason exists in SyncHub's current decline UI, so none is fabricated.

Round 3 finding: a retry branch for already-declined requests changed existing response semantics.

Fix: removed that branch and preserved the prior `Request already declined` response.

## Tests

Passed:

```text
npx vitest run tests/bidboard-callback-outbox.test.ts --testTimeout=15000
Test Files  1 passed (1)
Tests       11 passed (11)
```

Passed:

```text
npm run build
```

Repo-wide suite:

```text
npx vitest run --testTimeout=15000
Test Files  8 failed | 30 passed | 1 skipped (39)
Tests       5 failed | 287 passed | 6 skipped (298)
```

Failures are pre-existing/unrelated clusters in tests requiring `DATABASE_URL`, stale expectations in BidBoard/export/RFP approval tests, estimator message formatting, and stage-change email mocks.

Typecheck:

```text
npm run check
```

Failed on existing unrelated SyncHub type errors in archive/project archive, reports, bidboard/portfolio/report routes, settings, testing/webhook routes, and reconciliation guardrails. No reported typecheck errors were in the changed files.
