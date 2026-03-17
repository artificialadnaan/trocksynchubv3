/**
 * Email Service Module
 * ====================
 * 
 * This module provides a unified email sending interface that works with
 * multiple email providers (Gmail, Outlook). It abstracts the provider
 * selection and handles template rendering.
 * 
 * Supported Providers:
 * - Gmail: Via Google OAuth API
 * - Outlook: Via Microsoft Graph API
 * 
 * Features:
 * - Provider switching (configurable active provider)
 * - Template rendering with variable substitution
 * - HTML email support
 * - Connection status monitoring
 * 
 * Email Flow:
 * 1. Get active provider from configuration
 * 2. Check provider connection status
 * 3. Render template with variables
 * 4. Send via provider API
 * 5. Log send result
 * 
 * Key Functions:
 * - sendEmail(): Send email via active provider
 * - getEmailConfig(): Get provider configuration and status
 * - setEmailConfig(): Update provider selection
 * - renderTemplate(): Replace {{variables}} in template
 * 
 * Configuration (automation_config table):
 * - email_config.activeProvider: 'gmail' or 'outlook'
 * 
 * @module email-service
 */

import { storage } from './storage';
import { sendEmail as sendGmailEmail, isGmailConnected, getGmailConnectionStatus } from './gmail';
import { sendOutlookEmail, isOutlookConnected, isMicrosoftConnected } from './microsoft';

/** Supported email providers */
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

  // Check for testing mode - redirect all emails to test address
  const testingMode = await storage.getTestingMode();
  let finalTo = params.to;
  let finalSubject = params.subject;
  let finalBody = params.htmlBody;

  if (testingMode.enabled) {
    const originalRecipient = params.to;
    finalTo = testingMode.testEmail;
    finalSubject = `[TEST] ${params.subject}`;
    
    // Add testing banner to email body
    const testingBanner = `
      <div style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: #ffffff; padding: 16px 24px; margin-bottom: 24px; border-radius: 8px; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
          <tr>
            <td>
              <p style="margin: 0 0 8px 0; font-size: 14px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px;">
                ⚠️ Testing Mode Active
              </p>
              <p style="margin: 0; font-size: 13px; opacity: 0.95;">
                <strong>Original Recipient:</strong> ${originalRecipient}
              </p>
              <p style="margin: 4px 0 0 0; font-size: 11px; opacity: 0.8;">
                This email was redirected because testing mode is enabled in T-Rock Sync Hub.
              </p>
            </td>
          </tr>
        </table>
      </div>
    `;
    
    // Insert banner after <body> tag or at the start
    if (finalBody.includes('<body')) {
      finalBody = finalBody.replace(/(<body[^>]*>)/i, `$1${testingBanner}`);
    } else {
      finalBody = testingBanner + finalBody;
    }
    
    console.log(`[Email] Testing mode: Redirecting email from ${originalRecipient} to ${finalTo}`);
  }

  if (provider === 'outlook') {
    if (!config.outlookConnected) {
      return { success: false, error: 'Outlook not connected', provider: 'outlook' };
    }
    const result = await sendOutlookEmail({ ...params, to: finalTo, subject: finalSubject, htmlBody: finalBody });
    return { ...result, provider: 'outlook' };
  }

  // Default to Gmail
  if (!config.gmailConnected) {
    return { success: false, error: 'Gmail not connected', provider: 'gmail' };
  }
  const result = await sendGmailEmail({ ...params, to: finalTo, subject: finalSubject, htmlBody: finalBody });
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
