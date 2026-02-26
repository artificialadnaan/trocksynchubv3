# Trock Sync Hub 2.0

## Overview
Trock Sync Hub 2.0 is a production-grade middleware application designed for bidirectional synchronization between HubSpot CRM, Procore construction management, and CompanyCam. It aims to streamline operations by connecting these critical business platforms, automating data flow, and providing a unified view of information across systems. The project enhances data consistency, reduces manual effort, and improves decision-making by ensuring that key business data is always up-to-date across all integrated platforms.

## User Preferences
- Custom Node.js/Express middleware (no third-party platforms like Make.com or n8n)
- CompanyCam deduplication is critical
- Single admin role user management
- Railway deployment target with env var secrets
- Hybrid webhook + polling approach

## System Architecture
The application features a Node.js/Express backend and a React frontend. The UI is built with Tailwind CSS, `shadcn/ui` components, TanStack Query, wouter for routing, and Recharts for data visualization. Authentication is session-based with bcrypt for password hashing.

**Key Integrations & Features:**
- **HubSpot Integration:** Supports dual-mode authentication via Replit OAuth connector or environment variables. It mirrors HubSpot data (companies, contacts, deals, pipelines) to a local PostgreSQL database with 2-week change history tracking and automated purging. Includes HubSpot to Procore vendor directory sync and automatic deal project number assignment, replacing external Zapier integrations.
- **Procore Integration:** Utilizes OAuth 2.0 with token refresh, storing credentials in the `automation_config` table. It includes comprehensive data browsing for projects, vendors, users, bid packages, bids, bid forms, and bid board estimates, all mirrored locally with change detection. Features Procore to HubSpot project sync with conflict detection and automated role assignment polling and notifications.
- **CompanyCam Integration:** Uses bearer token authentication, with tokens stored in `oauth_tokens` or environment variables. It provides a data browser for projects, users, photos, and change history, with full sync and 2-week history.
- **Email Notifications:** Implemented using Gmail, supporting templated emails with variable substitution and deduplication, accessible via a dedicated page for template management and send history.
- **BidBoard Integration:** Facilitates CSV/XLSX import of BidBoard estimates, matching them to Procore projects and automatically mapping BidBoard statuses to HubSpot deal stages.
- **Data Browser:** A unified interface `/data-browser` allows users to explore data from HubSpot, Procore, and CompanyCam, with cross-linking functionality between related records (e.g., Procore projects to HubSpot deals).
- **Automation & Polling:** Configurable polling mechanisms for HubSpot and Procore (e.g., role assignments) ensure data freshness and trigger automated workflows.
- **Webhook Handlers:** Dedicated endpoints for HubSpot, Procore, and CompanyCam webhooks to enable real-time data synchronization and trigger automations.

**Database Schema Highlights:**
The PostgreSQL database (managed with Drizzle ORM) includes tables for:
- `users`, `sync_mappings`, `stage_mappings`, `webhook_logs`, `audit_logs`, `idempotency_keys`, `oauth_tokens`, `automation_config`, `contract_counters`, `poll_jobs`.
- Dedicated tables for mirrored data: `hubspot_companies`, `hubspot_contacts`, `hubspot_deals`, `hubspot_pipelines`, `hubspot_change_history`.
- `procore_projects`, `procore_vendors`, `procore_users`, `procore_change_history`, `procore_bid_packages`, `procore_bids`, `procore_bid_forms`, `procore_role_assignments`.
- `bidboard_estimates`.
- `companycam_projects`, `companycam_users`, `companycam_photos`, `companycam_change_history`.
- `email_templates`, `email_send_log`, `project_number_registry`.

## External Dependencies
- **HubSpot API:** For CRM data synchronization.
- **Procore API:** For construction management data synchronization.
- **CompanyCam API:** For project photos and related data synchronization.
- **Gmail API:** For sending email notifications.
- **PostgreSQL:** Primary database for all application data and session storage.