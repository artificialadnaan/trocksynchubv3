# CI runner setup (owner)

`.github/workflows/ci.yml` runs the type check (`npm run check`) and the vitest suite on every PR and on every push
to `main`. It asks for a **self-hosted** runner labelled `self-hosted, linux, x64`, because GitHub's hosted runners
are blocked for this account. No runner is registered for this repo yet, so until one is, CI jobs wait in
**Queued** and never run. That doesn't affect deploys: Railway deploys `main` on its own.

Registering a runner mints a registration token with repo-admin rights and puts a long-lived agent on a server.
That's an owner action, so no lane has done it.

## Steps

1. **Pick a host.** The runner image `trock-actions-runner:latest` is already on the rented CI servers.
   - `trock-ci` has 8 CPUs, and its 4 runners (2 CRM, 2 Core) already use 2 CPUs each. A fifth runner there would
     share CPUs with them.
   - `trock-ci-2` and `trock-ci-3` also run the lanes' remote test jobs.
   - One runner is enough: this repo's suite takes about 2 minutes.
2. **Start the runner** from the Mac, where `gh` is logged in as `artificialadnaan`:
   ```sh
   # 2 CPUs and 6 GB, like the CRM and Core server runners. Choose a cpuset that's free on that host.
   RUNNER_HOST=trock-ci-2 ~/Developer/trock-ci-runners/server-runner.sh trocksynchubv3 1 <cpuset> 6g
   ```
   The script mints the one-hour token with `gh` and sends it over SSH on stdin, so the token never appears on a
   command line. The container restarts on its own (`--restart unless-stopped`).
3. **Check that it registered:**
   ```sh
   gh api repos/artificialadnaan/trocksynchubv3/actions/runners --jq '.runners[] | [.name, .status] | @tsv'
   ```
   You should see `trock-trocksynchubv3-srv-1  online`.
4. **Run CI on an open PR:** push to the PR, or re-run its queued CI run from the Actions tab.
5. **Optional:** make **CI / typecheck-and-test** a required check on `main` (Settings → Branches). Do this only after
   it has passed once.

## Trust model

The runner is long-lived and the image allows `sudo`, so whatever it runs can change the host. That's why the
workflow runs only for pushes to `main` and for PRs whose branch lives in this repo (people with write access).
A PR from a fork is skipped. This matches the CRM, Core and Expense runners. For stronger isolation, start the
runner as an ephemeral one (`--ephemeral`, re-registered after every job) on a host that runs nothing else.

## What the job needs

- Node 20 (installed by `actions/setup-node`) and `npm ci`.
- Chromium for `tests/bidboard-notes-dom.test.ts`, which drives a real DOM and refuses to skip without a browser.
  `npx playwright install --with-deps chromium` installs it. It runs `apt` through `sudo`, which the runner image
  allows.
- **No secrets and no database.** Tests mock `server/db.ts`, storage and every external API. `DATABASE_URL` is set
  only to satisfy `db.ts`'s import-time check, and it points at a closed local port.

## Removing it

```sh
ssh trock-ci-2 docker rm -f trock-trocksynchubv3-srv-1
gh api -X DELETE repos/artificialadnaan/trocksynchubv3/actions/runners/<id>
```
