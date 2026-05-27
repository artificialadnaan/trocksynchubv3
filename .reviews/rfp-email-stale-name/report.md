# RFP Post-Approval Status Email Stale Name Fix

Date: 2026-05-27

Branch: `fix/rfp-email-stale-name`

## Summary

Fixed the SyncHub RFP post-approval status email so it reads the edited deal name first and falls back to the stored request deal name only when the edited name is unset/blank.

Production code changed:

- `server/rfp-approval.ts:1449`
- `server/rfp-approval.ts:1523`

Both status-email call sites now use:

```ts
(editedFields.dealname && String(editedFields.dealname).trim()) || dealData.dealname || 'Unknown Deal'
```

No other production code paths were modified. No email templates, project-creation code, schema, API surface, migrations, or data writes were changed.

## Tests

Added focused coverage in `tests/rfp-source-eligibility.test.ts`:

- Edited `dealname` is used in the post-approval status email subject/body.
- Missing `editedFields.dealname` falls back to `dealData.dealname`.
- Null `editedFields.dealname` falls back to `dealData.dealname`.

Commands run:

```sh
npx vitest run tests/rfp-source-eligibility.test.ts --testTimeout=15000
```

Result: passed, 13 tests.

```sh
npx vitest run tests/rfp-*.test.ts tests/bidboard-callback-outbox.test.ts --testTimeout=15000
```

Result: 9 test files passed, 1 failed; 93 tests passed, 1 failed.

The failing test is `tests/rfp-approval-processing.test.ts > processRfpApproval > creates the BidBoard project without taking an extra browser lock`. It expects the older three-argument `createBidBoardProjectFromDeal` call shape, while current `origin/main` code calls `createBidBoardProjectFromDeal` with the object-shaped input. I left that unrelated stale expectation unchanged to keep this PR minimal.

`git diff --check` passed.

## Review Rounds

Round 1 subagent review:

- Confirmed the production diff is limited to the two intended `dealName` values.
- Confirmed no project creation or other email paths changed.
- Confirmed tests cover edited-name and unset/null fallback.
- No changes requested.

Round 2 subagent review:

- Checked fallback edge cases: edited value, blank/whitespace, null/undefined, and stored-name fallback.
- Confirmed tests are meaningful and scoped.
- Confirmed no templates, project-creation path, or unrelated code changed.
- No changes requested.

