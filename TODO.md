# TODO

## Test infrastructure debt

- `npm run check` currently fails on pre-existing TypeScript errors unrelated to
  Bid Board CRM ingestion. Observed on 2026-04-28: archive route index typing,
  project archive document field-name drift, request query string/string[] route
  typing, settings route stale sync-mapping `projectNumber` references, and
  reconciliation snapshot shape drift. Treat this as a separate cleanup track,
  not a blocker for the Bid Board ingestion pipeline.
