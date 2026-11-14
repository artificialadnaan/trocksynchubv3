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
    // A double-stringified body: the quote escaped one level deeper must not end the value and leave its tail. r4: the pair is
    // cut in place, and the kept `password` key is then residue, so the message drops (the error code stays).
    expect(safeMessage(JSON.stringify(JSON.stringify({ password: 'prefix"val-nested' })))).toBeNull();
    expect(safeMessage(JSON.stringify(JSON.stringify({ password: "val-bs\\", next: "ok" })))).toBeNull();
    // Three levels: the pair is cut in place (r3) and the kept key is residue (r4).
    expect(safeMessage(JSON.stringify(JSON.stringify(JSON.stringify({ password: 'p"val-deep' }))))).toBeNull();
    // ...but a refresh_token key is renamed to the [credential field] placeholder, so nothing of it is left to drop.
    expect(safeMessage(JSON.stringify(JSON.stringify(JSON.stringify({ refresh_token: 'p"val-tok' }))))).toBe(
      String.raw`"\"{\\\"[credential field]\": [redacted]}\""`,
    );
    // Four levels: past the pair pass; the fail-closed read (any number of closers) drops the message. The error code stays.
    expect(safeMessage(JSON.stringify(JSON.stringify(JSON.stringify(JSON.stringify({ password: 'p"val-deep' })))))).toBeNull();
    expect(safeMessage(JSON.stringify(JSON.stringify(JSON.stringify(JSON.stringify({ refresh_token: 'p"val-tok' })))))).toBeNull();
  });

  it("keeps plain error text, caps at 200 characters, and maps nothing to null", () => {
    expect(safeMessage("AADSTS7000222: client secret expired")).toBe("AADSTS7000222: client secret expired");
    expect(safeMessage("x".repeat(300))).toHaveLength(200);
    expect(safeMessage(null)).toBeNull();
    expect(safeMessage("   ")).toBeNull();
  });
});

describe("safeMessage: the credential list Core and the CRM share (any case, any suffix, key=value and key: value)", () => {
  // Exact outputs (d9 on #139: not.toContain could not tell a cut value from a dropped message). r4 (d6's fail-closed ruling): a
  // `key: value` pair keeps its key, and a credential key left in the text is residue, so those messages drop to null; a
  // `key=value` pair goes whole, so its message survives with [redacted].
  it.each([
    ["auth=auth-value-01 retry", "[redacted] retry"],
    ["credentials: cred-value-02", null],
    ["credential: cred-value-03", null],
    ["creds=creds-value-04", "[redacted]"],
    ["pass=pass-value-05", "[redacted]"],
    ["pw=pw-value-06", "[redacted]"],
    ["passphrase=pp-value-07", "[redacted]"],
    ["session_id=sess-value-08", "[redacted]"],
    ["otp: 123456", null],
    ["pin=4321", "[redacted]"],
    ["jwt: abc.def.ghi", null],
    ["X-Api-Key: xak-value-12", null],
    ["api_key_2=ak2-value-13", "[redacted]"],
    ["password: tail one two", null],
    ["Authorization: Token short1", null],
    ["Authorization: Basic dXNlcjpwYXNz", null],
    ['{\\"session\\":\\"esc-json-value-17\\"}', null],
    // The word anywhere in the key, and signature / sig / private key.
    ["db_password=dbpw-value-18 retry", "[redacted] retry"],
    ["x-auth-token: xat-value-19", null],
    ["my_api_key=myak-value-20", "[redacted]"],
    ["signature=sigval-value-21", "[redacted]"],
    ["sig=sig-value-21b", "[redacted]"],
    ["private_key=pk-value-22", "[redacted]"],
    ['{"my_access_token":"mat-value-23"}', '{"my_[credential field]": [redacted]}'],
  ])("%s -> %s", (raw, out) => {
    expect(safeMessage(raw)).toBe(out);
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

describe("safeMessage cleaner r3 (d9's review of #139): every key / separator / value shape, exact outputs", () => {
  it.each([
    ["camelCase key", '{"error":"invalid_grant","refreshToken":"rt-value-30"}', null],
    ["leading _", "refresh failed _password=pw-value-31 retry", "refresh failed [redacted] retry"],
    ["camelCase client secret", '{"clientSecret":"cs-value-32"}', null],
    ["camelCase access token", '{"accessToken":"at-value-33","ok":1}', null],
    ["Ruby / PHP =>", '{"password"=>"hunter-value-34"}', "{[redacted]}"],
    ["array value", '{"tokens":["tok-value-35a","tok-value-35b"]}', null],
    ["object value", '{"credentials":{"user":"svc","key":"cred-value-36"}}', null],
    ["Cookie header", "Cookie: theme=dark; JSESSIONID=js-value-37", null],
    ["Set-Cookie header", "Set-Cookie: sid=sc-value-38; Path=/", null],
    [
      "Azure connection string",
      "DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=ak-value-39==;EndpointSuffix=core.example.test",
      "DefaultEndpointsProtocol=https;AccountName=acct;[redacted];EndpointSuffix=core.example.test",
    ],
    ["SharedAccessKey", "SharedAccessKey=sak-value-40", "[redacted]"],
    ["connect.sid", "connect.sid=s%3Asid-value-41", "[redacted]"],
    ["Ocp-Apim-Subscription-Key", "Ocp-Apim-Subscription-Key: ocp-value-42", null],
    ["hapikey", "hapikey=hk-value-43", "[redacted]"],
    ["bare key=", "key=k-value-44", "[redacted]"],
    ["OAuth code=", "redirect failed code=code-value-45", "redirect failed [redacted]"],
    ["JSESSIONID", "JSESSIONID=js-value-46", "[redacted]"],
    ["PHPSESSID", "PHPSESSID=php-value-47", "[redacted]"],
    ["bracketed key", "user[password]=pwb-value-48", "user[[redacted]"],
    ["backtick key", "`token`=bt-value-49", "[redacted]"],
    ["URL userinfo", "connect postgres://synchub:pg-value-50@db.internal.test:5432/db failed", "connect postgres://db.internal.test:5432/db failed"],
    ["RFP review link", "see https://app.example.test/rfp-review/link-value-51 now", "see https://app.example.test/rfp-review/[link] now"],
  ])("%s", (_name, raw, out) => {
    expect(safeMessage(raw)).toBe(out);
  });

  it("a bracket value that never closes inside the read is not guessed at: the message is dropped", () => {
    expect(safeMessage('{"tokens":["tok-value-52",["tok-value-53"')).toBeNull();
  });

  it("a cut message drops its partial last token, so a split email never half-survives", () => {
    // d9 round 3: the email starts at index 1972 and the cut at 2000 leaves `jane.value-54@mail.example.t`, which the email rule
    // (a 2+ letter TLD) does not match. Without the partial-token drop the output ends with it; with the drop, it does not.
    const head = "Graph send failed: to";
    const raw = `${head}${" ".repeat(1972 - head.length)}jane.value-54@mail.example.test`;
    expect(raw.length).toBeGreaterThan(2000);
    expect(safeMessage(raw)).toBe("Graph send failed: to");
  });

  it("words that only contain a short credential word stay plain, and so does an error code after a colon", () => {
    expect(safeMessage("signal=SIGKILL")).toBe("signal=SIGKILL");
    expect(safeMessage("ping: 12ms")).toBe("ping: 12ms");
    expect(safeMessage("authority: login.example.test")).toBe("authority: login.example.test");
    expect(safeMessage("refused code: billing_contact_not_set")).toBe("refused code: billing_contact_not_set");
    expect(safeMessage("550 5.7.139 Authentication unsuccessful, basic authentication is disabled")).toBe(
      "550 5.7.139 Authentication unsuccessful, basic authentication is disabled",
    );
  });
});

describe("safeMessage r4 (d6's ruling after d9's round 3): fail closed on residue", () => {
  // d9's 9 leak shapes from round 3, synthetic values. Each is null, or a `key=value` pair cut whole to [redacted]: no value is left.
  it.each([
    ["1 bearer=", "bearer=bv-value-60", "[redacted]"],
    ["1 JSON bearer", '{"bearer":"bv-value-61"}', null],
    ["1 Bearer:", "Bearer: bv-value-62", null],
    ["2 cookies:", "cookies: a=1; s=ck-value-63", null],
    ["2 cookie=", "cookie=a=1; s=ck-value-64", "[redacted]"],
    ["2 headers.cookie:", "headers.cookie: a=1; s=ck-value-65", null],
    ["3 any scheme's query", "wss://h.example.test/ws?ticket=tk-value-66", null],
    ["4 %2F rfp-review", "see %2Frfp-review%2Flink-value-67 now", null],
    ["4 \\/ rfp-review", "see \\/rfp-review\\/link-value-68 now", null],
    ["4 &#x2F; rfp-review", "see &#x2F;rfp-review&#x2F;link-value-69 now", null],
    ["5 userinfo with #", "postgres://svc:Pa#55pg-value-70@db:5432/x", null],
    // The userinfo cut takes `a:b@`, then the email rule takes the rest (`cpg-value-71@host…`): nothing of the password is left.
    ["5 userinfo with a second @", "https://a:b@cpg-value-71@host.example.test/x", "https://[email]/x"],
    ["5 userinfo eaten by the email rule", "postgres://svc:Pa#55pg-value-72@db.internal.test/x", null],
    ["6 = then a backslash", "password=\\hunter-value-73", "[redacted]"],
    ["6 : then a comma", "password: ,pw-value-74", null],
    ["7 : value with a comma", "password: ab,pw-value-75", null],
    ["7 = value with a comma", "password=ab,pw-value-76", "[redacted]"],
    ["8 a key past 80 characters", `${"x".repeat(72)}_password=pw-value-77`, null],
    ["9 a single-quoted bracket value", "{'tokens': ['a]b', 'tok-value-78']}", null],
  ])("%s", (_name, raw, out) => {
    expect(safeMessage(raw)).toBe(out);
  });

  // The module's own fixed sentences (SyncHub writes them into the columns the snapshot reads): each passes unchanged, so a
  // residue rule that is too broad fails here.
  it.each([
    "superseded by a newer create command for the same source deal",
    "destination_changed_hold",
    "cross_destination_hold",
    "the same sourceEventId is stored for another deal: refused before sending",
    "template_disabled",
    "no_portfolio_project_id",
    "could_not_fetch_project_detail",
    "no_project_manager",
    "pm_has_no_email",
    "No HubSpot deal linked to this project",
  ])("%s passes unchanged", (sentence) => {
    expect(safeMessage(sentence)).toBe(sentence);
  });
});
