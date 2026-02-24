import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ScrollText, ChevronDown, RefreshCw } from "lucide-react";
import { useState } from "react";
import { format } from "date-fns";
import type { AuditLog } from "@shared/schema";

export default function AuditLogsPage() {
  const [entityTypeFilter, setEntityTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());

  const queryParams = new URLSearchParams();
  if (entityTypeFilter !== "all") queryParams.set("entityType", entityTypeFilter);
  if (statusFilter !== "all") queryParams.set("status", statusFilter);
  queryParams.set("limit", "50");
  queryParams.set("offset", String(page * 50));

  const { data, isLoading, refetch } = useQuery<{ logs: AuditLog[]; total: number }>({
    queryKey: [`/api/audit-logs?${queryParams.toString()}`],
  });

  const toggleExpanded = (id: number) => {
    const next = new Set(expandedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedIds(next);
  };

  const statusColor = (status: string) => {
    const colors: Record<string, string> = {
      success: "bg-green-500/10 text-green-600 border-green-500/20",
      error: "bg-red-500/10 text-red-600 border-red-500/20",
      received: "bg-yellow-500/10 text-yellow-600 border-yellow-500/20",
      pending: "bg-blue-500/10 text-blue-600 border-blue-500/20",
    };
    return colors[status] || "";
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold" data-testid="text-audit-logs-title">Audit Logs</h2>
          <p className="text-muted-foreground text-sm mt-1">Complete sync history and activity trail</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-audit">
          <RefreshCw className="w-4 h-4 mr-1" />
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <ScrollText className="w-4 h-4" />
              Activity Trail
              {data && <span className="text-xs font-normal text-muted-foreground">({data.total} total)</span>}
            </CardTitle>
            <div className="flex gap-2">
              <Select value={entityTypeFilter} onValueChange={setEntityTypeFilter}>
                <SelectTrigger className="w-[140px] h-8" data-testid="filter-entity-type">
                  <SelectValue placeholder="Entity Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="deal">Deal</SelectItem>
                  <SelectItem value="company">Company</SelectItem>
                  <SelectItem value="project">Project</SelectItem>
                  <SelectItem value="procore">Procore</SelectItem>
                  <SelectItem value="unknown">Unknown</SelectItem>
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[120px] h-8" data-testid="filter-audit-status">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="success">Success</SelectItem>
                  <SelectItem value="error">Error</SelectItem>
                  <SelectItem value="received">Received</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : !data?.logs || data.logs.length === 0 ? (
            <p className="text-sm text-muted-foreground py-12 text-center">
              No audit logs yet. All sync operations, webhook events, and system actions will be recorded here.
            </p>
          ) : (
            <>
              <div className="space-y-1">
                {data.logs.map((log) => (
                  <Collapsible
                    key={log.id}
                    open={expandedIds.has(log.id)}
                    onOpenChange={() => toggleExpanded(log.id)}
                  >
                    <CollapsibleTrigger className="w-full" data-testid={`audit-log-${log.id}`}>
                      <div className="flex items-center justify-between py-2.5 px-3 rounded-lg hover:bg-muted/30 transition-colors text-left">
                        <div className="flex items-center gap-3 flex-1">
                          <StatusDot status={log.status} />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium">{log.action}</p>
                            <p className="text-xs text-muted-foreground">
                              {log.entityType} {log.entityId ? `#${log.entityId}` : ""} | {log.source}
                              {log.destination ? ` → ${log.destination}` : ""}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
                          <Badge className={`text-xs ${statusColor(log.status)}`}>{log.status}</Badge>
                          {log.durationMs && (
                            <span className="text-xs text-muted-foreground">{log.durationMs}ms</span>
                          )}
                          <span className="text-xs text-muted-foreground">
                            {log.createdAt ? format(new Date(log.createdAt), "MMM d, h:mm a") : ""}
                          </span>
                          <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${expandedIds.has(log.id) ? "rotate-180" : ""}`} />
                        </div>
                      </div>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="ml-8 mr-3 mb-3 p-4 rounded-lg border bg-muted/20 space-y-3">
                        <div className="grid grid-cols-2 gap-3 text-sm">
                          <div>
                            <span className="text-muted-foreground">Action:</span>
                            <span className="ml-2 font-medium">{log.action}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Entity:</span>
                            <span className="ml-2">{log.entityType} {log.entityId ? `#${log.entityId}` : ""}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Source:</span>
                            <span className="ml-2">{log.source}</span>
                          </div>
                          {log.idempotencyKey && (
                            <div>
                              <span className="text-muted-foreground">Idempotency Key:</span>
                              <span className="ml-2 font-mono text-xs">{log.idempotencyKey}</span>
                            </div>
                          )}
                        </div>
                        {log.details && (
                          <div>
                            <p className="text-sm font-medium mb-1">Details</p>
                            <ScrollArea className="h-32 rounded border bg-card p-2">
                              <pre className="text-xs font-mono whitespace-pre-wrap">
                                {JSON.stringify(log.details, null, 2)}
                              </pre>
                            </ScrollArea>
                          </div>
                        )}
                        {log.errorMessage && (
                          <div className="text-sm text-destructive bg-destructive/5 rounded p-2">
                            {log.errorMessage}
                          </div>
                        )}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                ))}
              </div>

              <div className="flex items-center justify-between mt-4">
                <p className="text-xs text-muted-foreground">
                  Showing {page * 50 + 1}-{Math.min((page + 1) * 50, data.total)} of {data.total}
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)}>
                    Previous
                  </Button>
                  <Button variant="outline" size="sm" disabled={(page + 1) * 50 >= data.total} onClick={() => setPage(page + 1)}>
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const color = status === "success" ? "bg-green-500" : status === "error" ? "bg-red-500" : "bg-yellow-500";
  return <div className={`w-2 h-2 rounded-full ${color} flex-shrink-0`} />;
}
