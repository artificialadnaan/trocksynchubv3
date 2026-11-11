import { beforeEach, describe, expect, it, vi } from "vitest";
import * as destination from "../server/sync/rfp-destination.ts";
import { CRM_FORMAT_PROJECT_NUMBER_RE, routeRfpCreate, type RfpDestination, type RouteInput } from "../server/sync/rfp-destination.ts";

const logMock = vi.hoisted(() => vi.fn());
vi.mock("../server/log.ts", () => ({ log: logMock }));

// CONTRACT v2.2 §2 ROUTE(r) + v2.4 c6 rule (f). Synthetic data only (I7).
type Input = RouteInput & { office?: string | null };
// c6 adds a third argument, the RFP_CORE_OFFICES set; typed here so this file compiles before and after it exists.
const route = routeRfpCreate as (r: Input, setting: string | undefined, coreOffices?: ReadonlySet<string>) => RfpDestination;
const DALLAS: ReadonlySet<string> = new Set(["dallas"]);
type ParsedOffices = { offices: ReadonlySet<string>; unknown: string[] };
const parseRfpCoreOffices = (destination as unknown as Record<string, unknown>).parseRfpCoreOffices as undefined | ((raw: string | undefined) => ParsedOffices);
const rfpCoreOfficesSetting = (destination as unknown as Record<string, unknown>).rfpCoreOfficesSetting as
  | undefined
  | ((env?: Record<string, string | undefined>) => ReadonlySet<string>);

function eligible(overrides: Partial<Input> = {}, deal: Partial<RouteInput["deal"]> = {}): Input {
  return {
    ingress: "create-from-rfp",
    sourceSystem: "trock_crm",
    decision: "approved",
    approvalKind: "vote",
    office: "dallas",
    deal: { projectNumber: "DFW-2-12345-ab", projectType: "2", ...deal },
    ...overrides,
  };
}

beforeEach(() => logMock.mockReset());

describe("ROUTE(r): all of (a)-(f) ⇒ core", () => {
  it("an eligible DFW vote under setting core, its office listed, routes to core", () => {
    expect(route(eligible(), "core", DALLAS)).toBe("core");
  });
  it("an eligible ATL vote under setting core, its office listed, routes to core", () => {
    const input = eligible({ office: "atlanta" }, { projectNumber: "ATL-5-06326-af", projectType: "5" });
    expect(route(input, "core", new Set(["dallas", "atlanta"]))).toBe("core");
  });
});

describe("ROUTE(r): each condition alone ⇒ procore", () => {
  it("(a) the setting is unset, procore, or anything but the exact string core", () => {
    for (const setting of [undefined, "", "procore", "CORE", "Core", " core", "core ", "true", "1"]) {
      expect(route(eligible(), setting, DALLAS), `setting=${JSON.stringify(setting)}`).toBe("procore");
    }
  });
  it("(b) not create-from-rfp, not trock_crm, or not decision approved", () => {
    for (const ingress of ["rfp-request", "override", "hubspot"] as const) {
      expect(route(eligible({ ingress }), "core", DALLAS), ingress).toBe("procore");
    }
    expect(route(eligible({ sourceSystem: "hubspot" }), "core", DALLAS)).toBe("procore");
    expect(route(eligible({ decision: undefined }), "core", DALLAS)).toBe("procore");
    expect(route(eligible({ decision: "declined" }), "core", DALLAS)).toBe("procore");
  });
  it("(c) approvalKind override, missing or null", () => {
    expect(route(eligible({ approvalKind: "override" }), "core", DALLAS)).toBe("procore");
    expect(route(eligible({ approvalKind: undefined }), "core", DALLAS)).toBe("procore");
    expect(route(eligible({ approvalKind: null }), "core", DALLAS)).toBe("procore");
  });
  it("(d) the effective digit is 4 (the number's digit wins over projectType)", () => {
    expect(route(eligible({}, { projectNumber: "DFW-4-12345-ab", projectType: "2" }), "core", DALLAS)).toBe("procore");
  });
  it("(e) the number is not exactly CRM-format", () => {
    for (const projectNumber of [
      "dfw-2-12345-ab", "DFW-0-12345-ab", "DFW-2-1234-ab", "DFW-2-123456-ab", "DFW-2-12345-AB", "HOU-2-12345-ab",
      "DFW-2-12345-ab-1", " DFW-2-12345-ab", "DFW-2-12345-ab ", "TR-1001", "", "8a1f2b3c-0000-4000-8000-000000000001",
    ]) {
      expect(route(eligible({}, { projectNumber }), "core", DALLAS), projectNumber).toBe("procore");
    }
  });
});

describe("ROUTE (f): the E1 office must be in RFP_CORE_OFFICES (CONTRACT v2.4 c6 / c6.1)", () => {
  it("an office not in the list ⇒ procore", () => {
    expect(route(eligible(), "core", new Set(["atlanta"]))).toBe("procore");
  });
  it("dallas listed ⇒ core", () => {
    expect(route(eligible(), "core", DALLAS)).toBe("core");
  });
  it("no list (unset) ⇒ procore even with destination core", () => {
    expect(route(eligible(), "core")).toBe("procore");
    expect(route(eligible(), "core", new Set())).toBe("procore");
  });
  it("the E1 office is matched exactly: missing, null, blank or not the lowercase slug ⇒ procore", () => {
    for (const office of [undefined, null, "", " dallas", "Dallas", "DALLAS", "dallas "]) {
      expect(route(eligible({ office }), "core", DALLAS), `office=${JSON.stringify(office)}`).toBe("procore");
    }
  });
  it("the list is trimmed and lowercased; unset, empty or only commas is no office", () => {
    expect(parseRfpCoreOffices).toBeTypeOf("function");
    const parse = parseRfpCoreOffices!;
    expect([...parse(" Dallas , ATLANTA ").offices].sort()).toEqual(["atlanta", "dallas"]);
    expect([...parse("dallas").offices]).toEqual(["dallas"]);
    for (const raw of [undefined, "", "  ", ",", " , "]) {
      expect([...parse(raw).offices], `raw=${JSON.stringify(raw)}`).toEqual([]);
      expect(parse(raw).unknown, `raw=${JSON.stringify(raw)}`).toEqual([]);
    }
  });
  it("an unknown slug is ignored and named; the known ones still count", () => {
    expect(parseRfpCoreOffices).toBeTypeOf("function");
    const parsed = parseRfpCoreOffices!("dallas,houston");
    expect([...parsed.offices]).toEqual(["dallas"]);
    expect(parsed.unknown).toEqual(["houston"]);
  });
  it("the setting reads RFP_CORE_OFFICES and warns ONCE per process about an unknown slug", () => {
    expect(rfpCoreOfficesSetting).toBeTypeOf("function");
    const env = { RFP_CORE_OFFICES: "dallas, Fort-Worth" };
    expect([...rfpCoreOfficesSetting!(env)]).toEqual(["dallas"]);
    expect([...rfpCoreOfficesSetting!(env)]).toEqual(["dallas"]);
    expect(logMock).toHaveBeenCalledTimes(1);
    expect(String(logMock.mock.calls[0][0])).toContain("fort-worth");
    expect([...rfpCoreOfficesSetting!({})]).toEqual([]);
    expect(logMock).toHaveBeenCalledTimes(1);
  });
});

describe("CRM_FORMAT_PROJECT_NUMBER_RE", () => {
  it("is the CRM generator's strict form", () => {
    expect(CRM_FORMAT_PROJECT_NUMBER_RE.source).toBe("^(DFW|ATL)-[1-9]-[0-9]{5}-[a-z]+$");
    expect(CRM_FORMAT_PROJECT_NUMBER_RE.flags).toBe("");
  });
});
