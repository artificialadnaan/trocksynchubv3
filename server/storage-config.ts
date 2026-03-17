/**
 * Storage Configuration Manager
 * ==============================
 *
 * Manages which storage provider is active and how it's configured.
 * Persists to automation config (storage_provider_config).
 *
 * @module storage-config
 */

import { storage } from './storage';
import {
  StorageProvider,
  StorageProviderType,
  GoogleDriveProvider,
  SharePointProvider,
  LocalStorageProvider,
} from './storage-provider';

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export type { StorageProviderType };

export interface AutoArchiveConfig {
  enabled: boolean;
  triggerStage: string;
  includeDrawings: boolean;
  includeSubmittals: boolean;
  includeRFIs: boolean;
  includeBidPackages: boolean;
  includePhotos: boolean;
  includeBudget: boolean;
  includeDocuments: boolean;
}

export interface StorageProviderConfig {
  activeProvider: StorageProviderType;
  googleDrive?: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    rootFolderId?: string;
  };
  sharePoint?: {
    siteId?: string;
    driveId?: string;
  };
  local?: {
    basePath: string;
  };
  archiveBaseFolderName: string;
  autoArchive?: AutoArchiveConfig;
}

const DEFAULT_CONFIG: StorageProviderConfig = {
  activeProvider: 'google-drive',
  archiveBaseFolderName: 'T-Rock Projects',
  autoArchive: {
    enabled: false,
    triggerStage: 'Closeout',
    includeDrawings: true,
    includeSubmittals: true,
    includeRFIs: true,
    includeBidPackages: true,
    includePhotos: true,
    includeBudget: true,
    includeDocuments: true,
  },
};

// ---------------------------------------------------------------------------
// Module-level cache
// ---------------------------------------------------------------------------

let cachedConfig: StorageProviderConfig | null = null;
let cachedProvider: StorageProvider | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getStorageConfig(): Promise<StorageProviderConfig> {
  if (cachedConfig) return cachedConfig;

  const config = await storage.getAutomationConfig('storage_provider_config');
  const value = config?.value as Partial<StorageProviderConfig> | undefined;

  if (!value || typeof value !== 'object') {
    cachedConfig = { ...DEFAULT_CONFIG };
    return cachedConfig;
  }

  cachedConfig = {
    activeProvider: value.activeProvider ?? DEFAULT_CONFIG.activeProvider,
    googleDrive: value.googleDrive,
    sharePoint: value.sharePoint,
    local: value.local ?? { basePath: './archive-output' },
    archiveBaseFolderName: value.archiveBaseFolderName ?? DEFAULT_CONFIG.archiveBaseFolderName,
    autoArchive: {
      ...DEFAULT_CONFIG.autoArchive!,
      ...value.autoArchive,
    },
  };

  return cachedConfig;
}

function isRedactedPlaceholder(val: string | undefined): boolean {
  if (!val || typeof val !== 'string') return true;
  return val === '********' || val.startsWith('****');
}

export async function saveStorageConfig(partial: Partial<StorageProviderConfig>): Promise<StorageProviderConfig> {
  const current = await getStorageConfig();

  // Don't overwrite Google Drive secrets with redacted placeholders from GET
  const gd = partial.googleDrive;
  let mergedGd: StorageProviderConfig['googleDrive'] = gd
    ? {
        clientId: !isRedactedPlaceholder(gd.clientId) ? gd.clientId : (current.googleDrive?.clientId ?? gd.clientId),
        clientSecret: !isRedactedPlaceholder(gd.clientSecret) ? gd.clientSecret : (current.googleDrive?.clientSecret ?? gd.clientSecret),
        refreshToken: !isRedactedPlaceholder(gd.refreshToken) ? gd.refreshToken : (current.googleDrive?.refreshToken ?? gd.refreshToken),
        rootFolderId: gd.rootFolderId ?? current.googleDrive?.rootFolderId,
      }
    : current.googleDrive;

  const merged: StorageProviderConfig = {
    ...current,
    ...partial,
    googleDrive: mergedGd,
    autoArchive: partial.autoArchive ? { ...current.autoArchive, ...partial.autoArchive } : current.autoArchive,
  };

  await storage.upsertAutomationConfig({
    key: 'storage_provider_config',
    value: merged,
    description: 'Storage provider configuration for project archives',
    isActive: true,
  });

  cachedConfig = null;
  cachedProvider = null;
  return merged;
}

function getGoogleDriveConfigFromEnv(): StorageProviderConfig['googleDrive'] | null {
  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_DRIVE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) return null;
  return {
    clientId,
    clientSecret,
    refreshToken,
    rootFolderId: process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || undefined,
  };
}

export async function getStorageProvider(): Promise<StorageProvider> {
  if (cachedProvider) return cachedProvider;

  const config = await getStorageConfig();

  if (config.activeProvider === 'google-drive') {
    const gd = config.googleDrive ?? getGoogleDriveConfigFromEnv();
    if (!gd?.clientId || !gd.clientSecret || !gd.refreshToken) {
      throw new Error(
        'Google Drive not configured. Set storage config in Settings or env vars GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET, GOOGLE_DRIVE_REFRESH_TOKEN.'
      );
    }
    cachedProvider = new GoogleDriveProvider(gd);
    return cachedProvider;
  }

  if (config.activeProvider === 'sharepoint') {
    cachedProvider = new SharePointProvider();
    return cachedProvider;
  }

  if (config.activeProvider === 'local') {
    cachedProvider = new LocalStorageProvider(config.local ?? { basePath: './archive-output' });
    return cachedProvider;
  }

  throw new Error(`Unknown storage provider: ${config.activeProvider}`);
}

export interface TestStorageResult {
  connected: boolean;
  provider: StorageProviderType;
  details: Record<string, string>;
  error?: string;
}

export async function testStorageConnection(): Promise<TestStorageResult> {
  const config = await getStorageConfig();
  try {
    const provider = await getStorageProvider();
    const connected = await provider.isConnected();
    const details = provider.getConfigSummary();

    return {
      connected,
      provider: provider.providerType,
      details,
      ...(connected ? {} : { error: 'Provider returned not connected' }),
    };
  } catch (e: any) {
    return {
      connected: false,
      provider: config.activeProvider,
      details: {},
      error: e.message,
    };
  }
}

export async function getAutoArchiveConfig(): Promise<AutoArchiveConfig | null> {
  const config = await getStorageConfig();
  if (!config.autoArchive?.enabled) return null;
  return config.autoArchive;
}
