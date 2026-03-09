/**
 * StorageSettings.tsx
 * ====================
 *
 * Settings panel for configuring the archive storage provider.
 * Drop this into the SyncHub settings page alongside existing settings panels.
 *
 * Talks to:
 *   GET    /api/settings/storage
 *   PUT    /api/settings/storage
 *   POST   /api/settings/storage/test
 *
 * Features:
 *   - Provider selector (Google Drive / SharePoint / Local)
 *   - Credential input per provider
 *   - Connection test button with live status
 *   - Auto-archive trigger configuration
 *   - Base folder name setting
 */

import { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/hooks/use-toast';
import {
  HardDrive,
  CloudIcon,
  FolderArchive,
  CheckCircle2,
  XCircle,
  Loader2,
  RefreshCw,
  Save,
  TestTube,
} from 'lucide-react';

// ─── Types ───────────────────────────────────────────────────────────────────

type StorageProviderType = 'google-drive' | 'sharepoint' | 'local';

interface StorageConfig {
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
  autoArchive?: {
    enabled: boolean;
    triggerStage: string;
    includeDrawings: boolean;
    includeSubmittals: boolean;
    includeRFIs: boolean;
    includeBidPackages: boolean;
    includePhotos: boolean;
    includeBudget: boolean;
    includeDocuments: boolean;
  };
}

interface TestResult {
  connected: boolean;
  provider: string;
  details: Record<string, string>;
  error?: string;
}

// ─── API Helpers ─────────────────────────────────────────────────────────────

async function fetchStorageConfig(): Promise<StorageConfig> {
  const res = await fetch('/api/settings/storage');
  if (!res.ok) throw new Error('Failed to load storage config');
  return res.json();
}

async function saveStorageConfig(config: Partial<StorageConfig>): Promise<void> {
  const res = await fetch('/api/settings/storage', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || err.error || 'Failed to save');
  }
}

async function testConnection(): Promise<TestResult> {
  const res = await fetch('/api/settings/storage/test', { method: 'POST' });
  if (!res.ok) throw new Error('Connection test failed');
  return res.json();
}

// ─── Provider Icons ──────────────────────────────────────────────────────────

const providerMeta: Record<StorageProviderType, { label: string; icon: typeof CloudIcon; description: string }> = {
  'google-drive': {
    label: 'Google Drive',
    icon: CloudIcon,
    description: 'Archive to Google Drive (recommended during development)',
  },
  sharepoint: {
    label: 'SharePoint',
    icon: FolderArchive,
    description: 'Archive to SharePoint (for T Rock post-handoff)',
  },
  local: {
    label: 'Local Filesystem',
    icon: HardDrive,
    description: 'Save to local disk (testing only)',
  },
};

// ─── Component ───────────────────────────────────────────────────────────────

export default function StorageSettings() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: config, isLoading } = useQuery({
    queryKey: ['storage-config'],
    queryFn: fetchStorageConfig,
  });

  // Local form state
  const [form, setForm] = useState<Partial<StorageConfig>>({});
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [isTesting, setIsTesting] = useState(false);

  // Sync fetched config into form state
  useEffect(() => {
    if (config) {
      setForm(config);
    }
  }, [config]);

  const saveMutation = useMutation({
    mutationFn: saveStorageConfig,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['storage-config'] });
      setTestResult(null);
      toast({ title: 'Storage settings saved' });
    },
    onError: (e: Error) => {
      toast({ title: 'Save failed', description: e.message, variant: 'destructive' });
    },
  });

  const handleTest = useCallback(async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const result = await testConnection();
      setTestResult(result);
      toast({
        title: result.connected ? 'Connection successful' : 'Connection failed',
        description: result.error || undefined,
        variant: result.connected ? 'default' : 'destructive',
      });
    } catch (e: unknown) {
      setTestResult({ connected: false, provider: form.activeProvider || '', details: {}, error: (e as Error).message });
    } finally {
      setIsTesting(false);
    }
  }, [form.activeProvider, toast]);

  const updateForm = (updates: Partial<StorageConfig>) => {
    setForm((prev) => ({ ...prev, ...updates }));
  };

  const updateGoogleDrive = (updates: Partial<NonNullable<StorageConfig['googleDrive']>>) => {
    setForm((prev) => ({
      ...prev,
      googleDrive: { ...prev.googleDrive, ...updates } as StorageConfig['googleDrive'],
    }));
  };

  const updateAutoArchive = (updates: Partial<NonNullable<StorageConfig['autoArchive']>>) => {
    setForm((prev) => ({
      ...prev,
      autoArchive: { ...prev.autoArchive, ...updates } as StorageConfig['autoArchive'],
    }));
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── Provider Selection ──────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FolderArchive className="h-5 w-5" />
            Archive Storage Provider
          </CardTitle>
          <CardDescription>
            Choose where archived project documents are stored. Switch providers without
            changing the archive logic.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label>Active Provider</Label>
            <Select
              value={form.activeProvider || 'google-drive'}
              onValueChange={(val: StorageProviderType) => updateForm({ activeProvider: val })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(providerMeta).map(([key, meta]) => (
                  <SelectItem key={key} value={key}>
                    <div className="flex items-center gap-2">
                      <meta.icon className="h-4 w-4" />
                      {meta.label}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">
              {providerMeta[form.activeProvider || 'google-drive']?.description}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="baseFolderName">Archive Base Folder</Label>
            <Input
              id="baseFolderName"
              value={form.archiveBaseFolderName || 'T-Rock Projects'}
              onChange={(e) => updateForm({ archiveBaseFolderName: e.target.value })}
              placeholder="T-Rock Projects"
            />
            <p className="text-sm text-muted-foreground">
              Root folder name in the storage provider. Projects are archived under this.
            </p>
          </div>

          <Separator />

          {/* ── Google Drive Config ─────────────────────────────────── */}
          {form.activeProvider === 'google-drive' && (
            <div className="space-y-4">
              <h4 className="font-medium">Google Drive Credentials</h4>
              <p className="text-sm text-muted-foreground">
                Run <code className="bg-muted px-1.5 py-0.5 rounded text-xs">npm run google-drive-setup</code> to
                get a refresh token, or set via environment variables.
              </p>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="gd-clientId">Client ID</Label>
                  <Input
                    id="gd-clientId"
                    value={form.googleDrive?.clientId || ''}
                    onChange={(e) => updateGoogleDrive({ clientId: e.target.value })}
                    placeholder="From Google Cloud Console"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="gd-clientSecret">Client Secret</Label>
                  <Input
                    id="gd-clientSecret"
                    type="password"
                    value={form.googleDrive?.clientSecret || ''}
                    onChange={(e) => updateGoogleDrive({ clientSecret: e.target.value })}
                    placeholder="••••••••"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="gd-refreshToken">Refresh Token</Label>
                <Input
                  id="gd-refreshToken"
                  type="password"
                  value={form.googleDrive?.refreshToken || ''}
                  onChange={(e) => updateGoogleDrive({ refreshToken: e.target.value })}
                  placeholder="From OAuth setup script"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="gd-rootFolder">Root Folder ID (optional)</Label>
                <Input
                  id="gd-rootFolder"
                  value={form.googleDrive?.rootFolderId || ''}
                  onChange={(e) => updateGoogleDrive({ rootFolderId: e.target.value })}
                  placeholder="Leave blank for My Drive root"
                />
                <p className="text-sm text-muted-foreground">
                  If using a Shared Drive or specific folder, paste its ID here.
                </p>
              </div>
            </div>
          )}

          {/* ── SharePoint Config ───────────────────────────────────── */}
          {form.activeProvider === 'sharepoint' && (
            <div className="space-y-4">
              <h4 className="font-medium">SharePoint Configuration</h4>
              <p className="text-sm text-muted-foreground">
                SharePoint authentication is managed via the Microsoft integration in Settings.
                These optional fields override the default site/drive.
              </p>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="sp-siteId">Site ID (optional)</Label>
                  <Input
                    id="sp-siteId"
                    value={form.sharePoint?.siteId || ''}
                    onChange={(e) =>
                      updateForm({ sharePoint: { ...form.sharePoint, siteId: e.target.value } })
                    }
                    placeholder="Auto-detected from Microsoft config"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sp-driveId">Drive ID (optional)</Label>
                  <Input
                    id="sp-driveId"
                    value={form.sharePoint?.driveId || ''}
                    onChange={(e) =>
                      updateForm({ sharePoint: { ...form.sharePoint, driveId: e.target.value } })
                    }
                    placeholder="Default document library"
                  />
                </div>
              </div>
            </div>
          )}

          {/* ── Local Config ────────────────────────────────────────── */}
          {form.activeProvider === 'local' && (
            <div className="space-y-4">
              <h4 className="font-medium">Local Filesystem</h4>
              <div className="space-y-2">
                <Label htmlFor="local-path">Base Path</Label>
                <Input
                  id="local-path"
                  value={form.local?.basePath || './archive-output'}
                  onChange={(e) => updateForm({ local: { basePath: e.target.value } })}
                  placeholder="./archive-output"
                />
              </div>
            </div>
          )}

          <Separator />

          {/* ── Connection Test ──────────────────────────────────────── */}
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              onClick={handleTest}
              disabled={isTesting}
            >
              {isTesting ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <TestTube className="h-4 w-4 mr-2" />
              )}
              Test Connection
            </Button>

            {testResult && (
              <Badge variant={testResult.connected ? 'default' : 'destructive'} className="gap-1">
                {testResult.connected ? (
                  <CheckCircle2 className="h-3 w-3" />
                ) : (
                  <XCircle className="h-3 w-3" />
                )}
                {testResult.connected ? 'Connected' : testResult.error || 'Failed'}
              </Badge>
            )}
          </div>

          {testResult?.connected && testResult.details && Object.keys(testResult.details).length > 0 && (
            <div className="bg-muted/50 rounded-md p-3 text-sm space-y-1">
              {Object.entries(testResult.details).map(([k, v]) => (
                <div key={k} className="flex justify-between">
                  <span className="text-muted-foreground">{k}</span>
                  <span className="font-mono">{v}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Auto-Archive Configuration ────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5" />
            Auto-Archive Trigger
          </CardTitle>
          <CardDescription>
            Automatically archive a project when it reaches a specific Procore stage.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <Label>Enable Auto-Archive</Label>
              <p className="text-sm text-muted-foreground">
                Triggered via Procore webhook when project stage changes
              </p>
            </div>
            <Switch
              checked={form.autoArchive?.enabled || false}
              onCheckedChange={(checked) => updateAutoArchive({ enabled: checked })}
            />
          </div>

          {form.autoArchive?.enabled && (
            <>
              <div className="space-y-2">
                <Label htmlFor="triggerStage">Trigger Stage</Label>
                <Input
                  id="triggerStage"
                  value={form.autoArchive?.triggerStage || 'Closeout'}
                  onChange={(e) => updateAutoArchive({ triggerStage: e.target.value })}
                  placeholder="Closeout"
                />
                <p className="text-sm text-muted-foreground">
                  Case-insensitive match against the Procore project stage field.
                </p>
              </div>

              <Separator />

              <div className="space-y-3">
                <Label>Document Types to Archive</Label>
                {[
                  { key: 'includeDocuments' as const, label: 'Project Documents' },
                  { key: 'includeDrawings' as const, label: 'Drawings' },
                  { key: 'includeSubmittals' as const, label: 'Submittals' },
                  { key: 'includeRFIs' as const, label: 'RFIs' },
                  { key: 'includeBidPackages' as const, label: 'Bid Packages' },
                  { key: 'includePhotos' as const, label: 'Photos' },
                  { key: 'includeBudget' as const, label: 'Budget Data' },
                ].map(({ key, label }) => (
                  <div key={key} className="flex items-center justify-between">
                    <Label className="font-normal">{label}</Label>
                    <Switch
                      checked={form.autoArchive?.[key] ?? true}
                      onCheckedChange={(checked) => updateAutoArchive({ [key]: checked })}
                    />
                  </div>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Save Button ───────────────────────────────────────────── */}
      <div className="flex justify-end">
        <Button
          onClick={() => saveMutation.mutate(form)}
          disabled={saveMutation.isPending}
          size="lg"
        >
          {saveMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
          ) : (
            <Save className="h-4 w-4 mr-2" />
          )}
          Save Storage Settings
        </Button>
      </div>
    </div>
  );
}
