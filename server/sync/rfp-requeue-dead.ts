/**
 * RFP Phase 2, S1b: the Requeue CLI (CONTRACT v2.4 §10). S1b RED: exported no-op stubs only (the names and signatures);
 * nothing is read or written. GREEN implements them.
 */
export interface RfpCliCheck {
  key: string;
  ok: boolean;
  detail: string;
}

export interface RfpCliResult {
  code: 0 | 1 | 2;
  applied: boolean;
  refused?: string;
  checks: RfpCliCheck[];
  rowId?: number;
}

export interface RfpCliDeps {
  db?: { execute: (q: any) => Promise<any>; transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T> };
  out?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  actor?: string;
}

export async function runRequeueDead(_argv: string[], _deps: RfpCliDeps = {}): Promise<RfpCliResult> {
  return { code: 0, applied: false, checks: [] };
}
