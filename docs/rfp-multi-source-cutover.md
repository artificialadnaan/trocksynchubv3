# RFP Multi-Source Cutover Runbook

This runbook covers production rollout for the multi-source RFP approval flow:

- HubSpot deal reaches RFP stage: existing trigger, still supported during migration.
- T Rock CRM deal reaches Opportunity stage: new trigger, routed through SyncHub as the system of record for RFP approval, Bid Board creation, and Phase 2 handoff.

## A. Pre-Cutover Checklist

### SyncHub Migrations

Run these on the SyncHub production database in order:

1. `0014_add_trockcrm_relay_outbox.sql`
   - Creates the TrockCRM relay outbox used by the Procore portfolio relay path.
2. `0015_add_source_identity_to_rfp_and_sync_mappings.sql`
   - Adds `source_system`, `source_deal_id`, `source_event_id`, `project_number`, and `token_expires_at`.
   - Backfills existing rows as `hubspot`.
3. `0016_relax_hubspot_deal_id_nullable.sql`
   - Allows CRM-sourced RFP requests without fake HubSpot IDs.
4. `0017_create_rfp_approver_config.sql`
   - Creates seeded approver routing config.
5. `0018_create_rfp_approval_edits.sql`
   - Logs CRM-sourced review-page edits until CRM write-back is active.
6. `0019_add_pending_project_number_unique.sql`
   - Adds `idx_rfp_approval_pending_project_number`, the cross-source pending uniqueness guard.
7. `0020_create_bidboard_callback_outbox.sql`
   - Adds durable SyncHub-to-CRM Bid Board-created callback delivery.

### CRM Migrations

Run these on the CRM production database in order:

1. `0086_rfp_job_queue_integration.sql`
   - Adds RFP approval state fields and canonical RFP payload fields to tenant deals.
2. `0087_bidboard_created_callback_link_fields.sql`
   - Adds `procore_company_id` and `bid_board_linked_at`.
3. `0088_bidboard_summary_panel_fields.sql`
   - Adds `bid_board_last_updated_at` and `bid_board_assigned_pm`.

### SyncHub Environment Variables

Required:

- `RFP_REQUEST_SYNC_SECRET`: shared HMAC secret for CRM-to-SyncHub RFP requests and SyncHub-to-CRM callbacks.
- `TROCK_CRM_BASE_URL`: CRM public base URL, for example `https://trockcrm.com`.
- `APP_URL`: SyncHub public base URL used in approval review links.
- `PROCORE_COMPANY_ID` or `procore_config.companyId`: required for Bid Board-created callback payloads.
- Existing HubSpot, Procore, email, database, and session env vars must remain configured.

Optional:

- `HUBSPOT_RFP_TRIGGER_ENABLED`: defaults to enabled when missing. Set to `false` only after CRM cutover is stable and HubSpot RFP triggering should be disabled.

### CRM Environment Variables

Required:

- `SYNCHUB_SHARED_SECRET`: same value as SyncHub `RFP_REQUEST_SYNC_SECRET`.
- `SYNCHUB_BASE_URL`: SyncHub public base URL used by the RFP delivery job. The payload builder also accepts `SYNC_HUB_BASE_URL` or `SYNCHUB_URL`, but `SYNCHUB_BASE_URL` is the preferred production name.
- Existing CRM database, auth, worker, frontend, and Procore env vars must remain configured.

### Deploy Order

Deploy SyncHub first, then CRM.

Reason:

- CRM Phase 5 emits to `POST /api/rfp-requests`; deploying CRM before SyncHub can create dead `rfp_request_delivery` jobs because the endpoint or schema may not exist yet.
- SyncHub changes are backward compatible with HubSpot. With SyncHub deployed first, existing HubSpot RFP approvals continue to work while CRM starts sending normalized requests after its deploy.
- CRM can safely receive Bid Board-created callbacks after its Phase 6 endpoint is live; until CRM deploys, SyncHub callback rows would retry and eventually dead if approvals happen first. Avoid this by deploying CRM immediately after SyncHub and avoiding manual CRM-sourced approvals during the deploy window.

### Staging Smoke Tests

Run these before production cutover:

1. CRM deal to Opportunity:
   - Move a staging CRM deal to Opportunity.
   - Confirm `public.job_queue` receives `job_type='rfp_request_delivery'`.
   - Run or wait for the worker.
   - Confirm SyncHub creates `rfp_approval_requests.source_system='trock_crm'`.
2. Approval:
   - Approve through SyncHub review page.
   - Confirm Bid Board creation is invoked.
   - Confirm `bidboard_callback_outbox` receives one pending row.
   - Confirm CRM deal gets `procore_bid_id`, `procore_company_id`, `is_bid_board_owned=true`, `rfp_approval_status='approved'`, and `bid_board_linked_at`.
3. HubSpot compatibility:
   - Fire a HubSpot RFP-stage webhook.
   - Confirm SyncHub creates `source_system='hubspot'`.
   - Confirm no `bidboard_callback_outbox` row is created for that request.
4. Collision:
   - Attempt same `project_number` from HubSpot and CRM.
   - Confirm the second request returns conflict and CRM shows `rfp_approval_status='conflict'`.
5. Expiry and source eligibility:
   - Confirm expired token approval returns 410.
   - Confirm deleted or no-longer-Opportunity CRM deal cancels approval and does not create Bid Board project.

## B. Rollback Procedure

### Deploy Rollback

Preferred first rollback is deploy-level:

1. If CRM outbound delivery fails but SyncHub is healthy, roll back CRM to the last pre-Phase-5 deploy. SyncHub remains backward compatible with HubSpot.
2. If SyncHub approval handling fails, roll back SyncHub to the last known-good deploy and set CRM worker concurrency to zero or pause the CRM worker so no new RFP jobs send during rollback.
3. If both sides are unstable, pause CRM workers, roll back CRM, then roll back SyncHub.

### Migration Rollback Notes

Only roll back schema after deploy rollback and after confirming no in-flight RFP requests depend on the new fields.

SyncHub:

- `0020_create_bidboard_callback_outbox.sql`: `DROP TABLE IF EXISTS bidboard_callback_outbox;`
- `0019_add_pending_project_number_unique.sql`: `DROP INDEX IF EXISTS idx_rfp_approval_pending_project_number;`
- `0018_create_rfp_approval_edits.sql`: `DROP TABLE IF EXISTS rfp_approval_edits;`
- `0017_create_rfp_approver_config.sql`: `DROP TABLE IF EXISTS rfp_approver_config;`
- `0016_relax_hubspot_deal_id_nullable.sql`: only restore `NOT NULL` after proving there are no non-HubSpot rows: `ALTER TABLE rfp_approval_requests ALTER COLUMN hubspot_deal_id SET NOT NULL;`
- `0015_add_source_identity_to_rfp_and_sync_mappings.sql`: do not drop source identity columns during normal rollback. They are additive and harmless to old code. Dropping them requires first removing unique indexes and verifying no CRM-sourced rows exist.
- `0014_add_trockcrm_relay_outbox.sql`: `DROP TABLE IF EXISTS trockcrm_relay_outbox;`

CRM:

- `0088_bidboard_summary_panel_fields.sql`: per tenant, `ALTER TABLE deals DROP COLUMN IF EXISTS bid_board_last_updated_at; ALTER TABLE deals DROP COLUMN IF EXISTS bid_board_assigned_pm;`
- `0087_bidboard_created_callback_link_fields.sql`: per tenant, `ALTER TABLE deals DROP COLUMN IF EXISTS procore_company_id; ALTER TABLE deals DROP COLUMN IF EXISTS bid_board_linked_at;`
- `0086_rfp_job_queue_integration.sql`: per tenant, drop RFP approval fields and canonical RFP payload fields only after checking no RFP outbox jobs are pending or dead and no UI needs these fields. Keep `public.job_queue` rows as audit history unless the whole environment is being restored from backup.

### Mid-Flight State Safety

The CRM dead-row sweep is idempotent. It only updates deals for `job_queue` rows where `status='dead'`, `job_type='rfp_request_delivery'`, and the job payload has not already been marked handled. Running it before or after a deploy rollback does not corrupt successfully sent rows.

SyncHub callback outbox rows are also idempotent by `rfp_approval_request_id`. A callback can be replayed safely; CRM treats duplicate `sourceDealId + bidboardProjectId` callbacks as success.

## C. HubSpot Decommission Kill Switch

The HubSpot RFP trigger lives in `server/routes/webhooks.ts` inside the deal `dealstage` property-change handler.

Feature flag:

- Env var: `HUBSPOT_RFP_TRIGGER_ENABLED`
- Missing or any value other than `"false"`: enabled for backwards compatibility.
- `"false"`: webhook still receives and logs the event, but does not call `createRfpApprovalRequest`.

Cut procedure:

1. Confirm CRM-sourced RFP triggering is stable for two weeks.
2. Confirm no active sales users are relying on HubSpot stage moves for new RFPs.
3. Set `HUBSPOT_RFP_TRIGGER_ENABLED=false` on SyncHub production.
4. Deploy or restart SyncHub so the environment change is active.
5. Monitor for one week:
   - HubSpot RFP webhook logs should show disabled-trigger messages.
   - New `rfp_approval_requests.source_system='hubspot'` rows should stop.
   - CRM `rfp_request_delivery` volume should match expected Opportunity transitions.
6. After one clean week, plan code removal:
   - Remove HubSpot RFP trigger branch.
   - Remove `hubspot_deal_id` dual-write.
   - Drop legacy HubSpot-only wrappers after all reporting and storage paths use source identity.

## D. Monitoring and Observability

### First 24 Hours

Watch:

- CRM jobs stuck in `pending`.
- CRM jobs moved to `dead`.
- SyncHub callback rows stuck in `pending` or `dead`.
- `cancelled_source_ineligible` RFP requests.
- CRM deals in `rfp_approval_status='conflict'`.
- Bid Board creation latency due to the Playwright browser lock.
- Approval email send failures.

### Useful Queries

CRM stuck pending outbox jobs:

```sql
SELECT id, office_id, attempts, max_attempts, last_error, run_after, created_at, payload->>'dealId' AS deal_id
FROM public.job_queue
WHERE job_type = 'rfp_request_delivery'
  AND status = 'pending'
  AND run_after < now() - interval '10 minutes'
ORDER BY created_at ASC;
```

CRM dead RFP delivery jobs:

```sql
SELECT id, office_id, attempts, max_attempts, last_error, created_at, payload->>'dealId' AS deal_id
FROM public.job_queue
WHERE job_type = 'rfp_request_delivery'
  AND status = 'dead'
ORDER BY created_at DESC;
```

SyncHub dead callback rows:

```sql
SELECT id, rfp_approval_request_id, source_system, source_deal_id, attempt_count, max_attempts, last_error, created_at
FROM bidboard_callback_outbox
WHERE status = 'dead'
ORDER BY created_at DESC;
```

SyncHub stuck pending callback rows:

```sql
SELECT id, rfp_approval_request_id, source_deal_id, attempt_count, next_attempt_at, last_error, created_at
FROM bidboard_callback_outbox
WHERE status = 'pending'
  AND next_attempt_at < now() - interval '10 minutes'
ORDER BY created_at ASC;
```

Source eligibility cancellations:

```sql
SELECT id, source_system, source_deal_id, project_number, approved_by, updated_at, created_at
FROM rfp_approval_requests
WHERE status = 'cancelled_source_ineligible'
ORDER BY updated_at DESC NULLS LAST, created_at DESC;
```

CRM conflict statuses:

```sql
-- Run per tenant schema.
SELECT id, deal_number, name, rfp_conflict_reason, rfp_conflict_with, updated_at
FROM deals
WHERE rfp_approval_status = 'conflict'
ORDER BY updated_at DESC;
```

New HubSpot RFP rows after kill switch:

```sql
SELECT id, source_deal_id, project_number, status, created_at
FROM rfp_approval_requests
WHERE source_system = 'hubspot'
  AND created_at > now() - interval '24 hours'
ORDER BY created_at DESC;
```

### Alerts Worth Adding

- Any `public.job_queue` row with `job_type='rfp_request_delivery'` and `status='dead'`.
- Any `bidboard_callback_outbox.status='dead'`.
- More than 3 `cancelled_source_ineligible` rows in 24 hours.
- More than 3 CRM `rfp_approval_status='conflict'` rows in 24 hours.
- Any pending callback row older than 30 minutes.
- Any pending RFP delivery job older than 30 minutes.

## E. Known Limitations and Operator Runbook

### Browser Lock Latency

Bid Board creation still goes through Procore browser automation. The browser lock serializes these operations. During approval bursts, expect a few minutes of latency per project. This is expected and protects Procore automation from concurrent browser-session collisions.

### Bid Board Stage Sync Lag

The Excel export polling cadence is 5 to 60 minutes depending on scheduler configuration. The CRM hard link and Open in Bid Board URL work immediately after callback delivery, but mirrored stage, estimate, and last-sync panel data lag until the next export ingestion cycle.

### Assigned PM

`bid_board_assigned_pm` is intentionally not populated by Bid Board export ingestion. Assigned PM becomes available later through Procore role polling after portfolio handoff. The CRM panel shows `Not yet assigned` until role polling populates the column.

### Pending Job Runbook

If a CRM RFP delivery job is stuck in `pending`:

1. Check whether the worker process is running.
2. Check `run_after`; if it is in the future, the job is backing off normally.
3. Check `last_error`; 5xx or network errors indicate SyncHub availability or routing issues.
4. If the worker died, restart the worker. Pending jobs are durable and should resume.

If a CRM RFP delivery job is `dead`:

1. Inspect `last_error`.
2. If the cause is a fixed configuration issue, use the deal-page retry button.
3. The retry button inserts a new `job_queue` row and leaves the dead row as audit history.

If a SyncHub callback row is stuck in `pending`:

1. Check the SyncHub callback worker logs.
2. Confirm `TROCK_CRM_BASE_URL` is set and reachable.
3. Confirm CRM `SYNCHUB_SHARED_SECRET` matches SyncHub `RFP_REQUEST_SYNC_SECRET`.

If a SyncHub callback row is `dead`:

1. Inspect `last_error`.
2. Fix auth or CRM availability.
3. Manually replay by inserting a new `bidboard_callback_outbox` row with the same payload and `status='pending'`, or update the dead row to `pending`, reset `attempt_count`, clear `last_error`, and set `next_attempt_at=now()` after documenting the manual intervention.
