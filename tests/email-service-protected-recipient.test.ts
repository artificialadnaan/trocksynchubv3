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

// Codex on #112: with global testing mode on, sendEmail swaps `to` for the configured test address — so a
// staff or client address set there would receive the owner-only Procore credential alert, and the owner
// would miss the outage. Protected ops alerts opt out of the redirect.
describe("sendEmail — protected recipients bypass testing-mode redirection", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  async function sendWithTestingModeOn(extra: Record<string, unknown>) {
    const { storage } = await import("../server/storage.ts");
    const gmail = await import("../server/gmail.ts");
    const microsoft = await import("../server/microsoft.ts");
    const { sendEmail } = await import("../server/email-service.ts");
    vi.mocked(storage.getAutomationConfig).mockResolvedValue({ value: { activeProvider: "gmail" } } as any);
    vi.mocked(storage.getTestingMode).mockResolvedValue({ enabled: true, testEmail: "staff@example.com" } as any);
    vi.mocked(gmail.getGmailConnectionStatus).mockResolvedValue({ connected: true, email: "ops@example.com" } as any);
    vi.mocked(microsoft.isMicrosoftConnected).mockResolvedValue({ connected: false } as any);
    vi.mocked(gmail.sendEmail).mockResolvedValue({ success: true, messageId: "g-1" } as any);
    await sendEmail({ to: "aiqbal@trockgc.com", subject: "Procore sign-in FAILED", htmlBody: "<p>x</p>", bypassGlobalCc: true, ...extra });
    return vi.mocked(gmail.sendEmail).mock.calls[0][0] as any;
  }

  it("without the opt-out, testing mode still redirects (the control)", async () => {
    const sent = await sendWithTestingModeOn({});
    expect(sent.to).toBe("staff@example.com");
    expect(sent.subject).toMatch(/^\[TEST\]/);
  });

  it("bypassTestingMode delivers to the pinned recipient, unprefixed, with no banner and no added cc", async () => {
    const sent = await sendWithTestingModeOn({ bypassTestingMode: true });
    expect(sent.to).toBe("aiqbal@trockgc.com");
    expect(sent.subject).toBe("Procore sign-in FAILED");
    expect(sent.htmlBody).not.toMatch(/Testing Mode Active/);
    expect(sent.cc ?? []).toEqual([]);
  });
});
