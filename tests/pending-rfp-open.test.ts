import { describe, expect, it } from "vitest";
import { classifyPendingRfp, parseRfpCleanupIds, rfpCleanupBlock, selectOpenPendingRfps } from "../server/pendingRfpOpen.ts";

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

describe("the older boundary matches the digest's (CodeRabbit on #114)", () => {
  it("30 days and one hour is OLDER with a 30-day window (elapsed time, not truncated days)", () => {
    const created = new Date(NOW.getTime() - (30 * 86_400_000 + 3_600_000)).toISOString();
    expect(classifyPendingRfp(req(5, created), { eligible: true }, NOW, 30).group).toBe("older");
  });
});

describe("selectOpenPendingRfps skips EXPIRED rows before any source check (Codex P2 on #114)", () => {
  it("an expired request is never checked against the CRM or HubSpot", async () => {
    const seen: number[] = [];
    const rows = [req(1, "2026-10-10T00:00:00Z"), req(2, "2026-10-11T00:00:00Z")];
    const kept = await selectOpenPendingRfps(
      rows,
      async (r) => { seen.push(r.id); return { eligible: true }; },
      (r) => r.id === 1,
    );
    expect(seen).toEqual([2]);
    expect(kept.map((r) => r.id)).toEqual([2]);
  });
});

describe("parseRfpCleanupIds: all or nothing (CodeRabbit on #114)", () => {
  it("accepts a clean, distinct list", () => {
    expect(parseRfpCleanupIds(["--apply", "--ids=12,40"])).toEqual({ ok: true, ids: [12, 40] });
  });
  it.each([["--ids=12,invalid"], ["--ids="], ["--ids=12,12"], ["--ids=12,,40"], ["--ids=0"]])("rejects %s entirely, never a partial list", (arg) => {
    expect(parseRfpCleanupIds(["--apply", arg]).ok).toBe(false);
  });
  it("--apply without --ids is an error", () => {
    expect(parseRfpCleanupIds(["--apply"]).ok).toBe(false);
  });
});

describe("an UNRESOLVED HubSpot stage keeps the row (Codex round 4 on #114)", () => {
  it("selectOpenPendingRfps keeps a row whose stage could not be resolved", async () => {
    const kept = await selectOpenPendingRfps([{ id: 1 }], async () => ({ eligible: false, stageUnresolved: true, reason: "x" }));
    expect(kept).toEqual([{ id: 1 }]);
  });
  it("classifyPendingRfp files it as open (never offered for cleanup)", () => {
    const c = classifyPendingRfp({ createdAt: new Date() }, { eligible: false, stageUnresolved: true, reason: "x" }, new Date(), 30);
    expect(c.open).toBe(true);
    expect(c.group).toBe("open");
    expect(c.reason).toMatch(/unresolved/i);
  });
});

describe("rfpCleanupBlock: never cancel a request an approver already started (Codex round 4 on #114)", () => {
  it("no approval attempt -> not blocked", () => {
    expect(rfpCleanupBlock(0)).toBeNull();
  });
  it("any approval attempt -> blocked, left for a human", () => {
    expect(rfpCleanupBlock(1)).toMatch(/approval/i);
  });
});
