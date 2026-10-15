// The bidboard_stage_sync_runs status mapping, in its own dependency-free module so the route modules (and their
// tests, which mock ../sync wholesale) always get the real one.
export interface StageSyncRunOutcome {
  failed: number;
  changed: number;
  initialized?: boolean;
  exportOnly?: boolean;
}

/**
 * The bidboard_stage_sync_runs status for a finished run: the ONE mapping every recording path uses.
 * "export_only" is never a baseline status (hasSuccessfulBidboardStageSyncRun counts only success/initialized),
 * so a later real run still initialises its baseline instead of pushing every stale difference (Codex P1 on #112).
 */
export function stageSyncRunStatus(result: StageSyncRunOutcome, dryRun: boolean): string {
  if (result.exportOnly) return "export_only";
  if (result.initialized) return "initialized";
  if (dryRun) return "dry_run";
  if (result.failed > 0) return result.changed > 0 ? "partial" : "failed";
  return "success";
}
