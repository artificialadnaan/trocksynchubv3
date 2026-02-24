# Trock Sync Hub 2.0

## Overview
Production-grade middleware application for bidirectional synchronization between HubSpot CRM, Procore construction management, and CompanyCam. Built with Node.js/Express backend and React frontend.

## Recent Changes
- 2026-02-24: Added Bid Board sync to Procore engine. Pulls bid packages (8), bids (138), and bid forms (29) via company and project-level API endpoints. Three new DB tables: procore_bid_packages, procore_bids, procore_bid_forms. Three new tabs added to Procore Data page with search, pagination, status filters, and expandable rows.
- 2026-02-24: Added Procore Data browser page (/procore-data) with tabs for Projects (273), Vendors (629), Users (495), Bid Packages (8), Bids (138), Bid Forms (29), and Change History. Full sync with 2-week version control.
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
- **Database**: PostgreSQL with tables: users, sync_mappings, stage_mappings, webhook_logs, audit_logs, idempotency_keys, oauth_tokens, automation_config, contract_counters, poll_jobs, hubspot_companies, hubspot_contacts, hubspot_deals, hubspot_pipelines, hubspot_change_history, procore_projects, procore_vendors, procore_users, procore_change_history, procore_bid_packages, procore_bids, procore_bid_forms

## Key Files
- `shared/schema.ts` - Drizzle schema and Zod validation schemas
- `server/storage.ts` - Database CRUD operations
- `server/routes.ts` - API endpoints and webhook receivers
- `server/hubspot.ts` - HubSpot sync engine
- `server/procore.ts` - Procore sync engine with OAuth token refresh
- `client/src/App.tsx` - Main app with auth flow and routing
- `client/src/pages/` - Dashboard, Sync Config, Webhooks, Projects, Audit Logs, Settings, HubSpot Data, Procore Data

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
