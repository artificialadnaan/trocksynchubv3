/**
 * SyncHub → CRM request signing, v2 (SIGNING-HARDENING r1 4c5bb802): the ONE shared signer every SyncHub → CRM request
 * will use. RED: exported no-op stubs only (names, types and constants); nothing signs or refuses yet. GREEN implements
 * them and routes every signer through them.
 */
export const CRM_SIGNATURE_VERSION = "2";
export const CRM_SIGNATURE_VERSION_HEADER = "x-signature-version";
export const CRM_SIGNATURE_TIMESTAMP_HEADER = "x-signature-timestamp";
export const MIN_CRM_SECRET_BYTES = 32;

export interface CrmV2SignInput {
  method: string;
  path: string;
  timestamp: number;
  rawBody: string;
}

export function crmV2SignedString(_input: CrmV2SignInput): string {
  return "";
}

export function signCrmV2(_input: CrmV2SignInput & { secret: string }): string {
  return "";
}

export function crmSecretUsable(_secret: string | null | undefined): _secret is string {
  return false;
}

export function crmUrlAllowed(_url: string | null | undefined): boolean {
  return false;
}

export type CrmSignRefusal = { reason: "secret_short" | "url_refused"; detail: string };

export function crmSigningRefusal(_input: { secret: string | null | undefined; url: string | null | undefined }): CrmSignRefusal | null {
  return null;
}

export type CrmV2Headers = { ok: true; headers: Record<string, string> } | ({ ok: false } & CrmSignRefusal);

export function crmV2Headers(_input: {
  url: string;
  rawBody: string;
  secret: string | null | undefined;
  signatureHeader: string;
  method?: string;
  now?: Date;
}): CrmV2Headers {
  return { ok: false, reason: "not_implemented", detail: "S1 signing v2 RED stub" } as any;
}

export function resetCrmSigningRefusalsForTests(): void {}

export function clearCrmSigningRefusal(_signer: string): void {}

export async function alertCrmSigningRefused(_signer: string, _refusal: CrmSignRefusal): Promise<void> {}
