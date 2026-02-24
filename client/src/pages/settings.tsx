import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { Settings, Link2, Clock, Shield, Activity } from "lucide-react";
import type { PollJob } from "@shared/schema";

export default function SettingsPage() {
  const { toast } = useToast();

  const { data: connections, isLoading: connLoading } = useQuery<any>({
    queryKey: ["/api/dashboard/connections"],
  });

  const { data: pollJobs, isLoading: jobsLoading } = useQuery<PollJob[]>({
    queryKey: ["/api/poll-jobs"],
  });

  const connectProcore = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("GET", "/api/oauth/procore/authorize");
      const { url } = await res.json();
      window.location.href = url;
    },
    onError: (e: Error) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
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
                onConnect={() => toast({ title: "HubSpot is connected via Replit integration" })}
                buttonLabel="Connected via Integration"
              />
              <ConnectionCard
                name="Procore"
                description="Bid Board, Projects, Contracts, Directory, Webhooks"
                connected={connections?.procore?.connected}
                expiresAt={connections?.procore?.expiresAt}
                onConnect={() => connectProcore.mutate()}
                buttonLabel={connectProcore.isPending ? "Redirecting..." : "Connect with OAuth"}
              />
              <ConnectionCard
                name="CompanyCam"
                description="Projects, Photos, Webhooks"
                connected={connections?.companycam?.connected}
                onConnect={() => toast({
                  title: "CompanyCam Setup",
                  description: "Add your COMPANYCAM_API_TOKEN to the Secrets tab to connect.",
                })}
                buttonLabel="Configure API Token"
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
          <EndpointRow
            name="HubSpot Webhook"
            url="/webhooks/hubspot"
            method="POST"
          />
          <EndpointRow
            name="Procore Webhook"
            url="/webhooks/procore"
            method="POST"
          />
          <EndpointRow
            name="CompanyCam Webhook"
            url="/webhooks/companycam"
            method="POST"
          />
          <EndpointRow
            name="Health Check"
            url="/api/health"
            method="GET"
          />
        </CardContent>
      </Card>
    </div>
  );
}

function ConnectionCard({ name, description, connected, expiresAt, onConnect, buttonLabel }: {
  name: string; description: string; connected?: boolean; expiresAt?: string; onConnect: () => void; buttonLabel: string;
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
      </div>
      {!connected && (
        <Button variant="outline" size="sm" onClick={onConnect} data-testid={`button-connect-${name.toLowerCase().replace(/\s+/g, "-")}`}>
          {buttonLabel}
        </Button>
      )}
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
