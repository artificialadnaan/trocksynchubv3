/**
 * Orphan Resolver — Link, ignore, or note for orphan_procore / orphan_hubspot projects
 */

import { useState, useEffect, useCallback } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Search } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, getQueryFn } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

const IGNORE_REASONS = [
  { value: "test", label: "Test/Demo data" },
  { value: "archived", label: "Archived project" },
  { value: "duplicate", label: "Duplicate record" },
  { value: "legacy", label: "Pre-SyncHub legacy" },
  { value: "other", label: "Other" },
];

export function OrphanResolver({
  projectId,
  project,
  open,
  onOpenChange,
}: {
  projectId: number;
  project: any;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [ignoreReason, setIgnoreReason] = useState("");
  const [ignoreOther, setIgnoreOther] = useState("");

  const isProcoreOrphan = project?.bucket === "orphan_procore";
  const data = isProcoreOrphan ? project?.procoreData : project?.hubspotData;
  const name = data?.name ?? data?.dealName ?? "—";

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const searchUrl = debouncedSearch.length >= 3
    ? isProcoreOrphan
      ? `/api/hubspot/deals?search=${encodeURIComponent(debouncedSearch)}&limit=10`
      : `/api/procore/projects?search=${encodeURIComponent(debouncedSearch)}&limit=10`
    : null;

  const { data: searchResults } = useQuery<any>({
    queryKey: searchUrl ? [searchUrl] : ["reconciliation-orphan-search-disabled"],
    queryFn: getQueryFn({ on401: "throw" }),
    enabled: !!searchUrl,
  });

  const items = isProcoreOrphan ? searchResults?.data ?? [] : searchResults?.data ?? [];

  const linkMutation = useMutation({
    mutationFn: async (targetId: string) => {
      await apiRequest("POST", `/api/reconciliation/projects/${projectId}/link`, {
        targetSystem: isProcoreOrphan ? "hubspot" : "procore",
        targetId,
      });
    },
    onSuccess: () => {
      toast({ title: "Linked successfully" });
      onOpenChange(false);
      queryClient.invalidateQueries({ queryKey: ["/api/reconciliation/projects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/reconciliation/dashboard"] });
    },
    onError: (e: Error) => {
      toast({ title: "Link failed", description: e.message, variant: "destructive" });
    },
  });

  const ignoreMutation = useMutation({
    mutationFn: async () => {
      const reason = ignoreReason === "other" ? ignoreOther : ignoreReason;
      if (!reason.trim()) throw new Error("Please select or enter a reason");
      await apiRequest("POST", `/api/reconciliation/projects/${projectId}/ignore`, { reason });
    },
    onSuccess: () => {
      toast({ title: "Marked as ignored" });
      onOpenChange(false);
      queryClient.invalidateQueries({ queryKey: ["/api/reconciliation/projects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/reconciliation/dashboard"] });
    },
    onError: (e: Error) => {
      toast({ title: "Failed", description: e.message, variant: "destructive" });
    },
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="pr-8">{name}</SheetTitle>
          <div className="flex gap-2 pt-2">
            <Badge variant="secondary">Orphan</Badge>
            <Badge variant="outline">
              {isProcoreOrphan
                ? "Exists in Procore, no HubSpot match"
                : "Exists in HubSpot, no Procore match"}
            </Badge>
          </div>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          <div className="rounded-lg border p-4">
            <h4 className="font-medium mb-2">
              {isProcoreOrphan ? "Procore Data" : "HubSpot Data"}
            </h4>
            <div className="text-sm space-y-1 text-muted-foreground">
              {isProcoreOrphan ? (
                <>
                  <p><span className="text-foreground">Name:</span> {data?.name ?? "—"}</p>
                  <p><span className="text-foreground">Project #:</span> {data?.projectNumber ?? "—"}</p>
                  <p><span className="text-foreground">Location:</span> {data?.address ?? data?.city ?? "—"}</p>
                  <p><span className="text-foreground">Stage:</span> {data?.stage ?? "—"}</p>
                  <p><span className="text-foreground">Amount:</span> {data?.estimatedValue ?? data?.actualValue ?? "—"}</p>
                </>
              ) : (
                <>
                  <p><span className="text-foreground">Deal Name:</span> {data?.dealName ?? "—"}</p>
                  <p><span className="text-foreground">Project #:</span> {data?.projectNumber ?? "—"}</p>
                  <p><span className="text-foreground">Address:</span> {data?.address ?? "—"}</p>
                  <p><span className="text-foreground">Stage:</span> {data?.dealStage ?? "—"}</p>
                  <p><span className="text-foreground">Amount:</span> {data?.amount ?? "—"}</p>
                </>
              )}
            </div>
          </div>

          <div className="border-t pt-4">
            <h4 className="font-medium mb-2">A. Link to existing record</h4>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by name or project number (3+ chars)..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
            {items.length > 0 && (
              <ul className="mt-2 space-y-2 max-h-48 overflow-y-auto">
                {items.map((item: any) => {
                  const id = isProcoreOrphan ? item.hubspotId : item.procoreId;
                  const label = isProcoreOrphan ? item.dealName : item.name;
                  return (
                    <li key={id} className="flex items-center justify-between border rounded p-2 text-sm">
                      <span className="truncate">
                        {label ?? id} — {item.projectNumber ?? "—"} — {item.amount ?? "—"}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => linkMutation.mutate(id)}
                        disabled={linkMutation.isPending}
                      >
                        Link
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="border-t pt-4">
            <h4 className="font-medium mb-2">B. Mark as intentionally unlinked</h4>
            <Select value={ignoreReason} onValueChange={setIgnoreReason}>
              <SelectTrigger>
                <SelectValue placeholder="Select reason" />
              </SelectTrigger>
              <SelectContent>
                {IGNORE_REASONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {ignoreReason === "other" && (
              <Input
                placeholder="Enter reason..."
                value={ignoreOther}
                onChange={(e) => setIgnoreOther(e.target.value)}
                className="mt-2"
              />
            )}
            <Button
              variant="secondary"
              className="mt-2"
              onClick={() => ignoreMutation.mutate()}
              disabled={ignoreMutation.isPending || !(ignoreReason === "other" ? ignoreOther.trim() : ignoreReason)}
            >
              Mark Ignored
            </Button>
          </div>

          <p className="text-xs text-muted-foreground border-t pt-4">
            To create a matching record in the other system, do so manually in HubSpot/Procore, then run a sync and re-scan.
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}
