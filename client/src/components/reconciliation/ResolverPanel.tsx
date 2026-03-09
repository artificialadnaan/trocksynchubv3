/**
 * Resolver Panel — Conflict resolution slide-over for conflict/fuzzy_match projects
 */

import { useState, useEffect, useRef } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";

const DFW_REGEX = /^DFW-\d+-\d{4,6}-[a-z]{2}$/i;

function formatCurrency(val: string | number | null): string {
  if (val == null || val === "") return "—";
  const n = typeof val === "number" ? val : parseFloat(String(val).replace(/[$,]/g, ""));
  return isNaN(n) ? String(val) : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

export function ResolverPanel({
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
  const [selections, setSelections] = useState<Record<string, { value: string; source: "procore" | "hubspot" | "manual" }>>({});
  const [adminNotes, setAdminNotes] = useState("");
  const [writeback, setWriteback] = useState(true);

  const pc = project?.procoreData ?? {};
  const hs = project?.hubspotData ?? {};
  const name = project?.canonicalName ?? pc?.name ?? hs?.dealName ?? "—";
  const projectNumber = project?.canonicalProjectNumber ?? pc?.projectNumber ?? hs?.projectNumber ?? null;
  const isLegacy = projectNumber && !DFW_REGEX.test(projectNumber);
  const unresolvedConflicts = (project?.conflicts ?? []).filter((c: any) => !c.isResolved);
  const prevOpenRef = useRef(false);

  // Initialize selections only when panel opens (transition closed→open)
  // #region agent log
  useEffect(() => {
    const justOpened = open && !prevOpenRef.current;
    prevOpenRef.current = open;
    if (justOpened) {
      const unresolved = (project?.conflicts ?? []).filter((c: any) => !c.isResolved);
      if (unresolved.length) {
        const init: Record<string, { value: string; source: "procore" | "hubspot" | "manual" }> = {};
        unresolved.forEach((c: any) => {
          const pv = c.procoreValue ?? "";
          const hv = c.hubspotValue ?? "";
          init[c.fieldName] = { value: pv || hv, source: pv ? "procore" : "hubspot" };
        });
        fetch('http://127.0.0.1:7661/ingest/61f6258c-19fa-4982-aa07-700f3fd86181',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'fe82c1'},body:JSON.stringify({sessionId:'fe82c1',location:'ResolverPanel.tsx:useEffect',message:'useEffect init (justOpened)',data:{conflictsLen:unresolved.length},hypothesisId:'A',timestamp:Date.now()})}).catch(()=>{});
        setSelections(init);
        setAdminNotes(project?.adminNotes ?? "");
      }
    }
  }, [open, project?.conflicts, project?.adminNotes]);
  // #endregion

  const saveMutation = useMutation({
    mutationFn: async () => {
      for (const [fieldName, sel] of Object.entries(selections)) {
        if (!sel.value.trim()) continue;
        await apiRequest("POST", `/api/reconciliation/projects/${projectId}/resolve-field`, {
          fieldName,
          resolvedValue: sel.value,
          source: sel.source,
          writeback,
          notes: adminNotes || undefined,
        });
      }
    },
    onSuccess: () => {
      toast({ title: "Resolutions saved" });
      onOpenChange(false);
      queryClient.invalidateQueries({ queryKey: ["/api/reconciliation/projects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/reconciliation/dashboard"] });
    },
    onError: (e: Error) => {
      toast({ title: "Failed to save", description: e.message, variant: "destructive" });
    },
  });

  const resolveAllMutation = useMutation({
    mutationFn: async (source: "procore" | "hubspot") => {
      await apiRequest("POST", `/api/reconciliation/projects/${projectId}/resolve-all`, {
        source,
        writeback,
        notes: adminNotes || undefined,
      });
    },
    onSuccess: () => {
      toast({ title: "All resolved" });
      onOpenChange(false);
      queryClient.invalidateQueries({ queryKey: ["/api/reconciliation/projects"] });
      queryClient.invalidateQueries({ queryKey: ["/api/reconciliation/dashboard"] });
    },
    onError: (e: Error) => {
      toast({ title: "Failed", description: e.message, variant: "destructive" });
    },
  });

  const setQuickAll = (source: "procore" | "hubspot") => {
    const next: Record<string, { value: string; source: "procore" | "hubspot" }> = {};
    unresolvedConflicts.forEach((c: any) => {
      const val = source === "procore" ? (c.procoreValue ?? "") : (c.hubspotValue ?? "");
      next[c.fieldName] = { value: val, source };
    });
    setSelections(next);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="pr-8">{name}</SheetTitle>
          <div className="flex flex-wrap gap-2 pt-2">
            <Badge variant={project?.bucket === "conflict" ? "destructive" : "secondary"}>
              {project?.bucket}
            </Badge>
            {project?.matchConfidence != null && (
              <Badge variant="outline">{Math.round(project.matchConfidence * 100)}% fuzzy</Badge>
            )}
            {isLegacy && <Badge variant="outline">legacy</Badge>}
            {!isLegacy && projectNumber && <Badge variant="outline">synchub</Badge>}
          </div>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-lg bg-blue-50 dark:bg-blue-950/30 p-4 text-sm space-y-1">
              <p className="font-medium text-blue-800 dark:text-blue-200">Procore</p>
              <p><span className="text-muted-foreground">Name:</span> {pc?.name ?? "—"}</p>
              <p><span className="text-muted-foreground">Project #:</span> {pc?.projectNumber ?? "—"}</p>
              <p><span className="text-muted-foreground">Location:</span> {pc?.address ?? "—"}</p>
              <p><span className="text-muted-foreground">Stage:</span> {pc?.stage ?? "—"}</p>
              <p><span className="text-muted-foreground">Amount:</span> {formatCurrency(pc?.estimatedValue ?? pc?.actualValue)}</p>
            </div>
            <div className="rounded-lg bg-orange-50 dark:bg-orange-950/30 p-4 text-sm space-y-1">
              <p className="font-medium text-orange-800 dark:text-orange-200">HubSpot</p>
              <p><span className="text-muted-foreground">Name:</span> {hs?.dealName ?? "—"}</p>
              <p><span className="text-muted-foreground">Project #:</span> {hs?.projectNumber ?? "—"}</p>
              <p><span className="text-muted-foreground">Location:</span> {hs?.address ?? "—"}</p>
              <p><span className="text-muted-foreground">Stage:</span> {hs?.dealStage ?? "—"}</p>
              <p><span className="text-muted-foreground">Amount:</span> {formatCurrency(hs?.amount)}</p>
            </div>
          </div>

          <div>
            <h4 className="font-medium mb-3">Field Conflicts</h4>
            <div className="space-y-4">
              {unresolvedConflicts.map((c: any) => {
                const sel = selections[c.fieldName] ?? { value: "", source: "procore" as const };
                const pv = c.procoreValue ?? "";
                const hv = c.hubspotValue ?? "";
                const isAmount = c.fieldName === "amount";
                const isProjectNum = c.fieldName === "project_number";
                let delta = "";
                if (isAmount && pv && hv) {
                  const a = parseFloat(String(pv).replace(/[$,]/g, ""));
                  const b = parseFloat(String(hv).replace(/[$,]/g, ""));
                  if (!isNaN(a) && !isNaN(b) && Math.max(a, b) > 0) {
                    const diff = Math.abs(a - b);
                    const pct = (diff / Math.max(a, b)) * 100;
                    delta = `Δ = ${formatCurrency(diff)} (${pct.toFixed(1)}%)`;
                  }
                }

                return (
                  <div key={c.id} className="border rounded-lg p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-medium capitalize">{c.fieldName.replace(/_/g, " ")}</Label>
                      <Badge
                        variant={
                          c.severity === "critical" ? "destructive" : c.severity === "warning" ? "secondary" : "outline"
                        }
                      >
                        {c.severity?.toUpperCase() ?? "INFO"}
                      </Badge>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <span className="text-muted-foreground">Procore:</span>{" "}
                        {isAmount ? formatCurrency(pv) : pv || "—"}
                      </div>
                      <div>
                        <span className="text-muted-foreground">HubSpot:</span>{" "}
                        {isAmount ? formatCurrency(hv) : hv || "—"}
                      </div>
                    </div>
                    {delta && <p className="text-xs text-muted-foreground">{delta}</p>}
                    {isProjectNum && isLegacy && (
                      <p className="text-xs text-amber-600">Legacy number — consider assigning a canonical DFW number in Legacy Mappings tab.</p>
                    )}
                    <RadioGroup
                      value={sel.source === "manual" ? "manual" : sel.source}
                      onValueChange={(v) => {
                        // #region agent log
                        fetch('http://127.0.0.1:7661/ingest/61f6258c-19fa-4982-aa07-700f3fd86181',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'fe82c1'},body:JSON.stringify({sessionId:'fe82c1',location:'ResolverPanel.tsx:onValueChange',message:'Radio onValueChange fired',data:{fieldName:c.fieldName,value:v},hypothesisId:'B',timestamp:Date.now()})}).catch(()=>{});
                        // #endregion
                        const src = v as "procore" | "hubspot" | "manual";
                        const val = src === "procore" ? pv : src === "hubspot" ? hv : sel.value;
                        setSelections((s) => ({ ...s, [c.fieldName]: { value: val, source: src } }));
                      }}
                      className="flex flex-col gap-2"
                    >
                      <label
                        className="flex items-center gap-2 cursor-pointer font-normal"
                        onClick={() => setSelections((s) => ({ ...s, [c.fieldName]: { value: pv, source: "procore" } }))}
                      >
                        <RadioGroupItem value="procore" id={`${c.fieldName}-pc`} />
                        <span>Use Procore</span>
                      </label>
                      <label
                        className="flex items-center gap-2 cursor-pointer font-normal"
                        onClick={() => setSelections((s) => ({ ...s, [c.fieldName]: { value: hv, source: "hubspot" } }))}
                      >
                        <RadioGroupItem value="hubspot" id={`${c.fieldName}-hs`} />
                        <span>Use HubSpot</span>
                      </label>
                      <label
                        className="flex items-center gap-2 cursor-pointer font-normal"
                        onClick={() => setSelections((s) => ({ ...s, [c.fieldName]: { value: sel.value, source: "manual" } }))}
                      >
                        <RadioGroupItem value="manual" id={`${c.fieldName}-manual`} />
                        <span>Manual Override</span>
                      </label>
                    </RadioGroup>
                    {sel.source === "manual" && (
                      <Input
                        placeholder="Enter value..."
                        value={sel.value}
                        onChange={(e) =>
                          setSelections((s) => ({
                            ...s,
                            [c.fieldName]: { ...s[c.fieldName], value: e.target.value },
                          }))
                        }
                        className="mt-2"
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setQuickAll("procore")}>
              Pre-fill Procore
            </Button>
            <Button variant="outline" size="sm" onClick={() => setQuickAll("hubspot")}>
              Pre-fill HubSpot
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => resolveAllMutation.mutate("procore")}
              disabled={resolveAllMutation.isPending || unresolvedConflicts.length === 0}
            >
              Accept All Procore
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => resolveAllMutation.mutate("hubspot")}
              disabled={resolveAllMutation.isPending || unresolvedConflicts.length === 0}
            >
              Accept All HubSpot
            </Button>
          </div>

          <div>
            <Label className="text-sm">Admin Notes</Label>
            <Textarea
              value={adminNotes}
              onChange={(e) => setAdminNotes(e.target.value)}
              placeholder="Optional notes..."
              className="mt-1"
              rows={2}
            />
          </div>

          <div className="flex items-center gap-2">
            <Checkbox id="writeback" checked={writeback} onCheckedChange={(v) => setWriteback(!!v)} />
            <Label htmlFor="writeback" className="text-sm font-normal">Write changes back to HubSpot</Label>
          </div>
        </div>

        <SheetFooter className="mt-6 gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || Object.keys(selections).length === 0}
          >
            {saveMutation.isPending ? "Saving..." : "Save Resolutions"}
          </Button>
        </SheetFooter>

        {project?.auditLog?.length > 0 && (
          <div className="mt-8 pt-6 border-t">
            <h4 className="font-medium mb-2">Resolution History</h4>
            <ul className="space-y-1 text-sm text-muted-foreground">
              {project.auditLog.slice(0, 10).map((e: any) => (
                <li key={e.id}>
                  {format(new Date(e.performedAt), "MMM d, h:mm a")} — {e.action} {e.fieldName ? `(${e.fieldName})` : ""}{" "}
                  {e.previousValue && e.newValue ? `${e.previousValue} → ${e.newValue}` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
