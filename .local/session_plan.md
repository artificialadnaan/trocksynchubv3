# Objective
Fix deployment so the app loads properly at the deployment URL instead of showing the default "Your Repl has been deployed!" page. The issue is that `.replit` deployment config has `ignorePorts = true` which prevents traffic from routing to the Express server.

# Tasks

### T001: Fix deployment configuration
- **Blocked By**: []
- **Details**:
  - Remove `ignorePorts = true` and `publicDir = "dist/public"` from the `[deployment]` section of `.replit`
  - Keep `deploymentTarget = "gce"`, `run`, and `build` as-is
  - The Express server serves both API and static frontend (via `server/static.ts` in production mode) — it doesn't need a separate `publicDir`
  - Files: `.replit`
  - Acceptance: After redeployment, the deployment URL shows the login page
