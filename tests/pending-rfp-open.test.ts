import { describe, expect, it } from "vitest";
import { classifyPendingRfp, selectOpenPendingRfps } from "../server/pendingRfpOpen.ts";

// THE OWNER (10-15, via 68): SyncHub's daily digest emailed every 'pending' rfp_approval_requests row forever. 107 were
// pending; about three quarters were already won, lost, inactive or no longer an RFP in the CRM. "Open" is the SAME rule
// the approve gate uses (checkRfpApprovalSourceEligibility): the source deal still exists and is still RFP-eligible. A
// failed check is fail-OPEN (kept), exactly as at approve time: a digest that shows one too many beats hiding one.
const NOW = new Date("2026-10-15T22:00:00Z");
const req = (id: number, createdAt: string, name = "Job") => ({ id, createdAt: new Date(createdAt), dealData: { dealname: name } });

describe("classifyPendingRfp", () => {
  it("a source deal no longer eligible is NOT open, with the gate's own reason", () => {
    expect(classifyPendingRfp(req(1, "2026-10-10T00:00:00Z"), { eligible: false, reason: "Source CRM deal is no longer in Opportunity stage (current stage: Won)" }, NOW, 30)).toEqual({
      open: false,
      group: "source_ineligible",
      reason: "Source CRM deal is no longer in Opportunity stage (current stage: Won)",
      ageDays: 5,
    });
  });
  it("an eligible RFP older than N days is open but OLDER; a current one is plain open", () => {
    expect(classifyPendingRfp(req(2, "2026-03-04T00:00:00Z"), { eligible: true }, NOW, 30)).toMatchObject({ open: true, group: "older" });
    expect(classifyPendingRfp(req(3, "2026-10-14T00:00:00Z"), { eligible: true }, NOW, 30)).toMatchObject({ open: true, group: "open" });
  });
  it("a FAILED check is fail-open (kept), and says so", () => {
    expect(classifyPendingRfp(req(4, "2026-10-14T00:00:00Z"), { eligible: true, checkFailed: true }, NOW, 30)).toMatchObject({
      open: true,
      group: "open",
      reason: "eligibility check failed (kept, fail-open)",
    });
  });
});

describe("selectOpenPendingRfps", () => {
  it("keeps only the rows the eligibility check calls open, checking each once", async () => {
    const seen: number[] = [];
    const rows = [req(1, "2026-10-10T00:00:00Z"), req(2, "2026-10-11T00:00:00Z"), req(3, "2026-10-12T00:00:00Z")];
    const kept = await selectOpenPendingRfps(rows, async (r) => {
      seen.push(r.id);
      return r.id === 2 ? { eligible: false, reason: "Source CRM deal no longer exists" } : { eligible: true };
    });
    expect(kept.map((r) => r.id)).toEqual([1, 3]);
    expect(seen).toEqual([1, 2, 3]);
  });
});
