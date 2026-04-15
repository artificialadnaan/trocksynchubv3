import { describe, expect, it } from "vitest";

import { sanitizeEstimatorList, validateEstimatorList } from "../shared/estimators";

describe("estimator settings helpers", () => {
  it("sanitizes estimator names and emails", () => {
    expect(
      sanitizeEstimatorList([
        { name: "  Edward McCarty  ", email: "  EMCCARTY@trockgc.com  " },
      ]),
    ).toEqual([
      { name: "Edward McCarty", email: "emccarty@trockgc.com" },
    ]);
  });

  it("rejects blank rows, invalid emails, and duplicates", () => {
    const errors = validateEstimatorList([
      { name: "", email: "" },
      { name: "Edward McCarty", email: "not-an-email" },
      { name: "Brett Bell", email: "bbell@trockgc.com" },
      { name: " brett bell ", email: "other@trockgc.com" },
      { name: "Alex Koch", email: "BBELL@trockgc.com" },
    ]);

    expect(errors).toEqual([
      "Estimator 1 is missing a name.",
      "Estimator 1 is missing an email.",
      "Estimator 2 has an invalid email address.",
      'Estimator 4 has a duplicate name: "brett bell".',
      'Estimator 5 has a duplicate email: "BBELL@trockgc.com".',
    ]);
  });

  it("accepts a valid unique list", () => {
    expect(
      validateEstimatorList([
        { name: "Brett Bell", email: "bbell@trockgc.com" },
        { name: "Edward McCarty", email: "emccarty@trockgc.com" },
      ]),
    ).toEqual([]);
  });
});
