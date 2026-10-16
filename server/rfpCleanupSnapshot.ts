import { randomUUID } from "crypto";
import { writeFileSync } from "fs";
import { join } from "path";

/**
 * Writes the stale-pending preview snapshot (customer names and ids) readable by its owner only (0600) under a random
 * name, with an EXCLUSIVE create: a pre-existing file or symlink at that path is refused, never followed or
 * overwritten (Codex P2 on SyncHub #114). Returns the path.
 */
export function writeRfpCleanupSnapshot(dir: string, data: unknown, randomName: () => string = randomUUID): string {
  const file = join(dir, `rfp-stale-pending-preview-${randomName()}.json`);
  writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600, flag: "wx" });
  return file;
}
