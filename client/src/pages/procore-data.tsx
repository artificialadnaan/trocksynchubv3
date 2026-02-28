import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
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
import {
  Database,
  Building2,
  Truck,
  Users,
  History,
  Search,
  ChevronDown,
  RefreshCw,
  Gavel,
  FileText,
  ClipboardList,
  ExternalLink,
  Pencil,
  Upload,
  Calculator,
  Link2,
  Loader2,
  Camera,
} from "lucide-react";
import { useState, useRef } from "react";
import { useLocation } from "wouter";
import { format } from "date-fns";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type {
  ProcoreProject,
  ProcoreVendor,
  ProcoreUser,
  ProcoreChangeHistory,
  ProcoreBidPackage,
  ProcoreBid,
  ProcoreBidForm,
  BidboardEstimate,
} from "@shared/schema";

type TabType = "projects" | "vendors" | "users" | "bidPackages" | "bids" | "bidForms" | "bidboardEstimates" | "history";

const tabs: { id: TabType; label: string; icon: any }[] = [
  { id: "projects", label: "Projects", icon: Building2 },
  { id: "vendors", label: "Vendors", icon: Truck },
  { id: "users", label: "Users", icon: Users },
  { id: "bidPackages", label: "Bid Packages", icon: Gavel },
  { id: "bids", label: "Bids", icon: FileText },
  { id: "bidForms", label: "Bid Forms", icon: ClipboardList },
  { id: "bidboardEstimates", label: "BidBoard", icon: Calculator },
  { id: "history", label: "Change History", icon: History },
];

export function ProcoreDataContent() {
  const [activeTab, setActiveTab] = useState<TabType>("projects");
  const { toast } = useToast();

  const { data: counts, isLoading: countsLoading } = useQuery<{
    projects: number;
    vendors: number;
    users: number;
    changeHistory: number;
    bidPackages: number;
    bids: number;
    bidForms: number;
    bidboardEstimates: number;
  }>({
    queryKey: ["/api/integrations/procore/data-counts"],
  });

  // Full sync from Procore API
  const syncMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/integrations/procore/sync");
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: "Procore Sync Complete",
        description: `Synced ${data.projects || 0} projects, ${data.vendors || 0} vendors, ${data.users || 0} users`,
      });
      queryClient.invalidateQueries({ queryKey: ["/api/integrations/procore/data-counts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/procore/projects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/procore/vendors"] });
      queryClient.invalidateQueries({ queryKey: ["/api/procore/users"] });
    },
    onError: (e: Error) => {
      toast({ title: "Sync failed", description: e.message, variant: "destructive" });
    },
  });

  const countMap: Record<TabType, number> = {
    projects: counts?.projects || 0,
    vendors: counts?.vendors || 0,
    users: counts?.users || 0,
    bidPackages: counts?.bidPackages || 0,
    bids: counts?.bids || 0,
    bidForms: counts?.bidForms || 0,
    bidboardEstimates: counts?.bidboardEstimates || 0,
    history: counts?.changeHistory || 0,
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-sm text-muted-foreground">
          Browse and manage Procore data synced to the local database
        </p>
        <Button 
          onClick={() => syncMutation.mutate()} 
          disabled={syncMutation.isPending}
          data-testid="button-sync-from-procore"
        >
          {syncMutation.isPending ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Syncing...
            </>
          ) : (
            <>
              <RefreshCw className="w-4 h-4 mr-2" />
              Sync from Procore
            </>
          )}
        </Button>
      </div>
      <div className="flex gap-2 border-b pb-0 flex-wrap">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-[1px] ${
              activeTab === tab.id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30"
            }`}
            data-testid={`tab-procore-${tab.id}`}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
            {!countsLoading && countMap[tab.id] != null && (
              <Badge variant="secondary" className="text-xs ml-1 px-1.5 py-0">
                {(countMap[tab.id] || 0).toLocaleString()}
              </Badge>
            )}
          </button>
        ))}
      </div>

      {activeTab === "projects" && <ProjectsTab />}
      {activeTab === "vendors" && <VendorsTab />}
      {activeTab === "users" && <UsersTab />}
      {activeTab === "bidPackages" && <BidPackagesTab />}
      {activeTab === "bids" && <BidsTab />}
      {activeTab === "bidForms" && <BidFormsTab />}
      {activeTab === "bidboardEstimates" && <BidboardEstimatesTab />}
      {activeTab === "history" && <ChangeHistoryTab />}
    </div>
  );
}

function EditableField({ label, value, field, projectId, type = "text" }: {
  label: string; value: string | null; field: string; projectId: string; type?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(value || "");
  const { toast } = useToast();

  const mutation = useMutation({
    mutationFn: async (newValue: string) => {
      const res = await apiRequest("PATCH", `/api/procore/projects/${projectId}`, { [field]: newValue || null });
      return res.json();
    },
    onSuccess: () => {
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: ["/api/procore/projects"] });
      toast({ title: "Project updated", description: `${label} synced to Procore.` });
    },
    onError: (e: Error) => {
      toast({ title: "Update failed", description: e.message, variant: "destructive" });
    },
  });

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <span className="text-muted-foreground">{label}:</span>
        <Input
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          className="h-6 text-xs w-32 px-1"
          type={type}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") mutation.mutate(editValue);
            if (e.key === "Escape") { setEditing(false); setEditValue(value || ""); }
          }}
          disabled={mutation.isPending}
          data-testid={`input-edit-project-${field}`}
        />
        <Button variant="ghost" size="sm" className="h-6 px-1 text-xs" onClick={() => mutation.mutate(editValue)} disabled={mutation.isPending} data-testid={`button-save-project-${field}`}>
          {mutation.isPending ? "..." : "Save"}
        </Button>
        <Button variant="ghost" size="sm" className="h-6 px-1 text-xs text-muted-foreground" onClick={() => { setEditing(false); setEditValue(value || ""); }}>
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="group cursor-pointer" onClick={() => { setEditValue(value || ""); setEditing(true); }}>
      <span className="text-muted-foreground">{label}:</span>
      <span className="ml-1 group-hover:underline group-hover:text-primary transition-colors">{value || "—"}</span>
      <Pencil className="w-3 h-3 ml-1 inline-block opacity-0 group-hover:opacity-50 transition-opacity" />
    </div>
  );
}

function ProjectStageDropdown({ project, stages }: { project: ProcoreProject; stages: { id: number; name: string }[] }) {
  const { toast } = useToast();
  const mutation = useMutation({
    mutationFn: async (stageId: string) => {
      const res = await apiRequest("PATCH", `/api/procore/projects/${project.procoreId}`, { project_stage_id: parseInt(stageId) });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/procore/projects"] });
      toast({ title: "Stage updated", description: `${project.name} stage synced to Procore.` });
    },
    onError: (e: Error) => {
      toast({ title: "Update failed", description: e.message, variant: "destructive" });
    },
  });

  const currentStage = stages.find(s => s.name === project.projectStageName);

  return (
    <Select
      value={currentStage?.id?.toString() || ""}
      onValueChange={(v) => mutation.mutate(v)}
      disabled={mutation.isPending}
    >
      <SelectTrigger
        className="h-7 w-[180px] text-xs"
        onClick={(e) => e.stopPropagation()}
        data-testid={`select-project-stage-${project.procoreId}`}
      >
        <SelectValue placeholder={project.projectStageName || project.stage || "Select stage"} />
      </SelectTrigger>
      <SelectContent>
        {stages.map((s) => (
          <SelectItem key={s.id} value={s.id.toString()}>{s.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ProjectActiveToggle({ project }: { project: ProcoreProject }) {
  const { toast } = useToast();
  const mutation = useMutation({
    mutationFn: async (active: boolean) => {
      const res = await apiRequest("PATCH", `/api/procore/projects/${project.procoreId}`, { active });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/procore/projects"] });
      toast({ title: "Status updated", description: `${project.name} status synced to Procore.` });
    },
    onError: (e: Error) => {
      toast({ title: "Update failed", description: e.message, variant: "destructive" });
    },
  });

  return (
    <Select
      value={project.active ? "active" : "inactive"}
      onValueChange={(v) => mutation.mutate(v === "active")}
      disabled={mutation.isPending}
    >
      <SelectTrigger
        className="h-7 w-[100px] text-xs"
        onClick={(e) => e.stopPropagation()}
        data-testid={`select-project-active-${project.procoreId}`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="active">Active</SelectItem>
        <SelectItem value="inactive">Inactive</SelectItem>
      </SelectContent>
    </Select>
  );
}

type SyncLookupEntry = { hubspotDealId: string | null; hubspotDealName: string | null; procoreProjectId: string | null; procoreProjectName: string | null; procoreProjectNumber: string | null; companycamProjectId: string | null };

const PROCORE_COMPANY_ID = "598134325683880";

function ProjectsTab() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const limit = 50;

  const params = new URLSearchParams();
  if (search) params.set("search", search);
  params.set("limit", String(limit));
  params.set("offset", String(page * limit));

  const { data, isLoading, refetch } = useQuery<{ data: ProcoreProject[]; total: number }>({
    queryKey: [`/api/procore/projects?${params.toString()}`],
  });

  const { data: stages } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["/api/procore/project-stages"],
  });

  const { data: syncLookup } = useQuery<Record<string, SyncLookupEntry>>({
    queryKey: ["/api/sync-mappings/lookup"],
  });

  const toggleExpand = (id: number) => {
    const next = new Set(expandedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpandedIds(next);
  };

  const formatValue = (val: string | null) => {
    if (!val) return "—";
    const num = parseFloat(val);
    if (isNaN(num)) return val;
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(num);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Building2 className="w-4 h-4" />
            Projects
            {data && <span className="text-xs font-normal text-muted-foreground">({data.total.toLocaleString()} total)</span>}
          </CardTitle>
          <div className="flex gap-2 items-center">
            <div className="relative">
              <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                placeholder="Search projects..."
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                className="h-8 w-[200px] pl-8 text-sm"
                data-testid="input-search-procore-projects"
              />
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-procore-projects">
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : !data?.data?.length ? (
          <p className="text-sm text-muted-foreground py-12 text-center">No projects found. Run a Procore sync from Settings to pull data.</p>
        ) : (
          <>
            <div className="rounded-lg border">
              <div className="grid grid-cols-[auto_1fr_0.8fr_1fr_0.6fr_0.8fr_0.8fr_auto] gap-3 px-4 py-2.5 bg-muted/50 text-xs font-medium text-muted-foreground border-b">
                <span className="w-12"></span>
                <span>Project Name</span>
                <span>Number</span>
                <span>Stage</span>
                <span>Status</span>
                <span>Location</span>
                <span>Value</span>
                <span className="w-8"></span>
              </div>
              {data.data.map((project) => {
                const linked = syncLookup?.[`procore:${project.procoreId}`];
                const procoreUrl = `https://us02.procore.com/webclients/host/companies/${PROCORE_COMPANY_ID}/projects/${project.procoreId}/tools/projecthome`;
                const hubspotDealUrl = linked?.hubspotDealId ? `https://app-na2.hubspot.com/contacts/245227962/record/0-3/${linked.hubspotDealId}` : null;
                const companycamUrl = linked?.companycamProjectId ? `https://app.companycam.com/projects/${linked.companycamProjectId}` : null;
                return (
                <Collapsible key={project.id} open={expandedIds.has(project.id)} onOpenChange={() => toggleExpand(project.id)}>
                  <div className="grid grid-cols-[auto_1fr_0.8fr_1fr_0.6fr_0.8fr_0.8fr_auto] gap-3 px-4 py-3 text-sm hover:bg-muted/30 transition-colors items-center border-b last:border-0 cursor-pointer" data-testid={`procore-project-row-${project.id}`}>
                    <span className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                      <a href={procoreUrl} target="_blank" rel="noopener noreferrer" title="Open in Procore" data-testid={`link-procore-project-${project.id}`} className="text-orange-500 hover:text-orange-600 p-1 rounded hover:bg-orange-50 dark:hover:bg-orange-950 inline-flex" onClick={(e) => { e.stopPropagation(); e.preventDefault(); window.open(procoreUrl, '_blank', 'noopener,noreferrer'); }}>
                        <ExternalLink className="w-4 h-4" />
                      </a>
                      {hubspotDealUrl ? (
                        <a href={hubspotDealUrl} target="_blank" rel="noopener noreferrer" title={`HubSpot Deal: ${linked?.hubspotDealName || ''}`} data-testid={`link-hubspot-deal-${project.id}`} className="text-[#ff7a59] hover:text-[#ff5c35] p-1 rounded hover:bg-orange-50 dark:hover:bg-orange-950 inline-flex" onClick={(e) => { e.stopPropagation(); e.preventDefault(); window.open(hubspotDealUrl, '_blank', 'noopener,noreferrer'); }}>
                          <Link2 className="w-4 h-4" />
                        </a>
                      ) : (
                        <span className="w-[24px]" />
                      )}
                      {companycamUrl ? (
                        <a href={companycamUrl} target="_blank" rel="noopener noreferrer" title="Open in CompanyCam" data-testid={`link-companycam-${project.id}`} className="text-green-600 hover:text-green-700 p-1 rounded hover:bg-green-50 dark:hover:bg-green-950 inline-flex" onClick={(e) => { e.stopPropagation(); e.preventDefault(); window.open(companycamUrl, '_blank', 'noopener,noreferrer'); }}>
                          <Camera className="w-4 h-4" />
                        </a>
                      ) : (
                        <span className="w-[24px]" />
                      )}
                    </span>
                    <CollapsibleTrigger asChild>
                      <span className="font-medium truncate text-left cursor-pointer">{project.name || "—"}</span>
                    </CollapsibleTrigger>
                      <span className="text-muted-foreground truncate text-left">{project.projectNumber || "—"}</span>
                      <span className="text-left" onClick={(e) => e.stopPropagation()}>
                        {stages ? (
                          <ProjectStageDropdown project={project} stages={stages} />
                        ) : (
                          <Badge variant="outline" className="text-xs">{project.projectStageName || project.stage || "—"}</Badge>
                        )}
                      </span>
                      <span className="text-left" onClick={(e) => e.stopPropagation()}>
                        <ProjectActiveToggle project={project} />
                      </span>
                      <span className="text-muted-foreground truncate text-left">
                        {[project.city, project.stateCode].filter(Boolean).join(", ") || "—"}
                      </span>
                      <span className="text-left font-medium">{formatValue(project.totalValue || project.estimatedValue)}</span>
                      <CollapsibleTrigger asChild>
                        <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform cursor-pointer ${expandedIds.has(project.id) ? "rotate-180" : ""}`} />
                      </CollapsibleTrigger>
                    </div>
                  <CollapsibleContent>
                    <div className="px-4 py-3 bg-muted/10 border-b space-y-2">
                      <div className="grid grid-cols-3 gap-4 text-sm">
                        <div><span className="text-muted-foreground">Procore ID:</span> <span className="font-mono text-xs ml-1">{project.procoreId}</span>
                          <a href={procoreUrl} target="_blank" rel="noopener noreferrer" className="ml-2 text-orange-500 hover:text-orange-600 inline-flex items-center gap-1 text-xs" data-testid={`link-procore-ext-${project.id}`}>
                            Open in Procore <ExternalLink className="w-3 h-3" />
                          </a>
                        </div>
                        {linked?.hubspotDealId && (
                          <div><span className="text-muted-foreground">HubSpot Deal:</span>
                            <a href={hubspotDealUrl!} target="_blank" rel="noopener noreferrer" className="ml-1 text-[#ff7a59] hover:text-[#ff5c35] inline-flex items-center gap-1 text-xs" data-testid={`link-hubspot-ext-${project.id}`}>
                              {linked.hubspotDealName || linked.hubspotDealId} <ExternalLink className="w-3 h-3" />
                            </a>
                          </div>
                        )}
                        <EditableField label="Phone" value={project.phone} field="phone" projectId={project.procoreId} />
                        <EditableField label="Address" value={project.address} field="address" projectId={project.procoreId} />
                        <EditableField label="City" value={project.city} field="city" projectId={project.procoreId} />
                        <EditableField label="State" value={project.stateCode} field="state_code" projectId={project.procoreId} />
                        <EditableField label="ZIP" value={project.zip} field="zip" projectId={project.procoreId} />
                        <EditableField label="Start Date" value={project.startDate} field="start_date" projectId={project.procoreId} type="date" />
                        <EditableField label="Completion Date" value={project.completionDate} field="completion_date" projectId={project.procoreId} type="date" />
                        <EditableField label="Projected Finish" value={project.projectedFinishDate} field="projected_finish_date" projectId={project.procoreId} type="date" />
                        <EditableField label="Estimated Value" value={project.estimatedValue} field="estimated_value" projectId={project.procoreId} />
                        <EditableField label="Total Value" value={project.totalValue} field="total_value" projectId={project.procoreId} />
                        <EditableField label="Delivery Method" value={project.deliveryMethod} field="delivery_method" projectId={project.procoreId} />
                        <EditableField label="Project Number" value={project.projectNumber} field="project_number" projectId={project.procoreId} />
                        <div><span className="text-muted-foreground">Company:</span> <span className="ml-1">{project.companyName || "—"}</span></div>
                        <div><span className="text-muted-foreground">Last Synced:</span> <span className="ml-1">{project.lastSyncedAt ? format(new Date(project.lastSyncedAt), "MMM d, h:mm a") : "—"}</span></div>
                      </div>
                      {!!project.properties && (
                        <details className="text-xs">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Raw Properties</summary>
                          <ScrollArea className="h-32 mt-1 rounded border bg-card p-2">
                            <pre className="font-mono whitespace-pre-wrap">{String(JSON.stringify(project.properties, null, 2))}</pre>
                          </ScrollArea>
                        </details>
                      )}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
                );
              })}
            </div>
            <Pagination page={page} setPage={setPage} total={data.total} limit={limit} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function VendorsTab() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const limit = 50;

  const params = new URLSearchParams();
  if (search) params.set("search", search);
  params.set("limit", String(limit));
  params.set("offset", String(page * limit));

  const { data, isLoading, refetch } = useQuery<{ data: ProcoreVendor[]; total: number }>({
    queryKey: [`/api/procore/vendors?${params.toString()}`],
  });

  const toggleExpand = (id: number) => {
    const next = new Set(expandedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpandedIds(next);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Truck className="w-4 h-4" />
            Vendors
            {data && <span className="text-xs font-normal text-muted-foreground">({data.total.toLocaleString()} total)</span>}
          </CardTitle>
          <div className="flex gap-2 items-center">
            <div className="relative">
              <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                placeholder="Search vendors..."
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                className="h-8 w-[200px] pl-8 text-sm"
                data-testid="input-search-procore-vendors"
              />
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-procore-vendors">
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : !data?.data?.length ? (
          <p className="text-sm text-muted-foreground py-12 text-center">No vendors found. Run a Procore sync from Settings to pull data.</p>
        ) : (
          <>
            <div className="rounded-lg border">
              <div className="grid grid-cols-[1.5fr_1fr_1fr_1fr_0.6fr_auto] gap-3 px-4 py-2.5 bg-muted/50 text-xs font-medium text-muted-foreground border-b">
                <span>Vendor Name</span>
                <span>Trade</span>
                <span>Email</span>
                <span>Phone</span>
                <span>Status</span>
                <span className="w-8"></span>
              </div>
              {data.data.map((vendor) => (
                <Collapsible key={vendor.id} open={expandedIds.has(vendor.id)} onOpenChange={() => toggleExpand(vendor.id)}>
                  <CollapsibleTrigger className="w-full" data-testid={`procore-vendor-row-${vendor.id}`}>
                    <div className="grid grid-cols-[1.5fr_1fr_1fr_1fr_0.6fr_auto] gap-3 px-4 py-3 text-sm hover:bg-muted/30 transition-colors items-center border-b last:border-0">
                      <span className="font-medium truncate text-left">{vendor.name || "—"}</span>
                      <span className="text-muted-foreground truncate text-left">{vendor.tradeName || "—"}</span>
                      <span className="text-muted-foreground truncate text-left">{vendor.emailAddress || "—"}</span>
                      <span className="text-muted-foreground truncate text-left">{vendor.businessPhone || "—"}</span>
                      <span className="text-left">
                        <Badge variant={vendor.isActive ? "secondary" : "outline"} className="text-xs">
                          {vendor.isActive ? "Active" : "Inactive"}
                        </Badge>
                      </span>
                      <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${expandedIds.has(vendor.id) ? "rotate-180" : ""}`} />
                    </div>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="px-4 py-3 bg-muted/10 border-b space-y-2">
                      <div className="grid grid-cols-3 gap-4 text-sm">
                        <div><span className="text-muted-foreground">Procore ID:</span> <span className="font-mono text-xs ml-1">{vendor.procoreId}</span></div>
                        <div><span className="text-muted-foreground">Legal Name:</span> <span className="ml-1">{vendor.legalName || "—"}</span></div>
                        <div><span className="text-muted-foreground">Abbreviated:</span> <span className="ml-1">{vendor.abbreviatedName || "—"}</span></div>
                        <div><span className="text-muted-foreground">Address:</span> <span className="ml-1">{vendor.address || "—"}</span></div>
                        <div><span className="text-muted-foreground">City:</span> <span className="ml-1">{[vendor.city, vendor.stateCode].filter(Boolean).join(", ") || "—"}</span></div>
                        <div><span className="text-muted-foreground">ZIP:</span> <span className="ml-1">{vendor.zip || "—"}</span></div>
                        <div><span className="text-muted-foreground">Mobile:</span> <span className="ml-1">{vendor.mobilePhone || "—"}</span></div>
                        <div><span className="text-muted-foreground">Fax:</span> <span className="ml-1">{vendor.faxNumber || "—"}</span></div>
                        <div><span className="text-muted-foreground">Website:</span> <span className="ml-1">{vendor.website || "—"}</span></div>
                        <div><span className="text-muted-foreground">License #:</span> <span className="ml-1">{vendor.licenseNumber || "—"}</span></div>
                        <div><span className="text-muted-foreground">Labor Union:</span> <span className="ml-1">{vendor.laborUnion || "—"}</span></div>
                        <div><span className="text-muted-foreground">Last Synced:</span> <span className="ml-1">{vendor.lastSyncedAt ? format(new Date(vendor.lastSyncedAt), "MMM d, h:mm a") : "—"}</span></div>
                      </div>
                      {!!vendor.properties && (
                        <details className="text-xs">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Raw Properties</summary>
                          <ScrollArea className="h-32 mt-1 rounded border bg-card p-2">
                            <pre className="font-mono whitespace-pre-wrap">{String(JSON.stringify(vendor.properties, null, 2))}</pre>
                          </ScrollArea>
                        </details>
                      )}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
            <Pagination page={page} setPage={setPage} total={data.total} limit={limit} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function UsersTab() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const limit = 50;

  const params = new URLSearchParams();
  if (search) params.set("search", search);
  params.set("limit", String(limit));
  params.set("offset", String(page * limit));

  const { data, isLoading, refetch } = useQuery<{ data: ProcoreUser[]; total: number }>({
    queryKey: [`/api/procore/users?${params.toString()}`],
  });

  const toggleExpand = (id: number) => {
    const next = new Set(expandedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpandedIds(next);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Users className="w-4 h-4" />
            Users
            {data && <span className="text-xs font-normal text-muted-foreground">({data.total.toLocaleString()} total)</span>}
          </CardTitle>
          <div className="flex gap-2 items-center">
            <div className="relative">
              <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                placeholder="Search users..."
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                className="h-8 w-[200px] pl-8 text-sm"
                data-testid="input-search-procore-users"
              />
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-procore-users">
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : !data?.data?.length ? (
          <p className="text-sm text-muted-foreground py-12 text-center">No users found. Run a Procore sync from Settings to pull data.</p>
        ) : (
          <>
            <div className="rounded-lg border">
              <div className="grid grid-cols-[1.2fr_1.2fr_1fr_1fr_0.6fr_auto] gap-3 px-4 py-2.5 bg-muted/50 text-xs font-medium text-muted-foreground border-b">
                <span>Name</span>
                <span>Email</span>
                <span>Job Title</span>
                <span>Phone</span>
                <span>Status</span>
                <span className="w-8"></span>
              </div>
              {data.data.map((user) => (
                <Collapsible key={user.id} open={expandedIds.has(user.id)} onOpenChange={() => toggleExpand(user.id)}>
                  <CollapsibleTrigger className="w-full" data-testid={`procore-user-row-${user.id}`}>
                    <div className="grid grid-cols-[1.2fr_1.2fr_1fr_1fr_0.6fr_auto] gap-3 px-4 py-3 text-sm hover:bg-muted/30 transition-colors items-center border-b last:border-0">
                      <span className="font-medium truncate text-left">{user.name || [user.firstName, user.lastName].filter(Boolean).join(" ") || "—"}</span>
                      <span className="text-muted-foreground truncate text-left">{user.emailAddress || "—"}</span>
                      <span className="text-muted-foreground truncate text-left">{user.jobTitle || "—"}</span>
                      <span className="text-muted-foreground truncate text-left">{user.businessPhone || user.mobilePhone || "—"}</span>
                      <span className="text-left">
                        <Badge variant={user.isActive ? "secondary" : "outline"} className="text-xs">
                          {user.isActive ? "Active" : "Inactive"}
                        </Badge>
                      </span>
                      <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${expandedIds.has(user.id) ? "rotate-180" : ""}`} />
                    </div>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="px-4 py-3 bg-muted/10 border-b space-y-2">
                      <div className="grid grid-cols-3 gap-4 text-sm">
                        <div><span className="text-muted-foreground">Procore ID:</span> <span className="font-mono text-xs ml-1">{user.procoreId}</span></div>
                        <div><span className="text-muted-foreground">First Name:</span> <span className="ml-1">{user.firstName || "—"}</span></div>
                        <div><span className="text-muted-foreground">Last Name:</span> <span className="ml-1">{user.lastName || "—"}</span></div>
                        <div><span className="text-muted-foreground">Mobile:</span> <span className="ml-1">{user.mobilePhone || "—"}</span></div>
                        <div><span className="text-muted-foreground">Address:</span> <span className="ml-1">{[user.address, user.city, user.stateCode].filter(Boolean).join(", ") || "—"}</span></div>
                        <div><span className="text-muted-foreground">ZIP:</span> <span className="ml-1">{user.zip || "—"}</span></div>
                        <div><span className="text-muted-foreground">Employee:</span> <span className="ml-1">{user.isEmployee ? "Yes" : "No"}</span></div>
                        <div><span className="text-muted-foreground">Employee ID:</span> <span className="ml-1">{user.employeeId || "—"}</span></div>
                        <div><span className="text-muted-foreground">Vendor:</span> <span className="ml-1">{user.vendorName || user.vendorId || "—"}</span></div>
                        <div><span className="text-muted-foreground">Last Login:</span> <span className="ml-1">{user.lastLoginAt || "—"}</span></div>
                        <div><span className="text-muted-foreground">Last Synced:</span> <span className="ml-1">{user.lastSyncedAt ? format(new Date(user.lastSyncedAt), "MMM d, h:mm a") : "—"}</span></div>
                      </div>
                      {!!user.properties && (
                        <details className="text-xs">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Raw Properties</summary>
                          <ScrollArea className="h-32 mt-1 rounded border bg-card p-2">
                            <pre className="font-mono whitespace-pre-wrap">{String(JSON.stringify(user.properties, null, 2))}</pre>
                          </ScrollArea>
                        </details>
                      )}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
            <Pagination page={page} setPage={setPage} total={data.total} limit={limit} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function BidPackagesTab() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const limit = 50;

  const params = new URLSearchParams();
  if (search) params.set("search", search);
  params.set("limit", String(limit));
  params.set("offset", String(page * limit));

  const { data, isLoading, refetch } = useQuery<{ data: ProcoreBidPackage[]; total: number }>({
    queryKey: [`/api/procore/bid-packages?${params.toString()}`],
  });

  const toggleExpand = (id: number) => {
    const next = new Set(expandedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpandedIds(next);
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return "—";
    try { return format(new Date(dateStr), "MMM d, yyyy"); } catch { return dateStr; }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Gavel className="w-4 h-4" />
            Bid Packages
            {data && <span className="text-xs font-normal text-muted-foreground">({data.total.toLocaleString()} total)</span>}
          </CardTitle>
          <div className="flex gap-2 items-center">
            <div className="relative">
              <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                placeholder="Search bid packages..."
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                className="h-8 w-[200px] pl-8 text-sm"
                data-testid="input-search-procore-bid-packages"
              />
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-procore-bid-packages">
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : !data?.data?.length ? (
          <p className="text-sm text-muted-foreground py-12 text-center">No bid packages found. Run a Procore sync to pull Bid Board data.</p>
        ) : (
          <>
            <div className="rounded-lg border">
              <div className="grid grid-cols-[1.5fr_1.2fr_0.8fr_0.8fr_0.6fr_0.6fr_auto] gap-3 px-4 py-2.5 bg-muted/50 text-xs font-medium text-muted-foreground border-b">
                <span>Title</span>
                <span>Project</span>
                <span>Due Date</span>
                <span>Status</span>
                <span>Invites</span>
                <span>Bids</span>
                <span className="w-8"></span>
              </div>
              {data.data.map((pkg) => (
                <Collapsible key={pkg.id} open={expandedIds.has(pkg.id)} onOpenChange={() => toggleExpand(pkg.id)}>
                  <CollapsibleTrigger className="w-full" data-testid={`procore-bid-package-row-${pkg.id}`}>
                    <div className="grid grid-cols-[1.5fr_1.2fr_0.8fr_0.8fr_0.6fr_0.6fr_auto] gap-3 px-4 py-3 text-sm hover:bg-muted/30 transition-colors items-center border-b last:border-0">
                      <span className="font-medium truncate text-left">{pkg.title || "—"}</span>
                      <span className="text-muted-foreground truncate text-left">{pkg.projectName || "—"}</span>
                      <span className="text-muted-foreground text-left">{formatDate(pkg.bidDueDate)}</span>
                      <span className="text-left">
                        <Badge variant={pkg.sealed ? "destructive" : "secondary"} className="text-xs">
                          {pkg.sealed ? "Sealed" : pkg.open ? "Open" : "Closed"}
                        </Badge>
                      </span>
                      <span className="text-center font-medium">{pkg.bidInvitesSentCount ?? 0}</span>
                      <span className="text-center font-medium">{pkg.bidsReceivedCount ?? 0}</span>
                      <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${expandedIds.has(pkg.id) ? "rotate-180" : ""}`} />
                    </div>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="mx-4 mb-2 p-3 rounded-lg border bg-muted/20 space-y-2">
                      <div className="grid grid-cols-2 gap-3 text-sm">
                        <div><span className="text-muted-foreground">Procore ID:</span> <span className="ml-1 font-mono text-xs">{pkg.procoreId}</span></div>
                        <div><span className="text-muted-foreground">Project ID:</span> <span className="ml-1 font-mono text-xs">{pkg.projectId || "—"}</span></div>
                        <div><span className="text-muted-foreground">Package #:</span> <span className="ml-1">{pkg.number ?? "—"}</span></div>
                        <div><span className="text-muted-foreground">Accounting:</span> <span className="ml-1">{pkg.accountingMethod || "—"}</span></div>
                        <div><span className="text-muted-foreground">Has Bid Docs:</span> <span className="ml-1">{pkg.hasBidDocs ? "Yes" : "No"}</span></div>
                        <div><span className="text-muted-foreground">Accept Late:</span> <span className="ml-1">{pkg.acceptPostDueSubmissions ? "Yes" : "No"}</span></div>
                        <div><span className="text-muted-foreground">Pre-bid Walkthrough:</span> <span className="ml-1">{pkg.enablePrebidWalkthrough ? "Yes" : "No"}</span></div>
                        <div><span className="text-muted-foreground">Pre-bid RFI:</span> <span className="ml-1">{pkg.enablePrebidRfiDeadline ? "Yes" : "No"}</span></div>
                      </div>
                      {pkg.projectLocation && (
                        <div className="text-sm"><span className="text-muted-foreground">Location:</span> <span className="ml-1">{pkg.projectLocation.replace(/<br\s*\/?>/gi, ", ").replace(/<[^>]*>/g, "")}</span></div>
                      )}
                      {!!pkg.properties && (
                        <details className="text-xs">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Full Data</summary>
                          <ScrollArea className="h-40 mt-1 rounded border bg-card p-2">
                            <pre className="font-mono whitespace-pre-wrap">{String(JSON.stringify(pkg.properties, null, 2))}</pre>
                          </ScrollArea>
                        </details>
                      )}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
            <Pagination page={page} setPage={setPage} total={data.total} limit={limit} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function BidAwardDropdown({ bid }: { bid: ProcoreBid }) {
  const { toast } = useToast();
  const currentValue = bid.awarded === true ? "awarded" : bid.awarded === false ? "rejected" : "pending";

  const mutation = useMutation({
    mutationFn: async (awarded: boolean | null) => {
      const res = await apiRequest("PATCH", `/api/procore/bids/${bid.procoreId}`, { awarded });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/procore/bids"] });
      toast({ title: "Bid status updated", description: `${bid.vendorName} — synced to Procore.` });
    },
    onError: (e: Error) => {
      toast({ title: "Update failed", description: e.message, variant: "destructive" });
    },
  });

  return (
    <Select
      value={currentValue}
      onValueChange={(v) => {
        const awarded = v === "awarded" ? true : v === "rejected" ? false : null;
        mutation.mutate(awarded);
      }}
      disabled={mutation.isPending}
    >
      <SelectTrigger
        className="h-7 w-[110px] text-xs"
        onClick={(e) => e.stopPropagation()}
        data-testid={`select-bid-award-${bid.procoreId}`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="pending">Pending</SelectItem>
        <SelectItem value="awarded">Awarded</SelectItem>
        <SelectItem value="rejected">Rejected</SelectItem>
      </SelectContent>
    </Select>
  );
}

function BidStatusDropdown({ bid }: { bid: ProcoreBid }) {
  const { toast } = useToast();
  const mutation = useMutation({
    mutationFn: async (bidStatus: string) => {
      const res = await apiRequest("PATCH", `/api/procore/bids/${bid.procoreId}`, { bid_status: bidStatus });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/procore/bids"] });
      toast({ title: "Bid status updated", description: `${bid.vendorName} status synced to Procore.` });
    },
    onError: (e: Error) => {
      toast({ title: "Update failed", description: e.message, variant: "destructive" });
    },
  });

  return (
    <Select
      value={bid.bidStatus || "undecided"}
      onValueChange={(v) => mutation.mutate(v)}
      disabled={mutation.isPending}
    >
      <SelectTrigger
        className="h-7 w-[120px] text-xs"
        onClick={(e) => e.stopPropagation()}
        data-testid={`select-bid-status-${bid.procoreId}`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="submitted">Submitted</SelectItem>
        <SelectItem value="will_bid">Will Bid</SelectItem>
        <SelectItem value="will_not_bid">Won't Bid</SelectItem>
        <SelectItem value="undecided">Undecided</SelectItem>
      </SelectContent>
    </Select>
  );
}

function BidsTab() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const [, navigate] = useLocation();
  const limit = 50;

  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (statusFilter !== "all") params.set("bidStatus", statusFilter);
  params.set("limit", String(limit));
  params.set("offset", String(page * limit));

  const { data, isLoading, refetch } = useQuery<{ data: ProcoreBid[]; total: number }>({
    queryKey: [`/api/procore/bids?${params.toString()}`],
  });

  const toggleExpand = (id: number) => {
    const next = new Set(expandedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpandedIds(next);
  };

  const statusColor = (status: string | null) => {
    const colors: Record<string, string> = {
      submitted: "bg-green-500/10 text-green-600 border-green-500/20",
      will_bid: "bg-blue-500/10 text-blue-600 border-blue-500/20",
      will_not_bid: "bg-red-500/10 text-red-600 border-red-500/20",
      undecided: "bg-yellow-500/10 text-yellow-600 border-yellow-500/20",
    };
    return colors[status || ""] || "";
  };

  const formatAmount = (val: string | null) => {
    if (!val || val === "0") return "—";
    const num = parseFloat(val);
    if (isNaN(num)) return val;
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(num);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <FileText className="w-4 h-4" />
            Bids
            {data && <span className="text-xs font-normal text-muted-foreground">({data.total.toLocaleString()} total)</span>}
          </CardTitle>
          <div className="flex gap-2 items-center">
            <div className="relative">
              <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                placeholder="Search bids..."
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                className="h-8 w-[200px] pl-8 text-sm"
                data-testid="input-search-procore-bids"
              />
            </div>
            <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(0); }}>
              <SelectTrigger className="w-[140px] h-8" data-testid="filter-procore-bid-status">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="submitted">Submitted</SelectItem>
                <SelectItem value="will_bid">Will Bid</SelectItem>
                <SelectItem value="will_not_bid">Will Not Bid</SelectItem>
                <SelectItem value="undecided">Undecided</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-procore-bids">
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : !data?.data?.length ? (
          <p className="text-sm text-muted-foreground py-12 text-center">No bids found. Run a Procore sync to pull Bid Board data.</p>
        ) : (
          <>
            <div className="rounded-lg border">
              <div className="grid grid-cols-[1.2fr_0.9fr_0.8fr_0.7fr_0.7fr_0.7fr_auto_auto] gap-3 px-4 py-2.5 bg-muted/50 text-xs font-medium text-muted-foreground border-b">
                <span>Vendor</span>
                <span>Bid Package</span>
                <span>Status</span>
                <span>Amount</span>
                <span>Award</span>
                <span>Committed</span>
                <span className="w-16 text-center">Detail</span>
                <span className="w-8"></span>
              </div>
              {data.data.map((bid) => (
                <Collapsible key={bid.id} open={expandedIds.has(bid.id)} onOpenChange={() => toggleExpand(bid.id)}>
                  <CollapsibleTrigger asChild data-testid={`procore-bid-row-${bid.id}`}>
                    <div className="grid grid-cols-[1.2fr_0.9fr_0.8fr_0.7fr_0.7fr_0.7fr_auto_auto] gap-3 px-4 py-3 text-sm hover:bg-muted/30 transition-colors items-center border-b last:border-0 cursor-pointer">
                      <span className="font-medium truncate text-left">{bid.vendorName || "—"}</span>
                      <span className="text-muted-foreground truncate text-left">{bid.bidPackageTitle || "—"}</span>
                      <span className="text-left" onClick={(e) => e.stopPropagation()}>
                        <BidStatusDropdown bid={bid} />
                      </span>
                      <span className="text-left font-medium">{formatAmount(bid.lumpSumAmount)}</span>
                      <span className="text-left" onClick={(e) => e.stopPropagation()}>
                        <BidAwardDropdown bid={bid} />
                      </span>
                      <span className="text-center">
                        {bid.isBidderCommitted ? <Badge variant="secondary" className="text-xs">Yes</Badge> : <span className="text-muted-foreground text-xs">No</span>}
                      </span>
                      <span className="w-16 text-center" onClick={(e) => e.stopPropagation()}>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs"
                          onClick={() => navigate(`/procore-data/bids/${bid.procoreId}`)}
                          data-testid={`button-view-bid-${bid.procoreId}`}
                        >
                          <ExternalLink className="w-3.5 h-3.5 mr-1" /> View
                        </Button>
                      </span>
                      <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${expandedIds.has(bid.id) ? "rotate-180" : ""}`} />
                    </div>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="mx-4 mb-2 p-3 rounded-lg border bg-muted/20 space-y-2">
                      <div className="grid grid-cols-2 gap-3 text-sm">
                        <div><span className="text-muted-foreground">Procore ID:</span> <span className="ml-1 font-mono text-xs">{bid.procoreId}</span></div>
                        <div><span className="text-muted-foreground">Vendor ID:</span> <span className="ml-1 font-mono text-xs">{bid.vendorId || "—"}</span></div>
                        <div><span className="text-muted-foreground">Project:</span> <span className="ml-1">{bid.projectName || "—"}</span></div>
                        <div><span className="text-muted-foreground">Due Date:</span> <span className="ml-1">{bid.dueDate ? format(new Date(bid.dueDate), "MMM d, yyyy") : "—"}</span></div>
                        <div><span className="text-muted-foreground">Submitted:</span> <span className="ml-1">{bid.submitted ? "Yes" : "No"}</span></div>
                        <div><span className="text-muted-foreground">Bid Form:</span> <span className="ml-1">{bid.bidFormTitle || "—"}</span></div>
                        <div><span className="text-muted-foreground">Requester:</span> <span className="ml-1">{bid.bidRequesterName || "—"} {bid.bidRequesterEmail ? `(${bid.bidRequesterEmail})` : ""}</span></div>
                        <div><span className="text-muted-foreground">Company:</span> <span className="ml-1">{bid.bidRequesterCompany || "—"}</span></div>
                        <div><span className="text-muted-foreground">Invitation Sent:</span> <span className="ml-1">{bid.invitationLastSentAt ? format(new Date(bid.invitationLastSentAt), "MMM d, yyyy h:mm a") : "—"}</span></div>
                        <div><span className="text-muted-foreground">NDA Required:</span> <span className="ml-1">{bid.requireNda ? "Yes" : "No"}</span></div>
                      </div>
                      {bid.bidderComments && (
                        <div className="text-sm"><span className="text-muted-foreground">Comments:</span> <span className="ml-1">{bid.bidderComments}</span></div>
                      )}
                      {!!bid.properties && (
                        <details className="text-xs">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Full Data</summary>
                          <ScrollArea className="h-40 mt-1 rounded border bg-card p-2">
                            <pre className="font-mono whitespace-pre-wrap">{String(JSON.stringify(bid.properties, null, 2))}</pre>
                          </ScrollArea>
                        </details>
                      )}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
            <Pagination page={page} setPage={setPage} total={data.total} limit={limit} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function BidFormsTab() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const limit = 50;

  const params = new URLSearchParams();
  if (search) params.set("search", search);
  params.set("limit", String(limit));
  params.set("offset", String(page * limit));

  const { data, isLoading, refetch } = useQuery<{ data: ProcoreBidForm[]; total: number }>({
    queryKey: [`/api/procore/bid-forms?${params.toString()}`],
  });

  const toggleExpand = (id: number) => {
    const next = new Set(expandedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpandedIds(next);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <ClipboardList className="w-4 h-4" />
            Bid Forms
            {data && <span className="text-xs font-normal text-muted-foreground">({data.total.toLocaleString()} total)</span>}
          </CardTitle>
          <div className="flex gap-2 items-center">
            <div className="relative">
              <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                placeholder="Search bid forms..."
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                className="h-8 w-[200px] pl-8 text-sm"
                data-testid="input-search-procore-bid-forms"
              />
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-procore-bid-forms">
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : !data?.data?.length ? (
          <p className="text-sm text-muted-foreground py-12 text-center">No bid forms found. Run a Procore sync to pull Bid Board data.</p>
        ) : (
          <>
            <div className="rounded-lg border">
              <div className="grid grid-cols-[1.5fr_1fr_1fr_0.8fr_auto] gap-3 px-4 py-2.5 bg-muted/50 text-xs font-medium text-muted-foreground border-b">
                <span>Form Title</span>
                <span>Bid Package ID</span>
                <span>Project ID</span>
                <span>Proposal</span>
                <span className="w-8"></span>
              </div>
              {data.data.map((form) => (
                <Collapsible key={form.id} open={expandedIds.has(form.id)} onOpenChange={() => toggleExpand(form.id)}>
                  <CollapsibleTrigger className="w-full" data-testid={`procore-bid-form-row-${form.id}`}>
                    <div className="grid grid-cols-[1.5fr_1fr_1fr_0.8fr_auto] gap-3 px-4 py-3 text-sm hover:bg-muted/30 transition-colors items-center border-b last:border-0">
                      <span className="font-medium truncate text-left">{form.title || "—"}</span>
                      <span className="text-muted-foreground truncate text-left font-mono text-xs">{form.bidPackageId || "—"}</span>
                      <span className="text-muted-foreground truncate text-left font-mono text-xs">{form.projectId || "—"}</span>
                      <span className="text-muted-foreground text-left">{form.proposalName || "—"}</span>
                      <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${expandedIds.has(form.id) ? "rotate-180" : ""}`} />
                    </div>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="mx-4 mb-2 p-3 rounded-lg border bg-muted/20 space-y-2">
                      <div className="grid grid-cols-2 gap-3 text-sm">
                        <div><span className="text-muted-foreground">Procore ID:</span> <span className="ml-1 font-mono text-xs">{form.procoreId}</span></div>
                        <div><span className="text-muted-foreground">Proposal ID:</span> <span className="ml-1 font-mono text-xs">{form.proposalId || "—"}</span></div>
                      </div>
                      {!!form.properties && (
                        <details className="text-xs">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Full Data</summary>
                          <ScrollArea className="h-40 mt-1 rounded border bg-card p-2">
                            <pre className="font-mono whitespace-pre-wrap">{String(JSON.stringify(form.properties, null, 2))}</pre>
                          </ScrollArea>
                        </details>
                      )}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
            <Pagination page={page} setPage={setPage} total={data.total} limit={limit} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function BidboardEstimatesTab() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState("all");
  const [matchFilter, setMatchFilter] = useState("all");
  const [openRows, setOpenRows] = useState<Set<number>>(new Set());
  const [urlInput, setUrlInput] = useState("");
  const [showUrlInput, setShowUrlInput] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const { data, isLoading } = useQuery<{ data: BidboardEstimate[]; total: number }>({
    queryKey: ["/api/bidboard/estimates", search, page, statusFilter, matchFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "50", offset: String(page * 50) });
      if (search) params.set("search", search);
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (matchFilter !== "all") params.set("matchStatus", matchFilter);
      const res = await fetch(`/api/bidboard/estimates?${params}`, { credentials: "include" });
      return res.json();
    },
  });

  const importMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/bidboard/import", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/bidboard/estimates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/integrations/procore/data-counts"] });
      toast({
        title: "BidBoard Import Complete",
        description: `${result.imported} estimates imported. ${result.matched} matched to Procore projects, ${result.unmatched} unmatched.`,
      });
    },
    onError: (e: Error) => {
      toast({ title: "Import failed", description: e.message, variant: "destructive" });
    },
  });

  const urlImportMutation = useMutation({
    mutationFn: async (url: string) => {
      const res = await apiRequest("POST", "/api/bidboard/import-url", { url });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/bidboard/estimates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/integrations/procore/data-counts"] });
      setUrlInput("");
      setShowUrlInput(false);
      toast({
        title: "BidBoard Import Complete",
        description: `${result.imported} estimates imported. ${result.matched} matched to Procore projects, ${result.unmatched} unmatched.`,
      });
    },
    onError: (e: Error) => {
      toast({ title: "Import failed", description: e.message, variant: "destructive" });
    },
  });

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) importMutation.mutate(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleUrlImport = () => {
    if (!urlInput.trim()) return;
    urlImportMutation.mutate(urlInput.trim());
  };

  const toggleRow = (id: number) => {
    setOpenRows(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const stripHtml = (str: string | null) => str ? str.replace(/<[^>]*>/g, "") : "";
  const totalPages = Math.ceil((data?.total || 0) / 50);
  const estimates = data?.data || [];

  const matchBadge = (status: string | null) => {
    if (status === "matched") return <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200" data-testid="badge-matched">Matched</Badge>;
    if (status === "partial") return <Badge className="bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200" data-testid="badge-partial">Partial</Badge>;
    return <Badge variant="outline" className="text-muted-foreground" data-testid="badge-unmatched">Unmatched</Badge>;
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg" data-testid="text-bidboard-title">BidBoard Estimates</CardTitle>
          <div className="flex items-center gap-2">
            <input
              type="file"
              ref={fileInputRef}
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={handleFileSelect}
              data-testid="input-bidboard-file"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowUrlInput(!showUrlInput)}
              data-testid="button-bidboard-url-toggle"
            >
              <Link2 className="w-4 h-4 mr-2" />
              Fetch from URL
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={importMutation.isPending}
              data-testid="button-bidboard-import"
            >
              <Upload className="w-4 h-4 mr-2" />
              {importMutation.isPending ? "Importing..." : "Upload File"}
            </Button>
          </div>
        </div>
        {showUrlInput && (
          <div className="mt-3 space-y-2">
            <p className="text-xs text-muted-foreground">
              Paste the S3 download link from Procore BidBoard export. Links expire in ~3 minutes, so paste and import quickly.
            </p>
            <div className="flex gap-2">
              <Input
                placeholder="https://procore-fas-general-default-production.s3.amazonaws.com/..."
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                className="text-xs"
                data-testid="input-bidboard-url"
              />
              <Button
                size="sm"
                onClick={handleUrlImport}
                disabled={!urlInput.trim() || urlImportMutation.isPending}
                data-testid="button-bidboard-url-import"
              >
                {urlImportMutation.isPending ? (
                  <><Loader2 className="w-4 h-4 mr-1 animate-spin" /> Fetching...</>
                ) : (
                  "Import"
                )}
              </Button>
            </div>
          </div>
        )}
      </CardHeader>
      <CardContent>
        <div className="flex gap-2 mb-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search estimates..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              className="pl-9"
              data-testid="input-bidboard-search"
            />
          </div>
          <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(0); }}>
            <SelectTrigger className="w-[200px]" data-testid="select-bidboard-status">
              <SelectValue placeholder="All Statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="Estimate Sent to Client">Estimate Sent</SelectItem>
              <SelectItem value="Estimate in Progress">In Progress</SelectItem>
              <SelectItem value="Estimate Under Review">Under Review</SelectItem>
              <SelectItem value="Service - Estimating">Service - Estimating</SelectItem>
              <SelectItem value="Service - Sent to Production">Sent to Production</SelectItem>
              <SelectItem value="Sent to Production">Production</SelectItem>
              <SelectItem value="Service - Lost">Service - Lost</SelectItem>
              <SelectItem value="Production Lost">Production Lost</SelectItem>
            </SelectContent>
          </Select>
          <Select value={matchFilter} onValueChange={(v) => { setMatchFilter(v); setPage(0); }}>
            <SelectTrigger className="w-[160px]" data-testid="select-bidboard-match">
              <SelectValue placeholder="All Match Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="matched">Matched</SelectItem>
              <SelectItem value="partial">Partial Match</SelectItem>
              <SelectItem value="unmatched">Unmatched</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {isLoading ? (
          <div className="space-y-2">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : estimates.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Calculator className="w-12 h-12 mx-auto mb-3 opacity-50" />
            <p className="text-lg font-medium">No BidBoard data imported yet</p>
            <p className="text-sm mt-1">Export your project list from BidBoard as .xlsx and import it here</p>
          </div>
        ) : (
          <div className="space-y-1">
            <div className="grid grid-cols-[1fr_150px_180px_120px_100px_100px] gap-2 px-3 py-2 text-xs font-medium text-muted-foreground border-b">
              <span>Project Name</span>
              <span>Estimator</span>
              <span>Status</span>
              <span>Customer</span>
              <span>Total Sales</span>
              <span>Match</span>
            </div>
            {estimates.map((est) => (
              <Collapsible key={est.id} open={openRows.has(est.id)}>
                <CollapsibleTrigger asChild>
                  <div
                    onClick={() => toggleRow(est.id)}
                    className="grid grid-cols-[1fr_150px_180px_120px_100px_100px] gap-2 px-3 py-2.5 hover:bg-muted/50 cursor-pointer rounded text-sm items-center"
                    data-testid={`row-bidboard-${est.id}`}
                  >
                    <span className="font-medium truncate flex items-center gap-1">
                      <ChevronDown className={`w-3 h-3 transition-transform ${openRows.has(est.id) ? "rotate-0" : "-rotate-90"}`} />
                      {stripHtml(est.name)}
                    </span>
                    <span className="text-muted-foreground truncate">{est.estimator || "-"}</span>
                    <Badge variant="outline" className="text-xs w-fit" data-testid={`badge-status-${est.id}`}>
                      {est.status || "-"}
                    </Badge>
                    <span className="text-muted-foreground truncate text-xs">{est.customerName || "-"}</span>
                    <span className="text-muted-foreground text-xs">
                      {est.totalSales ? `$${Number(est.totalSales).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "-"}
                    </span>
                    {matchBadge(est.matchStatus)}
                  </div>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="px-8 py-3 bg-muted/30 rounded-b text-sm space-y-2">
                    <div className="grid grid-cols-3 gap-4">
                      <div><span className="text-muted-foreground">Office:</span> {est.office || "-"}</div>
                      <div><span className="text-muted-foreground">Project #:</span> {est.projectNumber || "-"}</div>
                      <div><span className="text-muted-foreground">Customer Contact:</span> {est.customerContact || "-"}</div>
                      <div><span className="text-muted-foreground">Sales Price/Area:</span> {est.salesPricePerArea || "-"}</div>
                      <div><span className="text-muted-foreground">Project Cost:</span> {est.projectCost ? `$${Number(est.projectCost).toLocaleString()}` : "-"}</div>
                      <div><span className="text-muted-foreground">Profit Margin:</span> {est.profitMargin ? `${est.profitMargin}%` : "-"}</div>
                      <div><span className="text-muted-foreground">Created:</span> {est.createdDate ? format(new Date(est.createdDate), "MMM d, yyyy") : "-"}</div>
                      <div><span className="text-muted-foreground">Due:</span> {est.dueDate ? format(new Date(est.dueDate), "MMM d, yyyy") : "-"}</div>
                      <div><span className="text-muted-foreground">Procore ID:</span> {est.procoreProjectId || "Not linked"}</div>
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            ))}
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4 pt-4 border-t">
            <span className="text-sm text-muted-foreground">
              Page {page + 1} of {totalPages} ({data?.total.toLocaleString()} estimates)
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(p => p - 1)} data-testid="button-bidboard-prev">Previous</Button>
              <Button variant="outline" size="sm" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)} data-testid="button-bidboard-next">Next</Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ChangeHistoryTab() {
  const [entityTypeFilter, setEntityTypeFilter] = useState("all");
  const [changeTypeFilter, setChangeTypeFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const limit = 50;

  const params = new URLSearchParams();
  if (entityTypeFilter !== "all") params.set("entityType", entityTypeFilter);
  if (changeTypeFilter !== "all") params.set("changeType", changeTypeFilter);
  params.set("limit", String(limit));
  params.set("offset", String(page * limit));

  const { data, isLoading, refetch } = useQuery<{ data: ProcoreChangeHistory[]; total: number }>({
    queryKey: [`/api/procore/change-history?${params.toString()}`],
  });

  const toggleExpand = (id: number) => {
    const next = new Set(expandedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpandedIds(next);
  };

  const changeTypeColor = (type: string) => {
    const colors: Record<string, string> = {
      created: "bg-green-500/10 text-green-600 border-green-500/20",
      updated: "bg-blue-500/10 text-blue-600 border-blue-500/20",
      field_changed: "bg-yellow-500/10 text-yellow-600 border-yellow-500/20",
    };
    return colors[type] || "";
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <History className="w-4 h-4" />
            Change History
            {data && <span className="text-xs font-normal text-muted-foreground">({data.total.toLocaleString()} total, 2-week rolling window)</span>}
          </CardTitle>
          <div className="flex gap-2 items-center">
            <Select value={entityTypeFilter} onValueChange={(v) => { setEntityTypeFilter(v); setPage(0); }}>
              <SelectTrigger className="w-[130px] h-8" data-testid="filter-procore-history-entity">
                <SelectValue placeholder="Entity Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                <SelectItem value="project">Projects</SelectItem>
                <SelectItem value="vendor">Vendors</SelectItem>
                <SelectItem value="user">Users</SelectItem>
                <SelectItem value="bid_package">Bid Packages</SelectItem>
              </SelectContent>
            </Select>
            <Select value={changeTypeFilter} onValueChange={(v) => { setChangeTypeFilter(v); setPage(0); }}>
              <SelectTrigger className="w-[130px] h-8" data-testid="filter-procore-history-change">
                <SelectValue placeholder="Change Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Changes</SelectItem>
                <SelectItem value="created">Created</SelectItem>
                <SelectItem value="updated">Updated</SelectItem>
                <SelectItem value="field_changed">Field Changed</SelectItem>
                <SelectItem value="synced">Synced</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-procore-history">
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : !data?.data?.length ? (
          <p className="text-sm text-muted-foreground py-12 text-center">No change history yet. Changes are recorded automatically during each Procore sync.</p>
        ) : (
          <>
            <div className="space-y-1">
              {data.data.map((entry) => (
                <Collapsible key={entry.id} open={expandedIds.has(entry.id)} onOpenChange={() => toggleExpand(entry.id)}>
                  <CollapsibleTrigger className="w-full" data-testid={`procore-history-row-${entry.id}`}>
                    <div className="flex items-center justify-between py-2.5 px-3 rounded-lg hover:bg-muted/30 transition-colors text-left">
                      <div className="flex items-center gap-3 flex-1">
                        <ChangeTypeDot type={entry.changeType} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium">
                            {entry.entityType} #{entry.entityProcoreId}
                            {entry.fieldName && <span className="text-muted-foreground font-normal"> — {entry.fieldName}</span>}
                          </p>
                          {entry.changeType === "field_changed" && (
                            <p className="text-xs text-muted-foreground truncate">
                              <span className="text-red-400 line-through">{entry.oldValue || "empty"}</span>
                              {" → "}
                              <span className="text-green-500">{entry.newValue || "empty"}</span>
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <Badge className={`text-xs ${changeTypeColor(entry.changeType)}`}>{entry.changeType}</Badge>
                        <Badge variant="outline" className="text-xs">{entry.entityType}</Badge>
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {entry.createdAt ? format(new Date(entry.createdAt), "MMM d, h:mm a") : ""}
                        </span>
                        <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${expandedIds.has(entry.id) ? "rotate-180" : ""}`} />
                      </div>
                    </div>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="ml-8 mr-3 mb-2 p-3 rounded-lg border bg-muted/20 space-y-2">
                      <div className="grid grid-cols-2 gap-3 text-sm">
                        <div><span className="text-muted-foreground">Entity Type:</span> <span className="ml-1 font-medium">{entry.entityType}</span></div>
                        <div><span className="text-muted-foreground">Procore ID:</span> <span className="ml-1 font-mono text-xs">{entry.entityProcoreId}</span></div>
                        {entry.fieldName && (
                          <div><span className="text-muted-foreground">Field:</span> <span className="ml-1">{entry.fieldName}</span></div>
                        )}
                        <div><span className="text-muted-foreground">Change Type:</span> <span className="ml-1">{entry.changeType}</span></div>
                      </div>
                      {entry.changeType === "field_changed" && (
                        <div className="grid grid-cols-2 gap-3 text-sm">
                          <div className="p-2 bg-red-500/5 rounded border border-red-500/10">
                            <span className="text-xs text-muted-foreground">Old Value:</span>
                            <p className="font-mono text-xs mt-0.5 break-all">{entry.oldValue || "—"}</p>
                          </div>
                          <div className="p-2 bg-green-500/5 rounded border border-green-500/10">
                            <span className="text-xs text-muted-foreground">New Value:</span>
                            <p className="font-mono text-xs mt-0.5 break-all">{entry.newValue || "—"}</p>
                          </div>
                        </div>
                      )}
                      {!!entry.fullSnapshot && (
                        <details className="text-xs">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Full Snapshot</summary>
                          <ScrollArea className="h-40 mt-1 rounded border bg-card p-2">
                            <pre className="font-mono whitespace-pre-wrap">{String(JSON.stringify(entry.fullSnapshot, null, 2))}</pre>
                          </ScrollArea>
                        </details>
                      )}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
            <Pagination page={page} setPage={setPage} total={data.total} limit={limit} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Pagination({ page, setPage, total, limit }: { page: number; setPage: (p: number) => void; total: number; limit: number }) {
  if (total <= limit) return null;
  return (
    <div className="flex items-center justify-between mt-4">
      <p className="text-xs text-muted-foreground">
        Showing {page * limit + 1}-{Math.min((page + 1) * limit, total)} of {total.toLocaleString()}
      </p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)} data-testid="button-procore-prev-page">
          Previous
        </Button>
        <Button variant="outline" size="sm" disabled={(page + 1) * limit >= total} onClick={() => setPage(page + 1)} data-testid="button-procore-next-page">
          Next
        </Button>
      </div>
    </div>
  );
}

function ChangeTypeDot({ type }: { type: string }) {
  const color = type === "created" ? "bg-green-500" : type === "field_changed" ? "bg-yellow-500" : "bg-blue-500";
  return <div className={`w-2 h-2 rounded-full ${color} flex-shrink-0`} />;
}
