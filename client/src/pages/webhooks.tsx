import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Webhook, RefreshCw, Eye, RotateCcw } from "lucide-react";
import { useState } from "react";
import { format } from "date-fns";
import type { WebhookLog } from "@shared/schema";

export default function WebhooksPage() {
  const [sourceFilter, setSourceFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedLog, setSelectedLog] = useState<WebhookLog | null>(null);
  const [page, setPage] = useState(0);

  const queryString = new URLSearchParams({
    ...(sourceFilter !== "all" && { source: sourceFilter }),
    ...(statusFilter !== "all" && { status: statusFilter }),
    limit: "50",
    offset: String(page * 50),
  }).toString();

  const { data, isLoading, refetch } = useQuery<{ logs: WebhookLog[]; total: number }>({
    queryKey: [`/api/webhook-logs?${queryString}`],
  });

  const retryMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/webhook-logs/${id}/retry`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ predicate: (query) => (query.queryKey[0] as string).startsWith("/api/webhook-logs") });
    },
  });

  const statusBadge = (status: string) => {
    const variants: Record<string, string> = {
      processed: "bg-green-500/10 text-green-600 border-green-500/20",
      received: "bg-yellow-500/10 text-yellow-600 border-yellow-500/20",
      failed: "bg-red-500/10 text-red-600 border-red-500/20",
      retrying: "bg-blue-500/10 text-blue-600 border-blue-500/20",
    };
    return <Badge className={variants[status] || ""}>{status}</Badge>;
  };

  const sourceBadge = (source: string) => {
    const colors: Record<string, string> = {
      hubspot: "bg-orange-500/10 text-orange-600 border-orange-500/20",
      procore: "bg-blue-500/10 text-blue-600 border-blue-500/20",
      companycam: "bg-purple-500/10 text-purple-600 border-purple-500/20",
    };
    return <Badge className={colors[source] || ""}>{source}</Badge>;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold" data-testid="text-webhooks-title">Webhook Monitor</h2>
          <p className="text-muted-foreground text-sm mt-1">Track and manage webhook deliveries</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-webhooks">
          <RefreshCw className="w-4 h-4 mr-1" />
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <Webhook className="w-4 h-4" />
              Delivery Logs
              {data && <span className="text-xs font-normal text-muted-foreground">({data.total} total)</span>}
            </CardTitle>
            <div className="flex gap-2">
              <Select value={sourceFilter} onValueChange={setSourceFilter}>
                <SelectTrigger className="w-[130px] h-8" data-testid="filter-source">
                  <SelectValue placeholder="Source" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Sources</SelectItem>
                  <SelectItem value="hubspot">HubSpot</SelectItem>
                  <SelectItem value="procore">Procore</SelectItem>
                  <SelectItem value="companycam">CompanyCam</SelectItem>
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[130px] h-8" data-testid="filter-status">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="received">Received</SelectItem>
                  <SelectItem value="processed">Processed</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                  <SelectItem value="retrying">Retrying</SelectItem>
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
              No webhook deliveries yet. Webhooks from HubSpot, Procore, and CompanyCam will appear here.
            </p>
          ) : (
            <>
              <div className="border rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/30">
                      <th className="text-left p-3 font-medium text-muted-foreground">Time</th>
                      <th className="text-left p-3 font-medium text-muted-foreground">Source</th>
                      <th className="text-left p-3 font-medium text-muted-foreground">Event</th>
                      <th className="text-left p-3 font-medium text-muted-foreground">Resource</th>
                      <th className="text-left p-3 font-medium text-muted-foreground">Status</th>
                      <th className="text-right p-3 font-medium text-muted-foreground">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.logs.map((log) => (
                      <tr key={log.id} className="border-b last:border-0 hover:bg-muted/20" data-testid={`webhook-log-${log.id}`}>
                        <td className="p-3 text-xs text-muted-foreground">
                          {log.createdAt ? format(new Date(log.createdAt), "MMM d, h:mm a") : ""}
                        </td>
                        <td className="p-3">{sourceBadge(log.source)}</td>
                        <td className="p-3 font-mono text-xs">{log.eventType}</td>
                        <td className="p-3 text-xs">{log.resourceType} #{log.resourceId}</td>
                        <td className="p-3">{statusBadge(log.status)}</td>
                        <td className="p-3 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setSelectedLog(log)}
                              data-testid={`button-view-${log.id}`}
                            >
                              <Eye className="w-3.5 h-3.5" />
                            </Button>
                            {log.status === "failed" && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => retryMutation.mutate(log.id)}
                                data-testid={`button-retry-${log.id}`}
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between mt-4">
                <p className="text-xs text-muted-foreground">
                  Showing {page * 50 + 1}-{Math.min((page + 1) * 50, data.total)} of {data.total}
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)} data-testid="button-prev-page">
                    Previous
                  </Button>
                  <Button variant="outline" size="sm" disabled={(page + 1) * 50 >= data.total} onClick={() => setPage(page + 1)} data-testid="button-next-page">
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!selectedLog} onOpenChange={() => setSelectedLog(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Webhook Detail</DialogTitle>
          </DialogHeader>
          {selectedLog && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <span className="text-muted-foreground">Event ID:</span>
                  <span className="ml-2 font-mono">{selectedLog.id}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Source:</span>
                  <span className="ml-2">{selectedLog.source}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Event Type:</span>
                  <span className="ml-2 font-mono">{selectedLog.eventType}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Status:</span>
                  <span className="ml-2">{statusBadge(selectedLog.status)}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Processing Time:</span>
                  <span className="ml-2">{selectedLog.processingTimeMs ? `${selectedLog.processingTimeMs}ms` : "N/A"}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Retry Count:</span>
                  <span className="ml-2">{selectedLog.retryCount}/{selectedLog.maxRetries}</span>
                </div>
              </div>
              <div>
                <p className="text-sm font-medium mb-2">Payload</p>
                <ScrollArea className="h-48 rounded-lg border bg-muted/30 p-3">
                  <pre className="text-xs font-mono whitespace-pre-wrap" data-testid="text-payload">
                    {JSON.stringify(selectedLog.payload, null, 2)}
                  </pre>
                </ScrollArea>
              </div>
              {selectedLog.response && (
                <div>
                  <p className="text-sm font-medium mb-2">Response</p>
                  <ScrollArea className="h-32 rounded-lg border bg-muted/30 p-3">
                    <pre className="text-xs font-mono whitespace-pre-wrap">
                      {JSON.stringify(selectedLog.response, null, 2)}
                    </pre>
                  </ScrollArea>
                </div>
              )}
              {selectedLog.errorMessage && (
                <div>
                  <p className="text-sm font-medium mb-2 text-destructive">Error</p>
                  <p className="text-sm text-destructive bg-destructive/5 rounded-lg p-3">{selectedLog.errorMessage}</p>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
