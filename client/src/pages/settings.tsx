import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  Link2,
  Clock,
  Shield,
  Activity,
  CheckCircle2,
  XCircle,
  Loader2,
  Settings2,
  Unplug,
  RefreshCw,
  ArrowRightLeft,
  Save,
  UserPlus,
  Wifi,
  WifiOff,
  Hash,
} from "lucide-react";
import { useState, useEffect } from "react";
import type { PollJob } from "@shared/schema";

export default function SettingsPage() {
  const { toast } = useToast();
  const [hubspotDialogOpen, setHubspotDialogOpen] = useState(false);
  const [procoreDialogOpen, setProcoreDialogOpen] = useState(false);
  const [companycamDialogOpen, setCompanycamDialogOpen] = useState(false);
  const [microsoftDialogOpen, setMicrosoftDialogOpen] = useState(false);
  const [gmailDialogOpen, setGmailDialogOpen] = useState(false);

  const { data: connections, isLoading: connLoading } = useQuery<any>({
    queryKey: ["/api/dashboard/connections"],
  });

  const { data: microsoftStatus } = useQuery<{ connected: boolean; email?: string; userName?: string }>({
    queryKey: ["/api/integrations/microsoft/status"],
  });

  const { data: gmailStatus } = useQuery<{ connected: boolean; email?: string; userName?: string; method?: string }>({
    queryKey: ["/api/integrations/gmail/status"],
  });

  const { data: integrationConfig } = useQuery<any>({
    queryKey: ["/api/integrations/config"],
  });

  const { data: pollJobs, isLoading: jobsLoading } = useQuery<PollJob[]>({
    queryKey: ["/api/poll-jobs"],
  });

  const toggleJobMutation = useMutation({
    mutationFn: async ({ jobName, isActive }: { jobName: string; isActive: boolean }) => {
      const res = await apiRequest("PATCH", `/api/poll-jobs/${jobName}`, { isActive });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/poll-jobs"] });
      toast({ title: "Poll job updated" });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: async (provider: string) => {
      const res = await apiRequest("POST", `/api/integrations/${provider}/disconnect`);
      return res.json();
    },
    onSuccess: (_data, provider) => {
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/connections"] });
      queryClient.invalidateQueries({ queryKey: ["/api/integrations/config"] });
      toast({ title: `${provider} disconnected` });
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold" data-testid="text-settings-title">Settings</h2>
        <p className="text-muted-foreground text-sm mt-1">Manage connections, schedules, and system configuration</p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Link2 className="w-4 h-4" />
            API Connections
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {connLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : (
            <>
              <ConnectionCard
                name="HubSpot CRM"
                description="Deals, Companies, Contacts, Attachments"
                connected={connections?.hubspot?.connected}
                configuredAt={(integrationConfig?.hubspot as any)?.configuredAt}
                onConfigure={() => setHubspotDialogOpen(true)}
                onDisconnect={() => disconnectMutation.mutate("hubspot")}
              />
              <ConnectionCard
                name="Procore"
                description="Bid Board, Projects, Contracts, Directory, Webhooks"
                connected={connections?.procore?.connected}
                expiresAt={connections?.procore?.expiresAt}
                configuredAt={(integrationConfig?.procore as any)?.configuredAt}
                onConfigure={() => setProcoreDialogOpen(true)}
                onDisconnect={() => disconnectMutation.mutate("procore")}
              />
              <ConnectionCard
                name="CompanyCam"
                description="Projects, Photos, Webhooks"
                connected={connections?.companycam?.connected}
                configuredAt={(integrationConfig?.companycam as any)?.configuredAt}
                onConfigure={() => setCompanycamDialogOpen(true)}
                onDisconnect={() => disconnectMutation.mutate("companycam")}
              />

              <Separator className="my-2" />
              <p className="text-xs text-muted-foreground font-medium mb-2">Email & Cloud Storage</p>

              <ConnectionCard
                name="Gmail"
                description="Send emails via Gmail API"
                connected={gmailStatus?.connected}
                email={gmailStatus?.email}
                onConfigure={() => setGmailDialogOpen(true)}
                onDisconnect={() => disconnectMutation.mutate("gmail")}
              />
              <ConnectionCard
                name="Microsoft 365"
                description="OneDrive file storage, Outlook email"
                connected={microsoftStatus?.connected}
                email={microsoftStatus?.email}
                onConfigure={() => setMicrosoftDialogOpen(true)}
                onDisconnect={() => disconnectMutation.mutate("microsoft")}
              />
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Clock className="w-4 h-4" />
            Polling Schedule
          </CardTitle>
        </CardHeader>
        <CardContent>
          {jobsLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : !pollJobs || pollJobs.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No polling jobs configured. Jobs will be set up automatically when connections are established.
            </p>
          ) : (
            <div className="space-y-3">
              {pollJobs.map((job) => (
                <div
                  key={job.id}
                  className="flex items-center justify-between py-3 px-4 rounded-lg border"
                  data-testid={`poll-job-${job.jobName}`}
                >
                  <div className="flex-1">
                    <p className="text-sm font-medium">{job.jobName}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Schedule: {job.cronExpression} | Status: {job.status}
                      {job.lastRunAt && ` | Last run: ${new Date(job.lastRunAt).toLocaleString()}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    {job.errorCount > 0 && (
                      <Badge variant="destructive" className="text-xs">{job.errorCount} errors</Badge>
                    )}
                    <Switch
                      checked={job.isActive}
                      onCheckedChange={(checked) => toggleJobMutation.mutate({ jobName: job.jobName, isActive: checked })}
                      data-testid={`toggle-job-${job.jobName}`}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Activity className="w-4 h-4" />
            Rate Limits
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <RateLimitBar name="HubSpot" limit="100 req/10sec" usage={12} />
          <RateLimitBar name="Procore" limit="3600 req/hour" usage={5} />
          <RateLimitBar name="CompanyCam" limit="100 req/min" usage={2} />
        </CardContent>
      </Card>

      <StageMappingCard />

      <HubspotProcoreSyncCard />

      <PollingCard />

      <RolePollingCard />

      <ProjectNumberCard />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Shield className="w-4 h-4" />
            Webhook Endpoints
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <EndpointRow name="HubSpot Webhook" url="/webhooks/hubspot" method="POST" />
          <EndpointRow name="Procore Webhook" url="/webhooks/procore" method="POST" />
          <EndpointRow name="CompanyCam Webhook" url="/webhooks/companycam" method="POST" />
          <EndpointRow name="Health Check" url="/api/health" method="GET" />
        </CardContent>
      </Card>

      <HubSpotConfigDialog
        open={hubspotDialogOpen}
        onOpenChange={setHubspotDialogOpen}
        existingConfig={integrationConfig?.hubspot}
      />
      <ProcoreConfigDialog
        open={procoreDialogOpen}
        onOpenChange={setProcoreDialogOpen}
        existingConfig={integrationConfig?.procore}
      />
      <CompanyCamConfigDialog
        open={companycamDialogOpen}
        onOpenChange={setCompanycamDialogOpen}
        existingConfig={integrationConfig?.companycam}
      />
      <MicrosoftConfigDialog
        open={microsoftDialogOpen}
        onOpenChange={setMicrosoftDialogOpen}
        status={microsoftStatus}
      />
      <GmailConfigDialog
        open={gmailDialogOpen}
        onOpenChange={setGmailDialogOpen}
        status={gmailStatus}
      />
    </div>
  );
}

function ConnectionCard({ name, description, connected, expiresAt, configuredAt, email, onConfigure, onDisconnect }: {
  name: string; description: string; connected?: boolean; expiresAt?: string; configuredAt?: string; email?: string;
  onConfigure: () => void; onDisconnect: () => void;
}) {
  return (
    <div className="flex items-center justify-between py-3 px-4 rounded-lg border" data-testid={`connection-${name.toLowerCase().replace(/\s+/g, "-")}`}>
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">{name}</p>
          <Badge variant={connected ? "default" : "secondary"} className={connected ? "bg-green-500/10 text-green-600 border-green-500/20" : ""}>
            {connected ? "Connected" : "Not Connected"}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
        {email && (
          <p className="text-xs text-muted-foreground">Account: {email}</p>
        )}
        {expiresAt && (
          <p className="text-xs text-muted-foreground">Token expires: {new Date(expiresAt).toLocaleString()}</p>
        )}
        {configuredAt && (
          <p className="text-xs text-muted-foreground">Configured: {new Date(configuredAt).toLocaleString()}</p>
        )}
      </div>
      <div className="flex items-center gap-2">
        {connected && (
          <Button variant="ghost" size="sm" onClick={onDisconnect} data-testid={`button-disconnect-${name.toLowerCase().replace(/\s+/g, "-")}`}>
            <Unplug className="w-4 h-4 text-muted-foreground" />
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={onConfigure} data-testid={`button-configure-${name.toLowerCase().replace(/\s+/g, "-")}`}>
          <Settings2 className="w-4 h-4 mr-1" />
          {connected ? "Configure" : "Set Up"}
        </Button>
      </div>
    </div>
  );
}

function HubSpotConfigDialog({ open, onOpenChange, existingConfig }: {
  open: boolean; onOpenChange: (open: boolean) => void; existingConfig?: any;
}) {
  const { toast } = useToast();
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [syncResult, setSyncResult] = useState<any>(null);

  const { data: dataCounts, refetch: refetchCounts } = useQuery<any>({
    queryKey: ["/api/integrations/hubspot/data-counts"],
    enabled: open,
  });

  const testMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/integrations/hubspot/test");
      return res.json();
    },
    onSuccess: (data: any) => {
      setTestResult(data);
      if (data.success) {
        queryClient.invalidateQueries({ queryKey: ["/api/dashboard/connections"] });
      }
    },
    onError: (e: Error) => {
      setTestResult({ success: false, message: e.message });
    },
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/integrations/hubspot/sync");
      return res.json();
    },
    onSuccess: (data: any) => {
      setSyncResult(data);
      refetchCounts();
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
      const total = (data.companies?.synced || 0) + (data.contacts?.synced || 0) + (data.deals?.synced || 0);
      toast({ title: `Full sync complete`, description: `${total} records synced to local database in ${(data.duration / 1000).toFixed(1)}s` });
    },
    onError: (e: Error) => {
      setSyncResult(null);
      toast({ title: "Sync Error", description: e.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-orange-500/10 flex items-center justify-center">
              <span className="text-orange-600 font-bold text-sm">HS</span>
            </div>
            HubSpot CRM Configuration
          </DialogTitle>
          <DialogDescription>
            HubSpot is connected via the Replit integration. Sync Now pulls all companies, contacts, deals, and custom deal stages into your local database with 2-week version history.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <div className="p-3 rounded-lg bg-muted/50 border">
            <p className="text-sm font-medium mb-1">Connection Method</p>
            <p className="text-xs text-muted-foreground">
              Managed automatically via Replit integration with OAuth. Token refresh is handled for you.
            </p>
          </div>

          {dataCounts && (dataCounts.companies > 0 || dataCounts.contacts > 0 || dataCounts.deals > 0) && (
            <div className="p-3 rounded-lg border bg-muted/30" data-testid="hubspot-data-counts">
              <p className="text-sm font-medium mb-2">Local Database Mirror</p>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="flex justify-between px-2 py-1 rounded bg-background">
                  <span className="text-muted-foreground">Companies</span>
                  <span className="font-medium" data-testid="count-companies">{dataCounts.companies}</span>
                </div>
                <div className="flex justify-between px-2 py-1 rounded bg-background">
                  <span className="text-muted-foreground">Contacts</span>
                  <span className="font-medium" data-testid="count-contacts">{dataCounts.contacts}</span>
                </div>
                <div className="flex justify-between px-2 py-1 rounded bg-background">
                  <span className="text-muted-foreground">Deals</span>
                  <span className="font-medium" data-testid="count-deals">{dataCounts.deals}</span>
                </div>
                <div className="flex justify-between px-2 py-1 rounded bg-background">
                  <span className="text-muted-foreground">Pipelines</span>
                  <span className="font-medium" data-testid="count-pipelines">{dataCounts.pipelines}</span>
                </div>
                <div className="flex justify-between px-2 py-1 rounded bg-background col-span-2">
                  <span className="text-muted-foreground">Change History (14-day)</span>
                  <span className="font-medium" data-testid="count-history">{dataCounts.changeHistory}</span>
                </div>
              </div>
            </div>
          )}

          {testResult && (
            <TestResultBanner result={testResult} />
          )}

          <Separator />

          <div>
            <p className="text-sm font-medium mb-2">Test Connection</p>
            <Button
              variant="outline"
              onClick={() => testMutation.mutate()}
              disabled={testMutation.isPending}
              className="w-full"
              data-testid="button-test-hubspot"
            >
              {testMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Activity className="w-4 h-4 mr-1" />}
              {testMutation.isPending ? "Testing..." : "Test HubSpot Connection"}
            </Button>
          </div>

          <Separator />

          <div>
            <p className="text-sm font-medium mb-2">Full Data Sync</p>
            <p className="text-xs text-muted-foreground mb-3">
              Pulls all companies, contacts, deals, and custom deal stages/pipelines from HubSpot into the local database. Changes are tracked with 2-week version history.
            </p>
            <Button
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending}
              className="w-full"
              data-testid="button-sync-hubspot"
            >
              {syncMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1" />}
              {syncMutation.isPending ? "Syncing all data..." : "Sync Now"}
            </Button>
          </div>

          {syncResult && syncResult.success && (
            <div className="rounded-lg border overflow-hidden" data-testid="sync-results-panel">
              <div className="px-3 py-2 bg-green-500/10 border-b">
                <p className="text-sm font-medium text-green-700 dark:text-green-400">
                  Sync Complete ({(syncResult.duration / 1000).toFixed(1)}s)
                </p>
              </div>
              <div className="p-3 space-y-2 text-xs">
                <SyncResultRow label="Companies" data={syncResult.companies} />
                <SyncResultRow label="Contacts" data={syncResult.contacts} />
                <SyncResultRow label="Deals" data={syncResult.deals} />
                <div className="flex justify-between px-2 py-1 rounded bg-muted/30">
                  <span>Pipelines</span>
                  <span className="font-medium">{syncResult.pipelines} synced</span>
                </div>
                {syncResult.purgedHistory > 0 && (
                  <div className="flex justify-between px-2 py-1 rounded bg-muted/30">
                    <span>History Purged</span>
                    <span className="font-medium">{syncResult.purgedHistory} old records removed</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SyncResultRow({ label, data }: { label: string; data?: { synced: number; created: number; updated: number; changes: number } }) {
  if (!data) return null;
  return (
    <div className="flex justify-between px-2 py-1 rounded bg-muted/30" data-testid={`sync-row-${label.toLowerCase()}`}>
      <span>{label}</span>
      <span className="font-medium">
        {data.synced} synced
        {data.created > 0 && <span className="text-green-600 ml-1">(+{data.created} new)</span>}
        {data.updated > 0 && <span className="text-blue-600 ml-1">({data.updated} updated)</span>}
      </span>
    </div>
  );
}

function ProcoreConfigDialog({ open, onOpenChange, existingConfig }: {
  open: boolean; onOpenChange: (open: boolean) => void; existingConfig?: any;
}) {
  const { toast } = useToast();
  const [clientId, setClientId] = useState(existingConfig?.clientId || "");
  const [clientSecret, setClientSecret] = useState("");
  const [companyId, setCompanyId] = useState(existingConfig?.companyId || "");
  const [environment, setEnvironment] = useState(existingConfig?.environment || "production");
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/integrations/procore/save", { clientId, clientSecret, companyId, environment });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/connections"] });
      queryClient.invalidateQueries({ queryKey: ["/api/integrations/config"] });
      toast({ title: "Procore configuration saved" });
      onOpenChange(false);
    },
    onError: (e: Error) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const oauthMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("GET", "/api/oauth/procore/authorize");
      const { url } = await res.json();
      window.open(url, "_blank");
    },
    onError: (e: Error) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const testMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/integrations/procore/test");
      return res.json();
    },
    onSuccess: (data: any) => {
      setTestResult(data);
    },
    onError: (e: Error) => {
      setTestResult({ success: false, message: e.message });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
              <span className="text-blue-600 font-bold text-sm">PC</span>
            </div>
            Procore Configuration
          </DialogTitle>
          <DialogDescription>
            Connect to Procore using OAuth 2.0. First save your app credentials, then authorize via the OAuth flow.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <div className="space-y-2">
            <Label htmlFor="pc-env">Environment</Label>
            <Select value={environment} onValueChange={setEnvironment}>
              <SelectTrigger data-testid="select-procore-environment">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="production">Production</SelectItem>
                <SelectItem value="sandbox">Sandbox (Development)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="pc-client-id">Client ID (App ID)</Label>
            <Input
              id="pc-client-id"
              placeholder="Your Procore app client ID"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              data-testid="input-procore-client-id"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="pc-client-secret">Client Secret</Label>
            <Input
              id="pc-client-secret"
              type="password"
              placeholder="Your Procore app client secret"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              data-testid="input-procore-client-secret"
            />
            <p className="text-xs text-muted-foreground">Found in your Procore Developer Portal under App Management.</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="pc-company">Company ID</Label>
            <Input
              id="pc-company"
              placeholder="e.g., 12345"
              value={companyId}
              onChange={(e) => setCompanyId(e.target.value)}
              data-testid="input-procore-company-id"
            />
          </div>

          {testResult && (
            <TestResultBanner result={testResult} />
          )}

          <Separator />

          <div className="flex items-center justify-between gap-3">
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => testMutation.mutate()}
                disabled={testMutation.isPending}
                data-testid="button-test-procore"
              >
                {testMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Activity className="w-4 h-4 mr-1" />}
                Test
              </Button>
              <Button
                variant="outline"
                onClick={() => oauthMutation.mutate()}
                disabled={oauthMutation.isPending || !clientId}
                data-testid="button-oauth-procore"
              >
                {oauthMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Link2 className="w-4 h-4 mr-1" />}
                Authorize OAuth
              </Button>
            </div>
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={!clientId || !clientSecret || saveMutation.isPending}
              data-testid="button-save-procore"
            >
              {saveMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CompanyCamConfigDialog({ open, onOpenChange, existingConfig }: {
  open: boolean; onOpenChange: (open: boolean) => void; existingConfig?: any;
}) {
  const { toast } = useToast();
  const [apiToken, setApiToken] = useState("");
  const [webhookUrl, setWebhookUrl] = useState(existingConfig?.webhookUrl || "");
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/integrations/companycam/save", { apiToken, webhookUrl });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/connections"] });
      queryClient.invalidateQueries({ queryKey: ["/api/integrations/config"] });
      toast({ title: "CompanyCam configuration saved" });
      onOpenChange(false);
    },
    onError: (e: Error) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const testMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/integrations/companycam/test");
      return res.json();
    },
    onSuccess: (data: any) => {
      setTestResult(data);
    },
    onError: (e: Error) => {
      setTestResult({ success: false, message: e.message });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-purple-500/10 flex items-center justify-center">
              <span className="text-purple-600 font-bold text-sm">CC</span>
            </div>
            CompanyCam Configuration
          </DialogTitle>
          <DialogDescription>
            Connect CompanyCam using your API token. You can generate one from your CompanyCam account settings.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <div className="space-y-2">
            <Label htmlFor="cc-token">API Token</Label>
            <Input
              id="cc-token"
              type="password"
              placeholder="Your CompanyCam API token"
              value={apiToken}
              onChange={(e) => setApiToken(e.target.value)}
              data-testid="input-companycam-token"
            />
            <p className="text-xs text-muted-foreground">Find this in your CompanyCam account under Developer Settings or contact CompanyCam support.</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="cc-webhook">Webhook URL (optional)</Label>
            <Input
              id="cc-webhook"
              placeholder="Auto-detected from your deployment URL"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              data-testid="input-companycam-webhook-url"
            />
            <p className="text-xs text-muted-foreground">Leave blank to auto-detect. CompanyCam will send project creation events to this URL.</p>
          </div>

          {testResult && (
            <TestResultBanner result={testResult} />
          )}

          <Separator />

          <div className="flex items-center justify-between gap-3">
            <Button
              variant="outline"
              onClick={() => testMutation.mutate()}
              disabled={testMutation.isPending}
              data-testid="button-test-companycam"
            >
              {testMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Activity className="w-4 h-4 mr-1" />}
              Test Connection
            </Button>
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={!apiToken || saveMutation.isPending}
              data-testid="button-save-companycam"
            >
              {saveMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              Save Configuration
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function MicrosoftConfigDialog({ open, onOpenChange, status }: {
  open: boolean; onOpenChange: (open: boolean) => void; status?: { connected: boolean; email?: string; userName?: string };
}) {
  const { toast } = useToast();
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  const oauthMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("GET", "/api/oauth/microsoft/authorize");
      const { url } = await res.json();
      window.open(url, "_blank");
    },
    onError: (e: Error) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const testMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/integrations/microsoft/test");
      return res.json();
    },
    onSuccess: (data: any) => {
      setTestResult(data);
    },
    onError: (e: Error) => {
      setTestResult({ success: false, message: e.message });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
              <span className="text-blue-600 font-bold text-sm">MS</span>
            </div>
            Microsoft 365 Configuration
          </DialogTitle>
          <DialogDescription>
            Connect to Microsoft 365 for OneDrive file storage and Outlook email sending.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          {status?.connected ? (
            <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/20">
              <p className="text-sm font-medium text-green-700 dark:text-green-400">Connected</p>
              {status.email && <p className="text-xs text-muted-foreground mt-1">Account: {status.email}</p>}
              {status.userName && <p className="text-xs text-muted-foreground">Name: {status.userName}</p>}
            </div>
          ) : (
            <div className="p-3 rounded-lg bg-muted/50 border">
              <p className="text-sm font-medium mb-1">Setup Required</p>
              <p className="text-xs text-muted-foreground">
                Set <code className="bg-muted px-1 rounded">MICROSOFT_CLIENT_ID</code> and <code className="bg-muted px-1 rounded">MICROSOFT_CLIENT_SECRET</code> environment variables, then click Authorize.
              </p>
            </div>
          )}

          <div className="p-3 rounded-lg bg-muted/30 border">
            <p className="text-xs font-medium mb-2">Enabled Features:</p>
            <ul className="text-xs text-muted-foreground space-y-1">
              <li>• <strong>OneDrive:</strong> Store project archives and documents</li>
              <li>• <strong>Outlook:</strong> Send email notifications</li>
            </ul>
          </div>

          {testResult && (
            <TestResultBanner result={testResult} />
          )}

          <Separator />

          <div className="flex items-center justify-between gap-3">
            <Button
              variant="outline"
              onClick={() => testMutation.mutate()}
              disabled={testMutation.isPending || !status?.connected}
              data-testid="button-test-microsoft"
            >
              {testMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Activity className="w-4 h-4 mr-1" />}
              Test Connection
            </Button>
            <Button
              onClick={() => oauthMutation.mutate()}
              disabled={oauthMutation.isPending}
              data-testid="button-oauth-microsoft"
            >
              {oauthMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Link2 className="w-4 h-4 mr-1" />}
              {status?.connected ? "Re-authorize" : "Authorize with Microsoft"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function GmailConfigDialog({ open, onOpenChange, status }: {
  open: boolean; onOpenChange: (open: boolean) => void; status?: { connected: boolean; email?: string; userName?: string; method?: string };
}) {
  const { toast } = useToast();
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);

  const oauthMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("GET", "/api/oauth/google/authorize");
      const { url } = await res.json();
      window.open(url, "_blank");
    },
    onError: (e: Error) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const testMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/integrations/gmail/test");
      return res.json();
    },
    onSuccess: (data: any) => {
      setTestResult(data);
    },
    onError: (e: Error) => {
      setTestResult({ success: false, message: e.message });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-red-500/10 flex items-center justify-center">
              <span className="text-red-600 font-bold text-sm">G</span>
            </div>
            Gmail Configuration
          </DialogTitle>
          <DialogDescription>
            Connect Gmail to send email notifications via Google's API.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          {status?.connected ? (
            <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/20">
              <p className="text-sm font-medium text-green-700 dark:text-green-400">Connected</p>
              {status.email && <p className="text-xs text-muted-foreground mt-1">Account: {status.email}</p>}
              {status.method && <p className="text-xs text-muted-foreground">Method: {status.method === 'oauth' ? 'OAuth' : status.method === 'env' ? 'Environment Variable' : 'Replit Integration'}</p>}
            </div>
          ) : (
            <div className="p-3 rounded-lg bg-muted/50 border">
              <p className="text-sm font-medium mb-1">Setup Required</p>
              <p className="text-xs text-muted-foreground">
                Set <code className="bg-muted px-1 rounded">GOOGLE_CLIENT_ID</code> and <code className="bg-muted px-1 rounded">GOOGLE_CLIENT_SECRET</code> environment variables, then click Authorize.
              </p>
            </div>
          )}

          <div className="p-3 rounded-lg bg-muted/30 border">
            <p className="text-xs font-medium mb-2">Connection Methods (in priority order):</p>
            <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
              <li>OAuth authentication (recommended)</li>
              <li>GMAIL_ACCESS_TOKEN environment variable</li>
              <li>Replit Google Mail integration</li>
            </ol>
          </div>

          {testResult && (
            <TestResultBanner result={testResult} />
          )}

          <Separator />

          <div className="flex items-center justify-between gap-3">
            <Button
              variant="outline"
              onClick={() => testMutation.mutate()}
              disabled={testMutation.isPending}
              data-testid="button-test-gmail"
            >
              {testMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Activity className="w-4 h-4 mr-1" />}
              Test Connection
            </Button>
            <Button
              onClick={() => oauthMutation.mutate()}
              disabled={oauthMutation.isPending}
              data-testid="button-oauth-gmail"
            >
              {oauthMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Link2 className="w-4 h-4 mr-1" />}
              {status?.connected && status.method === 'oauth' ? "Re-authorize" : "Authorize with Google"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TestResultBanner({ result }: { result: { success: boolean; message: string } }) {
  return (
    <div className={`flex items-start gap-2 p-3 rounded-lg text-sm ${result.success ? "bg-green-500/10 text-green-700 dark:text-green-400" : "bg-red-500/10 text-red-700 dark:text-red-400"}`} data-testid="test-result-banner">
      {result.success ? <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" /> : <XCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />}
      <span>{result.message}</span>
    </div>
  );
}

function RateLimitBar({ name, limit, usage }: { name: string; limit: string; usage: number }) {
  return (
    <div className="space-y-1.5" data-testid={`rate-limit-${name.toLowerCase()}`}>
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">{name}</span>
        <span className="text-muted-foreground text-xs">{usage}% used ({limit})</span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${usage}%` }} />
      </div>
    </div>
  );
}

function EndpointRow({ name, url, method }: { name: string; url: string; method: string }) {
  return (
    <div className="flex items-center justify-between py-2 px-3 rounded-lg border" data-testid={`endpoint-${name.toLowerCase().replace(/\s+/g, "-")}`}>
      <div className="flex items-center gap-3">
        <Badge variant="outline" className="font-mono text-xs">{method}</Badge>
        <span className="text-sm">{name}</span>
      </div>
      <code className="text-xs text-muted-foreground font-mono bg-muted px-2 py-1 rounded">{url}</code>
    </div>
  );
}

function HubspotProcoreSyncCard() {
  const { toast } = useToast();
  const [enabled, setEnabled] = useState(false);
  const [bulkSyncing, setBulkSyncing] = useState(false);
  const [bulkResult, setBulkResult] = useState<any>(null);

  const { data: config, isLoading } = useQuery<any>({
    queryKey: ["/api/automation/hubspot-procore/config"],
  });

  useEffect(() => {
    if (config) {
      setEnabled(config.enabled || false);
    }
  }, [config]);

  const saveConfig = useMutation({
    mutationFn: async (newEnabled: boolean) => {
      const res = await apiRequest("POST", "/api/automation/hubspot-procore/config", {
        enabled: newEnabled,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/automation/hubspot-procore/config"] });
      toast({ title: "Configuration saved" });
    },
  });

  const handleToggle = (val: boolean) => {
    setEnabled(val);
    saveConfig.mutate(val);
  };

  const handleBulkSync = async (type: 'companies' | 'contacts' | 'both') => {
    setBulkSyncing(true);
    setBulkResult(null);
    try {
      const res = await apiRequest("POST", "/api/automation/hubspot-procore/bulk-sync", { type });
      const data = await res.json();
      setBulkResult(data);
      const companyStats = data.companies;
      const contactStats = data.contacts;
      const parts: string[] = [];
      if (companyStats) parts.push(`Companies: ${companyStats.created} created, ${companyStats.updated} updated, ${companyStats.skipped} skipped`);
      if (contactStats) parts.push(`Contacts: ${contactStats.created} created, ${contactStats.updated} updated, ${contactStats.skipped} skipped`);
      toast({ title: "Bulk sync complete", description: parts.join(' | ') + ` (${data.duration})` });
    } catch (e: any) {
      toast({ title: "Sync failed", description: e.message, variant: "destructive" });
    } finally {
      setBulkSyncing(false);
    }
  };

  if (isLoading) return <Skeleton className="h-40" />;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2" data-testid="text-hubspot-procore-sync-title">
            <ArrowRightLeft className="w-4 h-4" />
            HubSpot → Procore Directory Sync
          </CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{enabled ? "Auto-sync enabled" : "Disabled"}</span>
            <Switch
              checked={enabled}
              onCheckedChange={handleToggle}
              data-testid="switch-hubspot-procore-auto-sync"
            />
          </div>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          When enabled, new HubSpot companies and contacts are automatically synced to Procore's company directory as vendors. Matching rules prevent duplicates — updates only fill empty fields, never overwriting existing data.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md bg-muted/50 p-3 space-y-2">
          <p className="text-xs font-medium">Matching Rules (in priority order):</p>
          <div className="grid grid-cols-2 gap-1 text-xs text-muted-foreground">
            <div className="flex items-center gap-1"><Badge variant="outline" className="text-[10px] h-4 px-1">100</Badge> Exact email match</div>
            <div className="flex items-center gap-1"><Badge variant="outline" className="text-[10px] h-4 px-1">90</Badge> Exact company name</div>
            <div className="flex items-center gap-1"><Badge variant="outline" className="text-[10px] h-4 px-1">80</Badge> Domain match</div>
            <div className="flex items-center gap-1"><Badge variant="outline" className="text-[10px] h-4 px-1">70</Badge> Legal/trade name</div>
            <div className="flex items-center gap-1"><Badge variant="outline" className="text-[10px] h-4 px-1">60</Badge> Partial name match</div>
            <div className="flex items-center gap-1"><Badge variant="outline" className="text-[10px] h-4 px-1">40</Badge> Person name in vendor</div>
          </div>
          <p className="text-[10px] text-muted-foreground">Threshold: score ≥ 60 = match found. Below threshold = new vendor created.</p>
        </div>

        <Separator />

        <div>
          <p className="text-xs font-medium mb-2">Manual Bulk Sync</p>
          <p className="text-xs text-muted-foreground mb-3">
            Push all existing HubSpot companies/contacts to Procore. Safe to run multiple times — matching prevents duplicates.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={bulkSyncing}
              onClick={() => handleBulkSync('companies')}
              data-testid="button-bulk-sync-companies"
            >
              {bulkSyncing ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}
              Sync Companies
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={bulkSyncing}
              onClick={() => handleBulkSync('contacts')}
              data-testid="button-bulk-sync-contacts"
            >
              {bulkSyncing ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}
              Sync Contacts
            </Button>
            <Button
              size="sm"
              disabled={bulkSyncing}
              onClick={() => handleBulkSync('both')}
              data-testid="button-bulk-sync-both"
            >
              {bulkSyncing ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}
              Sync All
            </Button>
          </div>
        </div>

        {bulkResult && (
          <div className="rounded-md border p-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium">Last Sync Results</p>
              <Badge variant="outline" className="text-[10px]">{bulkResult.duration}</Badge>
            </div>
            {bulkResult.companies && (
              <div className="text-xs space-y-1">
                <p className="font-medium">Companies ({bulkResult.companies.total})</p>
                <div className="flex gap-3 text-muted-foreground">
                  <span className="text-green-600">{bulkResult.companies.created} created</span>
                  <span className="text-blue-600">{bulkResult.companies.updated} updated</span>
                  <span>{bulkResult.companies.skipped} skipped</span>
                  {bulkResult.companies.errors > 0 && <span className="text-red-600">{bulkResult.companies.errors} errors</span>}
                </div>
              </div>
            )}
            {bulkResult.contacts && (
              <div className="text-xs space-y-1">
                <p className="font-medium">Contacts ({bulkResult.contacts.total})</p>
                <div className="flex gap-3 text-muted-foreground">
                  <span className="text-green-600">{bulkResult.contacts.created} created</span>
                  <span className="text-blue-600">{bulkResult.contacts.updated} updated</span>
                  <span>{bulkResult.contacts.skipped} skipped</span>
                  {bulkResult.contacts.errors > 0 && <span className="text-red-600">{bulkResult.contacts.errors} errors</span>}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PollingCard() {
  const { toast } = useToast();

  const { data: pollingConfig, isLoading } = useQuery<{
    enabled: boolean;
    intervalMinutes: number;
    isRunning: boolean;
    lastPollAt: string | null;
    lastPollResult: any;
    currentlyPolling: boolean;
  }>({
    queryKey: ["/api/automation/polling/config"],
    refetchInterval: 30000,
  });

  const [pollingEnabled, setPollingEnabled] = useState(false);
  const [interval, setIntervalVal] = useState(10);

  useEffect(() => {
    if (pollingConfig) {
      setPollingEnabled(pollingConfig.enabled);
      setIntervalVal(pollingConfig.intervalMinutes);
    }
  }, [pollingConfig]);

  const savePolling = useMutation({
    mutationFn: async (config: { enabled: boolean; intervalMinutes: number }) => {
      const res = await apiRequest("POST", "/api/automation/polling/config", config);
      return res.json();
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/automation/polling/config"] });
      toast({ title: vars.enabled ? `Polling enabled (every ${vars.intervalMinutes} min)` : "Polling disabled" });
    },
  });

  const triggerNow = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/automation/polling/trigger", {});
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Sync triggered" });
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["/api/automation/polling/config"] }), 5000);
    },
  });

  const handleToggle = (val: boolean) => {
    setPollingEnabled(val);
    savePolling.mutate({ enabled: val, intervalMinutes: interval });
  };

  const handleIntervalChange = (val: string) => {
    const mins = parseInt(val);
    setIntervalVal(mins);
    if (pollingEnabled) {
      savePolling.mutate({ enabled: true, intervalMinutes: mins });
    }
  };

  if (isLoading) return <Skeleton className="h-40" />;

  const lastResult = pollingConfig?.lastPollResult;
  const lastPollTime = pollingConfig?.lastPollAt ? new Date(pollingConfig.lastPollAt) : null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2" data-testid="text-polling-title">
            <Clock className="w-4 h-4" />
            Automatic Polling
          </CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {pollingEnabled ? (
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-green-500 inline-block animate-pulse" />
                  Active
                </span>
              ) : "Off"}
            </span>
            <Switch
              checked={pollingEnabled}
              onCheckedChange={handleToggle}
              data-testid="switch-polling-enabled"
            />
          </div>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Automatically syncs HubSpot data on a timer. New or updated companies and contacts are pushed to Procore's vendor directory.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <Label className="text-xs whitespace-nowrap">Sync every</Label>
          <Select value={String(interval)} onValueChange={handleIntervalChange}>
            <SelectTrigger className="w-32 h-8" data-testid="select-polling-interval">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="5">5 minutes</SelectItem>
              <SelectItem value="10">10 minutes</SelectItem>
              <SelectItem value="15">15 minutes</SelectItem>
              <SelectItem value="30">30 minutes</SelectItem>
              <SelectItem value="60">1 hour</SelectItem>
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            onClick={() => triggerNow.mutate()}
            disabled={pollingConfig?.currentlyPolling || triggerNow.isPending}
            data-testid="button-trigger-poll-now"
          >
            {pollingConfig?.currentlyPolling ? (
              <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Syncing...</>
            ) : (
              <><RefreshCw className="w-3 h-3 mr-1" /> Sync Now</>
            )}
          </Button>
        </div>

        {lastPollTime && (
          <div className="rounded-md bg-muted/50 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium">Last Poll</p>
              <span className="text-[10px] text-muted-foreground">{lastPollTime.toLocaleString()}</span>
            </div>
            {lastResult && !lastResult.error && (
              <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                <div>
                  <span className="font-medium text-foreground">Companies:</span>{" "}
                  {lastResult.companies?.created || 0} new, {lastResult.companies?.updated || 0} updated
                </div>
                <div>
                  <span className="font-medium text-foreground">Contacts:</span>{" "}
                  {lastResult.contacts?.created || 0} new, {lastResult.contacts?.updated || 0} updated
                </div>
                <div>
                  <span className="font-medium text-foreground">Duration:</span>{" "}
                  {lastResult.duration ? `${(lastResult.duration / 1000).toFixed(1)}s` : "—"}
                </div>
              </div>
            )}
            {lastResult?.procoreAutoSync && !lastResult.procoreAutoSync.error && (
              lastResult.procoreAutoSync.companiesProcessed > 0 || lastResult.procoreAutoSync.contactsProcessed > 0
            ) && (
              <div className="text-xs text-muted-foreground border-t pt-2 mt-1">
                <span className="font-medium text-foreground">Procore push:</span>{" "}
                {lastResult.procoreAutoSync.results?.filter((r: any) => r.action === 'created').length || 0} created,{" "}
                {lastResult.procoreAutoSync.results?.filter((r: any) => r.action === 'updated').length || 0} updated
              </div>
            )}
            {lastResult?.error && (
              <p className="text-xs text-red-600">Error: {lastResult.error}</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RolePollingCard() {
  const { toast } = useToast();

  const { data: config, isLoading } = useQuery<{
    enabled: boolean;
    intervalMinutes: number;
    isRunning: boolean;
    lastPollAt: string | null;
    lastPollResult: any;
    currentlyPolling: boolean;
    lastWebhookEventAt: string | null;
    webhookActive: boolean;
  }>({
    queryKey: ["/api/automation/role-polling/config"],
    refetchInterval: 30000,
  });

  const [enabled, setEnabled] = useState(false);
  const [interval, setIntervalVal] = useState(5);

  useEffect(() => {
    if (config) {
      setEnabled(config.enabled);
      setIntervalVal(config.intervalMinutes);
    }
  }, [config]);

  const saveConfig = useMutation({
    mutationFn: async (cfg: { enabled: boolean; intervalMinutes: number }) => {
      const res = await apiRequest("POST", "/api/automation/role-polling/config", cfg);
      return res.json();
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/automation/role-polling/config"] });
      toast({ title: vars.enabled ? `Role polling enabled (every ${vars.intervalMinutes} min)` : "Role polling disabled" });
    },
  });

  const triggerNow = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/automation/role-polling/trigger", {});
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Role assignment sync triggered" });
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["/api/automation/role-polling/config"] }), 5000);
    },
  });

  const handleToggle = (val: boolean) => {
    setEnabled(val);
    saveConfig.mutate({ enabled: val, intervalMinutes: interval });
  };

  const handleIntervalChange = (val: string) => {
    const mins = parseInt(val);
    setIntervalVal(mins);
    if (enabled) {
      saveConfig.mutate({ enabled: true, intervalMinutes: mins });
    }
  };

  if (isLoading) return <Skeleton className="h-40" />;

  const lastResult = config?.lastPollResult;
  const lastPollTime = config?.lastPollAt ? new Date(config.lastPollAt) : null;
  const lastWebhookTime = config?.lastWebhookEventAt ? new Date(config.lastWebhookEventAt) : null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2" data-testid="text-role-polling-title">
            <UserPlus className="w-4 h-4" />
            Role Assignment Sync
          </CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {enabled ? (
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-green-500 inline-block animate-pulse" />
                  Active
                </span>
              ) : "Off"}
            </span>
            <Switch
              checked={enabled}
              onCheckedChange={handleToggle}
              data-testid="switch-role-polling-enabled"
            />
          </div>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Polls Procore for new project role assignments and sends email notifications. Webhooks are the primary notification method; polling acts as a reliable fallback.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2 text-xs">
          {config?.webhookActive ? (
            <Badge variant="outline" className="text-green-600 border-green-300 gap-1">
              <Wifi className="w-3 h-3" /> Webhook Active
            </Badge>
          ) : (
            <Badge variant="outline" className="text-amber-600 border-amber-300 gap-1">
              <WifiOff className="w-3 h-3" /> Webhook Inactive
            </Badge>
          )}
          {lastWebhookTime && (
            <span className="text-muted-foreground">
              Last event: {lastWebhookTime.toLocaleString()}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          <Label className="text-xs whitespace-nowrap">Poll every</Label>
          <Select value={String(interval)} onValueChange={handleIntervalChange}>
            <SelectTrigger className="w-32 h-8" data-testid="select-role-polling-interval">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="2">2 minutes</SelectItem>
              <SelectItem value="5">5 minutes</SelectItem>
              <SelectItem value="10">10 minutes</SelectItem>
              <SelectItem value="15">15 minutes</SelectItem>
              <SelectItem value="30">30 minutes</SelectItem>
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            onClick={() => triggerNow.mutate()}
            disabled={config?.currentlyPolling || triggerNow.isPending}
            data-testid="button-trigger-role-poll-now"
          >
            {config?.currentlyPolling ? (
              <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Syncing...</>
            ) : (
              <><RefreshCw className="w-3 h-3 mr-1" /> Sync Now</>
            )}
          </Button>
        </div>

        {lastPollTime && (
          <div className="rounded-md bg-muted/50 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium">Last Poll</p>
              <span className="text-[10px] text-muted-foreground">{lastPollTime.toLocaleString()}</span>
            </div>
            {lastResult && !lastResult.error && (
              <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                <div>
                  <span className="font-medium text-foreground">Synced:</span>{" "}
                  {lastResult.synced || 0} roles
                </div>
                <div>
                  <span className="font-medium text-foreground">New:</span>{" "}
                  {lastResult.newAssignments || 0} assignments
                </div>
                <div>
                  <span className="font-medium text-foreground">Emails:</span>{" "}
                  {lastResult.emails?.sent || 0} sent
                </div>
              </div>
            )}
            {lastResult?.error && (
              <p className="text-xs text-red-600">Error: {lastResult.error}</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StageMappingCard() {
  const { toast } = useToast();
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [enabled, setEnabled] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  const { data: config, isLoading: configLoading } = useQuery<{ mappings: Record<string, string>; enabled: boolean }>({
    queryKey: ["/api/stage-mapping/config"],
  });

  const { data: hubspotStages } = useQuery<{ stageId: string; label: string; pipelineLabel: string }[]>({
    queryKey: ["/api/stage-mapping/hubspot-stages"],
  });

  const { data: bidboardStatuses } = useQuery<string[]>({
    queryKey: ["/api/stage-mapping/bidboard-statuses"],
  });

  useEffect(() => {
    if (config) {
      setMappings(config.mappings || {});
      setEnabled(config.enabled || false);
    }
  }, [config]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/stage-mapping/config", { mappings, enabled });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/stage-mapping/config"] });
      setHasChanges(false);
      toast({ title: "Stage mapping saved" });
    },
    onError: (e: Error) => {
      toast({ title: "Failed to save", description: e.message, variant: "destructive" });
    },
  });

  const handleMappingChange = (bidboardStatus: string, hubspotStageId: string) => {
    setMappings(prev => {
      const updated = { ...prev };
      if (hubspotStageId === "__none__") {
        delete updated[bidboardStatus];
      } else {
        updated[bidboardStatus] = hubspotStageId;
      }
      return updated;
    });
    setHasChanges(true);
  };

  const handleEnabledChange = (val: boolean) => {
    setEnabled(val);
    setHasChanges(true);
  };

  const statuses = bidboardStatuses || [];
  const stages = hubspotStages || [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <ArrowRightLeft className="w-4 h-4" />
            BidBoard → HubSpot Stage Mapping
          </CardTitle>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <Label htmlFor="stage-mapping-toggle" className="text-xs text-muted-foreground">
                {enabled ? "Active" : "Disabled"}
              </Label>
              <Switch
                id="stage-mapping-toggle"
                checked={enabled}
                onCheckedChange={handleEnabledChange}
                data-testid="switch-stage-mapping-toggle"
              />
            </div>
            <Button
              size="sm"
              onClick={() => saveMutation.mutate()}
              disabled={!hasChanges || saveMutation.isPending}
              data-testid="button-save-stage-mapping"
            >
              {saveMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-1 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-1" />
              )}
              Save
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          When a BidBoard CSV is re-imported with status changes, matching HubSpot deals are automatically updated to the mapped stage.
        </p>
      </CardHeader>
      <CardContent>
        {configLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : statuses.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            No BidBoard data imported yet. Import a BidBoard CSV on the Procore Data page first.
          </p>
        ) : (
          <div className="space-y-2">
            <div className="grid grid-cols-[1fr,auto,1fr] gap-3 items-center px-2 pb-1 border-b">
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">BidBoard Status</span>
              <span className="text-xs text-muted-foreground">→</span>
              <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">HubSpot Stage</span>
            </div>
            {statuses.map(status => (
              <div key={status} className="grid grid-cols-[1fr,auto,1fr] gap-3 items-center px-2 py-1.5 rounded-lg hover:bg-muted/50" data-testid={`mapping-row-${status.toLowerCase().replace(/\s+/g, "-")}`}>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-xs font-normal">{status}</Badge>
                </div>
                <span className="text-muted-foreground text-sm">→</span>
                <Select
                  value={mappings[status] || "__none__"}
                  onValueChange={(val) => handleMappingChange(status, val)}
                >
                  <SelectTrigger className="h-8 text-xs" data-testid={`select-mapping-${status.toLowerCase().replace(/\s+/g, "-")}`}>
                    <SelectValue placeholder="Not mapped" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Not mapped</SelectItem>
                    {stages.map(s => (
                      <SelectItem key={s.stageId} value={s.stageId}>
                        {s.label} ({s.pipelineLabel})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
            {Object.keys(mappings).length > 0 && (
              <div className="mt-3 pt-3 border-t">
                <p className="text-xs text-muted-foreground">
                  {Object.keys(mappings).length} of {statuses.length} statuses mapped.
                  {!enabled && " Enable the toggle above to activate automatic syncing."}
                </p>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ProjectNumberCard() {
  const { toast } = useToast();

  const { data: config, isLoading } = useQuery<{ enabled: boolean }>({
    queryKey: ["/api/deal-project-number/config"],
  });

  const { data: registry } = useQuery<{ data: any[]; total: number }>({
    queryKey: ["/api/deal-project-number/registry"],
    refetchInterval: 30000,
  });

  const [enabled, setEnabled] = useState(false);
  const [testDealId, setTestDealId] = useState("");

  useEffect(() => {
    if (config) {
      setEnabled(config.enabled);
    }
  }, [config]);

  const saveConfig = useMutation({
    mutationFn: async (cfg: { enabled: boolean }) => {
      const res = await apiRequest("POST", "/api/deal-project-number/config", cfg);
      return res.json();
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/deal-project-number/config"] });
      toast({ title: vars.enabled ? "Project number auto-assign enabled" : "Project number auto-assign disabled" });
    },
  });

  const assignNow = useMutation({
    mutationFn: async (hubspotDealId: string) => {
      const res = await apiRequest("POST", "/api/deal-project-number/assign", { hubspotDealId });
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/deal-project-number/registry"] });
      toast({
        title: data.alreadyAssigned ? "Already assigned" : "Project number assigned",
        description: data.projectNumber ? `Project Number: ${data.projectNumber}` : data.message,
      });
      setTestDealId("");
    },
    onError: (err: any) => {
      toast({ title: "Assignment failed", description: err.message, variant: "destructive" });
    },
  });

  const handleToggle = (val: boolean) => {
    setEnabled(val);
    saveConfig.mutate({ enabled: val });
  };

  if (isLoading) return <Skeleton className="h-40" />;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2" data-testid="text-project-number-title">
            <Hash className="w-4 h-4" />
            Deal Project Number Assignment
          </CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {enabled ? (
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-green-500 inline-block animate-pulse" />
                  Active
                </span>
              ) : "Off"}
            </span>
            <Switch
              checked={enabled}
              onCheckedChange={handleToggle}
              data-testid="switch-project-number-enabled"
            />
          </div>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Automatically assigns a project number (dayOfYear + 2-digit year + suffix) to new HubSpot deals. Updates the deal's Project Number field and sends an email notification.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <Input
            placeholder="HubSpot Deal ID"
            value={testDealId}
            onChange={(e) => setTestDealId(e.target.value)}
            className="h-8 text-sm max-w-xs"
            data-testid="input-deal-id"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => testDealId && assignNow.mutate(testDealId)}
            disabled={assignNow.isPending || !testDealId}
            data-testid="button-assign-project-number"
          >
            {assignNow.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
            Assign Now
          </Button>
        </div>

        {registry && registry.data.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-2">
              Recent Assignments ({registry.total} total)
            </p>
            <div className="space-y-1 max-h-40 overflow-y-auto">
              {registry.data.slice(0, 10).map((entry: any) => (
                <div key={entry.id} className="flex items-center justify-between text-xs py-1 px-2 rounded bg-muted/50" data-testid={`row-registry-${entry.id}`}>
                  <span className="font-mono font-medium">{entry.fullProjectNumber}</span>
                  <span className="text-muted-foreground truncate max-w-[200px] ml-2">{entry.hubspotDealName || entry.hubspotDealId}</span>
                  <span className="text-muted-foreground ml-2">{entry.assignedAt ? new Date(entry.assignedAt).toLocaleDateString() : ""}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="text-xs text-muted-foreground border-t pt-3">
          <p><strong>Format:</strong> DDD + YY + suffix (e.g., 05626-aa for day 56 of 2026)</p>
          <p>Replaces the Zapier "New Deal → Run JavaScript → Create Record → Update Deal → Send Email" zap.</p>
        </div>
      </CardContent>
    </Card>
  );
}
