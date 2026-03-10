/**
 * Data Health Page — Reconciliation dashboard, queue, resolver, legacy mappings, audit log
 */

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import {
  AlertCircle,
  CheckCircle2,
  Building2,
  FileText,
  Play,
  RefreshCw,
  Search,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { format, formatDistanceToNow } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { ResolverPanel } from "@/components/reconciliation/ResolverPanel";
import { OrphanResolver } from "@/components/reconciliation/OrphanResolver";

const BUCKET_OPTIONS = [
  { value: "needs_attention", label: "Needs Attention" },
  { value: "all", label: "All" },
  { value: "conflict", label: "Conflicts" },
  { value: "fuzzy_match", label: "Fuzzy Matches" },
  { value: "orphan_procore", label: "Orphan Procore" },
  { value: "orphan_hubspot", label: "Orphan HubSpot" },
  { value: "resolved", label: "Resolved" },
  { value: "ignored", label: "Ignored" },
];

const DFW_REGEX = /^DFW-\d+-\d{4,6}-[a-z]{2}$/i;

export default function DataHealthPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [bucket, setBucket] = useState("needs_attention");
  const [severity, setSeverity] = useState("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [resolveProjectId, setResolveProjectId] = useState<number | null>(null);
  const [resolveMode, setResolveMode] = useState<"conflict" | "orphan" | null>(null);

  const [unmappedOnly, setUnmappedOnly] = useState(false);
  const [addMappingOpen, setAddMappingOpen] = useState(false);
  const [newLegacy, setNewLegacy] = useState("");
  const [newCanonical, setNewCanonical] = useState("");
  const [newEra, setNewEra] = useState<"legacy" | "zapier">("legacy");
  const [editingMappingId, setEditingMappingId] = useState<number | null>(null);
  const [editingCanonical, setEditingCanonical] = useState("");

  const [auditPage, setAuditPage] = useState(1);
  const [auditAction, setAuditAction] = useState("all");
  const [rollbackId, setRollbackId] = useState<number | null>(null);
  const [rollbackEntry, setRollbackEntry] = useState<any>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data: dashboard, isLoading } = useQuery<any>({
    queryKey: ["/api/reconciliation/dashboard"],
  });

  const queryParams = new URLSearchParams();
  if (bucket) queryParams.set("bucket", bucket);
  if (severity && severity !== "all") queryParams.set("severity", severity);
  if (debouncedSearch) queryParams.set("search", debouncedSearch);
  queryParams.set("page", String(page));
  queryParams.set("limit", "50");

  const { data: projects, isLoading: projectsLoading } = useQuery<any>({
    queryKey: [`/api/reconciliation/projects?${queryParams.toString()}`],
  });

  const { data: projectDetail } = useQuery<any>({
    queryKey: resolveProjectId ? [`/api/reconciliation/projects/${resolveProjectId}`] : ["reconciliation-project-disabled"],
    queryFn: getQueryFn({ on401: "throw" }),
    enabled: !!resolveProjectId,
  });

  const { data: mappings } = useQuery<any[]>({
    queryKey: [`/api/reconciliation/legacy-mappings${unmappedOnly ? "?unmappedOnly=true" : ""}`],
  });

  const auditParams = new URLSearchParams();
  if (auditAction && auditAction !== "all") auditParams.set("action", auditAction);
  auditParams.set("page", String(auditPage));
  auditParams.set("limit", "25");

  const { data: auditData } = useQuery<any>({
    queryKey: [`/api/reconciliation/audit-log?${auditParams.toString()}`],
  });

  const scanMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/reconciliation/scan", {
        triggeredBy: "manual",
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/reconciliation/dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["/api/reconciliation/projects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/reconciliation/legacy-mappings"] });
      toast({ title: "Scan complete", description: "Reconciliation scan finished." });
    },
    onError: (e: Error) => {
      toast({ title: "Scan failed", description: e.message, variant: "destructive" });
    },
  });

  const seedMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/reconciliation/seed", {});
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/reconciliation/dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["/api/reconciliation/projects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/reconciliation/legacy-mappings"] });
      toast({
        title: "Seed complete",
        description: `Processed ${data.syncMappingsProcessed} mappings, detected ${data.legacyNumbersDetected} legacy numbers.`,
      });
    },
    onError: (e: Error) => {
      toast({ title: "Seed failed", description: e.message, variant: "destructive" });
    },
  });

  const bulkResolveMutation = useMutation({
    mutationFn: async ({ source }: { source: "procore" | "hubspot" }) => {
      await apiRequest("POST", "/api/reconciliation/bulk/resolve", {
        projectIds: Array.from(selectedIds),
        source,
        writeback: true,
      });
    },
    onSuccess: () => {
      toast({ title: "Bulk resolution complete" });
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["/api/reconciliation/projects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/reconciliation/dashboard"] });
    },
    onError: (e: Error) => {
      toast({ title: "Bulk resolve failed", description: e.message, variant: "destructive" });
    },
  });

  const bulkIgnoreMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/reconciliation/bulk/ignore", {
        projectIds: Array.from(selectedIds),
        reason: "Bulk ignored from Data Health",
      });
    },
    onSuccess: () => {
      toast({ title: "Projects ignored" });
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["/api/reconciliation/projects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/reconciliation/dashboard"] });
    },
    onError: (e: Error) => {
      toast({ title: "Bulk ignore failed", description: e.message, variant: "destructive" });
    },
  });

  const addMappingMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("POST", "/api/reconciliation/legacy-mappings", {
        legacyNumber: newLegacy.trim(),
        canonicalNumber: newCanonical.trim() || null,
        era: newEra,
      });
    },
    onSuccess: () => {
      toast({ title: "Mapping added" });
      setAddMappingOpen(false);
      setNewLegacy("");
      setNewCanonical("");
      queryClient.invalidateQueries({ queryKey: ["/api/reconciliation/legacy-mappings"] });
    },
    onError: (e: Error) => {
      toast({ title: "Failed to add mapping", description: e.message, variant: "destructive" });
    },
  });

  const rollbackMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("POST", `/api/reconciliation/audit-log/${id}/rollback`);
    },
    onSuccess: () => {
      toast({ title: "Resolution rolled back" });
      setRollbackId(null);
      setRollbackEntry(null);
      queryClient.invalidateQueries({ queryKey: ["/api/reconciliation/audit-log"] });
      queryClient.invalidateQueries({ queryKey: ["/api/reconciliation/dashboard"] });
    },
    onError: (e: Error) => {
      toast({ title: "Rollback failed", description: e.message, variant: "destructive" });
    },
  });

  const totals = dashboard?.totals ?? {};
  const byBucket = dashboard?.byBucket ?? {};
  const bySeverity = dashboard?.bySeverity ?? {};
  const lastScan = dashboard?.lastScan;

  const projectsList = projects?.data ?? [];
  const projectsTotal = projects?.total ?? 0;
  const projectsPages = projects?.pages ?? 1;
  const start = (page - 1) * 50 + 1;
  const end = Math.min(page * 50, projectsTotal);

  const allSelected = projectsList.length > 0 && projectsList.every((p: any) => selectedIds.has(p.id));
  const toggleAll = () => {
    if (allSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(projectsList.map((p: any) => p.id)));
  };

  const getRowSeverity = (p: any) => {
    const conflicts = p.conflicts ?? [];
    if (conflicts.some((c: any) => c.severity === "critical")) return "critical";
    if (conflicts.some((c: any) => c.severity === "warning")) return "warning";
    if (conflicts.some((c: any) => c.severity === "info")) return "info";
    return null;
  };

  const handleResolveClick = (p: any) => {
    setResolveProjectId(p.id);
    setResolveMode(p.bucket?.startsWith("orphan_") ? "orphan" : "conflict");
  };

  const closeResolver = () => {
    setResolveProjectId(null);
    setResolveMode(null);
  };

  const addMappingValid = newLegacy.trim() && (!newCanonical.trim() || DFW_REGEX.test(newCanonical.trim()));

  const updateCanonicalMutation = useMutation({
    mutationFn: async ({ legacyNumber, canonicalNumber, era }: { legacyNumber: string; canonicalNumber: string; era: string }) => {
      await apiRequest("POST", "/api/reconciliation/legacy-mappings", {
        legacyNumber,
        canonicalNumber: canonicalNumber.trim() || null,
        era: era || "legacy",
      });
    },
    onSuccess: () => {
      setEditingMappingId(null);
      setEditingCanonical("");
      queryClient.invalidateQueries({ queryKey: ["/api/reconciliation/legacy-mappings"] });
      toast({ title: "Mapping updated" });
    },
    onError: (e: Error) => {
      toast({ title: "Update failed", description: e.message, variant: "destructive" });
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 className="text-xl md:text-2xl font-bold">Data Health</h2>
          <p className="text-muted-foreground text-sm mt-1">
            Reconcile projects across Procore, HubSpot, and BidBoard
          </p>
        </div>
        <div className="flex items-center gap-2">
          {lastScan && (
            <span className="text-xs text-muted-foreground">
              Last scan: {format(new Date(lastScan.startedAt), "MMM d, h:mm a")}
            </span>
          )}
          {!isLoading &&
            (byBucket.conflict ?? 0) + (byBucket.exact_match ?? 0) + (byBucket.orphan_procore ?? 0) + (byBucket.orphan_hubspot ?? 0) === 0 && (
              <Button
                variant="outline"
                onClick={() => seedMutation.mutate()}
                disabled={seedMutation.isPending}
              >
                {seedMutation.isPending ? (
                  <RefreshCw className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <FileText className="h-4 w-4 mr-2" />
                )}
                Import from Sync Mappings
              </Button>
            )}
          <Button
            onClick={() => scanMutation.mutate()}
            disabled={scanMutation.isPending}
          >
            {scanMutation.isPending ? (
              <RefreshCw className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Play className="h-4 w-4 mr-2" />
            )}
            Run Scan
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-5">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Conflicts</p>
                  <p className="text-2xl font-bold text-red-600">{byBucket.conflict ?? 0}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {bySeverity.critical ?? 0} crit, {bySeverity.warning ?? 0} warn
                  </p>
                </div>
                <AlertCircle className="h-8 w-8 text-red-500 opacity-80" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Matched</p>
                  <p className="text-2xl font-bold text-green-600">
                    {(byBucket.exact_match ?? 0) + (byBucket.resolved ?? 0)}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">{(byBucket.fuzzy_match ?? 0)} fuzzy</p>
                </div>
                <CheckCircle2 className="h-8 w-8 text-green-500 opacity-80" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Orphan Procore</p>
                  <p className="text-2xl font-bold text-amber-600">{byBucket.orphan_procore ?? 0}</p>
                </div>
                <Building2 className="h-8 w-8 text-amber-500 opacity-80" />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Orphan HubSpot</p>
                  <p className="text-2xl font-bold text-amber-600">{byBucket.orphan_hubspot ?? 0}</p>
                </div>
                <FileText className="h-8 w-8 text-amber-500 opacity-80" />
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <Tabs defaultValue="queue">
        <TabsList>
          <TabsTrigger value="queue">Reconciliation Queue</TabsTrigger>
          <TabsTrigger value="mappings">Legacy Mappings</TabsTrigger>
          <TabsTrigger value="audit">Audit Log</TabsTrigger>
        </TabsList>

        <TabsContent value="queue">
          <Card>
            <CardHeader>
              <CardTitle>Reconciliation Queue</CardTitle>
              <p className="text-sm text-muted-foreground">
                Projects needing resolution — filter by bucket or severity
              </p>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2 mb-4">
                <Select value={bucket} onValueChange={(v) => { setBucket(v); setPage(1); }}>
                  <SelectTrigger className="w-40">
                    <SelectValue placeholder="Bucket" />
                  </SelectTrigger>
                  <SelectContent>
                    {BUCKET_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={severity} onValueChange={(v) => { setSeverity(v); setPage(1); }}>
                  <SelectTrigger className="w-32">
                    <SelectValue placeholder="Severity" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="critical">Critical</SelectItem>
                    <SelectItem value="warning">Warning</SelectItem>
                    <SelectItem value="info">Info</SelectItem>
                  </SelectContent>
                </Select>
                <div className="relative flex-1 min-w-[200px]">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search by name or project number..."
                    value={search}
                    onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                    className="pl-8"
                  />
                </div>
              </div>

              {selectedIds.size > 0 && (
                <div className="flex items-center gap-2 py-2 mb-2 border rounded-lg px-3">
                  <span className="text-sm">{selectedIds.size} selected</span>
                  <Button size="sm" variant="outline" onClick={() => bulkResolveMutation.mutate({ source: "procore" })} disabled={bulkResolveMutation.isPending}>
                    Accept All Procore
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => bulkResolveMutation.mutate({ source: "hubspot" })} disabled={bulkResolveMutation.isPending}>
                    Accept All HubSpot
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => bulkIgnoreMutation.mutate()} disabled={bulkIgnoreMutation.isPending}>
                    Ignore Selected
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>Clear</Button>
                </div>
              )}

              {projectsLoading ? (
                <Skeleton className="h-64 w-full" />
              ) : projectsList.length > 0 ? (
                <>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">
                          <Checkbox checked={allSelected} onCheckedChange={toggleAll} />
                        </TableHead>
                        <TableHead>Name</TableHead>
                        <TableHead>Project #</TableHead>
                        <TableHead>Bucket</TableHead>
                        <TableHead>Conflicts</TableHead>
                        <TableHead>Updated</TableHead>
                        <TableHead></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {projectsList.map((p: any) => {
                        const sev = getRowSeverity(p);
                        return (
                          <TableRow key={p.id}>
                            <TableCell>
                              <Checkbox
                                checked={selectedIds.has(p.id)}
                                onCheckedChange={(v) => {
                                  if (v) setSelectedIds((s) => new Set([...s, p.id]));
                                  else setSelectedIds((s) => { const n = new Set(s); n.delete(p.id); return n; });
                                }}
                              />
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                {sev && (
                                  <span
                                    className={`w-2 h-2 rounded-full ${
                                      sev === "critical" ? "bg-red-500" : sev === "warning" ? "bg-amber-500" : "bg-gray-400"
                                    }`}
                                  />
                                )}
                                {p.canonicalName ??
                                  (p.procoreData as any)?.name ??
                                  (p.hubspotData as any)?.dealName ??
                                  "—"}
                              </div>
                            </TableCell>
                            <TableCell>
                              {p.canonicalProjectNumber ??
                                (p.procoreData as any)?.projectNumber ??
                                (p.hubspotData as any)?.projectNumber ??
                                "—"}
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant={
                                  p.bucket === "conflict"
                                    ? "destructive"
                                    : p.bucket === "resolved"
                                      ? "default"
                                      : "secondary"
                                }
                              >
                                {p.bucket}
                              </Badge>
                            </TableCell>
                            <TableCell>{p.conflicts?.length ?? 0}</TableCell>
                            <TableCell>
                              {p.updatedAt ? format(new Date(p.updatedAt), "MMM d, yyyy") : "—"}
                            </TableCell>
                            <TableCell>
                              <Button variant="outline" size="sm" onClick={() => handleResolveClick(p)}>
                                Resolve →
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                  <div className="flex items-center justify-between mt-4">
                    <span className="text-sm text-muted-foreground">
                      Showing {start}-{end} of {projectsTotal}
                    </span>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                        <ChevronLeft className="h-4 w-4" /> Previous
                      </Button>
                      <Button variant="outline" size="sm" disabled={page >= projectsPages} onClick={() => setPage((p) => p + 1)}>
                        Next <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </>
              ) : (
                <p className="text-center text-muted-foreground py-12">
                  Run a scan to populate the queue. No projects to display.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="mappings">
          <Card>
            <CardHeader>
              <div className="flex flex-row items-center justify-between">
                <div>
                  <CardTitle>Legacy Number Mappings</CardTitle>
                  <p className="text-sm text-muted-foreground">
                    Map legacy project numbers to canonical DFW format
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {mappings && (
                    <Badge variant="secondary">
                      ⚠️ {unmappedOnly ? mappings?.length ?? 0 : mappings?.filter((m: any) => !m.canonicalNumber).length ?? 0} unmapped
                    </Badge>
                  )}
                  <div className="flex items-center gap-2">
                    <label className="text-sm flex items-center gap-2">
                      <Checkbox checked={unmappedOnly} onCheckedChange={(v) => setUnmappedOnly(!!v)} />
                      Show unmapped only
                    </label>
                  </div>
                  <Button onClick={() => setAddMappingOpen(true)}>Add Mapping</Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {mappings && mappings.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Legacy Number</TableHead>
                      <TableHead>Canonical Number</TableHead>
                      <TableHead>Era</TableHead>
                      <TableHead>Project Name</TableHead>
                      <TableHead>Mapped By</TableHead>
                      <TableHead>Date</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {mappings.map((m: any) => (
                      <TableRow key={m.id}>
                        <TableCell className="font-mono">{m.legacyNumber}</TableCell>
                        <TableCell className="font-mono">
                          {editingMappingId === m.id ? (
                            <div className="flex gap-1">
                              <Input
                                value={editingCanonical}
                                onChange={(e) => setEditingCanonical(e.target.value)}
                                placeholder="DFW-X-XXXXX-XX"
                                className="font-mono h-8"
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    if (!editingCanonical.trim() || DFW_REGEX.test(editingCanonical.trim())) {
                                      updateCanonicalMutation.mutate({
                                        legacyNumber: m.legacyNumber,
                                        canonicalNumber: editingCanonical,
                                        era: m.era,
                                      });
                                    }
                                  }
                                  if (e.key === "Escape") {
                                    setEditingMappingId(null);
                                    setEditingCanonical("");
                                  }
                                }}
                                onBlur={() => {
                                  if (editingCanonical.trim() && DFW_REGEX.test(editingCanonical.trim())) {
                                    updateCanonicalMutation.mutate({
                                      legacyNumber: m.legacyNumber,
                                      canonicalNumber: editingCanonical,
                                      era: m.era,
                                    });
                                  } else {
                                    setEditingMappingId(null);
                                    setEditingCanonical("");
                                  }
                                }}
                                autoFocus
                              />
                            </div>
                          ) : m.canonicalNumber ? (
                            <button
                              type="button"
                              className="hover:underline text-left"
                              onClick={() => {
                                setEditingMappingId(m.id);
                                setEditingCanonical(m.canonicalNumber ?? "");
                              }}
                            >
                              {m.canonicalNumber}
                            </button>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setEditingMappingId(m.id);
                                setEditingCanonical("");
                              }}
                            >
                              Assign
                            </Button>
                          )}
                          {editingMappingId === m.id && editingCanonical && !DFW_REGEX.test(editingCanonical) && (
                            <p className="text-xs text-red-500 mt-1">Must match DFW-X-XXXXX-XX format</p>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant={m.era === "zapier" ? "default" : "secondary"}>{m.era}</Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">{m.projectName ?? "—"}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{m.mappedBy ?? "—"}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {m.mappedAt ? format(new Date(m.mappedAt), "MMM d, yyyy") : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-center text-muted-foreground py-12">
                  No legacy mappings found. Run a reconciliation scan to detect legacy project numbers, or add them manually.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="audit">
          <Card>
            <CardHeader>
              <CardTitle>Resolution Audit Log</CardTitle>
              <p className="text-sm text-muted-foreground">History of all resolution actions</p>
            </CardHeader>
            <CardContent>
              <div className="flex gap-2 mb-4">
                <Select value={auditAction} onValueChange={(v) => { setAuditAction(v); setAuditPage(1); }}>
                  <SelectTrigger className="w-44">
                    <SelectValue placeholder="Filter by action" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="accept_procore">Accept Procore</SelectItem>
                    <SelectItem value="accept_hubspot">Accept HubSpot</SelectItem>
                    <SelectItem value="manual_override">Manual Override</SelectItem>
                    <SelectItem value="mark_ignored">Mark Ignored</SelectItem>
                    <SelectItem value="assign_canonical_number">Number Assigned</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {auditData?.data?.length > 0 ? (
                <>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Project</TableHead>
                        <TableHead>Action</TableHead>
                        <TableHead>Field</TableHead>
                        <TableHead>Change</TableHead>
                        <TableHead>By</TableHead>
                        <TableHead></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {auditData.data.map((e: any) => {
                        const isRecent = new Date(e.performedAt).getTime() > Date.now() - 24 * 60 * 60 * 1000;
                        const actionBadge =
                          e.action === "accept_procore"
                            ? "default"
                            : e.action === "accept_hubspot"
                              ? "secondary"
                              : e.action === "manual_override"
                                ? "outline"
                                : "secondary";
                        return (
                          <TableRow key={e.id}>
                            <TableCell className="text-sm">
                              {isRecent
                                ? formatDistanceToNow(new Date(e.performedAt), { addSuffix: true })
                                : format(new Date(e.performedAt), "MMM d, yyyy h:mm a")}
                            </TableCell>
                            <TableCell className="text-sm">#{e.reconciliationProjectId}</TableCell>
                            <TableCell>
                              <Badge variant={actionBadge}>{e.action?.replace(/_/g, " ")}</Badge>
                            </TableCell>
                            <TableCell className="text-sm">{e.fieldName ?? "—"}</TableCell>
                            <TableCell className="text-sm max-w-[200px] truncate">
                              {e.previousValue ?? "—"} → {e.newValue ?? "—"}
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">{e.performedBy ?? "—"}</TableCell>
                            <TableCell>
                              {e.fieldName && (
                                <Button
                                  variant="destructive"
                                  size="sm"
                                  onClick={() => {
                                    setRollbackEntry(e);
                                    setRollbackId(e.id);
                                  }}
                                >
                                  Rollback
                                </Button>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                  <div className="flex items-center justify-between mt-4">
                    <span className="text-sm text-muted-foreground">
                      Showing {(auditPage - 1) * 25 + 1}-{Math.min(auditPage * 25, auditData.total)} of {auditData.total}
                    </span>
                    <div className="flex gap-2">
                      <Button variant="outline" size="sm" disabled={auditPage <= 1} onClick={() => setAuditPage((p) => p - 1)}>
                        Previous
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={auditPage * 25 >= auditData.total}
                        onClick={() => setAuditPage((p) => p + 1)}
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                </>
              ) : (
                <p className="text-center text-muted-foreground py-12">
                  No resolution actions recorded yet. Resolve conflicts from the Reconciliation Queue to see history here.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {resolveMode === "conflict" && resolveProjectId && projectDetail && (
        <ResolverPanel
          projectId={resolveProjectId}
          project={projectDetail}
          open={!!resolveProjectId}
          onOpenChange={(open) => !open && closeResolver()}
        />
      )}
      {resolveMode === "orphan" && resolveProjectId && projectDetail && (
        <OrphanResolver
          projectId={resolveProjectId}
          project={projectDetail}
          open={!!resolveProjectId}
          onOpenChange={(open) => !open && closeResolver()}
        />
      )}

      <Dialog open={addMappingOpen} onOpenChange={setAddMappingOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Legacy Mapping</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Legacy Number</Label>
              <Input
                value={newLegacy}
                onChange={(e) => setNewLegacy(e.target.value)}
                placeholder="e.g. ASMAABALCO"
              />
            </div>
            <div>
              <Label>Canonical Number (optional)</Label>
              <Input
                value={newCanonical}
                onChange={(e) => setNewCanonical(e.target.value)}
                placeholder="DFW-X-XXXXX-XX"
              />
              {newCanonical && !DFW_REGEX.test(newCanonical) && (
                <p className="text-sm text-red-500 mt-1">Must match DFW-&#123;type&#125;-&#123;id&#125;-&#123;suffix&#125; format</p>
              )}
            </div>
            <div>
              <Label>Era</Label>
              <Select value={newEra} onValueChange={(v: "legacy" | "zapier") => setNewEra(v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="legacy">legacy</SelectItem>
                  <SelectItem value="zapier">zapier</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddMappingOpen(false)}>Cancel</Button>
            <Button onClick={() => addMappingMutation.mutate()} disabled={!addMappingValid || addMappingMutation.isPending}>
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!rollbackId} onOpenChange={(open) => !open && setRollbackId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rollback resolution?</AlertDialogTitle>
            <AlertDialogDescription>
              This will revert the {rollbackEntry?.fieldName} field from &quot;{rollbackEntry?.newValue}&quot; back to
              &quot;{rollbackEntry?.previousValue}&quot;. This action will be logged. Continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground"
              onClick={() => rollbackId && rollbackMutation.mutate(rollbackId)}
            >
              Rollback
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
