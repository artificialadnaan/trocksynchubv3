import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// trock.integration-health.snapshot.v1 (integration-health S2): the cross-repo file of record and SyncHub's zod mirror of it.
// server/health/snapshot.v1.schema.json is the same bytes T-Rock Core and the CRM carry (sha pinned here, CONTRACT
// ADDENDUM-1); the golden fixtures are byte copies of Core S1's, the cases every producer's validator must agree on.

const { snapshotSchema, validateSnapshot, safeMessage, SNAPSHOT_SCHEMA_SHA256, SNAPSHOT_SCHEMA_R2_SHA256 } = await import(
  "../server/health/snapshot-contract.ts"
);

const read = (name: string) => readFileSync(new URL(`../server/health/${name}`, import.meta.url));
const valid = JSON.parse(read("__fixtures__/snapshot.v1.valid.json").toString("utf8")) as unknown;
const invalid = JSON.parse(read("__fixtures__/snapshot.v1.invalid.json").toString("utf8")) as Array<{ name: string; why: string; doc: unknown }>;

describe("snapshot.v1 file of record", () => {
  it("is byte-identical to the sealed contract schema (sha 53639e8d…)", () => {
    expect(SNAPSHOT_SCHEMA_SHA256).toBe("53639e8d33f3cdc80ceb0808e154928ed709044aff27bca24dd4bc581d3311b5");
    expect(createHash("sha256").update(read("snapshot.v1.schema.json")).digest("hex")).toBe(SNAPSHOT_SCHEMA_SHA256);
  });
});

describe("snapshot.v1 r2 (ADDENDUM-5: r1 + an optional per-connection failed_ids)", () => {
  it("r2 is byte-identical to the sealed file of record (sha cbad85ca…); r1 stays pinned above", () => {
    expect(SNAPSHOT_SCHEMA_R2_SHA256).toBe("cbad85ca3d669a410ff626a5bd0cfe4da05b59e085cdb0f00c8a712e4f5be869");
    expect(createHash("sha256").update(read("snapshot.v1.r2.schema.json")).digest("hex")).toBe(SNAPSHOT_SCHEMA_R2_SHA256);
  });

  it("the mirror (r2) accepts failed_ids of stable ids, and refuses more than 1000 or a malformed id", () => {
    const withIds = (ids: unknown) => {
      const doc = structuredClone(valid) as { connections: Array<Record<string, unknown>> };
      doc.connections[0]!.failed_ids = ids;
      return doc;
    };
    expect(validateSnapshot(withIds(["941", "dallas:1", "evt-41"])).ok).toBe(true);
    expect(validateSnapshot(withIds(Array.from({ length: 1001 }, (_, i) => String(i)))).ok).toBe(false);
    expect(validateSnapshot(withIds(["has space"])).ok).toBe(false);
    expect(validateSnapshot(withIds(["x".repeat(81)])).ok).toBe(false);
  });
});

describe("SyncHub's zod mirror agrees with Core's golden fixtures", () => {
  it("accepts the valid snapshot", () => {
    const r = snapshotSchema.safeParse(valid);
    expect(r.success ? [] : r.error.issues).toEqual([]);
    expect(validateSnapshot(valid).ok).toBe(true);
  });

  it("carries the 14 invalid cases", () => {
    expect(invalid.map((c) => c.name)).toHaveLength(14);
  });

  it.each(invalid.map((c) => [c.name, c] as const))("refuses %s", (_name, c) => {
    expect(snapshotSchema.safeParse(c.doc).success, c.why).toBe(false);
  });

  it("refuses a connection key from another system (the rule the JSON schema can't express)", () => {
    const doc = structuredClone(valid) as { connections: Array<{ key: string }> };
    doc.connections[0]!.key = "crm.mail.outlook";
    const r = validateSnapshot(doc);
    expect(r.ok ? [] : r.errors).toEqual(["connections.0.key: not a synchub key"]);
  });
});

describe("safeMessage input cap", () => {
  it("cuts the raw input to SAFE_MESSAGE_INPUT_MAX = 2000 before any pass (the key rule is quadratic on long runs)", async () => {
    const contract = await import("../server/health/snapshot-contract.ts");
    expect((contract as Record<string, unknown>).SAFE_MESSAGE_INPUT_MAX).toBe(2000);
  });
});

describe("safeMessage", () => {
  it("cuts email addresses, bearer credentials, JWT-shaped tokens, credential fields and URL queries", () => {
    expect(safeMessage("HTTP 409 test_data for someone@example.test")).toBe("HTTP 409 test_data for [email]");
    expect(safeMessage("auth Bearer abc.def.ghi rejected")).toBe("auth [credential] rejected");
    expect(safeMessage("got eyJhbGciOiJIUzI1NiJ9.e30.sig back")).toBe("got [token] back");
    expect(safeMessage("refresh failed token=abc123 retry")).toBe("refresh failed [redacted] retry");
    expect(safeMessage("POST https://crm.example.test/api/x?sig=abc failed")).toBe("POST https://crm.example.test/api/x failed");
  });

  it.each(["access_token", "refresh_token", "password", "client_secret"])(
    "a JSON %s key loses its whole VALUE, not just its name (PR #139 review)",
    (key) => {
      const out = safeMessage(`refresh failed: {"${key}":"opaque-value-${key}","x":1}`);
      expect(out ?? "").not.toContain(`opaque-value-${key}`);
    },
  );

  it("a quoted value with an escaped quote inside, and an unquoted numeric value, are cut whole", () => {
    expect(safeMessage('{"password":"pa\\"ss-tail-value"}') ?? "").not.toContain("ss-tail-value");
    expect(safeMessage('{"api_key": 123456789, "ok": true}') ?? "").not.toContain("123456789");
    expect(safeMessage('{"Authorization":"Basic c2VjcmV0LXZhbHVl"}') ?? "").not.toContain("c2VjcmV0LXZhbHVl");
  });

  it("reads an escaped-JSON value in whole escape pairs, and drops a value nested deeper than it can read (CodeRabbit)", () => {
    // A double-stringified body: the quote escaped one level deeper must not end the value and leave its tail.
    expect(safeMessage(JSON.stringify(JSON.stringify({ password: 'prefix"val-nested' })))).toBe('"{\\"password\\": [redacted]}"');
    expect(safeMessage(JSON.stringify(JSON.stringify({ password: "val-bs\\", next: "ok" })))).toBe(
      '"{\\"password\\": [redacted],\\"next\\":\\"ok\\"}"',
    );
    // Three levels: the passes cannot find the value's end, so the message is dropped; the error code still carries the signal.
    expect(safeMessage(JSON.stringify(JSON.stringify(JSON.stringify({ password: 'p"val-deep' }))))).toBeNull();
    // ...also when the key is the renamed token one ([credential field]), which the leftover check reads too (trockcrm-28).
    expect(safeMessage(JSON.stringify(JSON.stringify(JSON.stringify({ refresh_token: 'p"val-tok' }))))).toBeNull();
  });

  it("keeps plain error text, caps at 200 characters, and maps nothing to null", () => {
    expect(safeMessage("AADSTS7000222: client secret expired")).toBe("AADSTS7000222: client secret expired");
    expect(safeMessage("x".repeat(300))).toHaveLength(200);
    expect(safeMessage(null)).toBeNull();
    expect(safeMessage("   ")).toBeNull();
  });
});

describe("safeMessage: the credential list Core and the CRM share (any case, any suffix, key=value and key: value)", () => {
  it.each([
    ["auth=auth-value-01 retry", "auth-value-01"],
    ["credentials: cred-value-02", "cred-value-02"],
    ["credential: cred-value-03", "cred-value-03"],
    ["creds=creds-value-04", "creds-value-04"],
    ["pass=pass-value-05", "pass-value-05"],
    ["pw=pw-value-06", "pw-value-06"],
    ["passphrase=pp-value-07", "pp-value-07"],
    ["session_id=sess-value-08", "sess-value-08"],
    ["otp: 123456", "123456"],
    ["pin=4321", "4321"],
    ["jwt: abc.def.ghi", "abc.def.ghi"],
    ["X-Api-Key: xak-value-12", "xak-value-12"],
    ["api_key_2=ak2-value-13", "ak2-value-13"],
    ["password: tail one two", "one two"],
    ["Authorization: Token short1", "short1"],
    ["Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
    ['{\\"session\\":\\"esc-json-value-17\\"}', "esc-json-value-17"],
    // The word anywhere in the key (prefix segments ending in _ or -), and signature / sig / private key.
    ["db_password=dbpw-value-18 retry", "dbpw-value-18"],
    ["x-auth-token: xat-value-19", "xat-value-19"],
    ["my_api_key=myak-value-20", "myak-value-20"],
    ["signature=sigval-value-21", "sigval-value-21"],
    ["private_key=pk-value-22", "pk-value-22"],
    ['{"my_access_token":"mat-value-23"}', "mat-value-23"],
  ])("%s loses its value", (raw, value) => {
    expect(safeMessage(raw) ?? "").not.toContain(value);
  });

  it("a key kept around its cut value never trips the guard (the message survives)", () => {
    expect(safeMessage('refresh failed: {"my_access_token":"mat-value-24"}')).toBe('refresh failed: {"my_[credential field]": [redacted]}');
  });

  it("key=value cuts ONE bare token: the words after it stay", () => {
    expect(safeMessage("refresh failed token=abc123 retry")).toBe("refresh failed [redacted] retry");
    expect(safeMessage("token=abc retry")).toBe("[redacted] retry");
  });

  it("plain text that merely names a credential is left alone", () => {
    expect(safeMessage("client secret expired")).toBe("client secret expired");
    expect(safeMessage("AADSTS7000222: client secret expired")).toBe("AADSTS7000222: client secret expired");
    expect(safeMessage("Token has been expired or revoked.")).toBe("Token has been expired or revoked.");
    expect(safeMessage("spin=3 retries")).toBe("spin=3 retries");
    expect(safeMessage("design=v2 retries")).toBe("design=v2 retries");
  });
});
