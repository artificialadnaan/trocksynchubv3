import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../server/db.ts", () => ({ db: {}, pool: {} }));

const mockStorage = {
  getCloseoutSurveyByProjectId: vi.fn(),
  getCloseoutSurveyByToken: vi.fn(),
  getSyncMappingByProcoreProjectId: vi.fn(),
  getHubspotDealByHubspotId: vi.fn(),
  getHubspotOwnerByHubspotId: vi.fn(),
  getHubspotOwnerMappingByHubspotId: vi.fn(),
  getHubspotCompanyByHubspotId: vi.fn(),
  getProcoreRoleAssignmentsByProject: vi.fn(),
  getProcoreUserByProcoreId: vi.fn(),
  getEmailTemplate: vi.fn(),
  createCloseoutSurvey: vi.fn(),
  updateCloseoutSurvey: vi.fn(),
  createEmailSendLog: vi.fn(),
  createAuditLog: vi.fn(),
};

const mockSendEmail = vi.fn();
const mockFetchProcoreProjectDetail = vi.fn();
const mockSyncProcoreRoleAssignments = vi.fn();

vi.mock("../server/storage.ts", () => ({ storage: mockStorage }));
vi.mock("../server/email-service.ts", () => ({
  sendEmail: mockSendEmail,
  renderTemplate: (template: string, variables: Record<string, string>) =>
    template.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] ?? `{{${key}}}`),
}));
vi.mock("../server/procore.ts", () => ({
  fetchProcoreProjectDetail: mockFetchProcoreProjectDetail,
  syncProcoreRoleAssignments: mockSyncProcoreRoleAssignments,
  deactivateProject: vi.fn(),
}));
vi.mock("../server/project-archive.ts", () => ({
  startProjectArchive: vi.fn(),
  getArchiveProgress: vi.fn(),
}));

describe("closeout survey greeting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorage.getCloseoutSurveyByProjectId.mockResolvedValue(undefined);
    mockStorage.getCloseoutSurveyByToken.mockResolvedValue({
      id: 101,
      procoreProjectId: "project-1",
      procoreProjectName: "Test 4.8",
      hubspotDealId: null,
      clientEmail: "bbell@trockgc.com",
      clientName: "Highland Meadows Owner LLC",
      googleReviewLink: "https://g.page/r/CUNQR2SdSZivEAE/review",
      submittedAt: null,
    });
    mockStorage.getSyncMappingByProcoreProjectId.mockResolvedValue({
      hubspotDealId: "deal-1",
    });
    mockStorage.getHubspotDealByHubspotId.mockResolvedValue({
      ownerId: "owner-1",
      associatedCompanyId: "company-1",
    });
    mockStorage.getHubspotOwnerByHubspotId.mockResolvedValue({
      email: "bbell@trockgc.com",
      firstName: "Brett",
      lastName: "Bell",
    });
    mockStorage.getHubspotOwnerMappingByHubspotId.mockResolvedValue(undefined);
    mockStorage.getHubspotCompanyByHubspotId.mockResolvedValue({
      name: "Highland Meadows Owner LLC",
    });
    mockStorage.getEmailTemplate.mockResolvedValue({
      enabled: true,
      subject: "How did we do? {{projectName}}",
      bodyHtml: "Dear {{clientName}} {{googleReviewUrl}}",
    });
    mockStorage.createCloseoutSurvey.mockImplementation(async (data) => ({
      id: 101,
      ...data,
    }));
    mockStorage.updateCloseoutSurvey.mockResolvedValue({});
    mockStorage.createEmailSendLog.mockResolvedValue({});
    mockStorage.createAuditLog.mockResolvedValue({});
    mockSendEmail.mockResolvedValue({ success: true, messageId: "msg-1" });
    mockFetchProcoreProjectDetail.mockResolvedValue({
      name: "Test 4.8",
      display_name: "Test 4.8",
      client_name: null,
      company: { name: "Fallback Procore Client" },
      client_email: "",
      owner_email: "",
    });
    mockSyncProcoreRoleAssignments.mockResolvedValue(undefined);
  });

  it("uses the client company for the greeting even when the recipient is the deal owner", async () => {
    const { triggerCloseoutSurvey } = await import("../server/closeout-automation.ts");

    const result = await triggerCloseoutSurvey("project-1");

    expect(result.success).toBe(true);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0].htmlBody).toContain("Highland Meadows Owner LLC");
    expect(mockSendEmail.mock.calls[0][0].to).toBe("bbell@trockgc.com");
    expect(mockStorage.createCloseoutSurvey).toHaveBeenCalledWith(
      expect.objectContaining({
        clientEmail: "bbell@trockgc.com",
        clientName: "Highland Meadows Owner LLC",
      }),
    );
  });

  it("falls back to the Procore client/company name when no HubSpot company is available", async () => {
    mockStorage.getHubspotCompanyByHubspotId.mockResolvedValue(undefined);

    const { triggerCloseoutSurvey } = await import("../server/closeout-automation.ts");

    const result = await triggerCloseoutSurvey("project-1");

    expect(result.success).toBe(true);
    expect(mockStorage.createCloseoutSurvey).toHaveBeenCalledWith(
      expect.objectContaining({
        clientName: "Fallback Procore Client",
      }),
    );
  });

  it("uses the production Google review URL by default", async () => {
    const { triggerCloseoutSurvey } = await import("../server/closeout-automation.ts");

    const result = await triggerCloseoutSurvey("project-1");

    expect(result.success).toBe(true);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail.mock.calls[0][0].htmlBody).toContain("https://g.page/r/CUNQR2SdSZivEAE/review");
    expect(mockStorage.createCloseoutSurvey).toHaveBeenCalledWith(
      expect.objectContaining({
        googleReviewLink: "https://g.page/r/CUNQR2SdSZivEAE/review",
      }),
    );
  });

  it("prompts for a Google review when the average rating is exactly 4.00", async () => {
    const { submitSurveyResponse } = await import("../server/closeout-automation.ts");

    const result = await submitSurveyResponse("survey-token", {
      ratings: {
        overallExperience: 4,
        communication: 4,
        schedule: 4,
        quality: 4,
        hireAgain: 5,
        referral: 5,
      },
      feedback: "Solid job",
    });

    expect(result).toMatchObject({
      success: true,
      showGoogleReview: true,
      googleReviewLink: "https://g.page/r/CUNQR2SdSZivEAE/review",
    });
    expect(mockStorage.updateCloseoutSurvey).toHaveBeenCalledWith(
      101,
      expect.objectContaining({
        ratingAverage: "4.00",
      }),
    );
  });
});
