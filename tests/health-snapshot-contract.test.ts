import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// trock.integration-health.snapshot.v1 (integration-health S2): the cross-repo file of record and SyncHub's zod mirror of it.
// server/health/snapshot.v1.schema.json is the same bytes T-Rock Core and the CRM carry (sha pinned here, CONTRACT
// ADDENDUM-1); the golden fixtures are byte copies of Core S1's, the cases every producer's validator must agree on.

const { snapshotSchema, validateSnapshot, safeMessage, SNAPSHOT_SCHEMA_SHA256 } = await import("../server/health/snapshot-contract.ts");

const read = (name: string) => readFileSync(new URL(`../server/health/${name}`, import.meta.url));
const valid = JSON.parse(read("__fixtures__/snapshot.v1.valid.json").toString("utf8")) as unknown;
const invalid = JSON.parse(read("__fixtures__/snapshot.v1.invalid.json").toString("utf8")) as Array<{ name: string; why: string; doc: unknown }>;

describe("snapshot.v1 file of record", () => {
  it("is byte-identical to the sealed contract schema (sha 53639e8d…)", () => {
    expect(SNAPSHOT_SCHEMA_SHA256).toBe("53639e8d33f3cdc80ceb0808e154928ed709044aff27bca24dd4bc581d3311b5");
    expect(createHash("sha256").update(read("snapshot.v1.schema.json")).digest("hex")).toBe(SNAPSHOT_SCHEMA_SHA256);
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

  it("keeps plain error text, caps at 200 characters, and maps nothing to null", () => {
    expect(safeMessage("AADSTS7000222: client secret expired")).toBe("AADSTS7000222: client secret expired");
    expect(safeMessage("x".repeat(300))).toHaveLength(200);
    expect(safeMessage(null)).toBeNull();
    expect(safeMessage("   ")).toBeNull();
  });
});
