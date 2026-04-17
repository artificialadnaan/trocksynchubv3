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

function normalizeOutgoingEmailHtml(htmlBody: string): string {
  return htmlBody
    // Outlook can drop gradient backgrounds entirely; keep the gradient but add a flat fallback.
    .replace(/background:\s*linear-gradient\(([^;]+)\);/g, (_match, gradientArgs: string) => {
      const firstColor = gradientArgs.match(/#(?:[0-9a-fA-F]{3,8})/)?.[0] || '#1a1a2e';
      return `background-color: ${firstColor}; background-image: linear-gradient(${gradientArgs});`;
    })
    // Glow-only CTA styling can wash out in Outlook. Borders hold up better.
    .replace(/box-shadow:\s*0 4px 14px rgba\(209,\s*25,\s*33,\s*0\.4\);/g, 'border: 2px solid #b71c1c;')
    // Common dark-card labels need stronger contrast.
    .replace(
      /color:\s*#94a3b8;\s*font-size:\s*11px;\s*text-transform:\s*uppercase;\s*font-weight:\s*600;\s*letter-spacing:\s*1px;/g,
      'color: #cbd5e1; font-size: 11px; text-transform: uppercase; font-weight: 700; letter-spacing: 1px;'
    )
    .replace(
      'color: #94a3b8; font-size: 13px; margin: 0 0 10px 0; line-height: 1.5;',
      'color: #cbd5e1; font-size: 13px; margin: 0 0 10px 0; line-height: 1.5;'
    )
    .replace(
      'color: #64748b; font-size: 12px; margin: 0;',
      'color: #94a3b8; font-size: 12px; margin: 0;'
    )
    .replace(
      'color: #475569; font-size: 11px; margin: 20px 0 0 0;',
      'color: #94a3b8; font-size: 11px; margin: 20px 0 0 0;'
    );
}

// Global CC recipients for all outgoing emails
const GLOBAL_CC_RECIPIENTS = [
  'adnaan.iqbal@gmail.com',
  'bbell@trockgc.com',
];

export async function sendEmail(params: {
  to: string;
  subject: string;
  htmlBody: string;
  fromName?: string;
  provider?: EmailProvider;
  cc?: string[];
}): Promise<{ success: boolean; messageId?: string; error?: string; provider: string }> {
  const config = await getEmailConfig();
  const provider = params.provider || config.activeProvider;

  // Build CC list: merge global CC with any per-email CC, excluding the primary recipient
  const ccSet = new Set([...GLOBAL_CC_RECIPIENTS, ...(params.cc || [])]);
  ccSet.delete(params.to); // Don't CC someone who is already the To recipient
  const finalCc = Array.from(ccSet);

  // Check for testing mode - redirect all emails to test address
  const testingMode = await storage.getTestingMode();
  let finalTo = params.to;
  let finalSubject = params.subject;
  let finalBody = normalizeOutgoingEmailHtml(params.htmlBody);

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

  const sendWithGmailFallback = async (fallbackReason: string): Promise<{ success: boolean; messageId?: string; error?: string; provider: string }> => {
    if (!config.gmailConnected) {
      return { success: false, error: fallbackReason, provider: 'outlook' };
    }

    console.warn(`[Email] Outlook unavailable, falling back to Gmail: ${fallbackReason}`);
    const gmailResult = await sendGmailEmail({
      ...params,
      to: finalTo,
      subject: finalSubject,
      htmlBody: finalBody,
    });

    return {
      ...gmailResult,
      provider: 'gmail',
      error: gmailResult.success ? undefined : `${fallbackReason}; Gmail fallback failed: ${gmailResult.error || 'Unknown Gmail error'}`,
    };
  };

  if (provider === 'outlook') {
    if (!config.outlookConnected) {
      return sendWithGmailFallback('Outlook not connected');
    }
    const result = await sendOutlookEmail({ ...params, to: finalTo, subject: finalSubject, htmlBody: finalBody, cc: testingMode.enabled ? [] : finalCc });
    if (result.success) {
      return { ...result, provider: 'outlook' };
    }
    return sendWithGmailFallback(result.error || 'Outlook send failed');
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
export { normalizeOutgoingEmailHtml };
