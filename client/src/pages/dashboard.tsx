import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Activity,
  CheckCircle2,
  XCircle,
  Clock,
  ArrowUpDown,
  TrendingUp,
} from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { format } from "date-fns";

export default function DashboardPage() {
  const { data: stats, isLoading: statsLoading } = useQuery<any>({
    queryKey: ["/api/dashboard/stats"],
  });

  const { data: connections, isLoading: connLoading } = useQuery<any>({
    queryKey: ["/api/dashboard/connections"],
  });

  const statCards = [
    { label: "Total Syncs (24h)", value: stats?.totalSyncs || 0, icon: ArrowUpDown, color: "text-primary" },
    { label: "Successful", value: stats?.successfulSyncs || 0, icon: CheckCircle2, color: "text-green-500" },
    { label: "Failed", value: stats?.failedSyncs || 0, icon: XCircle, color: "text-destructive" },
    { label: "Pending Webhooks", value: stats?.pendingWebhooks || 0, icon: Clock, color: "text-yellow-500" },
  ];

  return (
    <div className="space-y-4 md:space-y-6">
      <div>
        <h2 className="text-xl md:text-2xl font-bold" data-testid="text-dashboard-title">Dashboard</h2>
        <p className="text-muted-foreground text-xs md:text-sm mt-1">System health and recent sync activity</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
        {statCards.map((card) => (
          <Card key={card.label}>
            <CardContent className="pt-3 pb-3 px-3 md:pt-5 md:pb-4 md:px-5">
              {statsLoading ? (
                <Skeleton className="h-14 md:h-16 w-full" />
              ) : (
                <div className="flex items-start justify-between">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs md:text-sm text-muted-foreground truncate">{card.label}</p>
                    <p className="text-2xl md:text-3xl font-bold mt-0.5 md:mt-1" data-testid={`stat-${card.label.toLowerCase().replace(/\s+/g, "-")}`}>
                      {card.value}
                    </p>
                  </div>
                  <card.icon className={`w-4 h-4 md:w-5 md:h-5 ${card.color} mt-1 flex-shrink-0`} />
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold">Connection Status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {connLoading ? (
              <Skeleton className="h-20 w-full" />
            ) : (
              <>
                <ConnectionRow name="HubSpot" connected={connections?.hubspot?.connected} data-testid="status-hubspot" />
                <ConnectionRow name="Procore" connected={connections?.procore?.connected} data-testid="status-procore" />
                <ConnectionRow name="CompanyCam" connected={connections?.companycam?.connected} data-testid="status-companycam" />
              </>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <TrendingUp className="w-4 h-4" />
              Sync Activity (7 Days)
            </CardTitle>
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-48 w-full" />
            ) : (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={stats?.syncsByDay || []}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis
                    dataKey="date"
                    fontSize={12}
                    tickFormatter={(d) => format(new Date(d), "MMM d")}
                    stroke="hsl(var(--muted-foreground))"
                  />
                  <YAxis fontSize={12} stroke="hsl(var(--muted-foreground))" />
                  <Tooltip
                    contentStyle={{
                      background: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "8px",
                      fontSize: "12px",
                    }}
                  />
                  <Bar dataKey="success" fill="hsl(var(--chart-2))" radius={[3, 3, 0, 0]} name="Success" />
                  <Bar dataKey="failed" fill="hsl(var(--chart-5))" radius={[3, 3, 0, 0]} name="Failed" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Activity className="w-4 h-4" />
            Recent Activity
          </CardTitle>
        </CardHeader>
        <CardContent>
          {statsLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : (
            <div className="space-y-2" data-testid="recent-activity-list">
              {(!stats?.recentActivity || stats.recentActivity.length === 0) ? (
                <p className="text-sm text-muted-foreground py-6 text-center">No recent activity. Syncs will appear here once webhooks start flowing.</p>
              ) : (
                stats.recentActivity.slice(0, 10).map((log: any) => (
                  <div
                    key={log.id}
                    className="flex items-center justify-between py-2 md:py-2.5 px-2 md:px-3 rounded-lg hover:bg-muted/50 transition-colors gap-2"
                    data-testid={`activity-${log.id}`}
                  >
                    <div className="flex items-center gap-2 md:gap-3 min-w-0 flex-1">
                      <StatusDot status={log.status} />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs md:text-sm font-medium truncate">{log.action}</p>
                        <p className="text-[10px] md:text-xs text-muted-foreground truncate">
                          {log.entityType} {log.entityId ? `#${log.entityId}` : ""} via {log.source}
                        </p>
                      </div>
                    </div>
                    <span className="text-[10px] md:text-xs text-muted-foreground flex-shrink-0">
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

function ConnectionRow({ name, connected }: { name: string; connected?: boolean; "data-testid"?: string }) {
  return (
    <div className="flex items-center justify-between py-2" data-testid={`status-${name.toLowerCase()}`}>
      <span className="text-sm font-medium">{name}</span>
      <Badge variant={connected ? "default" : "secondary"} className={connected ? "bg-green-500/10 text-green-600 border-green-500/20" : ""}>
        {connected ? "Connected" : "Not Connected"}
      </Badge>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const color = status === "success" ? "bg-green-500" : status === "error" ? "bg-red-500" : "bg-yellow-500";
  return <div className={`w-2 h-2 rounded-full ${color}`} />;
}
