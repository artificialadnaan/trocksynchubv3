import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Link2,
  Unlink,
  RefreshCw,
  Search,
  ChevronDown,
  AlertTriangle,
  CheckCircle2,
  ArrowRight,
  Building2,
  Loader2,
  ExternalLink,
  Plus,
  Camera,
  Calculator,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { format } from "date-fns";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

const PROCORE_COMPANY_ID = "598134325683880";
const HUBSPOT_PORTAL_ID = "245227962";

interface SyncOverview {
  totalMappings: number;
  totalProcore: number;
  totalHubspot: number;
  mappedProcore: number;
  mappedHubspot: number;
  withConflicts: number;
  recentMappings: any[];
}

interface MappingData {
  data: any[];
  total: number;
}

interface SyncLookupEntry {
  hubspotDealId: string | null;
  hubspotDealName: string | null;
  procoreProjectId: string | null;
  procoreProjectName: string | null;
  procoreProjectNumber: string | null;
  companycamProjectId: string | null;
}

type ReportType = "procore" | "hubspot" | "conflicts" | "companycam" | "bidboard" | null;

export default function ProjectSyncPage() {
  const [search, setSearch] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [manualLinkOpen, setManualLinkOpen] = useState(false);
  const [procoreSearch, setProcoreSearch] = useState("");
  const [hubspotSearch, setHubspotSearch] = useState("");
  const [selectedProcore, setSelectedProcore] = useState<string | null>(null);
  const [selectedHubspot, setSelectedHubspot] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState<ReportType>(null);
  const [reportTab, setReportTab] = useState<"matched" | "unmatched">("matched");
  const { toast } = useToast();

  const { data: overview, isLoading: overviewLoading } = useQuery<SyncOverview>({
    queryKey: ["/api/procore-hubspot/overview"],
  });

  const params = new URLSearchParams();
  if (search) params.set("search", search);
  const paramsStr = params.toString();

  const { data: mappings, isLoading: mappingsLoading } = useQuery<MappingData>({
    queryKey: ["/api/procore-hubspot/mappings", paramsStr],
    queryFn: async () => {
      const url = paramsStr ? `/api/procore-hubspot/mappings?${paramsStr}` : "/api/procore-hubspot/mappings";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch mappings");
      return res.json();
    },
  });

  const { data: unmatched } = useQuery<{
    unmatchedProcore: any[];
    unmatchedHubspot: any[];
  }>({
    queryKey: ["/api/procore-hubspot/unmatched"],
  });

  const { data: syncLookup } = useQuery<Record<string, SyncLookupEntry>>({
    queryKey: ["/api/sync-mappings/lookup"],
  });

  const { data: companycamProjects } = useQuery<{ data: any[]; total: number }>({
    queryKey: ["/api/companycam/projects?limit=500"],
  });

  const { data: bidboardEstimates } = useQuery<{ data: any[]; total: number }>({
    queryKey: ["/api/bidboard/estimates?limit=500"],
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/procore-hubspot/sync");
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Sync Complete",
        description: `Matched ${data.matched} projects. ${data.hubspotCreated || 0} created in HubSpot, ${data.hubspotUpdates} updated, ${data.conflicts} conflicts.`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/procore-hubspot/overview"] });
      queryClient.invalidateQueries({ queryKey: ["/api/procore-hubspot/mappings"] });
    },
    onError: (e: any) => {
      toast({ title: "Sync Failed", description: e.message, variant: "destructive" });
    },
  });

  const unlinkMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/procore-hubspot/mappings/${id}`);
    },
    onSuccess: () => {
      toast({ title: "Mapping removed" });
      queryClient.invalidateQueries({ queryKey: ["/api/procore-hubspot/overview"] });
      queryClient.invalidateQueries({ queryKey: ["/api/procore-hubspot/mappings"] });
    },
  });

  const manualLinkMutation = useMutation({
    mutationFn: async ({ procoreProjectId, hubspotDealId }: { procoreProjectId: string; hubspotDealId: string }) => {
      const res = await apiRequest("POST", "/api/procore-hubspot/manual-link", { procoreProjectId, hubspotDealId });
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Linked", description: data.message });
      setManualLinkOpen(false);
      setSelectedProcore(null);
      setSelectedHubspot(null);
      queryClient.invalidateQueries({ queryKey: ["/api/procore-hubspot/overview"] });
      queryClient.invalidateQueries({ queryKey: ["/api/procore-hubspot/mappings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/procore-hubspot/unmatched"] });
    },
    onError: (e: any) => {
      toast({ title: "Failed", description: e.message, variant: "destructive" });
    },
  });

  const toggleExpanded = (id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const filteredUnmatchedProcore = unmatched?.unmatchedProcore?.filter(
    (p) => !procoreSearch || p.name?.toLowerCase().includes(procoreSearch.toLowerCase()) || p.projectNumber?.toLowerCase().includes(procoreSearch.toLowerCase())
  ).slice(0, 50) || [];

  const filteredUnmatchedHubspot = unmatched?.unmatchedHubspot?.filter(
    (d) => !hubspotSearch || d.dealName?.toLowerCase().includes(hubspotSearch.toLowerCase())
  ).slice(0, 50) || [];

  const getProcoreUrl = (projectId: string) => 
    `https://us02.procore.com/webclients/host/companies/${PROCORE_COMPANY_ID}/projects/${projectId}/tools/projecthome`;
  
  const getHubspotUrl = (dealId: string) => 
    `https://app-na2.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-3/${dealId}`;

  const getCompanyCamUrl = (projectId: string) =>
    `https://app.companycam.com/projects/${projectId}`;

  // Calculate CompanyCam matched/unmatched
  const companycamMatched = companycamProjects?.data?.filter(p => {
    const lookup = syncLookup?.[`companycam:${p.companycamId}`];
    return lookup?.procoreProjectId || lookup?.hubspotDealId;
  }) || [];
  
  const companycamUnmatched = companycamProjects?.data?.filter(p => {
    const lookup = syncLookup?.[`companycam:${p.companycamId}`];
    return !lookup?.procoreProjectId && !lookup?.hubspotDealId;
  }) || [];

  // Calculate BidBoard matched/unmatched (matched = linked to Procore project or HubSpot deal)
  const bidboardMatched = bidboardEstimates?.data?.filter(b => {
    return b.matchStatus === 'matched' || b.procoreProjectId;
  }) || [];
  
  const bidboardUnmatched = bidboardEstimates?.data?.filter(b => {
    return b.matchStatus !== 'matched' && !b.procoreProjectId;
  }) || [];

  const getReportTitle = (type: ReportType) => {
    switch (type) {
      case "procore": return "Procore Projects";
      case "hubspot": return "HubSpot Deals";
      case "conflicts": return "Projects with Conflicts";
      case "companycam": return "CompanyCam Projects";
      case "bidboard": return "BidBoard Projects";
      default: return "Report";
    }
  };

  const getMappingsWithConflicts = () => {
    return mappings?.data?.filter(m => {
      const meta = m.metadata || {};
      return meta.conflicts && meta.conflicts.length > 0;
    }) || [];
  };

  const renderProjectList = (type: ReportType) => {
    if (type === "procore") {
      const matched = mappings?.data?.filter(m => m.procoreProjectId) || [];
      const unmatchedList = unmatched?.unmatchedProcore || [];
      
      return (
        <Tabs value={reportTab} onValueChange={(v) => setReportTab(v as any)}>
          <TabsList className="w-full">
            <TabsTrigger value="matched" className="flex-1">
              <CheckCircle2 className="w-4 h-4 mr-2 text-green-500" />
              Matched ({matched.length})
            </TabsTrigger>
            <TabsTrigger value="unmatched" className="flex-1">
              <XCircle className="w-4 h-4 mr-2 text-red-500" />
              Unmatched ({unmatchedList.length})
            </TabsTrigger>
          </TabsList>
          <TabsContent value="matched" className="mt-4">
            <div className="space-y-2">
              {matched.map((m: any) => (
                <div key={m.id} className="p-3 border rounded-lg">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{m.procoreProjectName}</div>
                      {m.procoreProjectNumber && (
                        <Badge variant="secondary" className="font-mono text-xs mt-1">{m.procoreProjectNumber}</Badge>
                      )}
                      <div className="text-xs text-muted-foreground mt-1">
                        Linked to: {m.hubspotDealName || "—"}
                      </div>
                    </div>
                    <div className="flex flex-col gap-1">
                      <a href={getProcoreUrl(m.procoreProjectId)} target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline">
                        <Building2 className="w-3 h-3" /> Procore <ExternalLink className="w-3 h-3" />
                      </a>
                      {m.hubspotDealId && (
                        <a href={getHubspotUrl(m.hubspotDealId)} target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-orange-600 hover:underline">
                          <Building2 className="w-3 h-3" /> HubSpot <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              {matched.length === 0 && <p className="text-center text-muted-foreground py-8">No matched projects</p>}
            </div>
          </TabsContent>
          <TabsContent value="unmatched" className="mt-4">
            <div className="space-y-2">
              {unmatchedList.map((p: any) => (
                <div key={p.procoreId} className="p-3 border rounded-lg border-red-200 bg-red-50/50 dark:bg-red-950/20">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{p.name}</div>
                      {p.projectNumber && (
                        <Badge variant="secondary" className="font-mono text-xs mt-1">{p.projectNumber}</Badge>
                      )}
                      <div className="text-xs text-muted-foreground mt-1">
                        {p.city && `${p.city}, ${p.stateCode}`} {p.stage && `• ${p.stage}`}
                      </div>
                    </div>
                    <a href={getProcoreUrl(p.procoreId)} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline">
                      <Building2 className="w-3 h-3" /> Procore <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                </div>
              ))}
              {unmatchedList.length === 0 && <p className="text-center text-muted-foreground py-8">All projects are matched!</p>}
            </div>
          </TabsContent>
        </Tabs>
      );
    }
    
    if (type === "hubspot") {
      const matched = mappings?.data?.filter(m => m.hubspotDealId) || [];
      const unmatchedList = unmatched?.unmatchedHubspot || [];
      
      return (
        <Tabs value={reportTab} onValueChange={(v) => setReportTab(v as any)}>
          <TabsList className="w-full">
            <TabsTrigger value="matched" className="flex-1">
              <CheckCircle2 className="w-4 h-4 mr-2 text-green-500" />
              Matched ({matched.length})
            </TabsTrigger>
            <TabsTrigger value="unmatched" className="flex-1">
              <XCircle className="w-4 h-4 mr-2 text-red-500" />
              Unmatched ({unmatchedList.length})
            </TabsTrigger>
          </TabsList>
          <TabsContent value="matched" className="mt-4">
            <div className="space-y-2">
              {matched.map((m: any) => (
                <div key={m.id} className="p-3 border rounded-lg">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{m.hubspotDealName}</div>
                      <div className="text-xs text-muted-foreground mt-1">
                        Linked to: {m.procoreProjectName || "—"}
                      </div>
                    </div>
                    <div className="flex flex-col gap-1">
                      <a href={getHubspotUrl(m.hubspotDealId)} target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-orange-600 hover:underline">
                        <Building2 className="w-3 h-3" /> HubSpot <ExternalLink className="w-3 h-3" />
                      </a>
                      {m.procoreProjectId && (
                        <a href={getProcoreUrl(m.procoreProjectId)} target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline">
                          <Building2 className="w-3 h-3" /> Procore <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              {matched.length === 0 && <p className="text-center text-muted-foreground py-8">No matched deals</p>}
            </div>
          </TabsContent>
          <TabsContent value="unmatched" className="mt-4">
            <div className="space-y-2">
              {unmatchedList.map((d: any) => (
                <div key={d.hubspotId} className="p-3 border rounded-lg border-red-200 bg-red-50/50 dark:bg-red-950/20">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{d.dealName}</div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {d.amount && `$${parseFloat(d.amount).toLocaleString()}`} {d.stageName && `• ${d.stageName}`}
                      </div>
                    </div>
                    <a href={getHubspotUrl(d.hubspotId)} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-orange-600 hover:underline">
                      <Building2 className="w-3 h-3" /> HubSpot <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                </div>
              ))}
              {unmatchedList.length === 0 && <p className="text-center text-muted-foreground py-8">All deals are matched!</p>}
            </div>
          </TabsContent>
        </Tabs>
      );
    }
    
    if (type === "conflicts") {
      const conflictsList = getMappingsWithConflicts();
      return (
        <div className="space-y-2">
          {conflictsList.map((m: any) => {
            const meta = m.metadata || {};
            return (
              <div key={m.id} className="p-3 border rounded-lg border-yellow-300 bg-yellow-50/50 dark:bg-yellow-950/20">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{m.procoreProjectName || m.hubspotDealName}</div>
                    {m.procoreProjectNumber && (
                      <Badge variant="secondary" className="font-mono text-xs mt-1">{m.procoreProjectNumber}</Badge>
                    )}
                    <div className="mt-2 space-y-1">
                      {meta.conflicts?.map((c: any, i: number) => (
                        <div key={i} className="text-xs text-yellow-700 dark:text-yellow-400">
                          <span className="font-medium">{c.field}:</span> Procore: {c.procoreValue || "—"} → HubSpot: {c.hubspotValue || "—"}
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-col gap-1">
                    {m.procoreProjectId && (
                      <a href={getProcoreUrl(m.procoreProjectId)} target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline">
                        <Building2 className="w-3 h-3" /> Procore <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                    {m.hubspotDealId && (
                      <a href={getHubspotUrl(m.hubspotDealId)} target="_blank" rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-orange-600 hover:underline">
                        <Building2 className="w-3 h-3" /> HubSpot <ExternalLink className="w-3 h-3" />
                      </a>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          {conflictsList.length === 0 && <p className="text-center text-muted-foreground py-8">No conflicts found</p>}
        </div>
      );
    }
    
    if (type === "companycam") {
      return (
        <Tabs value={reportTab} onValueChange={(v) => setReportTab(v as any)}>
          <TabsList className="w-full">
            <TabsTrigger value="matched" className="flex-1">
              <CheckCircle2 className="w-4 h-4 mr-2 text-green-500" />
              Linked ({companycamMatched.length})
            </TabsTrigger>
            <TabsTrigger value="unmatched" className="flex-1">
              <XCircle className="w-4 h-4 mr-2 text-red-500" />
              Not Linked ({companycamUnmatched.length})
            </TabsTrigger>
          </TabsList>
          <TabsContent value="matched" className="mt-4">
            <div className="space-y-2">
              {companycamMatched.map((p: any) => {
                const lookup = syncLookup?.[`companycam:${p.companycamId}`];
                return (
                  <div key={p.id} className="p-3 border rounded-lg">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{p.name}</div>
                        <div className="text-xs text-muted-foreground mt-1">
                          {p.streetAddress && `${p.streetAddress}, `}{p.city}, {p.state}
                        </div>
                        <div className="text-xs text-green-600 mt-1">
                          Linked to: {lookup?.procoreProjectName || lookup?.hubspotDealName || "Project"}
                        </div>
                      </div>
                      <div className="flex flex-col gap-1">
                        <a href={getCompanyCamUrl(p.companycamId)} target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-purple-600 hover:underline">
                          <Camera className="w-3 h-3" /> CompanyCam <ExternalLink className="w-3 h-3" />
                        </a>
                        {lookup?.procoreProjectId && (
                          <a href={getProcoreUrl(lookup.procoreProjectId)} target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline">
                            <Building2 className="w-3 h-3" /> Procore <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              {companycamMatched.length === 0 && <p className="text-center text-muted-foreground py-8">No linked projects</p>}
            </div>
          </TabsContent>
          <TabsContent value="unmatched" className="mt-4">
            <div className="space-y-2">
              {companycamUnmatched.map((p: any) => (
                <div key={p.id} className="p-3 border rounded-lg border-red-200 bg-red-50/50 dark:bg-red-950/20">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{p.name}</div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {p.streetAddress && `${p.streetAddress}, `}{p.city}, {p.state}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Photos: {p.photoCount || 0}
                      </div>
                    </div>
                    <a href={getCompanyCamUrl(p.companycamId)} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-purple-600 hover:underline">
                      <Camera className="w-3 h-3" /> CompanyCam <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                </div>
              ))}
              {companycamUnmatched.length === 0 && <p className="text-center text-muted-foreground py-8">All projects are linked!</p>}
            </div>
          </TabsContent>
        </Tabs>
      );
    }
    
    if (type === "bidboard") {
      return (
        <Tabs value={reportTab} onValueChange={(v) => setReportTab(v as any)}>
          <TabsList className="w-full">
            <TabsTrigger value="matched" className="flex-1">
              <CheckCircle2 className="w-4 h-4 mr-2 text-green-500" />
              Matched ({bidboardMatched.length})
            </TabsTrigger>
            <TabsTrigger value="unmatched" className="flex-1">
              <XCircle className="w-4 h-4 mr-2 text-red-500" />
              Unmatched ({bidboardUnmatched.length})
            </TabsTrigger>
          </TabsList>
          <TabsContent value="matched" className="mt-4">
            <div className="space-y-2">
              {bidboardMatched.map((b: any) => {
                const lookup = b.procoreProjectId ? syncLookup?.[`procore:${b.procoreProjectId}`] : null;
                return (
                  <div key={b.id} className="p-3 border rounded-lg">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{b.name}</div>
                        {b.projectNumber && (
                          <Badge variant="secondary" className="font-mono text-xs mt-1">{b.projectNumber}</Badge>
                        )}
                        <div className="text-xs text-muted-foreground mt-1">
                          {b.estimator && `Estimator: ${b.estimator}`} {b.status && `• ${b.status}`}
                        </div>
                        {lookup?.procoreProjectName && (
                          <div className="text-xs text-green-600 mt-1">
                            Linked to: {lookup.procoreProjectName}
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col gap-1">
                        {b.procoreProjectId && (
                          <a href={getProcoreUrl(b.procoreProjectId)} target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline">
                            <Building2 className="w-3 h-3" /> Procore <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                        {lookup?.hubspotDealId && (
                          <a href={getHubspotUrl(lookup.hubspotDealId)} target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-orange-600 hover:underline">
                            <Building2 className="w-3 h-3" /> HubSpot <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              {bidboardMatched.length === 0 && <p className="text-center text-muted-foreground py-8">No matched estimates</p>}
            </div>
          </TabsContent>
          <TabsContent value="unmatched" className="mt-4">
            <div className="space-y-2">
              {bidboardUnmatched.map((b: any) => (
                <div key={b.id} className="p-3 border rounded-lg border-red-200 bg-red-50/50 dark:bg-red-950/20">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{b.name}</div>
                      {b.projectNumber && (
                        <Badge variant="secondary" className="font-mono text-xs mt-1">{b.projectNumber}</Badge>
                      )}
                      <div className="text-xs text-muted-foreground mt-1">
                        {b.estimator && `Estimator: ${b.estimator}`} {b.status && `• ${b.status}`}
                      </div>
                      {b.customerName && (
                        <div className="text-xs text-muted-foreground">
                          Customer: {b.customerName}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              {bidboardUnmatched.length === 0 && <p className="text-center text-muted-foreground py-8">All estimates are matched!</p>}
            </div>
          </TabsContent>
        </Tabs>
      );
    }
    
    return null;
  };

  return (
    <div className="space-y-6" data-testid="project-sync-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-page-title">Procore → HubSpot Sync</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Link Procore projects to HubSpot deals via project number. Procore is master data.
          </p>
        </div>
        <div className="flex gap-2">
          <Dialog open={manualLinkOpen} onOpenChange={setManualLinkOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" data-testid="button-manual-link">
                <Plus className="w-4 h-4 mr-2" />
                Manual Link
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-4xl max-h-[80vh]" aria-describedby={undefined}>
              <DialogHeader>
                <DialogTitle>Manually Link Procore Project ↔ HubSpot Deal</DialogTitle>
              </DialogHeader>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <h3 className="font-medium mb-2">Unmatched Procore Projects ({unmatched?.unmatchedProcore?.length || 0})</h3>
                  <Input
                    placeholder="Search projects..."
                    value={procoreSearch}
                    onChange={(e) => setProcoreSearch(e.target.value)}
                    className="mb-2"
                    data-testid="input-search-procore-unmatched"
                  />
                  <ScrollArea className="h-[400px] border rounded-md">
                    {filteredUnmatchedProcore.map((p) => (
                      <div
                        key={p.procoreId}
                        className={`p-2 border-b cursor-pointer text-sm hover:bg-accent/50 transition-colors ${selectedProcore === p.procoreId ? "bg-accent" : ""}`}
                        onClick={() => setSelectedProcore(p.procoreId)}
                        data-testid={`item-procore-${p.procoreId}`}
                      >
                        <div className="font-medium truncate">{p.name}</div>
                        <div className="text-muted-foreground text-xs flex gap-2">
                          {p.projectNumber && <span>{p.projectNumber}</span>}
                          {p.city && <span>{p.city}, {p.stateCode}</span>}
                          {p.stage && <Badge variant="outline" className="text-xs py-0">{p.stage}</Badge>}
                        </div>
                      </div>
                    ))}
                  </ScrollArea>
                </div>
                <div>
                  <h3 className="font-medium mb-2">Unmatched HubSpot Deals ({unmatched?.unmatchedHubspot?.length || 0})</h3>
                  <Input
                    placeholder="Search deals..."
                    value={hubspotSearch}
                    onChange={(e) => setHubspotSearch(e.target.value)}
                    className="mb-2"
                    data-testid="input-search-hubspot-unmatched"
                  />
                  <ScrollArea className="h-[400px] border rounded-md">
                    {filteredUnmatchedHubspot.map((d) => (
                      <div
                        key={d.hubspotId}
                        className={`p-2 border-b cursor-pointer text-sm hover:bg-accent/50 transition-colors ${selectedHubspot === d.hubspotId ? "bg-accent" : ""}`}
                        onClick={() => setSelectedHubspot(d.hubspotId)}
                        data-testid={`item-hubspot-${d.hubspotId}`}
                      >
                        <div className="font-medium truncate">{d.dealName}</div>
                        <div className="text-muted-foreground text-xs flex gap-2">
                          {d.amount && <span>${parseFloat(d.amount).toLocaleString()}</span>}
                          {d.stageName && <Badge variant="outline" className="text-xs py-0">{d.stageName}</Badge>}
                          {d.pipeline && <span>{d.pipeline}</span>}
                        </div>
                      </div>
                    ))}
                  </ScrollArea>
                </div>
              </div>
              {selectedProcore && selectedHubspot && (
                <div className="flex justify-between items-center mt-4 pt-4 border-t">
                  <div className="text-sm">
                    <span className="font-medium">
                      {filteredUnmatchedProcore.find((p) => p.procoreId === selectedProcore)?.name}
                    </span>
                    <ArrowRight className="inline w-4 h-4 mx-2 text-muted-foreground" />
                    <span className="font-medium">
                      {filteredUnmatchedHubspot.find((d) => d.hubspotId === selectedHubspot)?.dealName}
                    </span>
                  </div>
                  <Button
                    onClick={() => manualLinkMutation.mutate({ procoreProjectId: selectedProcore, hubspotDealId: selectedHubspot })}
                    disabled={manualLinkMutation.isPending}
                    data-testid="button-confirm-link"
                  >
                    {manualLinkMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Link2 className="w-4 h-4 mr-2" />}
                    Link & Write Project Number
                  </Button>
                </div>
              )}
            </DialogContent>
          </Dialog>
          <Button
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
            data-testid="button-sync-procore-hubspot"
          >
            {syncMutation.isPending ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4 mr-2" />
            )}
            Run Sync
          </Button>
        </div>
      </div>

      {/* Stats Cards - All Clickable */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {overviewLoading ? (
          Array.from({ length: 6 }).map((_, i) => (
            <Card key={i}><CardContent className="pt-6"><Skeleton className="h-8 w-16" /><Skeleton className="h-4 w-24 mt-2" /></CardContent></Card>
          ))
        ) : (
          <>
            <Card data-testid="card-total-mappings">
              <CardContent className="pt-6">
                <div className="flex items-center gap-2">
                  <Link2 className="w-5 h-5 text-primary" />
                  <span className="text-2xl font-bold">{overview?.totalMappings || 0}</span>
                </div>
                <p className="text-sm text-muted-foreground mt-1">Linked Projects</p>
              </CardContent>
            </Card>
            
            <Card 
              className="cursor-pointer hover:border-primary/50 transition-colors" 
              onClick={() => { setReportOpen("procore"); setReportTab("matched"); }}
              data-testid="card-procore-coverage"
            >
              <CardContent className="pt-6">
                <div className="flex items-center gap-2">
                  <Building2 className="w-5 h-5 text-blue-500" />
                  <span className="text-2xl font-bold">{overview?.mappedProcore || 0}</span>
                  <span className="text-sm text-muted-foreground">/ {overview?.totalProcore || 0}</span>
                </div>
                <p className="text-sm text-muted-foreground mt-1">Procore Matched</p>
              </CardContent>
            </Card>
            
            <Card 
              className="cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => { setReportOpen("hubspot"); setReportTab("matched"); }}
              data-testid="card-hubspot-coverage"
            >
              <CardContent className="pt-6">
                <div className="flex items-center gap-2">
                  <Building2 className="w-5 h-5 text-orange-500" />
                  <span className="text-2xl font-bold">{overview?.mappedHubspot || 0}</span>
                  <span className="text-sm text-muted-foreground">/ {overview?.totalHubspot || 0}</span>
                </div>
                <p className="text-sm text-muted-foreground mt-1">HubSpot Matched</p>
              </CardContent>
            </Card>
            
            <Card 
              className="cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => setReportOpen("conflicts")}
              data-testid="card-conflicts"
            >
              <CardContent className="pt-6">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-5 h-5 text-yellow-500" />
                  <span className="text-2xl font-bold">{overview?.withConflicts || 0}</span>
                </div>
                <p className="text-sm text-muted-foreground mt-1">With Conflicts</p>
              </CardContent>
            </Card>

            <Card 
              className="cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => { setReportOpen("companycam"); setReportTab("matched"); }}
              data-testid="card-companycam"
            >
              <CardContent className="pt-6">
                <div className="flex items-center gap-2">
                  <Camera className="w-5 h-5 text-purple-500" />
                  <span className="text-2xl font-bold">{companycamMatched.length}</span>
                  <span className="text-sm text-muted-foreground">/ {companycamProjects?.total || 0}</span>
                </div>
                <p className="text-sm text-muted-foreground mt-1">CompanyCam</p>
              </CardContent>
            </Card>

            <Card 
              className="cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => { setReportOpen("bidboard"); setReportTab("matched"); }}
              data-testid="card-bidboard"
            >
              <CardContent className="pt-6">
                <div className="flex items-center gap-2">
                  <Calculator className="w-5 h-5 text-green-500" />
                  <span className="text-2xl font-bold">{bidboardMatched.length}</span>
                  <span className="text-sm text-muted-foreground">/ {bidboardEstimates?.total || 0}</span>
                </div>
                <p className="text-sm text-muted-foreground mt-1">BidBoard</p>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* Report Sheet */}
      <Sheet open={reportOpen !== null} onOpenChange={(open) => !open && setReportOpen(null)}>
        <SheetContent className="w-[600px] sm:max-w-[600px]">
          <SheetHeader>
            <SheetTitle>{getReportTitle(reportOpen)}</SheetTitle>
          </SheetHeader>
          <ScrollArea className="h-[calc(100vh-120px)] mt-4 pr-4">
            {renderProjectList(reportOpen)}
          </ScrollArea>
        </SheetContent>
      </Sheet>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg">Project Mappings</CardTitle>
            <div className="relative w-72">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search by name or project number..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
                data-testid="input-search-mappings"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {mappingsLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}
            </div>
          ) : !mappings?.data?.length ? (
            <div className="text-center py-12 text-muted-foreground">
              <Link2 className="w-12 h-12 mx-auto mb-3 opacity-40" />
              <p className="font-medium">No mappings yet</p>
              <p className="text-sm">Run a sync to automatically match Procore projects to HubSpot deals</p>
            </div>
          ) : (
            <div className="space-y-1">
              <div className="grid grid-cols-[1fr,1fr,180px,120px,100px,40px] gap-3 px-3 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider border-b">
                <span>Procore Project</span>
                <span>HubSpot Deal</span>
                <span>Project Number</span>
                <span>Match Type</span>
                <span>Status</span>
                <span></span>
              </div>
              {mappings.data.map((m: any) => {
                const meta = m.metadata || {};
                const hasConflicts = meta.conflicts && meta.conflicts.length > 0;
                return (
                  <Collapsible key={m.id} open={expandedIds.has(m.id)} onOpenChange={() => toggleExpanded(m.id)}>
                    <div className={`grid grid-cols-[1fr,1fr,180px,120px,100px,40px] gap-3 px-3 py-3 items-center text-sm rounded-lg hover:bg-accent/30 transition-colors ${hasConflicts ? "border-l-2 border-l-yellow-500" : ""}`}
                      data-testid={`row-mapping-${m.id}`}
                    >
                      <div className="truncate">
                        <span className="font-medium">{m.procoreProjectName || "—"}</span>
                      </div>
                      <div className="truncate">
                        <span>{m.hubspotDealName || "—"}</span>
                      </div>
                      <div>
                        {m.procoreProjectNumber ? (
                          <Badge variant="secondary" className="font-mono text-xs">{m.procoreProjectNumber}</Badge>
                        ) : (
                          <span className="text-muted-foreground text-xs">none</span>
                        )}
                      </div>
                      <div>
                        <Badge variant={meta.matchType === "exact_name" ? "outline" : meta.matchType === "manual" ? "default" : "secondary"} className="text-xs">
                          {meta.matchType || m.lastSyncDirection || "auto"}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-1">
                        {hasConflicts ? (
                          <Badge variant="outline" className="text-yellow-600 border-yellow-300 text-xs">
                            <AlertTriangle className="w-3 h-3 mr-1" />
                            {meta.conflicts.length}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-green-600 border-green-300 text-xs">
                            <CheckCircle2 className="w-3 h-3 mr-1" />
                            OK
                          </Badge>
                        )}
                      </div>
                      <CollapsibleTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-7 w-7" data-testid={`button-expand-${m.id}`}>
                          <ChevronDown className={`w-4 h-4 transition-transform ${expandedIds.has(m.id) ? "rotate-180" : ""}`} />
                        </Button>
                      </CollapsibleTrigger>
                    </div>
                    <CollapsibleContent>
                      <div className="px-3 py-4 bg-muted/30 rounded-lg mb-1 space-y-3 text-sm">
                        <div className="grid grid-cols-2 gap-6">
                          <div>
                            <h4 className="font-medium text-xs uppercase text-muted-foreground mb-2 flex items-center gap-2">
                              Procore (Master)
                              {m.procoreProjectId && (
                                <a href={getProcoreUrl(m.procoreProjectId)} target="_blank" rel="noopener noreferrer"
                                  className="text-blue-600 hover:text-blue-800">
                                  <ExternalLink className="w-3 h-3" />
                                </a>
                              )}
                            </h4>
                            <div className="space-y-1">
                              <div><span className="text-muted-foreground">ID:</span> {m.procoreProjectId}</div>
                              <div><span className="text-muted-foreground">Stage:</span> {meta.procoreStage || "—"}</div>
                              <div><span className="text-muted-foreground">Location:</span> {[meta.procoreCity, meta.procoreState].filter(Boolean).join(", ") || "—"}</div>
                              <div><span className="text-muted-foreground">Est. Value:</span> {meta.procoreEstimatedValue ? `$${parseFloat(meta.procoreEstimatedValue).toLocaleString()}` : "—"}</div>
                            </div>
                          </div>
                          <div>
                            <h4 className="font-medium text-xs uppercase text-muted-foreground mb-2 flex items-center gap-2">
                              HubSpot
                              {m.hubspotDealId && (
                                <a href={getHubspotUrl(m.hubspotDealId)} target="_blank" rel="noopener noreferrer"
                                  className="text-orange-600 hover:text-orange-800">
                                  <ExternalLink className="w-3 h-3" />
                                </a>
                              )}
                            </h4>
                            <div className="space-y-1">
                              <div><span className="text-muted-foreground">ID:</span> {m.hubspotDealId}</div>
                              <div><span className="text-muted-foreground">Stage:</span> {meta.hubspotStage || "—"}</div>
                              <div><span className="text-muted-foreground">Amount:</span> {meta.hubspotAmount ? `$${parseFloat(meta.hubspotAmount).toLocaleString()}` : "—"}</div>
                              <div><span className="text-muted-foreground">Pipeline:</span> {meta.hubspotPipeline || "—"}</div>
                            </div>
                          </div>
                        </div>

                        {hasConflicts && (
                          <div>
                            <h4 className="font-medium text-xs uppercase text-yellow-600 mb-2">Conflicts</h4>
                            <div className="space-y-2">
                              {meta.conflicts.map((c: any, i: number) => (
                                <div key={i} className="flex items-center gap-3 text-sm bg-yellow-50 dark:bg-yellow-950/20 rounded p-2 border border-yellow-200 dark:border-yellow-800">
                                  <Badge variant="outline" className="text-xs">{c.field}</Badge>
                                  <div className="flex items-center gap-2">
                                    <span className="text-blue-600">Procore: {c.procoreValue || "—"}</span>
                                    <ArrowRight className="w-3 h-3 text-muted-foreground" />
                                    <span className="text-orange-600">HubSpot: {c.hubspotValue || "—"}</span>
                                  </div>
                                  <Badge variant={c.resolution === "procore_wins" ? "default" : "outline"} className="ml-auto text-xs">
                                    {c.resolution === "procore_wins" ? "Procore Wins" : "Both Kept"}
                                  </Badge>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {meta.updatedFields && meta.updatedFields.length > 0 && (
                          <div>
                            <h4 className="font-medium text-xs uppercase text-muted-foreground mb-1">Fields Written to HubSpot</h4>
                            <div className="flex gap-1">
                              {meta.updatedFields.map((f: string) => (
                                <Badge key={f} variant="secondary" className="text-xs">{f}</Badge>
                              ))}
                            </div>
                          </div>
                        )}

                        <div className="flex items-center justify-between pt-2 border-t">
                          <div className="text-xs text-muted-foreground">
                            Last synced: {m.lastSyncAt ? format(new Date(m.lastSyncAt), "MMM d, yyyy h:mm a") : "Never"}
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            onClick={() => unlinkMutation.mutate(m.id)}
                            disabled={unlinkMutation.isPending}
                            data-testid={`button-unlink-${m.id}`}
                          >
                            <Unlink className="w-3 h-3 mr-1" />
                            Unlink
                          </Button>
                        </div>
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                );
              })}
            </div>
          )}

          {mappings && mappings.total > 0 && (
            <div className="flex items-center justify-between mt-4 pt-4 border-t">
              <span className="text-sm text-muted-foreground">
                Showing {mappings.data.length} of {mappings.total} mappings
              </span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
