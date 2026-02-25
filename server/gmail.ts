import { google } from 'googleapis';

let connectionSettings: any;

async function getAccessToken() {
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

  if (!xReplitToken) {
    throw new Error('X-Replit-Token not found for repl/depl');
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

  const accessToken = connectionSettings?.settings?.access_token || connectionSettings.settings?.oauth?.credentials?.access_token;

  if (!connectionSettings || !accessToken) {
    throw new Error('Gmail not connected');
  }
  return accessToken;
}

async function getUncachableGmailClient() {
  const accessToken = await getAccessToken();
  const oauth2Client = new google.auth.OAuth2();
  oauth2Client.setCredentials({ access_token: accessToken });
  return google.gmail({ version: 'v1', auth: oauth2Client });
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
