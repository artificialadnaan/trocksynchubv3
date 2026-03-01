/**
 * Gmail Integration Module
 * ========================
 * 
 * This module handles Gmail API integration for sending email notifications.
 * Uses Google OAuth 2.0 for authentication.
 * 
 * OAuth Flow:
 * 1. User clicks "Connect Gmail" in settings
 * 2. Redirect to Google OAuth consent screen
 * 3. User authorizes application
 * 4. Callback receives authorization code
 * 5. Exchange code for access/refresh tokens
 * 6. Store tokens in database
 * 
 * Features:
 * - Send emails via Gmail API
 * - Automatic token refresh when expired
 * - Read user's email address for display
 * - HTML email support
 * 
 * Gmail API Scopes:
 * - gmail.send: Send emails
 * - gmail.readonly: Read user info
 * - openid, profile, email: User identification
 * 
 * Key Functions:
 * - getGmailAuthUrl(): Generate OAuth authorization URL
 * - exchangeGmailCode(): Exchange auth code for tokens
 * - sendEmail(): Send email via Gmail API
 * - isGmailConnected(): Check if Gmail is connected
 * - getGmailConnectionStatus(): Get connection details
 * 
 * Environment Variables:
 * - GOOGLE_CLIENT_ID: OAuth client ID
 * - GOOGLE_CLIENT_SECRET: OAuth client secret
 * - APP_URL: Application base URL for callback
 * 
 * @module gmail
 */

import { google } from 'googleapis';
import { storage } from './storage';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Gmail OAuth token storage */
interface GmailTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userEmail?: string;
  userName?: string;
}

let connectionSettings: any;

function getGoogleConfig() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: `${process.env.APP_URL || 'http://localhost:5000'}/api/oauth/google/callback`,
  };
}

export function getGmailAuthUrl(): string {
  const { clientId, redirectUri } = getGoogleConfig();

  if (!clientId) {
    throw new Error('GOOGLE_CLIENT_ID not configured');
  }

  const scopes = [
    'openid',
    'profile',
    'email',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.readonly',
  ].join(' ');

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes,
    access_type: 'offline',
    prompt: 'consent',
  });

  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export async function exchangeGoogleCode(code: string): Promise<GmailTokens> {
  const { clientId, clientSecret, redirectUri } = getGoogleConfig();

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Google token exchange failed: ${error}`);
  }

  const data = await response.json();
  const tokens: GmailTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in * 1000),
  };

  // Get user info
  try {
    const userInfo = await getGoogleUserInfo(tokens.accessToken);
    tokens.userEmail = userInfo.email;
    tokens.userName = userInfo.name;
  } catch (e) {
    console.log('[Gmail] Could not fetch user info:', e);
  }

  // Save tokens
  await storage.upsertAutomationConfig({
    key: 'gmail_oauth',
    value: tokens,
    description: 'Gmail OAuth tokens',
    isActive: true,
  });

  console.log(`[Gmail] OAuth connected for ${tokens.userEmail}`);
  return tokens;
}

async function refreshGmailTokens(refreshToken: string): Promise<GmailTokens> {
  const { clientId, clientSecret } = getGoogleConfig();

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gmail token refresh failed: ${error}`);
  }

  const data = await response.json();
  return {
    accessToken: data.access_token,
    refreshToken: refreshToken, // Google doesn't always return a new refresh token
    expiresAt: Date.now() + (data.expires_in * 1000),
  };
}

async function getGoogleUserInfo(accessToken: string): Promise<any> {
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error('Failed to get Google user info');
  }

  return response.json();
}

export async function getGmailTokens(): Promise<GmailTokens | null> {
  // First check for stored OAuth tokens
  const config = await storage.getAutomationConfig('gmail_oauth');
  if (config?.value && (config.value as GmailTokens).accessToken) {
    const tokens = config.value as GmailTokens;

    // Refresh if expired or expiring soon (5 min buffer)
    if (tokens.expiresAt < Date.now() + 300000) {
      try {
        const refreshed = await refreshGmailTokens(tokens.refreshToken);
        refreshed.userEmail = tokens.userEmail;
        refreshed.userName = tokens.userName;

        await storage.upsertAutomationConfig({
          key: 'gmail_oauth',
          value: refreshed,
          description: 'Gmail OAuth tokens',
          isActive: true,
        });

        return refreshed;
      } catch (error) {
        console.error('[Gmail] Token refresh failed:', error);
        return null;
      }
    }

    return tokens;
  }

  return null;
}

async function getAccessToken(): Promise<string> {
  // First try our OAuth tokens
  const gmailTokens = await getGmailTokens();
  if (gmailTokens) {
    return gmailTokens.accessToken;
  }

  // Fall back to environment variable
  if (process.env.GMAIL_ACCESS_TOKEN) {
    return process.env.GMAIL_ACCESS_TOKEN;
  }

  // Fall back to Replit connector
  if (connectionSettings?.settings?.expires_at && new Date(connectionSettings.settings.expires_at).getTime() > Date.now()) {
    const cachedToken = connectionSettings.settings?.access_token || connectionSettings.settings?.oauth?.credentials?.access_token;
    if (cachedToken) return cachedToken;
  }
  connectionSettings = null;

  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? 'repl ' + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
    ? 'depl ' + process.env.WEB_REPL_RENEWAL
    : null;

  if (!xReplitToken || !hostname) {
    throw new Error('Gmail not connected. Configure Gmail OAuth in Settings or set GMAIL_ACCESS_TOKEN env var.');
  }

  connectionSettings = await fetch(
    'https://' + hostname + '/api/v2/connection?include_secrets=true&connector_names=google-mail',
    {
      headers: {
        'Accept': 'application/json',
        'X-Replit-Token': xReplitToken
      }
    }
  ).then(res => res.json()).then(data => data.items?.[0]);

  const accessToken = connectionSettings?.settings?.access_token || connectionSettings?.settings?.oauth?.credentials?.access_token;

  if (!connectionSettings || !accessToken) {
    throw new Error('Gmail not connected. Configure Gmail OAuth in Settings or set GMAIL_ACCESS_TOKEN env var.');
  }
  return accessToken;
}

async function getUncachableGmailClient() {
  const accessToken = await getAccessToken();
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

export async function disconnectGmail(): Promise<void> {
  await storage.upsertAutomationConfig({
    key: 'gmail_oauth',
    value: {},
    description: 'Gmail OAuth tokens',
    isActive: false,
  });
  console.log('[Gmail] Disconnected');
}

export async function getGmailConnectionStatus(): Promise<{ connected: boolean; email?: string; userName?: string; method?: string }> {
  // Check OAuth tokens first
  const tokens = await getGmailTokens();
  if (tokens) {
    return { connected: true, email: tokens.userEmail, userName: tokens.userName, method: 'oauth' };
  }

  // Check env var
  if (process.env.GMAIL_ACCESS_TOKEN) {
    return { connected: true, method: 'env' };
  }

  // Check Replit connector
  try {
    await getAccessToken();
    return { connected: true, method: 'replit' };
  } catch {
    return { connected: false };
  }
}

function buildRawEmail(to: string, subject: string, htmlBody: string, fromName?: string): string {
  const boundary = `boundary_${Date.now()}`;
  const lines = [
    `From: ${fromName ? `${fromName} <me>` : 'me'}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    htmlBody,
    ``,
    `--${boundary}--`,
  ];
  const rawEmail = lines.join('\r\n');
  return Buffer.from(rawEmail).toString('base64url');
}

export async function sendEmail(params: {
  to: string;
  subject: string;
  htmlBody: string;
  fromName?: string;
}): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    const gmail = await getUncachableGmailClient();
    const raw = buildRawEmail(params.to, params.subject, params.htmlBody, params.fromName);
    const result = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw },
    });
    console.log(`[Email] Sent to ${params.to}: "${params.subject}" (ID: ${result.data.id})`);
    return { success: true, messageId: result.data.id || undefined };
  } catch (error: any) {
    console.error(`[Email] Failed to send to ${params.to}:`, error.message);
    return { success: false, error: error.message };
  }
}

export function renderTemplate(template: string, variables: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value || '');
  }
  return result;
}

export async function isGmailConnected(): Promise<boolean> {
  try {
    await getAccessToken();
    return true;
  } catch {
    return false;
  }
}
