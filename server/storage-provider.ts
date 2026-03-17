/**
 * Storage Provider Interface and Implementations
 * ==============================================
 *
 * Abstract storage layer for project archives. Supports Google Drive,
 * SharePoint, and local filesystem for testing.
 *
 * @module storage-provider
 */

import { Readable } from 'stream';
import { mkdir, writeFile, readdir, stat } from 'fs/promises';
import { join, resolve } from 'path';
import { createSharePointFolder, uploadFileToSharePoint, listSharePointFolder, isSharePointConnected } from './microsoft';
import { google } from 'googleapis';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface FolderResult {
  id: string;
  name: string;
  path: string;
  webUrl: string;
}

export interface FileResult {
  id: string;
  name: string;
  path: string;
  webUrl: string;
  size: number;
}

export interface FileListItem {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  modifiedAt: string;
}

export type StorageProviderType = 'google-drive' | 'sharepoint' | 'local';

export interface StorageProvider {
  readonly providerType: StorageProviderType;
  isConnected(): Promise<boolean>;
  createFolder(path: string): Promise<FolderResult>;
  uploadFile(folderPath: string, fileName: string, content: Buffer, mimeType: string): Promise<FileResult>;
  getUrl(path: string): Promise<string | null>;
  listFiles(folderPath: string): Promise<FileListItem[]>;
  getConfigSummary(): Record<string, string>;
}

// ---------------------------------------------------------------------------
// Google Drive Provider
// ---------------------------------------------------------------------------

interface GoogleDriveProviderConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  rootFolderId?: string;
}

export class GoogleDriveProvider implements StorageProvider {
  readonly providerType = 'google-drive' as const;
  private drive: ReturnType<typeof google.drive>;
  private config: GoogleDriveProviderConfig;
  private pathCache = new Map<string, string>();

  constructor(config: GoogleDriveProviderConfig) {
    this.config = config;
    const auth = new google.auth.OAuth2(config.clientId, config.clientSecret);
    auth.setCredentials({ refresh_token: config.refreshToken });
    this.drive = google.drive({ version: 'v3', auth });
  }

  async isConnected(): Promise<boolean> {
    try {
      await this.drive.about.get({ fields: 'user' });
      return true;
    } catch {
      return false;
    }
  }

  async createFolder(path: string): Promise<FolderResult> {
    const segments = path.split('/').filter(Boolean);
    let parentId = this.config.rootFolderId || 'root';
    let builtPath = '';

    for (const segment of segments) {
      builtPath = builtPath ? `${builtPath}/${segment}` : segment;

      const cached = this.pathCache.get(builtPath);
      if (cached) {
        parentId = cached;
        continue;
      }

      const listRes = await this.drive.files.list({
        q: `name='${segment.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id, name, webViewLink)',
        pageSize: 1,
      });

      const existing = listRes.data.files?.[0];
      if (existing) {
        parentId = existing.id!;
        this.pathCache.set(builtPath, parentId);
        continue;
      }

      const createRes = await this.drive.files.create({
        requestBody: {
          name: segment,
          mimeType: 'application/vnd.google-apps.folder',
          parents: parentId === 'root' ? undefined : [parentId],
        },
        fields: 'id, name, webViewLink',
      });

      const folder = createRes.data;
      if (!folder.id) throw new Error(`Failed to create folder: ${segment}`);
      parentId = folder.id;
      this.pathCache.set(builtPath, parentId);
    }

    const folderId = parentId;
    const lastSegment = segments[segments.length - 1] || path;
    const webUrl = `https://drive.google.com/drive/folders/${folderId}`;

    return {
      id: folderId,
      name: lastSegment,
      path,
      webUrl,
    };
  }

  async uploadFile(folderPath: string, fileName: string, content: Buffer, mimeType: string): Promise<FileResult> {
    const folder = await this.createFolder(folderPath);
    const media = {
      mimeType,
      body: Readable.from(content),
    };

    const createRes = await this.drive.files.create({
      requestBody: {
        name: fileName,
        parents: [folder.id],
      },
      media,
      fields: 'id, name, size, webViewLink',
    });

    const file = createRes.data;
    if (!file.id) throw new Error('Failed to upload file');
    const filePath = `${folderPath}/${fileName}`;

    return {
      id: file.id,
      name: fileName,
      path: filePath,
      webUrl: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`,
      size: Number(file.size) || content.length,
    };
  }

  async getUrl(path: string): Promise<string | null> {
    const cached = this.pathCache.get(path);
    if (cached) {
      return `https://drive.google.com/drive/folders/${cached}`;
    }
    try {
      const folder = await this.createFolder(path);
      return folder.webUrl;
    } catch {
      return null;
    }
  }

  async listFiles(folderPath: string): Promise<FileListItem[]> {
    const folder = await this.createFolder(folderPath);
    const listRes = await this.drive.files.list({
      q: `'${folder.id}' in parents and trashed=false`,
      fields: 'files(id, name, mimeType, size, modifiedTime)',
    });

    return (listRes.data.files || []).map((f) => ({
      id: f.id!,
      name: f.name || 'Unknown',
      mimeType: f.mimeType || 'application/octet-stream',
      size: Number(f.size) || 0,
      modifiedAt: f.modifiedTime || new Date().toISOString(),
    }));
  }

  getConfigSummary(): Record<string, string> {
    return {
      provider: 'Google Drive',
      clientId: this.config.clientId ? `${this.config.clientId.slice(0, 8)}...` : '(not set)',
      rootFolderId: this.config.rootFolderId || '(default root)',
    };
  }
}

// ---------------------------------------------------------------------------
// SharePoint Provider
// ---------------------------------------------------------------------------

export class SharePointProvider implements StorageProvider {
  readonly providerType = 'sharepoint' as const;

  async isConnected(): Promise<boolean> {
    return isSharePointConnected();
  }

  async createFolder(path: string): Promise<FolderResult> {
    const result = await createSharePointFolder(path);
    if (!result) throw new Error('Failed to create SharePoint folder');
    return {
      id: result.id,
      name: path.split('/').filter(Boolean).pop() || path,
      path,
      webUrl: result.webUrl,
    };
  }

  async uploadFile(folderPath: string, fileName: string, content: Buffer, mimeType: string): Promise<FileResult> {
    const result = await uploadFileToSharePoint(folderPath, fileName, content, mimeType);
    if (!result) throw new Error('Failed to upload file to SharePoint');
    return {
      id: result.id,
      name: result.name,
      path: `${folderPath}/${fileName}`,
      webUrl: result.webUrl,
      size: content.length,
    };
  }

  async getUrl(path: string): Promise<string | null> {
    try {
      const folder = await this.createFolder(path);
      return folder.webUrl;
    } catch {
      return null;
    }
  }

  async listFiles(folderPath: string): Promise<FileListItem[]> {
    const items = await listSharePointFolder(folderPath);
    return items.map((f: any) => ({
      id: f.id || f.name,
      name: f.name || 'Unknown',
      mimeType: f.file?.mimeType || 'application/octet-stream',
      size: f.size || 0,
      modifiedAt: f.lastModifiedDateTime || new Date().toISOString(),
    }));
  }

  getConfigSummary(): Record<string, string> {
    return {
      provider: 'SharePoint',
      note: 'Uses Microsoft OAuth and SharePoint site config from Settings',
    };
  }
}

// ---------------------------------------------------------------------------
// Local Storage Provider (for testing)
// ---------------------------------------------------------------------------

interface LocalStorageProviderConfig {
  basePath: string;
}

export class LocalStorageProvider implements StorageProvider {
  readonly providerType = 'local' as const;
  private basePath: string;

  constructor(config: LocalStorageProviderConfig = { basePath: './archive-output' }) {
    this.basePath = resolve(process.cwd(), config.basePath);
  }

  async isConnected(): Promise<boolean> {
    try {
      await mkdir(this.basePath, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  async createFolder(path: string): Promise<FolderResult> {
    const fullPath = join(this.basePath, path);
    await mkdir(fullPath, { recursive: true });
    const name = path.split('/').filter(Boolean).pop() || path;
    return {
      id: fullPath,
      name,
      path,
      webUrl: `file://${fullPath}`,
    };
  }

  async uploadFile(folderPath: string, fileName: string, content: Buffer, _mimeType: string): Promise<FileResult> {
    const fullDir = join(this.basePath, folderPath);
    await mkdir(fullDir, { recursive: true });
    const fullPath = join(fullDir, fileName);
    await writeFile(fullPath, content);
    return {
      id: fullPath,
      name: fileName,
      path: `${folderPath}/${fileName}`,
      webUrl: `file://${fullPath}`,
      size: content.length,
    };
  }

  async getUrl(path: string): Promise<string | null> {
    const fullPath = join(this.basePath, path);
    try {
      const st = await stat(fullPath);
      return st.isDirectory() ? `file://${fullPath}` : `file://${fullPath}`;
    } catch {
      return null;
    }
  }

  async listFiles(folderPath: string): Promise<FileListItem[]> {
    const fullPath = join(this.basePath, folderPath);
    const items: FileListItem[] = [];
    try {
      const entries = await readdir(fullPath, { withFileTypes: true });
      for (const e of entries) {
        const entryPath = join(fullPath, e.name);
        const st = await stat(entryPath);
        items.push({
          id: entryPath,
          name: e.name,
          mimeType: e.isDirectory() ? 'application/vnd.google-apps.folder' : 'application/octet-stream',
          size: st.size,
          modifiedAt: st.mtime.toISOString(),
        });
      }
    } catch {
      // Directory may not exist
    }
    return items;
  }

  getConfigSummary(): Record<string, string> {
    return {
      provider: 'Local',
      basePath: this.basePath,
    };
  }
}
