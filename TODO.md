# TODO

## Test infrastructure debt

- `npm run check` currently fails on pre-existing TypeScript errors unrelated to
  Bid Board CRM ingestion. Observed on 2026-04-28: archive route index typing,
  project archive document field-name drift, request query string/string[] route
  typing, settings route stale sync-mapping `projectNumber` references, and
  reconciliation snapshot shape drift. Treat this as a separate cleanup track,
  not a blocker for the Bid Board ingestion pipeline.
- SyncHub `sync_mappings` table contains test-data residue from E2E test runs
  (e.g., `procore_project_number` `DFW-8-09026-ac` mapped to 9 distinct HubSpot
  deals across test/clone records). This contributes to the contested-mapping
  count that the bid-board-bootstrap script must skip. Cleanup pass should
  identify and remove or archive test rows so `sync_mappings` reflects
  production data only. Surfaced 2026-04-28 during bid-board bootstrap design.
