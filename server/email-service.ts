import { storage } from './storage';
import { sendEmail as sendGmailEmail, isGmailConnected, getGmailConnectionStatus } from './gmail';
import { sendOutlookEmail, isOutlookConnected, isMicrosoftConnected } from './microsoft';

export type EmailProvider = 'gmail' | 'outlook';

interface EmailConfig {
  activeProvider: EmailProvider;
}

export async function getEmailConfig(): Promise<EmailConfig & {
  gmailConnected: boolean;
  gmailEmail?: string;
  outlookConnected: boolean;
  outlookEmail?: string;
}> {
  const config = await storage.getAutomationConfig('email_config');
  const activeProvider: EmailProvider = (config?.value as any)?.activeProvider || 'gmail';

  const gmailStatus = await getGmailConnectionStatus();
  const microsoftStatus = await isMicrosoftConnected();

  return {
    activeProvider,
    gmailConnected: gmailStatus.connected,
    gmailEmail: gmailStatus.email,
    outlookConnected: microsoftStatus.connected,
    outlookEmail: microsoftStatus.email,
  };
}

export async function setEmailConfig(config: Partial<EmailConfig>): Promise<void> {
  const existing = await storage.getAutomationConfig('email_config');
  const currentConfig = (existing?.value as any) || {};

  await storage.upsertAutomationConfig({
    key: 'email_config',
    value: { ...currentConfig, ...config },
    description: 'Email notification configuration',
    isActive: true,
  });

  console.log(`[Email] Active provider set to: ${config.activeProvider}`);
}

export async function sendEmail(params: {
  to: string;
  subject: string;
  htmlBody: string;
  fromName?: string;
  provider?: EmailProvider;
}): Promise<{ success: boolean; messageId?: string; error?: string; provider: string }> {
  const config = await getEmailConfig();
  const provider = params.provider || config.activeProvider;

  if (provider === 'outlook') {
    if (!config.outlookConnected) {
      return { success: false, error: 'Outlook not connected', provider: 'outlook' };
    }
    const result = await sendOutlookEmail(params);
    return { ...result, provider: 'outlook' };
  }

  // Default to Gmail
  if (!config.gmailConnected) {
    return { success: false, error: 'Gmail not connected', provider: 'gmail' };
  }
  const result = await sendGmailEmail(params);
  return { ...result, provider: 'gmail' };
}

export async function getEmailStats(): Promise<{
  total: number;
  sent: number;
  failed: number;
  gmailConnected: boolean;
  outlookConnected: boolean;
  activeProvider: string;
}> {
  const config = await getEmailConfig();
  const counts = await storage.getEmailSendLogCounts();

  return {
    ...counts,
    gmailConnected: config.gmailConnected,
    outlookConnected: config.outlookConnected,
    activeProvider: config.activeProvider,
  };
}

export { renderTemplate } from './gmail';
