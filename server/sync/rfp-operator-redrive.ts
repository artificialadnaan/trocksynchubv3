/**
 * RFP Phase 2: the operator re-drive marker on an rfp_core_create_outbox row (REDRIVE-DESIGN.r2 001ab3ba + d9's S1b r2 / r3
 * rulings): payload.operatorRedrive = { reason: "operator_redrive", go, office, approvalKind, approval? }, written ONLY by
 * scripts/rfp-redrive-to-core.ts. A row is a re-drive row iff `go` is a non-empty string. Read by the S1 sender (the
 * Procore-footprint skip; office / approvalKind for an E1 that lacks them), the follow-ups (N1's office) and S0's
 * handleReattempt (a CRM re-post of a re-driven approval is a no-op replay). No imports: S0 loads it.
 */
export interface OperatorRedrive {
  reason: string;
  go: string;
  /** dallas | atlanta, attested by the GO when the stored E1 has none (d9 Q1). */
  office: string | null;
  /** "vote", attested by the GO when the stored E1 has none (d9 Q1). */
  approvalKind: string | null;
  /** The vote evidence attested by the GO when the stored E1 has no approval block (d9 ruling A, S1b r3); else null. */
  approval: OperatorRedriveApproval | null;
}

/** The attested evidence: E2's approval block + `source` ("<path> <sha256>", recorded only, never sent to Core). */
export interface OperatorRedriveApproval {
  roundEventId: string;
  approvals: number;
  rejections: number;
  invitedVoterCount: number;
  decidedAt: string;
  source: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export function operatorRedriveOf(payload: unknown): OperatorRedrive | null {
  if (!isObject(payload)) return null;
  const r = payload.operatorRedrive;
  if (!isObject(r) || typeof r.go !== "string" || r.go.trim() === "") return null;
  return {
    reason: typeof r.reason === "string" ? r.reason : "",
    go: r.go,
    office: typeof r.office === "string" && r.office.trim() !== "" ? r.office.trim() : null,
    approvalKind: typeof r.approvalKind === "string" && r.approvalKind.trim() !== "" ? r.approvalKind.trim() : null,
    approval: approvalOf(r.approval),
  };
}

function approvalOf(v: unknown): OperatorRedriveApproval | null {
  if (!isObject(v)) return null;
  const { roundEventId, approvals, rejections, invitedVoterCount, decidedAt, source } = v;
  if (typeof roundEventId !== "string" || roundEventId.trim() === "") return null;
  if (![approvals, rejections, invitedVoterCount].every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) return null;
  if (typeof decidedAt !== "string" || typeof source !== "string") return null;
  return {
    roundEventId, approvals: approvals as number, rejections: rejections as number,
    invitedVoterCount: invitedVoterCount as number, decidedAt, source,
  };
}

/** A one-deal operator re-drive row: a non-empty string at payload.operatorRedrive.go. */
export function isOperatorRedrive(payload: unknown): boolean {
  return operatorRedriveOf(payload) !== null;
}

export function operatorRedrivePayload(input: { go: string; office: string; approvalKind: string; approval?: OperatorRedriveApproval | null }) {
  return {
    operatorRedrive: {
      reason: "operator_redrive", go: input.go, office: input.office, approvalKind: input.approvalKind,
      ...(input.approval ? { approval: input.approval } : {}),
    },
  };
}
