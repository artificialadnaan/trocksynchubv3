# Trock Sync Hub 2.0

## Overview
Production-grade middleware application for bidirectional synchronization between HubSpot CRM, Procore construction management, and CompanyCam. Built with Node.js/Express backend and React frontend.

## Recent Changes
- 2026-02-25: Fixed Procore project role assignment sync. Correct endpoint is `GET /rest/v1.0/project_roles?project_id={PID}&company_id={CID}` (root-level with query params, NOT nested). Returns role name, user_id, contact_id, name with company. Emails enriched from synced procore_users table. 219 assignments synced across 16 role types. New route: `POST /api/procore/sync-role-assignments` for independent sync. DB table: `procore_role_assignments` with composite unique index (project_id, role_name, assignee_id). Integrated into `runFullProcoreSync()`.
- 2026-02-25: Added email notification system using Gmail (Replit OAuth connector). When new team members are assigned to Procore projects, sends templated email notification. Deduplication via `email_send_log.dedupe_key` prevents duplicate sends. New files: `server/gmail.ts` (Gmail client), `server/email-notifications.ts` (notification logic). DB tables: `email_templates`, `email_send_log`.
- 2026-02-25: Added Email Notifications page (`/email-notifications`) with editable templates and send history. Templates support variable substitution (`{{projectName}}`, `{{roleName}}`, etc.), enable/disable toggle, inline preview, and test email sending. Designed to be extensible for future notification types.
- 2026-02-24: Added automatic HubSpot polling (every 10 min configurable). When enabled, runs HubSpot full sync on a timer and auto-pushes new/updated companies and contacts to Procore vendor directory. Toggle + interval selector + Sync Now button in Settings (Automatic Polling card). Config stored in automation_config key="hubspot_polling". Resumes on server restart if previously enabled.
- 2026-02-24: Added HubSpot → Procore Directory Sync automation (server/hubspot-procore-sync.ts). When a new company or contact is created in HubSpot, automatically creates/updates the Procore vendor directory. Multi-criteria matching (email, domain, company name, legal/trade name, person name) with scoring to prevent duplicates. Non-destructive updates only fill empty fields. Toggle enable/disable in Settings. Manual bulk sync button for all companies/contacts. Webhook handler auto-triggers on company/contact creation/update events. State name normalization (e.g., "texas" → "TX") with automatic country_code. Procore vendor API uses user-level endpoints (/rest/v1.0/vendors?company_id=...).
- 2026-02-24: Added CompanyCam Data browser page (/companycam-data) with tabs for Projects, Users, Photos, and Change History. Full sync engine (server/companycam.ts) pulls all data via CompanyCam API with paginated fetching, change detection, and 2-week history. 4 new DB tables: companycam_projects, companycam_users, companycam_photos, companycam_change_history.
- 2026-02-24: Added BidBoard → HubSpot stage mapping feature. Configurable mapping page in Settings lets user map BidBoard statuses to HubSpot deal stages. On BidBoard CSV re-import, detects status changes and automatically pushes matching HubSpot deals to the mapped stage via API. Mapping stored in automation_config table. Toggle to enable/disable auto-sync.
- 2026-02-24: Added BidBoard CSV/XLSX import feature. New bidboard_estimates DB table stores imported data with auto-matching to Procore projects (exact and fuzzy name matching). Upload via BidBoard tab on Procore Data page. Each re-import clears and replaces previous data. 378 estimates imported, 188 matched to Procore, 190 BidBoard-only.
- 2026-02-24: Upgraded Procore project sync to use company-level endpoint (/rest/v1.0/companies/{CID}/projects) which returns 505 projects vs 273 from user-level endpoint. Detailed data enriched from user-level endpoint where available. Company-level returns simplified structure (nested address, stage_name, status_name).
- 2026-02-24: Fixed bid PATCH routes to explicitly construct upsert objects instead of using `...bid` spread (which carried DB Date objects causing `value.toISOString is not a function`).
- 2026-02-24: Added bid detail page (/procore-data/bids/:bidId) with full Procore bid data: bid_items, attachments (proxied via backend), bidder notes/comments, inclusions/exclusions, cost codes, vendor/requester details, NDA status, raw JSON. Award status dropdown (Pending/Awarded/Rejected) PATCHes Procore in real-time from both the bids list and detail page. Attachment proxy endpoint handles Procore's S3 redirect URLs.
- 2026-02-24: Added inline bid award status dropdown to Bids tab on Procore Data page. Each bid row has a select dropdown that writes back to Procore API via PATCH /rest/v1.0/projects/{PID}/bid_packages/{BPID}/bids/{BID_ID}. View Detail button navigates to dedicated bid detail page.
- 2026-02-24: Added Bid Board sync to Procore engine. Pulls bid packages (8), bids (138), and bid forms (29) via company and project-level API endpoints. Three new DB tables: procore_bid_packages, procore_bids, procore_bid_forms. Three new tabs added to Procore Data page with search, pagination, status filters, and expandable rows.
- 2026-02-24: Added Procore Data browser page (/procore-data) with tabs for Projects (505), Vendors (629), Users (496), Bid Packages (8), Bids (138), Bid Forms (29), BidBoard Estimates (378), and Change History. Full sync with 2-week version control.
- 2026-02-24: Created Procore sync engine (server/procore.ts) with OAuth token refresh, paginated API fetching, and change detection.
- 2026-02-24: Procore OAuth flow updated to read credentials from DB config instead of env vars. Opens in new tab to avoid iframe blocking.
- 2026-02-24: Added HubSpot Data browser page (/hubspot-data) with tabs for Companies, Contacts, Deals, Pipelines, and Change History. Search, pagination, expandable rows with full details.
- 2026-02-24: Added HubSpot local database mirror with version control. Full sync pulls all companies, contacts, deals, and custom deal stages/pipelines. 2-week change history tracking with automatic purge.
- 2026-02-24: HubSpot now uses Replit's built-in OAuth connector (automatic token management).
- 2026-02-24: Initial implementation of full-stack application with auth, dashboard, sync config, webhook monitor, project mapper, audit logs, and settings pages.

## Architecture
- **Backend**: Express.js with PostgreSQL (Drizzle ORM), session auth via connect-pg-simple
- **Frontend**: React + Vite with Tailwind CSS, shadcn/ui components, TanStack Query, wouter routing, Recharts
- **Auth**: Session-based with bcrypt password hashing
- **HubSpot Integration**: Replit OAuth connector (server/hubspot.ts) - auto token refresh
- **Procore Integration**: OAuth 2.0 with token refresh (server/procore.ts) - credentials stored in automation_config
- **CompanyCam Integration**: Bearer token auth (server/companycam.ts) - token stored in oauth_tokens table
- **Email Notifications**: Gmail via Replit OAuth connector (server/gmail.ts) - templated emails with deduplication
- **Database**: PostgreSQL with tables: users, sync_mappings, stage_mappings, webhook_logs, audit_logs, idempotency_keys, oauth_tokens, automation_config, contract_counters, poll_jobs, hubspot_companies, hubspot_contacts, hubspot_deals, hubspot_pipelines, hubspot_change_history, procore_projects, procore_vendors, procore_users, procore_change_history, procore_bid_packages, procore_bids, procore_bid_forms, bidboard_estimates, companycam_projects, companycam_users, companycam_photos, companycam_change_history, procore_role_assignments, email_templates, email_send_log

## Key Files
- `shared/schema.ts` - Drizzle schema and Zod validation schemas
- `server/storage.ts` - Database CRUD operations
- `server/routes.ts` - API endpoints and webhook receivers
- `server/hubspot.ts` - HubSpot sync engine
- `server/procore.ts` - Procore sync engine with OAuth token refresh
- `server/companycam.ts` - CompanyCam sync engine with paginated fetching and change detection
- `server/gmail.ts` - Gmail client using Replit OAuth connector (never cache client)
- `server/email-notifications.ts` - Email notification logic with template rendering and dedup
- `client/src/App.tsx` - Main app with auth flow and routing
- `client/src/pages/` - Dashboard, Sync Config, Webhooks, Projects, Audit Logs, Settings, HubSpot Data, Procore Data, CompanyCam Data, Email Notifications

## Webhook Endpoints
- POST `/webhooks/hubspot` - HubSpot webhook receiver
- POST `/webhooks/procore` - Procore webhook receiver
- POST `/webhooks/companycam` - CompanyCam webhook receiver

## User Preferences
- Custom Node.js/Express middleware (no third-party platforms like Make.com or n8n)
- CompanyCam deduplication is critical
- Single admin role user management
- Railway deployment target with env var secrets
- Hybrid webhook + polling approach
