import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import {
  BarChart3,
  PieChart,
  TrendingUp,
  DollarSign,
  Building2,
  Users,
  Link2,
  Mail,
  ClipboardCheck,
  Activity,
  AlertCircle,
  CheckCircle2,
  Clock,
  RefreshCw,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart as RePieChart,
  Pie,
  Cell,
  Legend,
  LineChart,
  Line,
} from "recharts";
import { format, formatDistanceToNow } from "date-fns";

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16'];

interface DashboardMetrics {
  totalDeals: number;
  totalProjects: number;
  totalMappings: number;
  activeProjects: number;
  dealsByStage: { stage: string; count: number; totalValue: number }[];
  projectsByStage: { stage: string; count: number }[];
  totalDealValue: number;
  averageDealValue: number;
  syncActivity: {
    totalSyncs: number;
    successfulSyncs: number;
    failedSyncs: number;
    recentSyncs: { date: string; count: number }[];
  };
  emailsSent: number;
  surveysCompleted: number;
  recentActivity: {
    id: string;
    type: string;
    description: string;
    timestamp: string;
    status: string;
    entityType?: string;
  }[];
}

interface SyncHealthReport {
  lastHubSpotSync: string | null;
  lastProcoreSync: string | null;
  lastCompanyCamSync: string | null;
  webhooksProcessedToday: number;
  failedWebhooksToday: number;
  pendingActions: number;
  systemHealth: 'healthy' | 'degraded' | 'unhealthy';
}

export default function ReportsPage() {
  const { data: metrics, isLoading: metricsLoading } = useQuery<DashboardMetrics>({
    queryKey: ["/api/reports/dashboard"],
  });

  const { data: health, isLoading: healthLoading } = useQuery<SyncHealthReport>({
    queryKey: ["/api/reports/health"],
  });

  const formatCurrency = (value: number) => {
    if (value >= 1000000) return `$${(value / 1000000).toFixed(1)}M`;
    if (value >= 1000) return `$${(value / 1000).toFixed(0)}K`;
    return `$${value.toFixed(0)}`;
  };

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div>
          <h2 className="text-xl md:text-2xl font-bold">Reports & Analytics</h2>
          <p className="text-muted-foreground text-xs md:text-sm mt-1">
            Insights into sync operations and pipeline
          </p>
        </div>
        {health && (
          <Badge
            variant={health.systemHealth === 'healthy' ? 'default' : 'destructive'}
            className={
              health.systemHealth === 'healthy'
                ? 'bg-green-500/10 text-green-600 border-green-500/20'
                : health.systemHealth === 'degraded'
                ? 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20'
                : ''
            }
          >
            System {health.systemHealth.charAt(0).toUpperCase() + health.systemHealth.slice(1)}
          </Badge>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 md:gap-4">
        <MetricCard
          icon={Building2}
          label="Deals"
          value={metrics?.totalDeals || 0}
          loading={metricsLoading}
        />
        <MetricCard
          icon={Users}
          label="Projects"
          value={metrics?.totalProjects || 0}
          loading={metricsLoading}
        />
        <MetricCard
          icon={Link2}
          label="Mappings"
          value={metrics?.totalMappings || 0}
          loading={metricsLoading}
        />
        <MetricCard
          icon={DollarSign}
          label="Pipeline"
          value={formatCurrency(metrics?.totalDealValue || 0)}
          loading={metricsLoading}
        />
        <MetricCard
          icon={Mail}
          label="Emails"
          value={metrics?.emailsSent || 0}
          loading={metricsLoading}
        />
        <MetricCard
          icon={ClipboardCheck}
          label="Surveys"
          value={metrics?.surveysCompleted || 0}
          loading={metricsLoading}
        />
      </div>

      <Tabs defaultValue="pipeline" className="space-y-4">
        <TabsList className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="pipeline" className="gap-1 md:gap-2 text-xs md:text-sm px-2 md:px-3">
            <PieChart className="h-3 w-3 md:h-4 md:w-4" />
            <span className="hidden sm:inline">Pipeline</span>
            <span className="sm:hidden">Pipe</span>
          </TabsTrigger>
          <TabsTrigger value="sync" className="gap-1 md:gap-2 text-xs md:text-sm px-2 md:px-3">
            <RefreshCw className="h-3 w-3 md:h-4 md:w-4" />
            <span className="hidden sm:inline">Sync Activity</span>
            <span className="sm:hidden">Sync</span>
          </TabsTrigger>
          <TabsTrigger value="health" className="gap-1 md:gap-2 text-xs md:text-sm px-2 md:px-3">
            <Activity className="h-3 w-3 md:h-4 md:w-4" />
            <span className="hidden sm:inline">System Health</span>
            <span className="sm:hidden">Health</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="pipeline" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <BarChart3 className="h-4 w-4" />
                  Deals by Stage
                </CardTitle>
                <CardDescription>Distribution of deals across pipeline stages</CardDescription>
              </CardHeader>
              <CardContent>
                {metricsLoading ? (
                  <Skeleton className="h-64 w-full" />
                ) : (
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart data={metrics?.dealsByStage || []} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis type="number" fontSize={12} stroke="hsl(var(--muted-foreground))" />
                      <YAxis
                        type="category"
                        dataKey="stage"
                        width={120}
                        fontSize={11}
                        stroke="hsl(var(--muted-foreground))"
                        tickFormatter={(v) => v.length > 15 ? v.slice(0, 15) + '...' : v}
                      />
                      <Tooltip
                        contentStyle={{
                          background: "hsl(var(--card))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: "8px",
                          fontSize: "12px",
                        }}
                        formatter={(value: number, name: string) => [
                          name === 'count' ? value : formatCurrency(value),
                          name === 'count' ? 'Deals' : 'Value'
                        ]}
                      />
                      <Bar dataKey="count" fill="#3b82f6" radius={[0, 4, 4, 0]} name="count" />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <PieChart className="h-4 w-4" />
                  Deal Value by Stage
                </CardTitle>
                <CardDescription>Total contract value distribution</CardDescription>
              </CardHeader>
              <CardContent>
                {metricsLoading ? (
                  <Skeleton className="h-64 w-full" />
                ) : (
                  <ResponsiveContainer width="100%" height={280}>
                    <RePieChart>
                      <Pie
                        data={(metrics?.dealsByStage || []).filter(d => d.totalValue > 0)}
                        cx="50%"
                        cy="50%"
                        innerRadius={60}
                        outerRadius={100}
                        paddingAngle={2}
                        dataKey="totalValue"
                        nameKey="stage"
                        label={({ stage, percent }) =>
                          percent > 0.05 ? `${(percent * 100).toFixed(0)}%` : ''
                        }
                        labelLine={false}
                      >
                        {(metrics?.dealsByStage || []).map((_, index) => (
                          <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{
                          background: "hsl(var(--card))",
                          border: "1px solid hsl(var(--border))",
                          borderRadius: "8px",
                          fontSize: "12px",
                        }}
                        formatter={(value: number) => formatCurrency(value)}
                      />
                      <Legend
                        wrapperStyle={{ fontSize: '11px' }}
                        formatter={(value) => value.length > 20 ? value.slice(0, 20) + '...' : value}
                      />
                    </RePieChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Building2 className="h-4 w-4" />
                  Projects by Stage
                </CardTitle>
                <CardDescription>Procore project stage distribution</CardDescription>
              </CardHeader>
              <CardContent>
                {metricsLoading ? (
                  <Skeleton className="h-64 w-full" />
                ) : (
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart data={metrics?.projectsByStage || []}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis
                        dataKey="stage"
                        fontSize={11}
                        stroke="hsl(var(--muted-foreground))"
                        tickFormatter={(v) => v.length > 10 ? v.slice(0, 10) + '...' : v}
                        angle={-45}
                        textAnchor="end"
                        height={60}
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
                      <Bar dataKey="count" fill="#10b981" radius={[4, 4, 0, 0]} name="Projects" />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <DollarSign className="h-4 w-4" />
                  Pipeline Summary
                </CardTitle>
                <CardDescription>Key financial metrics</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {metricsLoading ? (
                  <Skeleton className="h-48 w-full" />
                ) : (
                  <>
                    <div className="flex items-center justify-between py-3 border-b">
                      <span className="text-sm text-muted-foreground">Total Pipeline Value</span>
                      <span className="text-2xl font-bold text-primary">
                        {formatCurrency(metrics?.totalDealValue || 0)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between py-3 border-b">
                      <span className="text-sm text-muted-foreground">Average Deal Size</span>
                      <span className="text-xl font-semibold">
                        {formatCurrency(metrics?.averageDealValue || 0)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between py-3 border-b">
                      <span className="text-sm text-muted-foreground">Active Projects</span>
                      <span className="text-xl font-semibold">{metrics?.activeProjects || 0}</span>
                    </div>
                    <div className="flex items-center justify-between py-3">
                      <span className="text-sm text-muted-foreground">Linked Mappings</span>
                      <span className="text-xl font-semibold">{metrics?.totalMappings || 0}</span>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="sync" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <TrendingUp className="h-4 w-4" />
                  Sync Activity (Last 7 Days)
                </CardTitle>
              </CardHeader>
              <CardContent>
                {metricsLoading ? (
                  <Skeleton className="h-64 w-full" />
                ) : (
                  <ResponsiveContainer width="100%" height={280}>
                    <LineChart data={metrics?.syncActivity?.recentSyncs || []}>
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
                        labelFormatter={(d) => format(new Date(d), "MMM d, yyyy")}
                      />
                      <Line
                        type="monotone"
                        dataKey="count"
                        stroke="#3b82f6"
                        strokeWidth={2}
                        dot={{ fill: '#3b82f6', r: 4 }}
                        name="Syncs"
                      />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Sync Summary</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {metricsLoading ? (
                  <Skeleton className="h-48 w-full" />
                ) : (
                  <>
                    <div className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span>Success Rate</span>
                        <span className="font-medium">
                          {metrics?.syncActivity?.totalSyncs
                            ? Math.round((metrics.syncActivity.successfulSyncs / metrics.syncActivity.totalSyncs) * 100)
                            : 0}%
                        </span>
                      </div>
                      <Progress
                        value={metrics?.syncActivity?.totalSyncs
                          ? (metrics.syncActivity.successfulSyncs / metrics.syncActivity.totalSyncs) * 100
                          : 0}
                        className="h-2"
                      />
                    </div>
                    <div className="pt-2 space-y-3">
                      <div className="flex items-center justify-between py-2">
                        <div className="flex items-center gap-2">
                          <CheckCircle2 className="h-4 w-4 text-green-500" />
                          <span className="text-sm">Successful</span>
                        </div>
                        <Badge variant="secondary" className="bg-green-500/10 text-green-600">
                          {metrics?.syncActivity?.successfulSyncs || 0}
                        </Badge>
                      </div>
                      <div className="flex items-center justify-between py-2">
                        <div className="flex items-center gap-2">
                          <AlertCircle className="h-4 w-4 text-red-500" />
                          <span className="text-sm">Failed</span>
                        </div>
                        <Badge variant="secondary" className="bg-red-500/10 text-red-600">
                          {metrics?.syncActivity?.failedSyncs || 0}
                        </Badge>
                      </div>
                      <div className="flex items-center justify-between py-2">
                        <div className="flex items-center gap-2">
                          <Activity className="h-4 w-4 text-blue-500" />
                          <span className="text-sm">Total</span>
                        </div>
                        <Badge variant="secondary">
                          {metrics?.syncActivity?.totalSyncs || 0}
                        </Badge>
                      </div>
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Activity className="h-4 w-4" />
                Recent Activity
              </CardTitle>
            </CardHeader>
            <CardContent>
              {metricsLoading ? (
                <Skeleton className="h-48 w-full" />
              ) : (
                <div className="space-y-2">
                  {(!metrics?.recentActivity || metrics.recentActivity.length === 0) ? (
                    <p className="text-sm text-muted-foreground py-8 text-center">
                      No recent activity to display
                    </p>
                  ) : (
                    metrics.recentActivity.slice(0, 15).map((item) => (
                      <div
                        key={item.id}
                        className="flex items-center justify-between py-2.5 px-3 rounded-lg hover:bg-muted/50 transition-colors"
                      >
                        <div className="flex items-center gap-3">
                          <StatusIcon status={item.status} />
                          <div>
                            <p className="text-sm font-medium">{item.description}</p>
                            <p className="text-xs text-muted-foreground">{item.entityType}</p>
                          </div>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {item.timestamp
                            ? formatDistanceToNow(new Date(item.timestamp), { addSuffix: true })
                            : ''}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="health" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Last Sync Times</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {healthLoading ? (
                  <Skeleton className="h-32 w-full" />
                ) : (
                  <>
                    <SyncTimeRow
                      name="HubSpot"
                      timestamp={health?.lastHubSpotSync}
                    />
                    <SyncTimeRow
                      name="Procore"
                      timestamp={health?.lastProcoreSync}
                    />
                    <SyncTimeRow
                      name="CompanyCam"
                      timestamp={health?.lastCompanyCamSync}
                    />
                  </>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Today's Webhooks</CardTitle>
              </CardHeader>
              <CardContent>
                {healthLoading ? (
                  <Skeleton className="h-32 w-full" />
                ) : (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Processed</span>
                      <span className="text-2xl font-bold text-green-600">
                        {health?.webhooksProcessedToday || 0}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Failed</span>
                      <span className="text-2xl font-bold text-red-600">
                        {health?.failedWebhooksToday || 0}
                      </span>
                    </div>
                    <div className="pt-2">
                      <div className="flex justify-between text-sm mb-1">
                        <span>Success Rate</span>
                        <span>
                          {health?.webhooksProcessedToday
                            ? Math.round(
                                ((health.webhooksProcessedToday - health.failedWebhooksToday) /
                                  health.webhooksProcessedToday) *
                                  100
                              )
                            : 100}
                          %
                        </span>
                      </div>
                      <Progress
                        value={
                          health?.webhooksProcessedToday
                            ? ((health.webhooksProcessedToday - health.failedWebhooksToday) /
                                health.webhooksProcessedToday) *
                              100
                            : 100
                        }
                        className="h-2"
                      />
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">System Status</CardTitle>
              </CardHeader>
              <CardContent>
                {healthLoading ? (
                  <Skeleton className="h-32 w-full" />
                ) : (
                  <div className="flex flex-col items-center justify-center py-4">
                    <div
                      className={`w-20 h-20 rounded-full flex items-center justify-center mb-4 ${
                        health?.systemHealth === 'healthy'
                          ? 'bg-green-500/10'
                          : health?.systemHealth === 'degraded'
                          ? 'bg-yellow-500/10'
                          : 'bg-red-500/10'
                      }`}
                    >
                      {health?.systemHealth === 'healthy' ? (
                        <CheckCircle2 className="h-10 w-10 text-green-500" />
                      ) : health?.systemHealth === 'degraded' ? (
                        <Clock className="h-10 w-10 text-yellow-500" />
                      ) : (
                        <AlertCircle className="h-10 w-10 text-red-500" />
                      )}
                    </div>
                    <span className="text-lg font-semibold capitalize">
                      {health?.systemHealth || 'Unknown'}
                    </span>
                    <span className="text-sm text-muted-foreground mt-1">
                      {health?.systemHealth === 'healthy'
                        ? 'All systems operational'
                        : health?.systemHealth === 'degraded'
                        ? 'Some issues detected'
                        : 'Critical issues detected'}
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  loading,
}: {
  icon: React.ElementType;
  label: string;
  value: number | string;
  loading?: boolean;
}) {
  return (
    <Card>
      <CardContent className="pt-3 pb-2 px-3 md:pt-4 md:pb-3 md:px-4">
        {loading ? (
          <Skeleton className="h-12 md:h-14 w-full" />
        ) : (
          <div className="flex items-center gap-2 md:gap-3">
            <div className="p-1.5 md:p-2 rounded-lg bg-primary/10 flex-shrink-0">
              <Icon className="h-3.5 w-3.5 md:h-4 md:w-4 text-primary" />
            </div>
            <div className="min-w-0">
              <p className="text-base md:text-lg font-bold truncate">{value}</p>
              <p className="text-[10px] md:text-xs text-muted-foreground truncate">{label}</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'success') {
    return <CheckCircle2 className="h-4 w-4 text-green-500" />;
  }
  if (status === 'error' || status === 'failed') {
    return <AlertCircle className="h-4 w-4 text-red-500" />;
  }
  return <Clock className="h-4 w-4 text-yellow-500" />;
}

function SyncTimeRow({ name, timestamp }: { name: string; timestamp: string | null }) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm font-medium">{name}</span>
      <span className="text-sm text-muted-foreground">
        {timestamp
          ? formatDistanceToNow(new Date(timestamp), { addSuffix: true })
          : 'Never'}
      </span>
    </div>
  );
}
