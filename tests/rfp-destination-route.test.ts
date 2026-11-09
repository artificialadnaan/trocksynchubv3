import { describe, expect, it } from "vitest";
import { CRM_FORMAT_PROJECT_NUMBER_RE, routeRfpCreate, type RouteInput } from "../server/sync/rfp-destination.ts";

// CONTRACT v2.2 §2 ROUTE(r). Synthetic data only (I7).
function eligible(overrides: Partial<RouteInput> = {}, deal: Partial<RouteInput["deal"]> = {}): RouteInput {
  return {
    ingress: "create-from-rfp",
    sourceSystem: "trock_crm",
    decision: "approved",
    approvalKind: "vote",
    deal: { projectNumber: "DFW-2-12345-ab", projectType: "2", ...deal },
    ...overrides,
  };
}

describe("ROUTE(r): all of (a)-(e) ⇒ core", () => {
  it("an eligible DFW vote under setting core routes to core", () => {
    expect(routeRfpCreate(eligible(), "core")).toBe("core");
  });
  it("an eligible ATL vote under setting core routes to core", () => {
    expect(routeRfpCreate(eligible({}, { projectNumber: "ATL-5-06326-af", projectType: "5" }), "core")).toBe("core");
  });
});

describe("ROUTE(r): each condition alone ⇒ procore", () => {
  it("(a) the setting is unset, procore, or anything but the exact string core", () => {
    for (const setting of [undefined, "", "procore", "CORE", "Core", " core", "core ", "true", "1"]) {
      expect(routeRfpCreate(eligible(), setting), `setting=${JSON.stringify(setting)}`).toBe("procore");
    }
  });
  it("(b) not create-from-rfp, not trock_crm, or not decision approved", () => {
    for (const ingress of ["rfp-request", "override", "hubspot"] as const) {
      expect(routeRfpCreate(eligible({ ingress }), "core"), ingress).toBe("procore");
    }
    expect(routeRfpCreate(eligible({ sourceSystem: "hubspot" }), "core")).toBe("procore");
    expect(routeRfpCreate(eligible({ decision: undefined }), "core")).toBe("procore");
    expect(routeRfpCreate(eligible({ decision: "declined" }), "core")).toBe("procore");
  });
  it("(c) approvalKind override, missing or null", () => {
    expect(routeRfpCreate(eligible({ approvalKind: "override" }), "core")).toBe("procore");
    expect(routeRfpCreate(eligible({ approvalKind: undefined }), "core")).toBe("procore");
    expect(routeRfpCreate(eligible({ approvalKind: null }), "core")).toBe("procore");
  });
  it("(d) the effective digit is 4 (the number's digit wins over projectType)", () => {
    expect(routeRfpCreate(eligible({}, { projectNumber: "DFW-4-12345-ab", projectType: "2" }), "core")).toBe("procore");
  });
  it("(e) the number is not exactly CRM-format", () => {
    for (const projectNumber of [
      "dfw-2-12345-ab", "DFW-0-12345-ab", "DFW-2-1234-ab", "DFW-2-123456-ab", "DFW-2-12345-AB", "HOU-2-12345-ab",
      "DFW-2-12345-ab-1", " DFW-2-12345-ab", "DFW-2-12345-ab ", "TR-1001", "", "8a1f2b3c-0000-4000-8000-000000000001",
    ]) {
      expect(routeRfpCreate(eligible({}, { projectNumber }), "core"), projectNumber).toBe("procore");
    }
  });
});

describe("CRM_FORMAT_PROJECT_NUMBER_RE", () => {
  it("is the CRM generator's strict form", () => {
    expect(CRM_FORMAT_PROJECT_NUMBER_RE.source).toBe("^(DFW|ATL)-[1-9]-[0-9]{5}-[a-z]+$");
    expect(CRM_FORMAT_PROJECT_NUMBER_RE.flags).toBe("");
  });
});
