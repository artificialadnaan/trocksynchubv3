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
} from "lucide-react";
import { useState } from "react";
import type { PollJob } from "@shared/schema";

export default function SettingsPage() {
  const { toast } = useToast();
  const [hubspotDialogOpen, setHubspotDialogOpen] = useState(false);
  const [procoreDialogOpen, setProcoreDialogOpen] = useState(false);
  const [companycamDialogOpen, setCompanycamDialogOpen] = useState(false);

  const { data: connections, isLoading: connLoading } = useQuery<any>({
    queryKey: ["/api/dashboard/connections"],
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
    </div>
  );
}

function ConnectionCard({ name, description, connected, expiresAt, configuredAt, onConfigure, onDisconnect }: {
  name: string; description: string; connected?: boolean; expiresAt?: string; configuredAt?: string;
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
  const [syncType, setSyncType] = useState("deals");
  const [syncResult, setSyncResult] = useState<any>(null);

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
    mutationFn: async (type: string) => {
      const res = await fetch(`/api/integrations/hubspot/sync?type=${type}&limit=20`, { credentials: "include" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message);
      }
      return res.json();
    },
    onSuccess: (data: any) => {
      setSyncResult(data);
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
      toast({ title: `Synced ${data.count} ${data.type} from HubSpot` });
    },
    onError: (e: Error) => {
      setSyncResult(null);
      toast({ title: "Sync Error", description: e.message, variant: "destructive" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-orange-500/10 flex items-center justify-center">
              <span className="text-orange-600 font-bold text-sm">HS</span>
            </div>
            HubSpot CRM Configuration
          </DialogTitle>
          <DialogDescription>
            HubSpot is connected via the Replit integration. Use the buttons below to test the connection and sync data.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-2">
          <div className="p-3 rounded-lg bg-muted/50 border">
            <p className="text-sm font-medium mb-1">Connection Method</p>
            <p className="text-xs text-muted-foreground">
              Managed automatically via Replit integration with OAuth. Token refresh is handled for you.
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Scopes: deals (read/write), companies (read/write), contacts (read/write), schemas (read)
            </p>
          </div>

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
            <p className="text-sm font-medium mb-2">Sync Data from HubSpot</p>
            <p className="text-xs text-muted-foreground mb-3">Pull the latest records from your HubSpot account to verify the integration is working.</p>
            <div className="flex gap-2">
              <Select value={syncType} onValueChange={setSyncType}>
                <SelectTrigger className="w-[140px]" data-testid="select-sync-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="deals">Deals</SelectItem>
                  <SelectItem value="companies">Companies</SelectItem>
                  <SelectItem value="contacts">Contacts</SelectItem>
                </SelectContent>
              </Select>
              <Button
                onClick={() => syncMutation.mutate(syncType)}
                disabled={syncMutation.isPending}
                className="flex-1"
                data-testid="button-sync-hubspot"
              >
                {syncMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-1" />}
                {syncMutation.isPending ? "Syncing..." : "Sync Now"}
              </Button>
            </div>
          </div>

          {syncResult && (
            <div className="rounded-lg border overflow-hidden">
              <div className="px-3 py-2 bg-muted/30 border-b">
                <p className="text-sm font-medium">
                  {syncResult.count} {syncResult.type} found
                </p>
              </div>
              <div className="max-h-48 overflow-y-auto">
                {syncResult.data?.map((item: any, i: number) => (
                  <div key={item.id || i} className="px-3 py-2 border-b last:border-0 text-sm" data-testid={`sync-result-${i}`}>
                    <p className="font-medium text-sm">
                      {item.properties?.dealname || item.properties?.name || `${item.properties?.firstname || ""} ${item.properties?.lastname || ""}`.trim() || `Record #${item.id}`}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      ID: {item.id}
                      {item.properties?.amount && ` | $${Number(item.properties.amount).toLocaleString()}`}
                      {item.properties?.dealstage && ` | Stage: ${item.properties.dealstage}`}
                      {item.properties?.email && ` | ${item.properties.email}`}
                      {item.properties?.domain && ` | ${item.properties.domain}`}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
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
      window.location.href = url;
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
