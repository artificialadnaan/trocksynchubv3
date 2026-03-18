import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import {
  Activity,
  CheckCircle2,
  XCircle,
  ArrowLeftRight,
  TrendingUp,
  AlertTriangle,
  RefreshCw,
  Gauge,
} from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { format, formatDistanceToNow } from "date-fns";
import { useState } from "react";

export default function DashboardPage() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();

  const { data: stats, isLoading: statsLoading } = useQuery<any>({
    queryKey: ["/api/dashboard/stats"],
  });

  const { data: connections, isLoading: connLoading } = useQuery<any>({
    queryKey: ["/api/dashboard/connections"],
  });

  const { data: failures, isLoading: failuresLoading } = useQuery<any>({
    queryKey: ["/api/dashboard/recent-failures"],
    refetchInterval: 60000,
  });

  const { data: lastSync } = useQuery<any>({
    queryKey: ["/api/dashboard/last-sync"],
  });

  const { data: rateLimits } = useQuery<any>({
    queryKey: ["/api/dashboard/rate-limits"],
    refetchInterval: 30000,
  });

  const syncTotal = stats?.syncs?.total ?? 0;
  const successRate = stats?.syncs?.successRate ?? 0;
  const successRateColor = successRate >= 95 ? "text-emerald-600" : successRate >= 80 ? "text-amber-500" : "text-destructive";
  const successRateDisplay = syncTotal === 0 ? "\u2014" : `${successRate}%`;

  const primaryCards = [
    { label: "Sync Operations", sublabel: "Last 24h", value: syncTotal, icon: ArrowLeftRight, accentColor: "border-l-primary", iconColor: "text-primary", tooltip: "End-to-end sync operations between HubSpot, Procore, and other integrated systems in the last 24 hours.", clickable: true },
    { label: "Successful", sublabel: "Completed", value: stats?.syncs?.successful ?? 0, icon: CheckCircle2, accentColor: "border-l-emerald-500", iconColor: "text-emerald-500", tooltip: "Sync operations that completed without errors and data was successfully written to the target system.", clickable: true },
    { label: "Failed", sublabel: "Errors", value: stats?.syncs?.failed ?? 0, icon: XCircle, accentColor: "border-l-red-400", iconColor: "text-red-400", tooltip: "Sync operations that encountered an error. Check the activity log for details.", clickable: true },
    { label: "Success Rate", sublabel: "Reliability", value: successRateDisplay, icon: TrendingUp, accentColor: "border-l-amber-400", iconColor: successRateColor, tooltip: "Percentage of sync operations that completed successfully in the last 24 hours.", isRate: true },
  ];

  const secondaryCards = [
    { label: "System Events (24h)", value: stats?.system?.total ?? 0, tooltip: "Background system activity including polling, health checks, token refreshes, and webhook acknowledgments." },
    { label: "Pending Webhooks", value: stats?.pendingWebhooks ?? 0, tooltip: "Incoming webhook events that are queued but not yet processed." },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-2xl font-bold font-display tracking-tight" data-testid="text-dashboard-title">Dashboard</h2>
          <p className="text-muted-foreground text-sm mt-0.5">System health and sync activity overview</p>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
        {primaryCards.map((card) => (
          <Card
            key={card.label}
            className={`border-l-[3px] ${card.accentColor} overflow-hidden${card.clickable ? " cursor-pointer hover:shadow-md transition-shadow" : ""}`}
            onClick={card.clickable ? () => setLocation("/audit-logs") : undefined}
          >
            <CardContent className="pt-4 pb-4 px-4 md:pt-5 md:pb-4 md:px-5">
              {statsLoading ? (
                <Skeleton className="h-16 w-full" />
              ) : (
                <div className="flex items-start justify-between">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                      {card.label}
                      <InfoTooltip text={card.tooltip} />
                    </p>
                    <p className="text-2xl md:text-3xl font-bold font-display mt-1 tracking-tight" data-testid={`stat-${card.label.toLowerCase().replace(/\s+/g, "-")}`}>
                      {card.value}
                    </p>
                    <p className="text-[10px] text-muted-foreground/60 mt-0.5 uppercase tracking-wider font-medium">{card.sublabel}</p>
                  </div>
                  <div className="w-9 h-9 rounded-lg bg-muted/50 flex items-center justify-center flex-shrink-0">
                    <card.icon className={`w-4 h-4 ${card.iconColor}`} />
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3 md:gap-4">
        {secondaryCards.map((card) => (
          <Card key={card.label} className="bg-muted/30 border-muted">
            <CardContent className="pt-3 pb-3 px-4 md:pt-4 md:pb-3 md:px-5">
              {statsLoading ? (
                <Skeleton className="h-12 w-full" />
              ) : (
                <div className="flex items-center justify-between overflow-visible">
                  <div className="min-w-0 flex-1 overflow-visible">
                    <p className="text-xs text-muted-foreground flex items-center gap-1.5 shrink-0">
                      {card.label}
                      <InfoTooltip text={card.tooltip} />
                    </p>
                    <p className="text-lg font-semibold text-muted-foreground mt-0.5" data-testid={`stat-${card.label.toLowerCase().replace(/\s+/g, "-")}`}>
                      {card.value}
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold font-display">Connections</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {connLoading ? (
              <Skeleton className="h-20 w-full" />
            ) : (
              <>
                <ConnectionRow name="HubSpot" connected={connections?.hubspot?.connected} lastSync={lastSync?.hubspot} />
                <ConnectionRow name="Procore" connected={connections?.procore?.connected} lastSync={lastSync?.procore} />
                <ConnectionRow name="CompanyCam" connected={connections?.companycam?.connected} lastSync={lastSync?.companycam} />
              </>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold font-display flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-muted-foreground" />
              Sync Activity
              <span className="text-xs font-normal text-muted-foreground">7 days</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-48 w-full" />
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={stats?.syncsByDay || []}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis
                    dataKey="date"
                    fontSize={11}
                    tickFormatter={(d) => format(new Date(d), "MMM d")}
                    stroke="hsl(var(--muted-foreground))"
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    fontSize={11}
                    stroke="hsl(var(--muted-foreground))"
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "8px",
                      fontSize: "12px",
                      boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
                    }}
                  />
                  <Bar dataKey="success" fill="hsl(var(--chart-2))" radius={[4, 4, 0, 0]} name="Success" />
                  <Bar dataKey="failed" fill="hsl(var(--chart-1))" radius={[4, 4, 0, 0]} name="Failed" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {rateLimits && (rateLimits.hubspot?.limit || rateLimits.procore?.limit) && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold font-display flex items-center gap-2">
              <Gauge className="w-4 h-4 text-muted-foreground" />
              API Rate Limits
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {["hubspot", "procore"].map((provider) => {
              const state = rateLimits?.[provider];
              if (!state?.limit) return null;
              const ratio = state.remaining != null ? state.remaining / state.limit : 1;
              const barColor = ratio < 0.05 ? "bg-red-500" : ratio < 0.1 ? "bg-amber-500" : "bg-emerald-500";
              return (
                <div key={provider}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium capitalize">{provider}</span>
                    <span className="text-xs text-muted-foreground">
                      {state.remaining ?? "?"} / {state.limit} remaining
                    </span>
                  </div>
                  <div className="h-2 bg-muted rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${barColor}`}
                      style={{ width: `${Math.max(ratio * 100, 1)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}

      <RecentFailuresCard failures={failures} isLoading={failuresLoading} queryClient={queryClient} />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold font-display flex items-center gap-2">
            <Activity className="w-4 h-4 text-muted-foreground" />
            Recent Activity
          </CardTitle>
        </CardHeader>
        <CardContent>
          {statsLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : (
            <div className="space-y-1" data-testid="recent-activity-list">
              {(!stats?.recentActivity || stats.recentActivity.length === 0) ? (
                <div className="text-center py-10">
                  <Activity className="w-8 h-8 text-muted-foreground/30 mx-auto mb-3" />
                  <p className="text-sm text-muted-foreground">No recent activity</p>
                  <p className="text-xs text-muted-foreground/60 mt-1">Syncs will appear here once webhooks start flowing.</p>
                </div>
              ) : (
                stats.recentActivity.slice(0, 10).map((log: any) => (
                  <div
                    key={log.id}
                    className="flex items-center justify-between py-2.5 px-3 rounded-lg hover:bg-muted/40 transition-colors gap-3"
                    data-testid={`activity-${log.id}`}
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <StatusDot status={log.status} />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">{log.action}</p>
                        <p className="text-xs text-muted-foreground truncate mt-0.5">
                          {log.entityType} {log.entityId ? `#${log.entityId}` : ""} via {log.source}
                        </p>
                      </div>
                    </div>
                    <span className="text-xs text-muted-foreground/60 flex-shrink-0 tabular-nums">
                      {log.createdAt ? format(new Date(log.createdAt), "h:mm a") : ""}
                    </span>
                  </div>
                ))
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function RecentFailuresCard({ failures, isLoading, queryClient }: { failures: any; isLoading: boolean; queryClient: any }) {
  const [replayingId, setReplayingId] = useState<number | null>(null);
  const totalFailures = (failures?.auditFailures?.length ?? 0) + (failures?.webhookFailures?.length ?? 0);

  const handleReplay = async (webhookId: number) => {
    setReplayingId(webhookId);
    try {
      const res = await fetch(`/api/webhooks/replay/${webhookId}`, { method: "POST", credentials: "include" });
      const data = await res.json();
      if (data.success) {
        queryClient.invalidateQueries({ queryKey: ["/api/dashboard/recent-failures"] });
        queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
      }
    } catch {
    } finally {
      setReplayingId(null);
    }
  };

  if (!isLoading && totalFailures === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-semibold font-display flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-red-400" />
          Recent Failures
          {totalFailures > 0 && (
            <Badge variant="destructive" className="text-[10px] px-1.5 py-0">{totalFailures}</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <div className="space-y-1">
            {failures?.webhookFailures?.map((wh: any) => (
              <div key={`wh-${wh.id}`} className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-muted/40 transition-colors gap-2">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <StatusDot status="error" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">Webhook: {wh.source} {wh.eventType}</p>
                    <p className="text-xs text-muted-foreground truncate mt-0.5">
                      {wh.errorMessage || "Unknown error"} &middot; Retry {wh.retryCount}/{wh.maxRetries}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="text-xs text-muted-foreground/60 tabular-nums">
                    {wh.createdAt ? format(new Date(wh.createdAt), "h:mm a") : ""}
                  </span>
                  {wh.retryCount < wh.maxRetries && (
                    <Button size="sm" variant="outline" className="h-6 px-2 text-xs" disabled={replayingId === wh.id} onClick={() => handleReplay(wh.id)}>
                      <RefreshCw className={`w-3 h-3 mr-1 ${replayingId === wh.id ? "animate-spin" : ""}`} />
                      Retry
                    </Button>
                  )}
                </div>
              </div>
            ))}
            {failures?.auditFailures?.map((log: any) => (
              <div key={`audit-${log.id}`} className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-muted/40 transition-colors gap-3">
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <StatusDot status="error" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{log.action}</p>
                    <p className="text-xs text-muted-foreground truncate mt-0.5">
                      {log.entityType} {log.entityId ? `#${log.entityId}` : ""} &middot; {log.errorMessage || "Unknown error"}
                    </p>
                  </div>
                </div>
                <span className="text-xs text-muted-foreground/60 flex-shrink-0 tabular-nums">
                  {log.createdAt ? format(new Date(log.createdAt), "h:mm a") : ""}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ConnectionRow({ name, connected, lastSync }: { name: string; connected?: boolean; lastSync?: string | null }) {
  return (
    <div className="flex items-center justify-between py-2.5 px-1" data-testid={`status-${name.toLowerCase()}`}>
      <div className="flex items-center gap-2.5">
        <div className={`w-2 h-2 rounded-full ${connected ? "bg-emerald-500" : "bg-muted-foreground/30"}`} />
        <div>
          <span className="text-sm font-medium">{name}</span>
          {lastSync && (
            <p className="text-[10px] text-muted-foreground/60">
              Last sync {formatDistanceToNow(new Date(lastSync), { addSuffix: true })}
            </p>
          )}
        </div>
      </div>
      <Badge
        variant={connected ? "default" : "secondary"}
        className={connected
          ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20 text-[11px] font-medium"
          : "text-[11px] font-medium"
        }
      >
        {connected ? "Connected" : "Disconnected"}
      </Badge>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const styles = {
    success: "bg-emerald-500",
    error: "bg-red-500",
    pending: "bg-amber-400",
  };
  const color = styles[status as keyof typeof styles] || styles.pending;
  return <div className={`w-2 h-2 rounded-full flex-shrink-0 ${color}`} />;
}
