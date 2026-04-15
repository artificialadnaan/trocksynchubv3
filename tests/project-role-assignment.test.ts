import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../server/db.ts", () => ({ db: {}, pool: {} }));

const mockStorage = {
  getEmailTemplate: vi.fn(),
  checkEmailDedupeKey: vi.fn(),
  getSyncMappingByProcoreProjectId: vi.fn(),
  getProcoreProjectByProcoreId: vi.fn(),
  getHubspotDealByProjectNumber: vi.fn(),
  createEmailSendLog: vi.fn(),
  createAuditLog: vi.fn(),
};

const mockSendEmail = vi.fn();

vi.mock("../server/storage.ts", () => ({ storage: mockStorage }));
vi.mock("../server/email-service.ts", () => ({
  sendEmail: mockSendEmail,
  renderTemplate: (template: string, variables: Record<string, string>) =>
    template.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] ?? `{{${key}}}`),
}));
vi.mock("../server/hubspot.ts", () => ({ getDealOwnerInfo: vi.fn() }));
vi.mock("../server/procore.ts", () => ({
  fetchProcoreProjectDetail: vi.fn(),
  getProjectTeamMembers: vi.fn(),
}));

describe("project role assignment email links", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStorage.getEmailTemplate.mockResolvedValue({
      enabled: true,
      subject: "Assigned to {{projectName}}",
      bodyHtml: "{{hubspotUrl}}",
    });
    mockStorage.checkEmailDedupeKey.mockResolvedValue(false);
    mockStorage.createEmailSendLog.mockResolvedValue({});
    mockStorage.createAuditLog.mockResolvedValue({});
    mockSendEmail.mockResolvedValue({ success: true, messageId: "msg-1" });
  });

  it("prefers an exact HubSpot project-number match over a stale sync mapping", async () => {
    mockStorage.getSyncMappingByProcoreProjectId.mockResolvedValue({
      hubspotDealId: "273338607327",
      companyCamProjectId: null,
    });
    mockStorage.getProcoreProjectByProcoreId.mockResolvedValue({
      projectNumber: "DFW-1-02226-ac",
    });
    mockStorage.getHubspotDealByProjectNumber.mockResolvedValue({
      hubspotId: "269389208292",
    });

    const { sendRoleAssignmentEmails } = await import("../server/email-notifications.ts");

    await sendRoleAssignmentEmails([
      {
        procoreProjectId: "598134326454009",
        projectName: "Tides at Highland Meadows",
        roleName: "Project Engineer",
        assigneeId: "user-1",
        assigneeName: "Brett Bell",
        assigneeEmail: "bbell@trockgc.com",
        assigneeCompany: "T-Rock Construction",
      },
    ]);

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const payload = mockSendEmail.mock.calls[0][0];
    expect(payload.htmlBody).toContain("/record/0-3/269389208292");
    expect(payload.htmlBody).not.toContain("/record/0-3/273338607327");
  });

  it("falls back to the sync mapping when no exact project-number match exists", async () => {
    mockStorage.getSyncMappingByProcoreProjectId.mockResolvedValue({
      hubspotDealId: "273338607327",
      companyCamProjectId: null,
    });
    mockStorage.getProcoreProjectByProcoreId.mockResolvedValue({
      projectNumber: "DFW-1-02226-ac",
    });
    mockStorage.getHubspotDealByProjectNumber.mockResolvedValue(undefined);

    const { sendRoleAssignmentEmails } = await import("../server/email-notifications.ts");

    await sendRoleAssignmentEmails([
      {
        procoreProjectId: "598134326454009",
        projectName: "Tides at Highland Meadows",
        roleName: "Project Engineer",
        assigneeId: "user-1",
        assigneeName: "Brett Bell",
        assigneeEmail: "bbell@trockgc.com",
        assigneeCompany: "T-Rock Construction",
      },
    ]);

    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const payload = mockSendEmail.mock.calls[0][0];
    expect(payload.htmlBody).toContain("/record/0-3/273338607327");
  });
});
