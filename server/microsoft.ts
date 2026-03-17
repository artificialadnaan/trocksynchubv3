import { storage } from './storage';
import { Client } from '@microsoft/microsoft-graph-client';

const MICROSOFT_AUTH_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const GRAPH_API_URL = 'https://graph.microsoft.com/v1.0';

interface MicrosoftTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  userEmail?: string;
  userName?: string;
}

function getConfig() {
  return {
    clientId: process.env.MICROSOFT_CLIENT_ID || '',
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET || '',
    redirectUri: `${process.env.APP_URL || 'http://localhost:5000'}/api/oauth/microsoft/callback`,
  };
}

export function getMicrosoftAuthUrl(): string {
  const { clientId, redirectUri } = getConfig();
  
  if (!clientId) {
    throw new Error('MICROSOFT_CLIENT_ID not configured');
  }

  const scopes = [
    'openid',
    'profile',
    'email',
    'offline_access',
    'Files.ReadWrite.All',
    'Mail.Send',
    'Mail.ReadWrite',
    'User.Read',
    'Sites.ReadWrite.All',        // SharePoint site access
    'Sites.Manage.All',           // SharePoint management
  ].join(' ');

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: scopes,
    response_mode: 'query',
    prompt: 'consent',
  });

  return `${MICROSOFT_AUTH_URL}/authorize?${params.toString()}`;
}

export async function exchangeMicrosoftCode(code: string): Promise<MicrosoftTokens> {
  const { clientId, clientSecret, redirectUri } = getConfig();

  const response = await fetch(`${MICROSOFT_AUTH_URL}/token`, {
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
    throw new Error(`Microsoft token exchange failed: ${error}`);
  }

  const data = await response.json();
  const tokens: MicrosoftTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in * 1000),
    scope: data.scope,
  };

  // Get user info
  try {
    const userInfo = await getMicrosoftUserInfo(tokens.accessToken);
    tokens.userEmail = userInfo.mail || userInfo.userPrincipalName;
    tokens.userName = userInfo.displayName;
  } catch (e) {
    console.log('[Microsoft] Could not fetch user info:', e);
  }

  // Save tokens
  await storage.upsertAutomationConfig({
    key: 'microsoft_oauth',
    value: tokens,
    description: 'Microsoft OAuth tokens for OneDrive and Outlook',
    isActive: true,
  });

  console.log(`[Microsoft] OAuth connected for ${tokens.userEmail}`);
  return tokens;
}

async function refreshMicrosoftTokens(refreshToken: string): Promise<MicrosoftTokens> {
  const { clientId, clientSecret } = getConfig();

  const response = await fetch(`${MICROSOFT_AUTH_URL}/token`, {
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
    throw new Error(`Microsoft token refresh failed: ${error}`);
  }

  const data = await response.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt: Date.now() + (data.expires_in * 1000),
    scope: data.scope,
  };
}

export async function getMicrosoftTokens(): Promise<MicrosoftTokens | null> {
  const config = await storage.getAutomationConfig('microsoft_oauth');
  if (!config?.value) return null;

  const tokens = config.value as MicrosoftTokens;

  // Refresh if expired or expiring soon (5 min buffer)
  if (tokens.expiresAt < Date.now() + 300000) {
    try {
      const refreshed = await refreshMicrosoftTokens(tokens.refreshToken);
      refreshed.userEmail = tokens.userEmail;
      refreshed.userName = tokens.userName;

      await storage.upsertAutomationConfig({
        key: 'microsoft_oauth',
        value: refreshed,
        description: 'Microsoft OAuth tokens for OneDrive and Outlook',
        isActive: true,
      });

      return refreshed;
    } catch (error) {
      console.error('[Microsoft] Token refresh failed:', error);
      return null;
    }
  }

  return tokens;
}

async function getMicrosoftUserInfo(accessToken: string): Promise<any> {
  const response = await fetch(`${GRAPH_API_URL}/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error('Failed to get Microsoft user info');
  }

  return response.json();
}

export async function isMicrosoftConnected(): Promise<{ connected: boolean; email?: string; userName?: string }> {
  try {
    const tokens = await getMicrosoftTokens();
    if (!tokens) return { connected: false };
    return { connected: true, email: tokens.userEmail, userName: tokens.userName };
  } catch {
    return { connected: false };
  }
}

export async function disconnectMicrosoft(): Promise<void> {
  await storage.upsertAutomationConfig({
    key: 'microsoft_oauth',
    value: {},
    description: 'Microsoft OAuth tokens for OneDrive and Outlook',
    isActive: false,
  });
  console.log('[Microsoft] Disconnected');
}

// ============= OUTLOOK EMAIL =============

export async function sendOutlookEmail(params: {
  to: string;
  subject: string;
  htmlBody: string;
  fromName?: string;
}): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    const tokens = await getMicrosoftTokens();
    if (!tokens) {
      throw new Error('Microsoft/Outlook not connected');
    }

    const message = {
      subject: params.subject,
      body: {
        contentType: 'HTML',
        content: params.htmlBody,
      },
      toRecipients: [
        {
          emailAddress: {
            address: params.to,
          },
        },
      ],
    };

    const response = await fetch(`${GRAPH_API_URL}/me/sendMail`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message, saveToSentItems: true }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Outlook send failed: ${error}`);
    }

    console.log(`[Outlook] Sent to ${params.to}: "${params.subject}"`);
    return { success: true };
  } catch (error: any) {
    console.error(`[Outlook] Failed to send to ${params.to}:`, error.message);
    return { success: false, error: error.message };
  }
}

export async function isOutlookConnected(): Promise<boolean> {
  const status = await isMicrosoftConnected();
  return status.connected;
}

// ============= ONEDRIVE =============

export function getGraphClient(): Client | null {
  return null; // Will be initialized with token when needed
}

export async function createOneDriveFolder(folderPath: string): Promise<{ id: string; webUrl: string } | null> {
  const tokens = await getMicrosoftTokens();
  if (!tokens) {
    throw new Error('Microsoft/OneDrive not connected');
  }

  // Split path into parts and create each folder
  const parts = folderPath.split('/').filter(Boolean);
  let currentPath = '';
  let lastFolder: any = null;

  for (const part of parts) {
    const parentPath = currentPath || 'root';
    const endpoint = currentPath
      ? `${GRAPH_API_URL}/me/drive/root:/${currentPath}:/children`
      : `${GRAPH_API_URL}/me/drive/root/children`;

    // Check if folder exists
    const checkResponse = await fetch(
      `${GRAPH_API_URL}/me/drive/root:/${currentPath ? currentPath + '/' : ''}${part}`,
      {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      }
    );

    if (checkResponse.ok) {
      lastFolder = await checkResponse.json();
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      continue;
    }

    // Create folder
    const createResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: part,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'fail',
      }),
    });

    if (!createResponse.ok) {
      const error = await createResponse.text();
      // If conflict (folder exists), try to get it
      if (createResponse.status === 409) {
        const getResponse = await fetch(
          `${GRAPH_API_URL}/me/drive/root:/${currentPath ? currentPath + '/' : ''}${part}`,
          {
            headers: { Authorization: `Bearer ${tokens.accessToken}` },
          }
        );
        if (getResponse.ok) {
          lastFolder = await getResponse.json();
          currentPath = currentPath ? `${currentPath}/${part}` : part;
          continue;
        }
      }
      throw new Error(`Failed to create folder ${part}: ${error}`);
    }

    lastFolder = await createResponse.json();
    currentPath = currentPath ? `${currentPath}/${part}` : part;
  }

  return lastFolder ? { id: lastFolder.id, webUrl: lastFolder.webUrl } : null;
}

export async function uploadFileToOneDrive(
  folderPath: string,
  fileName: string,
  fileBuffer: Buffer,
  mimeType: string = 'application/octet-stream'
): Promise<{ id: string; webUrl: string; name: string } | null> {
  const tokens = await getMicrosoftTokens();
  if (!tokens) {
    throw new Error('Microsoft/OneDrive not connected');
  }

  const filePath = `${folderPath}/${fileName}`.replace(/\/+/g, '/');

  // For small files (< 4MB), use simple upload
  if (fileBuffer.length < 4 * 1024 * 1024) {
    const response = await fetch(
      `${GRAPH_API_URL}/me/drive/root:/${filePath}:/content`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          'Content-Type': mimeType,
        },
        body: fileBuffer,
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to upload file: ${error}`);
    }

    const result = await response.json();
    console.log(`[OneDrive] Uploaded ${fileName} to ${folderPath}`);
    return { id: result.id, webUrl: result.webUrl, name: result.name };
  }

  // For larger files, use upload session (chunked upload)
  const sessionResponse = await fetch(
    `${GRAPH_API_URL}/me/drive/root:/${filePath}:/createUploadSession`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        item: {
          '@microsoft.graph.conflictBehavior': 'replace',
        },
      }),
    }
  );

  if (!sessionResponse.ok) {
    const error = await sessionResponse.text();
    throw new Error(`Failed to create upload session: ${error}`);
  }

  const session = await sessionResponse.json();
  const uploadUrl = session.uploadUrl;

  // Upload in chunks
  const chunkSize = 320 * 1024 * 10; // 3.2 MB chunks
  let offset = 0;
  let result: any = null;

  while (offset < fileBuffer.length) {
    const end = Math.min(offset + chunkSize, fileBuffer.length);
    const chunk = fileBuffer.slice(offset, end);

    const chunkResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(chunk.length),
        'Content-Range': `bytes ${offset}-${end - 1}/${fileBuffer.length}`,
      },
      body: chunk,
    });

    if (!chunkResponse.ok && chunkResponse.status !== 202) {
      const error = await chunkResponse.text();
      throw new Error(`Chunk upload failed: ${error}`);
    }

    if (chunkResponse.status === 200 || chunkResponse.status === 201 || chunkResponse.status === 202) {
      const responseText = await chunkResponse.text();
      if (responseText) {
        try {
          result = JSON.parse(responseText);
        } catch {
          // 202 may not always have a body during intermediate chunks
        }
      }
    }

    offset = end;
  }

  console.log(`[OneDrive] Uploaded large file ${fileName} to ${folderPath}`);
  return result ? { id: result.id, webUrl: result.webUrl, name: result.name } : null;
}

export async function listOneDriveFolder(folderPath: string): Promise<any[]> {
  const tokens = await getMicrosoftTokens();
  if (!tokens) {
    throw new Error('Microsoft/OneDrive not connected');
  }

  const endpoint = folderPath
    ? `${GRAPH_API_URL}/me/drive/root:/${folderPath}:/children`
    : `${GRAPH_API_URL}/me/drive/root/children`;

  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to list folder: ${error}`);
  }

  const data = await response.json();
  return data.value || [];
}

export async function isOneDriveConnected(): Promise<boolean> {
  const status = await isMicrosoftConnected();
  return status.connected;
}

// ============= SHAREPOINT =============

interface SharePointConfig {
  siteUrl: string;       // e.g., "trockgc.sharepoint.com"
  siteName: string;      // e.g., "TRockProjects" 
  documentLibrary: string; // e.g., "Project Archives" (defaults to "Documents")
}

export async function getSharePointConfig(): Promise<SharePointConfig | null> {
  const config = await storage.getAutomationConfig('sharepoint_config');
  if (!config?.value) return null;
  return config.value as SharePointConfig;
}

export async function setSharePointConfig(config: SharePointConfig): Promise<void> {
  await storage.upsertAutomationConfig({
    key: 'sharepoint_config',
    value: config,
    description: 'SharePoint site configuration for project archives',
    isActive: true,
  });
  console.log(`[SharePoint] Configuration saved: ${config.siteUrl}/${config.siteName}`);
}

export async function isSharePointConfigured(): Promise<boolean> {
  const config = await getSharePointConfig();
  return !!(config?.siteUrl && config?.siteName);
}

export async function getSharePointSiteId(): Promise<string | null> {
  const tokens = await getMicrosoftTokens();
  if (!tokens) return null;

  const config = await getSharePointConfig();
  if (!config) return null;

  try {
    // Get site by hostname and site name
    const response = await fetch(
      `${GRAPH_API_URL}/sites/${config.siteUrl}:/sites/${config.siteName}`,
      {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      }
    );

    if (!response.ok) {
      // Try alternative format for root site or different path
      const altResponse = await fetch(
        `${GRAPH_API_URL}/sites/${config.siteUrl}:/${config.siteName}`,
        {
          headers: { Authorization: `Bearer ${tokens.accessToken}` },
        }
      );
      
      if (altResponse.ok) {
        const data = await altResponse.json();
        return data.id;
      }
      
      console.error('[SharePoint] Site not found:', await response.text());
      return null;
    }

    const data = await response.json();
    return data.id;
  } catch (error) {
    console.error('[SharePoint] Error getting site ID:', error);
    return null;
  }
}

export async function getSharePointDriveId(): Promise<string | null> {
  const tokens = await getMicrosoftTokens();
  if (!tokens) return null;

  const siteId = await getSharePointSiteId();
  if (!siteId) return null;

  const config = await getSharePointConfig();
  const libraryName = config?.documentLibrary || 'Documents';

  try {
    // Get drives (document libraries) for the site
    const response = await fetch(
      `${GRAPH_API_URL}/sites/${siteId}/drives`,
      {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      }
    );

    if (!response.ok) {
      console.error('[SharePoint] Failed to get drives:', await response.text());
      return null;
    }

    const data = await response.json();
    const drives = data.value || [];
    
    // Find the specified document library or default to first one
    const targetDrive = drives.find((d: any) => 
      d.name === libraryName || 
      d.name?.toLowerCase() === libraryName.toLowerCase()
    ) || drives[0];

    return targetDrive?.id || null;
  } catch (error) {
    console.error('[SharePoint] Error getting drive ID:', error);
    return null;
  }
}

export async function listSharePointSites(): Promise<Array<{ id: string; name: string; webUrl: string }>> {
  const tokens = await getMicrosoftTokens();
  if (!tokens) return [];

  try {
    const response = await fetch(
      `${GRAPH_API_URL}/sites?search=*`,
      {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      }
    );

    if (!response.ok) {
      console.error('[SharePoint] Failed to list sites:', await response.text());
      return [];
    }

    const data = await response.json();
    return (data.value || []).map((site: any) => ({
      id: site.id,
      name: site.displayName || site.name,
      webUrl: site.webUrl,
    }));
  } catch (error) {
    console.error('[SharePoint] Error listing sites:', error);
    return [];
  }
}

export async function listSharePointDrives(siteId?: string): Promise<Array<{ id: string; name: string; webUrl: string }>> {
  const tokens = await getMicrosoftTokens();
  if (!tokens) return [];

  const targetSiteId = siteId || await getSharePointSiteId();
  if (!targetSiteId) return [];

  try {
    const response = await fetch(
      `${GRAPH_API_URL}/sites/${targetSiteId}/drives`,
      {
        headers: { Authorization: `Bearer ${tokens.accessToken}` },
      }
    );

    if (!response.ok) {
      console.error('[SharePoint] Failed to list drives:', await response.text());
      return [];
    }

    const data = await response.json();
    return (data.value || []).map((drive: any) => ({
      id: drive.id,
      name: drive.name,
      webUrl: drive.webUrl,
    }));
  } catch (error) {
    console.error('[SharePoint] Error listing drives:', error);
    return [];
  }
}

export async function createSharePointFolder(folderPath: string): Promise<{ id: string; webUrl: string } | null> {
  const tokens = await getMicrosoftTokens();
  if (!tokens) {
    throw new Error('Microsoft not connected');
  }

  const driveId = await getSharePointDriveId();
  if (!driveId) {
    throw new Error('SharePoint not configured or site not found');
  }

  const siteId = await getSharePointSiteId();
  if (!siteId) {
    throw new Error('SharePoint site not found');
  }

  // Split path into parts and create each folder
  const parts = folderPath.split('/').filter(Boolean);
  let currentPath = '';
  let lastFolder: any = null;

  for (const part of parts) {
    const endpoint = currentPath
      ? `${GRAPH_API_URL}/sites/${siteId}/drives/${driveId}/root:/${currentPath}:/children`
      : `${GRAPH_API_URL}/sites/${siteId}/drives/${driveId}/root/children`;

    // Check if folder exists
    const checkEndpoint = currentPath
      ? `${GRAPH_API_URL}/sites/${siteId}/drives/${driveId}/root:/${currentPath}/${part}`
      : `${GRAPH_API_URL}/sites/${siteId}/drives/${driveId}/root:/${part}`;

    const checkResponse = await fetch(checkEndpoint, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
    });

    if (checkResponse.ok) {
      lastFolder = await checkResponse.json();
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      continue;
    }

    // Create folder
    const createResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: part,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'fail',
      }),
    });

    if (!createResponse.ok) {
      const error = await createResponse.text();
      // If conflict (folder exists), try to get it
      if (createResponse.status === 409) {
        const getResponse = await fetch(checkEndpoint, {
          headers: { Authorization: `Bearer ${tokens.accessToken}` },
        });
        if (getResponse.ok) {
          lastFolder = await getResponse.json();
          currentPath = currentPath ? `${currentPath}/${part}` : part;
          continue;
        }
      }
      throw new Error(`Failed to create SharePoint folder ${part}: ${error}`);
    }

    lastFolder = await createResponse.json();
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    console.log(`[SharePoint] Created folder: ${currentPath}`);
  }

  return lastFolder ? { id: lastFolder.id, webUrl: lastFolder.webUrl } : null;
}

export async function uploadFileToSharePoint(
  folderPath: string,
  fileName: string,
  fileBuffer: Buffer,
  mimeType: string = 'application/octet-stream'
): Promise<{ id: string; webUrl: string; name: string } | null> {
  const tokens = await getMicrosoftTokens();
  if (!tokens) {
    throw new Error('Microsoft not connected');
  }

  const driveId = await getSharePointDriveId();
  if (!driveId) {
    throw new Error('SharePoint not configured or site not found');
  }

  const siteId = await getSharePointSiteId();
  if (!siteId) {
    throw new Error('SharePoint site not found');
  }

  const filePath = `${folderPath}/${fileName}`.replace(/\/+/g, '/');

  // For small files (< 4MB), use simple upload
  if (fileBuffer.length < 4 * 1024 * 1024) {
    const response = await fetch(
      `${GRAPH_API_URL}/sites/${siteId}/drives/${driveId}/root:/${filePath}:/content`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          'Content-Type': mimeType,
        },
        body: fileBuffer,
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to upload file to SharePoint: ${error}`);
    }

    const result = await response.json();
    console.log(`[SharePoint] Uploaded ${fileName} to ${folderPath}`);
    return { id: result.id, webUrl: result.webUrl, name: result.name };
  }

  // For larger files, use upload session (chunked upload)
  const sessionResponse = await fetch(
    `${GRAPH_API_URL}/sites/${siteId}/drives/${driveId}/root:/${filePath}:/createUploadSession`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        item: {
          '@microsoft.graph.conflictBehavior': 'replace',
        },
      }),
    }
  );

  if (!sessionResponse.ok) {
    const error = await sessionResponse.text();
    throw new Error(`Failed to create SharePoint upload session: ${error}`);
  }

  const session = await sessionResponse.json();
  const uploadUrl = session.uploadUrl;

  // Upload in chunks
  const chunkSize = 320 * 1024 * 10; // 3.2 MB chunks
  let offset = 0;
  let result: any = null;

  while (offset < fileBuffer.length) {
    const end = Math.min(offset + chunkSize, fileBuffer.length);
    const chunk = fileBuffer.slice(offset, end);

    const chunkResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(chunk.length),
        'Content-Range': `bytes ${offset}-${end - 1}/${fileBuffer.length}`,
      },
      body: chunk,
    });

    if (!chunkResponse.ok && chunkResponse.status !== 202) {
      const error = await chunkResponse.text();
      throw new Error(`SharePoint chunk upload failed: ${error}`);
    }

    if (chunkResponse.status === 200 || chunkResponse.status === 201 || chunkResponse.status === 202) {
      const responseText = await chunkResponse.text();
      if (responseText) {
        try {
          result = JSON.parse(responseText);
        } catch {
          // 202 may not always have a body during intermediate chunks
        }
      }
    }

    offset = end;
  }

  console.log(`[SharePoint] Uploaded large file ${fileName} to ${folderPath}`);
  return result ? { id: result.id, webUrl: result.webUrl, name: result.name } : null;
}

export async function listSharePointFolder(folderPath: string): Promise<any[]> {
  const tokens = await getMicrosoftTokens();
  if (!tokens) {
    throw new Error('Microsoft not connected');
  }

  const driveId = await getSharePointDriveId();
  if (!driveId) {
    throw new Error('SharePoint not configured');
  }

  const siteId = await getSharePointSiteId();
  if (!siteId) {
    throw new Error('SharePoint site not found');
  }

  const endpoint = folderPath
    ? `${GRAPH_API_URL}/sites/${siteId}/drives/${driveId}/root:/${folderPath}:/children`
    : `${GRAPH_API_URL}/sites/${siteId}/drives/${driveId}/root/children`;

  const response = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${tokens.accessToken}` },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to list SharePoint folder: ${error}`);
  }

  const data = await response.json();
  return data.value || [];
}

export async function isSharePointConnected(): Promise<boolean> {
  const microsoftConnected = await isMicrosoftConnected();
  if (!microsoftConnected.connected) return false;
  
  const configured = await isSharePointConfigured();
  if (!configured) return false;
  
  // Verify we can access the site
  const siteId = await getSharePointSiteId();
  return !!siteId;
}
