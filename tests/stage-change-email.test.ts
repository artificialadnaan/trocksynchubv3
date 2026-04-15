import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../server/db.ts", () => ({ db: {}, pool: {} }));

const mockStorage = {
  getEmailTemplate: vi.fn(),
  createEmailSendLog: vi.fn(),
  getSyncMappingByProcoreProjectId: vi.fn(),
  getProcoreProjectByProcoreId: vi.fn(),
};

const mockSendEmail = vi.fn();
const mockGetDealOwnerInfo = vi.fn();

vi.mock("../server/storage.ts", () => ({ storage: mockStorage }));
vi.mock("../server/email-service.ts", () => ({
  sendEmail: mockSendEmail,
  renderTemplate: (template: string, variables: Record<string, string>) =>
    template.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] ?? `{{${key}}}`),
}));
vi.mock("../server/hubspot.ts", () => ({
  getDealOwnerInfo: mockGetDealOwnerInfo,
}));
vi.mock("../server/procore.ts", () => ({
  fetchProcoreProjectDetail: vi.fn(),
  getProjectTeamMembers: vi.fn(),
}));

describe("stage change notification rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorage.getEmailTemplate.mockResolvedValue({
      enabled: true,
      subject: "Stage Update: {{projectName}} - {{newStage}}",
      bodyHtml:
        "Project {{projectName}} {{projectNumber}} Procore {{procoreProjectId}} HubSpot {{hubspotDealId}} {{procoreUrl}}",
    });
    mockStorage.createEmailSendLog.mockResolvedValue({});
    mockStorage.getSyncMappingByProcoreProjectId.mockResolvedValue({
      companyCamProjectId: null,
      procoreProjectNumber: "DFW-1-02226-ac",
    });
    mockStorage.getProcoreProjectByProcoreId.mockResolvedValue({
      projectNumber: "DFW-1-02226-ac",
    });
    mockGetDealOwnerInfo.mockResolvedValue({
      ownerEmail: "owner@trockgc.com",
      ownerName: "Owner",
    });
    mockSendEmail.mockResolvedValue({ success: true, messageId: "msg-1" });
  });

  it("uses the Procore project id and project number in the email body", async () => {
    const { sendStageChangeEmail } = await import("../server/email-notifications.ts");

    await sendStageChangeEmail({
      hubspotDealId: "318905030374",
      dealName: "The Nirvana Laurel Springs",
      procoreProjectId: "562949955705473",
      procoreProjectName: "The Nirvana Laurel Springs",
      oldStage: "Estimate in Progress",
      newStage: "Estimate Under Review",
      hubspotStageName: "Estimate Under Review",
    });

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const payload = mockSendEmail.mock.calls[0][0];
    expect(payload.htmlBody).toContain("DFW-1-02226-ac");
    expect(payload.htmlBody).toContain("562949955705473");
    expect(payload.htmlBody).toContain("318905030374");
    expect(payload.htmlBody).toContain("/projects/562949955705473/tools/projecthome");
  });
});
