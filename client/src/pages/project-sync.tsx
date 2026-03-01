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
import { useState, useMemo } from "react";
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

type LucideIcon = React.ComponentType<{ className?: string }>;

function ExternalServiceLink({ href, icon: Icon, label, colorClass }: {
  href: string;
  icon: LucideIcon;
  label: string;
  colorClass: string;
}) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer"
      className={`inline-flex items-center gap-1 text-xs ${colorClass} hover:underline`}>
      <Icon className="w-3 h-3" /> {label} <ExternalLink className="w-3 h-3" />
    </a>
  );
}

function ExternalIconLink({ href, colorClass }: { href: string; colorClass: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`${colorClass} hover:opacity-80`}>
      <ExternalLink className="w-3 h-3" />
    </a>
  );
}

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
  const [reportSearch, setReportSearch] = useState("");
  const { toast } = useToast();

  const { data: overview, isLoading: overviewLoading } = useQuery<SyncOverview>({
    queryKey: ["/api/procore-hubspot/overview"],
  });

  const paramsStr = useMemo(() => {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    return params.toString();
  }, [search]);

  const { data: mappings, isLoading: mappingsLoading } = useQuery<MappingData>({
    queryKey: ["/api/procore-hubspot/mappings", paramsStr],
    queryFn: async () => {
      const url = paramsStr ? `/api/procore-hubspot/mappings?${paramsStr}` : "/api/procore-hubspot/mappings";
      const res = await apiRequest("GET", url);
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

  const invalidateSyncQueries = (...extraKeys: string[]) => {
    queryClient.invalidateQueries({ queryKey: ["/api/procore-hubspot/overview"] });
    queryClient.invalidateQueries({ queryKey: ["/api/procore-hubspot/mappings"] });
    extraKeys.forEach(key => queryClient.invalidateQueries({ queryKey: [key] }));
  };

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
      invalidateSyncQueries();
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
      invalidateSyncQueries();
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
      invalidateSyncQueries("/api/procore-hubspot/unmatched");
    },
    onError: (e: any) => {
      toast({ title: "Failed", description: e.message, variant: "destructive" });
    },
  });

  const companycamMatchMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/companycam/bulk-match");
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "CompanyCam Match Complete",
        description: `Matched ${data.matched} projects. ${data.alreadyMatched} already matched, ${data.noMatch} no match found.`,
      });
      invalidateSyncQueries("/api/sync-mappings/lookup");
      queryClient.invalidateQueries({ queryKey: ["/api/companycam/projects?limit=500"] });
    },
    onError: (e: any) => {
      toast({ title: "Match Failed", description: e.message, variant: "destructive" });
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

  const filteredUnmatchedProcore = useMemo(() =>
    unmatched?.unmatchedProcore?.filter(
      (p) => !procoreSearch || p.name?.toLowerCase().includes(procoreSearch.toLowerCase()) || p.projectNumber?.toLowerCase().includes(procoreSearch.toLowerCase())
    ).slice(0, 50) || [],
    [unmatched?.unmatchedProcore, procoreSearch]
  );

  const filteredUnmatchedHubspot = useMemo(() =>
    unmatched?.unmatchedHubspot?.filter(
      (d) => !hubspotSearch || d.dealName?.toLowerCase().includes(hubspotSearch.toLowerCase())
    ).slice(0, 50) || [],
    [unmatched?.unmatchedHubspot, hubspotSearch]
  );

  const getProcoreUrl = (projectId: string) => 
    `https://us02.procore.com/webclients/host/companies/${PROCORE_COMPANY_ID}/projects/${projectId}/tools/projecthome`;
  
  const getHubspotUrl = (dealId: string) => 
    `https://app-na2.hubspot.com/contacts/${HUBSPOT_PORTAL_ID}/record/0-3/${dealId}`;

  const getCompanyCamUrl = (projectId: string) =>
    `https://app.companycam.com/projects/${projectId}`;

  const [companycamMatched, companycamUnmatched] = useMemo(() => {
    const matched: any[] = [];
    const unmatched_: any[] = [];
    for (const p of companycamProjects?.data || []) {
      const lookup = syncLookup?.[`companycam:${p.companycamId}`];
      if (lookup?.procoreProjectId || lookup?.hubspotDealId) {
        matched.push(p);
      } else {
        unmatched_.push(p);
      }
    }
    return [matched, unmatched_];
  }, [companycamProjects?.data, syncLookup]);

  const [bidboardMatched, bidboardUnmatched] = useMemo(() => {
    const matched: any[] = [];
    const unmatched_: any[] = [];
    for (const b of bidboardEstimates?.data || []) {
      if (b.matchStatus === 'matched' || b.procoreProjectId) {
        matched.push(b);
      } else {
        unmatched_.push(b);
      }
    }
    return [matched, unmatched_];
  }, [bidboardEstimates?.data]);

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

  const conflictMappings = useMemo(() =>
    mappings?.data?.filter((m: any) => {
      const meta = m.metadata || {};
      return meta.conflicts && meta.conflicts.length > 0;
    }) || [],
    [mappings?.data]
  );

  const renderProjectList = (type: ReportType) => {
    const searchLower = reportSearch.toLowerCase();
    
    if (type === "procore") {
      const allMatched = mappings?.data?.filter(m => m.procoreProjectId) || [];
      const allUnmatched = unmatched?.unmatchedProcore || [];
      const filteredMatched = reportSearch
        ? allMatched.filter((m: any) =>
            m.procoreProjectName?.toLowerCase().includes(searchLower) ||
            m.procoreProjectNumber?.toLowerCase().includes(searchLower) ||
            m.hubspotDealName?.toLowerCase().includes(searchLower)
          )
        : allMatched;
      const filteredUnmatched = reportSearch
        ? allUnmatched.filter((p: any) =>
            p.name?.toLowerCase().includes(searchLower) ||
            p.projectNumber?.toLowerCase().includes(searchLower) ||
            p.city?.toLowerCase().includes(searchLower) ||
            p.stage?.toLowerCase().includes(searchLower)
          )
        : allUnmatched;
      
      return (
        <Tabs value={reportTab} onValueChange={(v) => setReportTab(v as any)}>
          <TabsList className="w-full">
            <TabsTrigger value="matched" className="flex-1">
              <CheckCircle2 className="w-4 h-4 mr-2 text-green-500" />
              Matched ({filteredMatched.length}{reportSearch && filteredMatched.length !== allMatched.length ? ` of ${allMatched.length}` : ''})
            </TabsTrigger>
            <TabsTrigger value="unmatched" className="flex-1">
              <XCircle className="w-4 h-4 mr-2 text-red-500" />
              Unmatched ({filteredUnmatched.length}{reportSearch && filteredUnmatched.length !== allUnmatched.length ? ` of ${allUnmatched.length}` : ''})
            </TabsTrigger>
          </TabsList>
          <TabsContent value="matched" className="mt-4">
            <div className="space-y-2">
              {filteredMatched.map((m: any) => (
                <div key={m.id} className="p-4 border rounded-lg">
                  <div className="grid grid-cols-[1fr,auto] gap-4">
                    <div className="space-y-2">
                      <div className="font-medium text-base">{m.procoreProjectName}</div>
                      <div className="flex flex-wrap items-center gap-2">
                        {m.procoreProjectNumber && (
                          <Badge variant="secondary" className="font-mono text-xs">{m.procoreProjectNumber}</Badge>
                        )}
                      </div>
                      <div className="text-sm text-green-600 font-medium">
                        Linked to: {m.hubspotDealName || "—"}
                      </div>
                    </div>
                    <div className="flex flex-col gap-2 items-end">
                      <ExternalServiceLink href={getProcoreUrl(m.procoreProjectId)} icon={Building2} label="Procore" colorClass="text-blue-600" />
                      {m.hubspotDealId && (
                        <ExternalServiceLink href={getHubspotUrl(m.hubspotDealId)} icon={Building2} label="HubSpot" colorClass="text-orange-600" />
                      )}
                    </div>
                  </div>
                </div>
              ))}
              {filteredMatched.length === 0 && <p className="text-center text-muted-foreground py-8">{reportSearch ? 'No matching projects found' : 'No matched projects'}</p>}
            </div>
          </TabsContent>
          <TabsContent value="unmatched" className="mt-4">
            <div className="space-y-2">
              {filteredUnmatched.map((p: any) => (
                <div key={p.procoreId} className="p-4 border rounded-lg border-red-200 bg-red-50/50 dark:bg-red-950/20">
                  <div className="grid grid-cols-[1fr,auto] gap-4">
                    <div className="space-y-2">
                      <div className="font-medium text-base">{p.name}</div>
                      <div className="flex flex-wrap items-center gap-2">
                        {p.projectNumber && (
                          <Badge variant="secondary" className="font-mono text-xs">{p.projectNumber}</Badge>
                        )}
                        {p.stage && (
                          <Badge variant="outline" className="text-xs">{p.stage}</Badge>
                        )}
                      </div>
                      {p.city && (
                        <div className="text-sm text-muted-foreground">
                          {p.city}, {p.stateCode}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col gap-2 items-end">
                      <ExternalServiceLink href={getProcoreUrl(p.procoreId)} icon={Building2} label="Procore" colorClass="text-blue-600" />
                    </div>
                  </div>
                </div>
              ))}
              {filteredUnmatched.length === 0 && <p className="text-center text-muted-foreground py-8">{reportSearch ? 'No matching projects found' : 'All projects are matched!'}</p>}
            </div>
          </TabsContent>
        </Tabs>
      );
    }
    
    if (type === "hubspot") {
      const allMatched = mappings?.data?.filter(m => m.hubspotDealId) || [];
      const allUnmatched = unmatched?.unmatchedHubspot || [];
      const filteredMatched = reportSearch
        ? allMatched.filter((m: any) =>
            m.hubspotDealName?.toLowerCase().includes(searchLower) ||
            m.procoreProjectName?.toLowerCase().includes(searchLower)
          )
        : allMatched;
      const filteredUnmatched = reportSearch
        ? allUnmatched.filter((d: any) =>
            d.dealName?.toLowerCase().includes(searchLower) ||
            d.stageName?.toLowerCase().includes(searchLower) ||
            d.pipeline?.toLowerCase().includes(searchLower)
          )
        : allUnmatched;
      
      return (
        <Tabs value={reportTab} onValueChange={(v) => setReportTab(v as any)}>
          <TabsList className="w-full">
            <TabsTrigger value="matched" className="flex-1">
              <CheckCircle2 className="w-4 h-4 mr-2 text-green-500" />
              Matched ({filteredMatched.length}{reportSearch && filteredMatched.length !== allMatched.length ? ` of ${allMatched.length}` : ''})
            </TabsTrigger>
            <TabsTrigger value="unmatched" className="flex-1">
              <XCircle className="w-4 h-4 mr-2 text-red-500" />
              Unmatched ({filteredUnmatched.length}{reportSearch && filteredUnmatched.length !== allUnmatched.length ? ` of ${allUnmatched.length}` : ''})
            </TabsTrigger>
          </TabsList>
          <TabsContent value="matched" className="mt-4">
            <div className="space-y-2">
              {filteredMatched.map((m: any) => (
                <div key={m.id} className="p-4 border rounded-lg">
                  <div className="grid grid-cols-[1fr,auto] gap-4">
                    <div className="space-y-2">
                      <div className="font-medium text-base">{m.hubspotDealName}</div>
                      <div className="text-sm text-green-600 font-medium">
                        Linked to: {m.procoreProjectName || "—"}
                      </div>
                    </div>
                    <div className="flex flex-col gap-2 items-end">
                      <ExternalServiceLink href={getHubspotUrl(m.hubspotDealId)} icon={Building2} label="HubSpot" colorClass="text-orange-600" />
                      {m.procoreProjectId && (
                        <ExternalServiceLink href={getProcoreUrl(m.procoreProjectId)} icon={Building2} label="Procore" colorClass="text-blue-600" />
                      )}
                    </div>
                  </div>
                </div>
              ))}
              {filteredMatched.length === 0 && <p className="text-center text-muted-foreground py-8">{reportSearch ? 'No matching deals found' : 'No matched deals'}</p>}
            </div>
          </TabsContent>
          <TabsContent value="unmatched" className="mt-4">
            <div className="space-y-2">
              {filteredUnmatched.map((d: any) => (
                <div key={d.hubspotId} className="p-4 border rounded-lg border-red-200 bg-red-50/50 dark:bg-red-950/20">
                  <div className="grid grid-cols-[1fr,auto] gap-4">
                    <div className="space-y-2">
                      <div className="font-medium text-base">{d.dealName}</div>
                      <div className="flex flex-wrap items-center gap-2">
                        {d.amount && (
                          <Badge variant="secondary" className="text-xs">${parseFloat(d.amount).toLocaleString()}</Badge>
                        )}
                        {d.stageName && (
                          <Badge variant="outline" className="text-xs">{d.stageName}</Badge>
                        )}
                        {d.pipeline && (
                          <span className="text-sm text-muted-foreground">{d.pipeline}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-col gap-2 items-end">
                      <ExternalServiceLink href={getHubspotUrl(d.hubspotId)} icon={Building2} label="HubSpot" colorClass="text-orange-600" />
                    </div>
                  </div>
                </div>
              ))}
              {filteredUnmatched.length === 0 && <p className="text-center text-muted-foreground py-8">{reportSearch ? 'No matching deals found' : 'All deals are matched!'}</p>}
            </div>
          </TabsContent>
        </Tabs>
      );
    }
    
    if (type === "conflicts") {
      const filteredConflicts = reportSearch
        ? conflictMappings.filter((m: any) =>
            m.procoreProjectName?.toLowerCase().includes(searchLower) ||
            m.hubspotDealName?.toLowerCase().includes(searchLower) ||
            m.procoreProjectNumber?.toLowerCase().includes(searchLower)
          )
        : conflictMappings;
      return (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Showing {filteredConflicts.length}{reportSearch && filteredConflicts.length !== conflictMappings.length ? ` of ${conflictMappings.length}` : ''} conflicts
          </p>
          {filteredConflicts.map((m: any) => {
            const meta = m.metadata || {};
            return (
              <div key={m.id} className="p-4 border rounded-lg border-yellow-300 bg-yellow-50/50 dark:bg-yellow-950/20">
                <div className="grid grid-cols-[1fr,auto] gap-4">
                  <div className="space-y-3">
                    <div>
                      <div className="font-medium text-base">{m.procoreProjectName || m.hubspotDealName}</div>
                      {m.procoreProjectNumber && (
                        <Badge variant="secondary" className="font-mono text-xs mt-1">{m.procoreProjectNumber}</Badge>
                      )}
                    </div>
                    <div className="space-y-2">
                      {meta.conflicts?.map((c: any, i: number) => (
                        <div key={i} className="p-2 bg-yellow-100/50 dark:bg-yellow-900/20 rounded border border-yellow-200 dark:border-yellow-800">
                          <div className="font-medium text-sm text-yellow-800 dark:text-yellow-300 mb-1">{c.field}</div>
                          <div className="grid grid-cols-2 gap-4 text-sm">
                            <div><span className="text-blue-600 font-medium">Procore:</span> {c.procoreValue || "—"}</div>
                            <div><span className="text-orange-600 font-medium">HubSpot:</span> {c.hubspotValue || "—"}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="flex flex-col gap-2 items-end">
                    {m.procoreProjectId && (
                      <ExternalServiceLink href={getProcoreUrl(m.procoreProjectId)} icon={Building2} label="Procore" colorClass="text-blue-600" />
                    )}
                    {m.hubspotDealId && (
                      <ExternalServiceLink href={getHubspotUrl(m.hubspotDealId)} icon={Building2} label="HubSpot" colorClass="text-orange-600" />
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          {filteredConflicts.length === 0 && <p className="text-center text-muted-foreground py-8">{reportSearch ? 'No matching conflicts found' : 'No conflicts found'}</p>}
        </div>
      );
    }
    
    if (type === "companycam") {
      const filteredMatched = reportSearch
        ? companycamMatched.filter((p: any) =>
            p.name?.toLowerCase().includes(searchLower) ||
            p.streetAddress?.toLowerCase().includes(searchLower) ||
            p.city?.toLowerCase().includes(searchLower)
          )
        : companycamMatched;
      const filteredUnmatched = reportSearch
        ? companycamUnmatched.filter((p: any) =>
            p.name?.toLowerCase().includes(searchLower) ||
            p.streetAddress?.toLowerCase().includes(searchLower) ||
            p.city?.toLowerCase().includes(searchLower)
          )
        : companycamUnmatched;
        
      return (
        <Tabs value={reportTab} onValueChange={(v) => setReportTab(v as any)}>
          <TabsList className="w-full">
            <TabsTrigger value="matched" className="flex-1">
              <CheckCircle2 className="w-4 h-4 mr-2 text-green-500" />
              Linked ({filteredMatched.length}{reportSearch && filteredMatched.length !== companycamMatched.length ? ` of ${companycamMatched.length}` : ''})
            </TabsTrigger>
            <TabsTrigger value="unmatched" className="flex-1">
              <XCircle className="w-4 h-4 mr-2 text-red-500" />
              Not Linked ({filteredUnmatched.length}{reportSearch && filteredUnmatched.length !== companycamUnmatched.length ? ` of ${companycamUnmatched.length}` : ''})
            </TabsTrigger>
          </TabsList>
          <TabsContent value="matched" className="mt-4">
            <div className="space-y-2">
              {filteredMatched.map((p: any) => {
                const lookup = syncLookup?.[`companycam:${p.companycamId}`];
                return (
                  <div key={p.id} className="p-4 border rounded-lg">
                    <div className="grid grid-cols-[1fr,auto] gap-4">
                      <div className="space-y-2">
                        <div className="font-medium text-base">{p.name}</div>
                        <div className="text-sm text-muted-foreground">
                          {p.streetAddress && `${p.streetAddress}, `}{p.city}, {p.state}
                        </div>
                        <div className="text-sm text-green-600 font-medium">
                          Linked to: {lookup?.procoreProjectName || lookup?.hubspotDealName || "Project"}
                        </div>
                      </div>
                      <div className="flex flex-col gap-2 items-end">
                        <ExternalServiceLink href={getCompanyCamUrl(p.companycamId)} icon={Camera} label="CompanyCam" colorClass="text-purple-600" />
                        {lookup?.procoreProjectId && (
                          <ExternalServiceLink href={getProcoreUrl(lookup.procoreProjectId)} icon={Building2} label="Procore" colorClass="text-blue-600" />
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              {filteredMatched.length === 0 && <p className="text-center text-muted-foreground py-8">{reportSearch ? 'No matching projects found' : 'No linked projects'}</p>}
            </div>
          </TabsContent>
          <TabsContent value="unmatched" className="mt-4">
            <div className="space-y-2">
              {filteredUnmatched.map((p: any) => (
                <div key={p.id} className="p-4 border rounded-lg border-red-200 bg-red-50/50 dark:bg-red-950/20">
                  <div className="grid grid-cols-[1fr,auto] gap-4">
                    <div className="space-y-2">
                      <div className="font-medium text-base">{p.name}</div>
                      <div className="text-sm text-muted-foreground">
                        {p.streetAddress && `${p.streetAddress}, `}{p.city}, {p.state}
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary" className="text-xs">Photos: {p.photoCount || 0}</Badge>
                      </div>
                    </div>
                    <div className="flex flex-col gap-2 items-end">
                      <ExternalServiceLink href={getCompanyCamUrl(p.companycamId)} icon={Camera} label="CompanyCam" colorClass="text-purple-600" />
                    </div>
                  </div>
                </div>
              ))}
              {filteredUnmatched.length === 0 && <p className="text-center text-muted-foreground py-8">{reportSearch ? 'No matching projects found' : 'All projects are linked!'}</p>}
            </div>
          </TabsContent>
        </Tabs>
      );
    }
    
    if (type === "bidboard") {
      const filteredMatched = reportSearch 
        ? bidboardMatched.filter((b: any) => 
            b.name?.toLowerCase().includes(searchLower) ||
            b.projectNumber?.toLowerCase().includes(searchLower) ||
            b.estimator?.toLowerCase().includes(searchLower) ||
            b.customerName?.toLowerCase().includes(searchLower) ||
            b.status?.toLowerCase().includes(searchLower)
          )
        : bidboardMatched;
      const filteredUnmatched = reportSearch
        ? bidboardUnmatched.filter((b: any) =>
            b.name?.toLowerCase().includes(searchLower) ||
            b.projectNumber?.toLowerCase().includes(searchLower) ||
            b.estimator?.toLowerCase().includes(searchLower) ||
            b.customerName?.toLowerCase().includes(searchLower) ||
            b.status?.toLowerCase().includes(searchLower)
          )
        : bidboardUnmatched;
        
      return (
        <Tabs value={reportTab} onValueChange={(v) => setReportTab(v as any)}>
          <TabsList className="w-full">
            <TabsTrigger value="matched" className="flex-1">
              <CheckCircle2 className="w-4 h-4 mr-2 text-green-500" />
              Matched ({filteredMatched.length}{reportSearch && filteredMatched.length !== bidboardMatched.length ? ` of ${bidboardMatched.length}` : ''})
            </TabsTrigger>
            <TabsTrigger value="unmatched" className="flex-1">
              <XCircle className="w-4 h-4 mr-2 text-red-500" />
              Unmatched ({filteredUnmatched.length}{reportSearch && filteredUnmatched.length !== bidboardUnmatched.length ? ` of ${bidboardUnmatched.length}` : ''})
            </TabsTrigger>
          </TabsList>
          <TabsContent value="matched" className="mt-4">
            <div className="space-y-2">
              {filteredMatched.map((b: any) => {
                const lookup = b.procoreProjectId ? syncLookup?.[`procore:${b.procoreProjectId}`] : null;
                return (
                  <div key={b.id} className="p-4 border rounded-lg">
                    <div className="grid grid-cols-[1fr,auto] gap-4">
                      <div className="space-y-2">
                        <div className="font-medium text-base">{b.name}</div>
                        <div className="flex flex-wrap items-center gap-2">
                          {b.projectNumber && (
                            <Badge variant="secondary" className="font-mono text-xs">{b.projectNumber}</Badge>
                          )}
                          {b.status && (
                            <Badge variant="outline" className="text-xs">{b.status}</Badge>
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-muted-foreground">
                          {b.estimator && <div><span className="font-medium">Estimator:</span> {b.estimator}</div>}
                          {b.customerName && <div><span className="font-medium">Customer:</span> {b.customerName}</div>}
                          {b.bidDueDate && <div><span className="font-medium">Bid Due:</span> {b.bidDueDate}</div>}
                        </div>
                        {lookup?.procoreProjectName && (
                          <div className="text-sm text-green-600 font-medium">
                            Linked to: {lookup.procoreProjectName}
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col gap-2 items-end">
                        {b.procoreProjectId && (
                          <ExternalServiceLink href={getProcoreUrl(b.procoreProjectId)} icon={Building2} label="Procore" colorClass="text-blue-600" />
                        )}
                        {lookup?.hubspotDealId && (
                          <ExternalServiceLink href={getHubspotUrl(lookup.hubspotDealId)} icon={Building2} label="HubSpot" colorClass="text-orange-600" />
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              {filteredMatched.length === 0 && <p className="text-center text-muted-foreground py-8">{reportSearch ? 'No matching estimates found' : 'No matched estimates'}</p>}
            </div>
          </TabsContent>
          <TabsContent value="unmatched" className="mt-4">
            <div className="space-y-2">
              {filteredUnmatched.map((b: any) => (
                <div key={b.id} className="p-4 border rounded-lg border-red-200 bg-red-50/50 dark:bg-red-950/20">
                  <div className="space-y-2">
                    <div className="font-medium text-base">{b.name}</div>
                    <div className="flex flex-wrap items-center gap-2">
                      {b.projectNumber && (
                        <Badge variant="secondary" className="font-mono text-xs">{b.projectNumber}</Badge>
                      )}
                      {b.status && (
                        <Badge variant="outline" className="text-xs">{b.status}</Badge>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-muted-foreground">
                      {b.estimator && <div><span className="font-medium">Estimator:</span> {b.estimator}</div>}
                      {b.customerName && <div><span className="font-medium">Customer:</span> {b.customerName}</div>}
                      {b.bidDueDate && <div><span className="font-medium">Bid Due:</span> {b.bidDueDate}</div>}
                    </div>
                  </div>
                </div>
              ))}
              {filteredUnmatched.length === 0 && <p className="text-center text-muted-foreground py-8">{reportSearch ? 'No matching estimates found' : 'All estimates are matched!'}</p>}
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
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Camera className="w-5 h-5 text-purple-500" />
                    <span className="text-2xl font-bold">{companycamMatched.length}</span>
                    <span className="text-sm text-muted-foreground">/ {companycamProjects?.total || 0}</span>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      companycamMatchMutation.mutate();
                    }}
                    disabled={companycamMatchMutation.isPending}
                  >
                    {companycamMatchMutation.isPending ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <RefreshCw className="w-3 h-3" />
                    )}
                  </Button>
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

      {/* Report Sheet - Full width on mobile, 900px on desktop */}
      <Sheet open={reportOpen !== null} onOpenChange={(open) => { if (!open) { setReportOpen(null); setReportSearch(""); } }}>
        <SheetContent className="w-full sm:w-[900px] sm:max-w-[900px] overflow-hidden">
          <SheetHeader>
            <SheetTitle className="text-xl">{getReportTitle(reportOpen)}</SheetTitle>
          </SheetHeader>
          <div className="relative mt-4 mb-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search projects..."
              value={reportSearch}
              onChange={(e) => setReportSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <ScrollArea className="h-[calc(100vh-180px)] pr-4">
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
                                <ExternalIconLink href={getProcoreUrl(m.procoreProjectId)} colorClass="text-blue-600" />
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
                                <ExternalIconLink href={getHubspotUrl(m.hubspotDealId)} colorClass="text-orange-600" />
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
