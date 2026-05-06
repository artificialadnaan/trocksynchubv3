# RFP Request Contract

This document defines Stop 3A for the multi-source RFP approval flow. It locks the `POST /api/rfp-requests` wire contract, idempotency behavior, HMAC auth, and refactor boundaries before endpoint code is implemented.

## 1. Request Body Schema

The endpoint accepts one normalized RFP request from either HubSpot or T Rock CRM. The Zod schema should live beside the new route code, likely `server/routes/rfp-requests.ts`, and should be exported for tests.

```ts
import { z } from "zod";

export const rfpRequestBodySchema = z.object({
  sourceSystem: z.enum(["hubspot", "trock_crm"]),
  sourceDealId: z.string().trim().min(1),
  sourceEventId: z.string().trim().min(1),
  deal: z.object({
    name: z.string().trim().min(1),
    projectNumber: z.string().trim().min(1),
    projectType: z.string().trim().min(1),
    amount: z.number().finite().nullable(),
    estimator: z.string().trim().nullable(),
    companyName: z.string().trim().nullable(),
    contactName: z.string().trim().nullable(),
    clientEmail: z.string().trim().email().nullable(),
    clientPhone: z.string().trim().nullable(),
    address: z.object({
      street: z.string().trim().nullable(),
      city: z.string().trim().nullable(),
      state: z.string().trim().nullable(),
      zip: z.string().trim().nullable(),
      country: z.string().trim().nullable(),
    }).nullable(),
    description: z.string().trim().nullable(),
    dueDate: z.string().trim().datetime({ offset: true }).nullable(),
    workflowRoute: z.string().trim().nullable(),
  }),
  attachments: z.array(z.object({
    name: z.string().trim().min(1),
    url: z.string().trim().url(),
    contentType: z.string().trim().min(1),
  })).default([]),
});

export type RfpRequestBody = z.infer<typeof rfpRequestBodySchema>;
```

Field mapping notes:

| Field | Type | Required | Existing HubSpot-shaped mapping |
| --- | --- | --- | --- |
| `sourceSystem` | `"hubspot" | "trock_crm"` | yes | New source discriminator. Existing HubSpot flow will use `"hubspot"`. |
| `sourceDealId` | `string` | yes | Existing `hubspotDealId`; stored as `rfp_approval_requests.source_deal_id`. |
| `sourceEventId` | `string` | yes | New idempotency key for source event replay; stored as `source_event_id`. |
| `deal.name` | `string` | yes | `dealData.dealname`. |
| `deal.projectNumber` | `string` | yes | `dealData.project_number`; also stored as `rfp_approval_requests.project_number`. |
| `deal.projectType` | `string` | yes | `dealData.project_types`; feeds approver lookup and BidBoard project type. |
| `deal.amount` | `number | null` | yes | `dealData.amount`, normalized to number instead of HubSpot string. |
| `deal.estimator` | `string | null` | yes | `dealData.estimator`. |
| `deal.companyName` | `string | null` | yes | `dealData.company_name` or associated company name. |
| `deal.contactName` | `string | null` | yes | `dealData.contact_name` or associated contact name. |
| `deal.clientEmail` | `string | null` | yes | `dealData.client_email` or associated contact email. |
| `deal.clientPhone` | `string | null` | yes | `dealData.client_phone` or associated contact phone. |
| `deal.address` | object or `null` | yes | Normalized replacement for `address`, `city`, `state`, `zip`, `country`. |
| `deal.address.street` | `string | null` | when `address` exists | `dealData.address` or `dealData.street_address`. |
| `deal.address.city` | `string | null` | when `address` exists | `dealData.city`. |
| `deal.address.state` | `string | null` | when `address` exists | `dealData.state` or `state_region`. |
| `deal.address.zip` | `string | null` | when `address` exists | `dealData.zip` or `postal_code`. |
| `deal.address.country` | `string | null` | when `address` exists | `dealData.country`. |
| `deal.description` | `string | null` | yes | `description`, `notes`, or `project_description__briefly_describe_the_project_`. |
| `deal.dueDate` | ISO datetime string or `null` | yes | `bid_due_date`, `due_date`, `proposal_due_date`, or HubSpot `closedate` normalized to ISO. |
| `deal.workflowRoute` | `string | null` | yes | New CRM workflow route; for HubSpot, `null` unless a HubSpot property is later mapped. |
| `attachments[]` | array | no; defaults to `[]` | Existing `dealData.attachments`, normalized to attachment rows. |
| `attachments[].name` | `string` | yes | Existing attachment `name` or `fileName`. |
| `attachments[].url` | URL string | yes | Existing attachment `url` or `fileUrl`. |
| `attachments[].contentType` | `string` | yes | Existing attachment `type` or `mimeType`. |

Implementation note: `deal.projectNumber` is intentionally required for cross-source idempotency. Requests without it should fail validation with `422`.

## 2. Response Shapes

### 201 Created

Returned when SyncHub creates a new pending approval request and queues/sends the approver email.

```json
{
  "success": true,
  "requestId": 123,
  "token": "uuid-token",
  "status": "pending",
  "sourceSystem": "trock_crm",
  "sourceDealId": "crm-deal-123",
  "projectNumber": "DFW-2-12345"
}
```

### 200 OK: idempotent replay

Returned when the same `(sourceSystem, sourceEventId)` was already accepted. No email is sent and no new DB rows are inserted.
`200` idempotent replay is returned for any terminal or non-terminal status of the existing request; the caller's event was already accepted and processed, regardless of where it landed.

```json
{
  "success": true,
  "idempotent": true,
  "requestId": 123,
  "token": "uuid-token",
  "status": "pending",
  "sourceSystem": "trock_crm",
  "sourceDealId": "crm-deal-123",
  "sourceEventId": "evt-123",
  "projectNumber": "DFW-2-12345"
}
```

### 401 Unauthorized: bad HMAC

Returned when the signature header is missing, malformed, or does not match the raw request body.

```json
{
  "success": false,
  "error": "Unauthorized",
  "message": "Invalid RFP request signature"
}
```

### 409 Conflict: cross-source collision

Pending request collision:

```json
{
  "success": false,
  "error": "RFP already in flight",
  "message": "RFP already in flight for project_number=DFW-2-12345 from source=hubspot",
  "projectNumber": "DFW-2-12345",
  "conflict": {
    "requestId": 99,
    "sourceSystem": "hubspot",
    "sourceDealId": "321011207920",
    "status": "pending"
  }
}
```

Approved request collision:

```json
{
  "success": false,
  "error": "Bid Board project already created",
  "message": "Bid Board project already created for this project_number",
  "projectNumber": "DFW-2-12345",
  "conflict": {
    "requestId": 99,
    "sourceSystem": "hubspot",
    "sourceDealId": "321011207920",
    "status": "approved",
    "bidboardProjectId": "562949955999999"
  }
}
```

### 422 Unprocessable Entity: validation failed

```json
{
  "success": false,
  "error": "Validation failed",
  "issues": [
    {
      "path": ["deal", "projectNumber"],
      "message": "String must contain at least 1 character(s)"
    }
  ]
}
```

### 500 Internal Server Error

```json
{
  "success": false,
  "error": "Internal server error",
  "message": "Failed to create RFP approval request"
}
```

## 3. Idempotency Decision Tree

The route must run these rules in order after HMAC verification and schema validation.

Phase 3 must also add the database-level cross-source pending guard to the `rfp_approval_requests` table indexes:

```ts
uniqueIndex("idx_rfp_approval_pending_project_number")
  .on(table.projectNumber)
  .where(sql`status = 'pending'`)
```

Migration `0017_add_pending_project_number_unique.sql`:

```sql
-- Cross-source guard: only one pending RFP per project_number across all sources.
-- Without this, the SELECT-then-INSERT idempotency path in /api/rfp-requests
-- races and can create duplicate pending RFPs from different sources.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM rfp_approval_requests
    WHERE status = 'pending' AND project_number IS NOT NULL
    GROUP BY project_number
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot create pending project_number uniqueness index: duplicate pending project_number rows exist';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_rfp_approval_pending_project_number
  ON rfp_approval_requests(project_number)
  WHERE status = 'pending';
```

1. Same source event replay: query `rfp_approval_requests.source_system` and `rfp_approval_requests.source_event_id`.
   - If found, return `200 OK` with existing `id`, `token`, `status`, `sourceSystem`, `sourceDealId`, `sourceEventId`, and `projectNumber`.
   - No side effects: do not create a request, do not send email.

   Drizzle:

   ```ts
   const [existingEvent] = await db
     .select()
     .from(rfpApprovalRequests)
     .where(and(
       eq(rfpApprovalRequests.sourceSystem, body.sourceSystem),
       eq(rfpApprovalRequests.sourceEventId, body.sourceEventId),
     ))
     .orderBy(desc(rfpApprovalRequests.createdAt))
     .limit(1);
   ```

   SQL:

   ```sql
   SELECT *
   FROM rfp_approval_requests
   WHERE source_system = $1
     AND source_event_id = $2
   ORDER BY created_at DESC
   LIMIT 1;
   ```

2. Pending cross-source collision: query `rfp_approval_requests.project_number` and `status='pending'` across all sources.
   - If found, return `409 Conflict`.
   - Body says `RFP already in flight for project_number=X from source=Y`.
   - No email is sent.
   - This SELECT remains as the friendly fast path for the common case. The unique index `idx_rfp_approval_pending_project_number` is the actual concurrency guarantee.

   Drizzle:

   ```ts
   const [pendingForProject] = await db
     .select()
     .from(rfpApprovalRequests)
     .where(and(
       eq(rfpApprovalRequests.projectNumber, body.deal.projectNumber),
       eq(rfpApprovalRequests.status, "pending"),
     ))
     .orderBy(desc(rfpApprovalRequests.createdAt))
     .limit(1);
   ```

   SQL:

   ```sql
   SELECT *
   FROM rfp_approval_requests
   WHERE project_number = $1
     AND status = 'pending'
   ORDER BY created_at DESC
   LIMIT 1;
   ```

3. Approved project collision: query `rfp_approval_requests.project_number` and `status='approved'`.
   - If found, return `409 Conflict`.
   - Body says `Bid Board project already created for this project_number`.
   - Include `bidboardProjectId` if present.

   Drizzle:

   ```ts
   const [approvedForProject] = await db
     .select()
     .from(rfpApprovalRequests)
     .where(and(
       eq(rfpApprovalRequests.projectNumber, body.deal.projectNumber),
       eq(rfpApprovalRequests.status, "approved"),
     ))
     .orderBy(desc(rfpApprovalRequests.approvedAt))
     .limit(1);
   ```

   SQL:

   ```sql
   SELECT *
   FROM rfp_approval_requests
   WHERE project_number = $1
     AND status = 'approved'
   ORDER BY approved_at DESC NULLS LAST
   LIMIT 1;
   ```

4. Declined or source-ineligible-cancelled request with same project number: query may find `status IN ('declined', 'cancelled_source_ineligible')`, but this does not block.
   - A declined RFP or an RFP cancelled because the source deal became ineligible can be re-bid, so proceed to creation.
   - No response is returned by this rule.

   Drizzle for optional audit/log context:

   ```ts
   const [reBiddableForProject] = await db
     .select()
     .from(rfpApprovalRequests)
     .where(and(
       eq(rfpApprovalRequests.projectNumber, body.deal.projectNumber),
       inArray(rfpApprovalRequests.status, ["declined", "cancelled_source_ineligible"]),
     ))
     .orderBy(desc(rfpApprovalRequests.createdAt))
     .limit(1);
   ```

   SQL:

   ```sql
   SELECT *
   FROM rfp_approval_requests
   WHERE project_number = $1
     AND status IN ('declined', 'cancelled_source_ineligible')
   ORDER BY created_at DESC NULLS LAST
   LIMIT 1;
   ```

5. No blocking idempotency match: create a new approval request.
   - Insert `source_system`, `source_deal_id`, `source_event_id`, `project_number`, nullable `hubspot_deal_id`, `token`, `token_expires_at`, `status='pending'`, and normalized `deal_data`.
   - Wrap the insert in `try/catch`. If Postgres raises a unique violation for `idx_rfp_approval_pending_project_number`, re-fetch the conflicting pending row by `project_number` and return the same `409 Conflict` body as Rule 2.
   - Send approver email using the existing email path after it is refactored to accept normalized input.
   - Return `201 Created`.

   Drizzle insert shape:

   ```ts
   const [created] = await db
     .insert(rfpApprovalRequests)
     .values({
       sourceSystem: body.sourceSystem,
       sourceDealId: body.sourceDealId,
       sourceEventId: body.sourceEventId,
       projectNumber: body.deal.projectNumber,
       // hubspot_deal_id is dual-written for HubSpot rows during the migration window only.
       hubspotDealId: body.sourceSystem === "hubspot" ? body.sourceDealId : null,
       token,
       tokenExpiresAt,
       status: "pending",
       dealData: normalizedDealData,
     })
     .returning();
   ```

   Unique violation handling:

   ```ts
   try {
     const [created] = await db.insert(rfpApprovalRequests).values(insertValues).returning();
     return created;
   } catch (error: any) {
     if (isUniqueViolation(error, "idx_rfp_approval_pending_project_number")) {
       const [conflict] = await db
         .select()
         .from(rfpApprovalRequests)
         .where(and(
           eq(rfpApprovalRequests.projectNumber, body.deal.projectNumber),
           eq(rfpApprovalRequests.status, "pending"),
         ))
         .orderBy(desc(rfpApprovalRequests.createdAt))
         .limit(1);
       return buildPendingProjectNumberConflict(conflict);
     }
     throw error;
   }
   ```

Concurrency model:

- The Rule 2 SELECT gives a fast path with a clean error message in the common case.
- The partial unique index `idx_rfp_approval_pending_project_number` is the actual guarantee that two concurrent sources cannot create duplicate pending RFP requests for the same `project_number`.
- The Rule 5 unique-violation catch converts the DB-enforced race winner/loser outcome back into the same `409 Conflict` response shape as Rule 2.

## 4. HMAC Auth Scheme

Match the existing `server/sync/bidboard-crm-ingestion.ts` pattern for now:

- Signature header: `x-rfp-request-signature`
- Secret env var: `RFP_REQUEST_SYNC_SECRET`
- Algorithm: HMAC SHA-256
- Signed content: raw request body bytes exactly as received
- Header value format: `sha256=<hex digest>`

Example signer:

```ts
function signRfpRequestBody(rawBody: string, secret: string) {
  return `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}
```

Verification must use timing-safe comparison:

```ts
const expected = signRfpRequestBody(rawBody, secret);
const valid =
  signature.length === expected.length &&
  crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
```

Replay protection:

- The existing BidBoard CRM ingestion pattern signs body only and does not include a timestamp.
- For `POST /api/rfp-requests`, replay protection is handled by `sourceEventId` idempotency, not by HMAC timestamp windows.
- Do not add a timestamp header in Phase 3 unless both SyncHub and CRM add the same convention. Adding it now would diverge from the existing internal-call pattern and require CRM middleware changes before the endpoint can be used.

Operational behavior:

- If `RFP_REQUEST_SYNC_SECRET` is missing, reject all requests with `500` and log a configuration error. Do not silently allow unsigned RFP creation.
- On server startup, if `RFP_REQUEST_SYNC_SECRET` is missing, log a clear ERROR-level message with the recognizable text `RFP_REQUEST_SYNC_SECRET not configured — POST /api/rfp-requests will reject all requests with 500` so this surfaces in deploy logs before the first request.
- If `x-rfp-request-signature` is missing or invalid, return `401`.
- The route must use a raw-body capture middleware before JSON parsing or reuse an Express `verify` hook so the HMAC signs the original body, not a reserialized object.

## 5. Source-Aware URL Builder

Add a single source-aware URL builder in `server/rfp-approval.ts` or a small adjacent helper if the file grows during Phase 3:

```ts
export async function buildSourceDealUrl(sourceSystem: "hubspot" | "trock_crm", sourceDealId: string): Promise<string | null> {
  if (sourceSystem === "hubspot") {
    const hubspotConfig = await storage.getAutomationConfig("hubspot_config");
    const portalId = (hubspotConfig?.value as any)?.portalId?.trim() || "45644695";
    return `https://app-na2.hubspot.com/contacts/${portalId}/record/0-3/${sourceDealId}?eschref=%2Fcontacts%2F${portalId}%2Fobjects%2F0-3%2Fviews%2Fall%2Flist%3Fquery%3Drfp`;
  }

  const crmBaseUrl = process.env.TROCK_CRM_BASE_URL?.replace(/\/+$/, "");
  if (!crmBaseUrl) return null;
  return `${crmBaseUrl}/deals/${encodeURIComponent(sourceDealId)}`;
}
```

Configuration:

- HubSpot URL: existing `hubspot_config.portalId` with default `45644695`.
- CRM URL: new env var `TROCK_CRM_BASE_URL`, for example `https://trockcrm.com`.

Call sites:

- Email template CTA currently hardcodes `View in HubSpot` in `server/rfp-approval.ts`. Replace with `View in HubSpot` or `View in T Rock CRM` based on `sourceSystem`; hide the secondary link if `buildSourceDealUrl()` returns `null`.
- Review page copy currently says edits update HubSpot in `server/routes/rfp-approval.ts`. Replace with source-aware copy:
  - HubSpot: keep current behavior and wording.
  - T Rock CRM: say edits are captured for CRM write-back; Phase 5 sends them to CRM.

## 6. Review Page Write-Back

HubSpot behavior remains current for Phase 3:

- On approve, edited fields are applied to HubSpot by `processRfpApproval()`.
- The HubSpot deal is moved to the estimating stage.
- BidBoard creation still uses refreshed HubSpot/cache data.

T Rock CRM behavior in Phase 3:

- Do not attempt CRM write-back from the review page yet.
- Log edits to a new `rfp_approval_edits` table.
- Phase 5 wires the actual CRM-side endpoint `POST /api/internal/rfp-edits` and replays or directly sends these edits.

Planned schema:

```ts
export const rfpApprovalEdits = pgTable("rfp_approval_edits", {
  id: serial("id").primaryKey(),
  rfpApprovalRequestId: integer("rfp_approval_request_id")
    .notNull()
    .references(() => rfpApprovalRequests.id, { onDelete: "cascade" }),
  editedFields: jsonb("edited_fields").notNull(),
  editedAt: timestamp("edited_at").notNull().defaultNow(),
});
```

SQL migration shape:

```sql
CREATE TABLE IF NOT EXISTS rfp_approval_edits (
  id serial PRIMARY KEY,
  rfp_approval_request_id integer NOT NULL REFERENCES rfp_approval_requests(id) ON DELETE CASCADE,
  edited_fields jsonb NOT NULL,
  edited_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rfp_approval_edits_request_id
  ON rfp_approval_edits(rfp_approval_request_id);
```

Phase 3 storage method:

```ts
createRfpApprovalEdit(data: {
  rfpApprovalRequestId: number;
  editedFields: Record<string, string>;
}): Promise<RfpApprovalEdit>;
```

Phase 5 hand-off:

- CRM implements `POST /api/internal/rfp-edits`.
- SyncHub signs the request with the shared internal secret.
- CRM validates the signature, applies editable fields to the deal, and returns success/failure.

## 7. Refactor Plan

Phase 3 should introduce a normalized internal function used by both event sources.

Types:

```ts
export interface NormalizedRfpAttachment {
  name: string;
  url: string;
  contentType: string;
}

export interface NormalizedRfpDeal {
  name: string;
  projectNumber: string;
  projectType: string;
  amount: number | null;
  estimator: string | null;
  companyName: string | null;
  contactName: string | null;
  clientEmail: string | null;
  clientPhone: string | null;
  address: {
    street: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    country: string | null;
  } | null;
  description: string | null;
  dueDate: string | null;
  workflowRoute: string | null;
}

export interface NormalizedRfpRequestInput {
  sourceSystem: "hubspot" | "trock_crm";
  sourceDealId: string;
  sourceEventId: string;
  deal: NormalizedRfpDeal;
  attachments: NormalizedRfpAttachment[];
}
```

New internal function:

```ts
export async function createRfpApprovalRequestFromNormalizedInput(
  input: NormalizedRfpRequestInput
): Promise<{
  success: boolean;
  requestId?: number;
  token?: string;
  status?: string;
  idempotent?: boolean;
  conflict?: {
    requestId: number;
    sourceSystem: string;
    sourceDealId: string;
    status: string;
    bidboardProjectId?: string | null;
  };
  error?: string;
}> {
  // Apply idempotency decision tree.
  // Insert request.
  // Render/send email.
}
```

Keep backwards-compatible wrapper:

```ts
export async function createRfpApprovalRequest(
  hubspotDealId: string
): Promise<{ success: boolean; token?: string; error?: string }> {
  const sourceEventId = `hubspot:dealstage:rfp:${hubspotDealId}:${Date.now()}`;
  const input = await buildNormalizedRfpRequestFromHubSpotDeal(hubspotDealId, {
    sourceEventId,
  });
  const result = await createRfpApprovalRequestFromNormalizedInput(input);
  return { success: result.success, token: result.token, error: result.error };
}
```

`hubspot_deal_id` is dual-written for HubSpot-sourced rows during the migration window only. It is being kept to avoid breaking legacy HubSpot-shaped queries and storage wrappers. Per the migration plan, this column will be dropped when HubSpot is decommissioned in the Phase 8 cutover doc.

HubSpot adapter:

```ts
export async function buildNormalizedRfpRequestFromHubSpotDeal(
  hubspotDealId: string,
  options: { sourceEventId: string }
): Promise<NormalizedRfpRequestInput> {
  const dealData = await fetchFullDealFromHubSpot(hubspotDealId);
  return {
    sourceSystem: "hubspot",
    sourceDealId: hubspotDealId,
    sourceEventId: options.sourceEventId,
    deal: {
      name: String(dealData.dealname || `Deal ${hubspotDealId}`),
      projectNumber: String(dealData.project_number || "").trim(),
      projectType: String(dealData.project_types || "").trim(),
      amount: dealData.amount == null || dealData.amount === "" ? null : Number(dealData.amount),
      estimator: dealData.estimator ?? null,
      companyName: dealData.company_name ?? null,
      contactName: dealData.contact_name ?? null,
      clientEmail: dealData.client_email ?? null,
      clientPhone: dealData.client_phone ?? null,
      address: {
        street: dealData.address ?? null,
        city: dealData.city ?? null,
        state: dealData.state ?? null,
        zip: dealData.zip ?? null,
        country: dealData.country ?? null,
      },
      description: resolveRfpDescription(dealData) || null,
      dueDate: normalizeHubSpotDueDate(dealData),
      workflowRoute: null,
    },
    attachments: (dealData.attachments || []).map((attachment: any) => ({
      name: attachment.name || attachment.fileName || "attachment",
      url: attachment.url || attachment.fileUrl,
      contentType: attachment.type || attachment.mimeType || "application/octet-stream",
    })).filter((attachment: NormalizedRfpAttachment) => attachment.url),
  };
}
```

HubSpot webhook handler:

- Current call site: `server/routes/webhooks.ts` imports `createRfpApprovalRequest(objectId)` when a HubSpot deal reaches RFP.
- Stop 3B should either keep that wrapper call or make the adapter explicit there:

```ts
const sourceEventId = event.eventId
  ? `hubspot:event:${event.eventId}`
  : `hubspot:dealstage:rfp:${objectId}:${event.occurredAt || Date.now()}`;

const input = await buildNormalizedRfpRequestFromHubSpotDeal(objectId, {
  sourceEventId,
});
const result = await createRfpApprovalRequestFromNormalizedInput(input);
```

Recommended: keep the wrapper in Phase 3 to reduce webhook churn, then make the webhook explicit only when we need better HubSpot event IDs.

New endpoint handler:

- `POST /api/rfp-requests` validates body with `rfpRequestBodySchema`.
- It calls `createRfpApprovalRequestFromNormalizedInput(validatedBody)`.
- It maps the internal result to `201`, `200`, `409`, or `500`.

## 8. Open Questions

1. Resolved: HubSpot webhook should use a true HubSpot event ID for `sourceEventId` when available, with a re-entry-safe fallback.
   - Answer: use `event.eventId ? \`hubspot:event:${event.eventId}\` : \`hubspot:dealstage:rfp:${hubspotDealId}:${event.occurredAt || Date.now()}\``.
   - Why: the fallback must vary per re-entry. A stable fallback like `hubspot:dealstage:rfp:${hubspotDealId}` would cause Rule 1 to replay an old declined request instead of creating a fresh request when the deal moves back into RFP.

2. Should `dueDate` accept date-only strings as well as ISO datetimes?
   - Proposed answer: accept ISO datetime in the public endpoint for strictness, and have CRM send midnight UTC or local-normalized ISO.
   - Why: the original prompt says ISO date, but existing systems may treat dates as timestamps. A datetime string prevents ambiguous timezone parsing in SyncHub.

3. Should HMAC include timestamp and path?
   - Proposed answer: not for Phase 3.
   - Why: existing internal CRM ingestion signs body only. `sourceEventId` gives replay protection at the business-event layer. Adding timestamp/path now would diverge from the existing working pattern.

4. Should `sourceSystem='hubspot'` be allowed on the public normalized endpoint?
   - Proposed answer: validate it but restrict operational use to internal/known callers via HMAC.
   - Why: the endpoint contract is intentionally multi-source, and tests need both paths. Security comes from the shared secret, not from blocking the enum value.

5. What URL should T Rock CRM deal links use?
   - Proposed answer: `${TROCK_CRM_BASE_URL}/deals/${sourceDealId}` unless CRM confirms a different route.
   - Why: discovery showed deal-centric CRM routes, but the exact production route should be verified in Phase 5 when the CRM caller is wired.
