# Trock Sync Hub 2.0

## Overview
Production-grade middleware application for bidirectional synchronization between HubSpot CRM, Procore construction management, and CompanyCam. Built with Node.js/Express backend and React frontend.

## Recent Changes
- 2026-02-24: Added HubSpot local database mirror with version control. Full sync pulls all companies, contacts, deals, and custom deal stages/pipelines. 2-week change history tracking with automatic purge.
- 2026-02-24: HubSpot now uses Replit's built-in OAuth connector (automatic token management).
- 2026-02-24: Initial implementation of full-stack application with auth, dashboard, sync config, webhook monitor, project mapper, audit logs, and settings pages.

## Architecture
- **Backend**: Express.js with PostgreSQL (Drizzle ORM), session auth via connect-pg-simple
- **Frontend**: React + Vite with Tailwind CSS, shadcn/ui components, TanStack Query, wouter routing, Recharts
- **Auth**: Session-based with bcrypt password hashing
- **HubSpot Integration**: Replit OAuth connector (server/hubspot.ts) - auto token refresh
- **Database**: PostgreSQL with tables: users, sync_mappings, stage_mappings, webhook_logs, audit_logs, idempotency_keys, oauth_tokens, automation_config, contract_counters, poll_jobs, hubspot_companies, hubspot_contacts, hubspot_deals, hubspot_pipelines, hubspot_change_history

## Key Files
- `shared/schema.ts` - Drizzle schema and Zod validation schemas
- `server/storage.ts` - Database CRUD operations
- `server/routes.ts` - API endpoints and webhook receivers
- `client/src/App.tsx` - Main app with auth flow and routing
- `client/src/pages/` - Dashboard, Sync Config, Webhooks, Projects, Audit Logs, Settings

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
