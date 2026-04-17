import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../server/storage.ts", () => ({
  storage: {
    getAutomationConfig: vi.fn(),
    upsertAutomationConfig: vi.fn(),
    getTestingMode: vi.fn(),
    getEmailSendLogCounts: vi.fn(),
  },
}));

vi.mock("../server/gmail.ts", () => ({
  sendEmail: vi.fn(),
  isGmailConnected: vi.fn(),
  getGmailConnectionStatus: vi.fn(),
  renderTemplate: vi.fn(),
}));

vi.mock("../server/microsoft.ts", () => ({
  sendOutlookEmail: vi.fn(),
  isOutlookConnected: vi.fn(),
  isMicrosoftConnected: vi.fn(),
}));

describe("email service fallback", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("falls back to Gmail when Outlook is configured as active but not connected", async () => {
    const { storage } = await import("../server/storage.ts");
    const gmail = await import("../server/gmail.ts");
    const microsoft = await import("../server/microsoft.ts");
    const { sendEmail } = await import("../server/email-service.ts");

    vi.mocked(storage.getAutomationConfig).mockResolvedValue({
      value: { activeProvider: "outlook" },
    } as any);
    vi.mocked(storage.getTestingMode).mockResolvedValue({ enabled: false, testEmail: "" } as any);
    vi.mocked(gmail.getGmailConnectionStatus).mockResolvedValue({
      connected: true,
      email: "adnaan.iqbal@gmail.com",
    } as any);
    vi.mocked(microsoft.isMicrosoftConnected).mockResolvedValue({
      connected: false,
    } as any);
    vi.mocked(gmail.sendEmail).mockResolvedValue({
      success: true,
      messageId: "gmail-123",
    } as any);

    const result = await sendEmail({
      to: "user@example.com",
      subject: "Test",
      htmlBody: "<p>Hello</p>",
    });

    expect(result).toMatchObject({
      success: true,
      provider: "gmail",
      messageId: "gmail-123",
    });
    expect(vi.mocked(gmail.sendEmail)).toHaveBeenCalledOnce();
    expect(vi.mocked(gmail.sendEmail)).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user@example.com",
        cc: ["adnaan.iqbal@gmail.com", "bbell@trockgc.com"],
      })
    );
    expect(vi.mocked(microsoft.sendOutlookEmail)).not.toHaveBeenCalled();
  });

  it("falls back to Gmail when Outlook send fails after connection succeeds", async () => {
    const { storage } = await import("../server/storage.ts");
    const gmail = await import("../server/gmail.ts");
    const microsoft = await import("../server/microsoft.ts");
    const { sendEmail } = await import("../server/email-service.ts");

    vi.mocked(storage.getAutomationConfig).mockResolvedValue({
      value: { activeProvider: "outlook" },
    } as any);
    vi.mocked(storage.getTestingMode).mockResolvedValue({ enabled: false, testEmail: "" } as any);
    vi.mocked(gmail.getGmailConnectionStatus).mockResolvedValue({
      connected: true,
      email: "adnaan.iqbal@gmail.com",
    } as any);
    vi.mocked(microsoft.isMicrosoftConnected).mockResolvedValue({
      connected: true,
      email: "office@trockgc.com",
    } as any);
    vi.mocked(microsoft.sendOutlookEmail).mockResolvedValue({
      success: false,
      error: "Outlook send failed: invalid_grant",
    } as any);
    vi.mocked(gmail.sendEmail).mockResolvedValue({
      success: true,
      messageId: "gmail-456",
    } as any);

    const result = await sendEmail({
      to: "user@example.com",
      subject: "Test",
      htmlBody: "<p>Hello</p>",
    });

    expect(result).toMatchObject({
      success: true,
      provider: "gmail",
      messageId: "gmail-456",
    });
    expect(vi.mocked(microsoft.sendOutlookEmail)).toHaveBeenCalledOnce();
    expect(vi.mocked(gmail.sendEmail)).toHaveBeenCalledOnce();
  });

  it("dedupes CC recipients against the primary recipient and repeated CC values", async () => {
    const { storage } = await import("../server/storage.ts");
    const gmail = await import("../server/gmail.ts");
    const microsoft = await import("../server/microsoft.ts");
    const { sendEmail } = await import("../server/email-service.ts");

    vi.mocked(storage.getAutomationConfig).mockResolvedValue({
      value: { activeProvider: "outlook" },
    } as any);
    vi.mocked(storage.getTestingMode).mockResolvedValue({ enabled: false, testEmail: "" } as any);
    vi.mocked(gmail.getGmailConnectionStatus).mockResolvedValue({
      connected: true,
      email: "adnaan.iqbal@gmail.com",
    } as any);
    vi.mocked(microsoft.isMicrosoftConnected).mockResolvedValue({
      connected: true,
      email: "office@trockgc.com",
    } as any);
    vi.mocked(microsoft.sendOutlookEmail).mockResolvedValue({
      success: true,
      messageId: "outlook-123",
    } as any);

    const result = await sendEmail({
      to: "bbell@trockgc.com",
      subject: "Test",
      htmlBody: "<p>Hello</p>",
      cc: ["bbell@trockgc.com", "adnaan.iqbal@gmail.com", "extra@example.com", "extra@example.com"],
    });

    expect(result).toMatchObject({
      success: true,
      provider: "outlook",
      cc: ["adnaan.iqbal@gmail.com", "extra@example.com"],
    });
    expect(vi.mocked(microsoft.sendOutlookEmail)).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "bbell@trockgc.com",
        cc: ["adnaan.iqbal@gmail.com", "extra@example.com"],
      })
    );
  });
});
