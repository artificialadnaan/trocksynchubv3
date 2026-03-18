/**
 * Dashboard Page
 * ===============
 *
 * Main landing page showing system health, sync statistics, and recent activity.
 * This is the first page users see after logging in.
 *
 * Dashboard Sections:
 *
 * 1. Stat Cards:
 *    - Total syncs in last 24 hours
 *    - Successful/failed sync counts
 *    - Pending webhook count
 *
 * 2. Connection Status:
 *    - HubSpot connection health
 *    - Procore connection health
 *    - CompanyCam connection health
 *
 * 3. Sync Activity Chart:
 *    - Bar chart showing sync volume over time
 *    - Success vs failure breakdown
 *
 * 4. Recent Activity Feed:
 *    - Latest sync operations
 *    - Stage changes and updates
 *    - Error notifications
 *
 * Data Sources:
 * - GET /api/dashboard/stats: Sync statistics
 * - GET /api/dashboard/connections: Service connection status
 *
 * @page Dashboard
 */

import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import {
  Activity,
  CheckCircle2,
  XCircle,
  ArrowLeftRight,
  TrendingUp,
  Wifi,
  WifiOff,
} from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { format } from "date-fns";

/** Main dashboard page component */
export default function DashboardPage() {
  const [, setLocation] = useLocation();

  const { data: stats, isLoading: statsLoading } = useQuery<any>({
    queryKey: ["/api/dashboard/stats"],
  });

  const { data: connections, isLoading: connLoading } = useQuery<any>({
    queryKey: ["/api/dashboard/connections"],
  });

  const syncTotal = stats?.syncs?.total ?? 0;
  const successRate = stats?.syncs?.successRate ?? 0;
  const successRateColor = successRate >= 95 ? "text-emerald-600" : successRate >= 80 ? "text-amber-500" : "text-destructive";
  const successRateDisplay = syncTotal === 0 ? "—" : `${successRate}%`;

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
      {/* Header */}
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-2xl font-bold font-display tracking-tight" data-testid="text-dashboard-title">Dashboard</h2>
          <p className="text-muted-foreground text-sm mt-0.5">System health and sync activity overview</p>
        </div>
      </div>

      {/* Primary stat cards */}
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

      {/* Secondary row: System events (muted) */}
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

      {/* Connections + Chart */}
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
                <ConnectionRow name="HubSpot" connected={connections?.hubspot?.connected} />
                <ConnectionRow name="Procore" connected={connections?.procore?.connected} />
                <ConnectionRow name="CompanyCam" connected={connections?.companycam?.connected} />
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

      {/* Recent Activity */}
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

function ConnectionRow({ name, connected }: { name: string; connected?: boolean }) {
  return (
    <div className="flex items-center justify-between py-2.5 px-1" data-testid={`status-${name.toLowerCase()}`}>
      <div className="flex items-center gap-2.5">
        <div className={`w-2 h-2 rounded-full ${connected ? "bg-emerald-500" : "bg-muted-foreground/30"}`} />
        <span className="text-sm font-medium">{name}</span>
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
