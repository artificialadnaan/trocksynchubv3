// Side-effect-free home of log(): importing it never boots the Express server, its schedulers or workers
// (Codex P1 on SyncHub #114: a CLI script that needed log() through rfp-approval started the whole app).
/**
 * Centralized logging utility for the application.
 * Formats log messages with timestamp and source identifier.
 * Used throughout the codebase for consistent logging format.
 * 
 * @param message - The message to log
 * @param source - The source module (e.g., 'express', 'playwright', 'hubspot', 'procore')
 * 
 * @example
 * log("Successfully synced 10 projects", "procore");
 * // Output: "5:30:45 PM [procore] Successfully synced 10 projects"
 */
export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}
