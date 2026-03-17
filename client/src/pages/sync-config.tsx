import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
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
  DialogTrigger,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Plus, ArrowRight, Trash2, MoveHorizontal, RefreshCw, Loader2 } from "lucide-react";
import { useState } from "react";
import type { StageMapping } from "@shared/schema";

const procoreStages = [
  { value: "estimate_in_progress", label: "Estimate in Progress" },
  { value: "service_estimating", label: "Service - Estimating" },
  { value: "estimate_under_review", label: "Estimate Under Review" },
  { value: "estimate_sent_to_client", label: "Estimate Sent to Client" },
  { value: "service_sent_to_production", label: "Service - Sent to Production" },
  { value: "sent_to_production", label: "Sent to Production" },
  { value: "service_lost", label: "Service - Lost" },
  { value: "production_lost", label: "Production Lost" },
];

interface HubSpotStage {
  stageId: string;
  label: string;
  pipelineLabel: string;
  pipelineId: string;
}

export default function SyncConfigPage() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { toast } = useToast();

  const { data: mappings, isLoading } = useQuery<StageMapping[]>({
    queryKey: ["/api/stage-mappings"],
  });

  const { data: configs } = useQuery<any[]>({
    queryKey: ["/api/automation-config"],
  });

  // Fetch HubSpot stages dynamically from API
  const { data: hubspotStagesData, isLoading: stagesLoading, refetch: refetchStages } = useQuery<HubSpotStage[]>({
    queryKey: ["/api/stage-mapping/hubspot-stages"],
  });

  const refreshPipelinesMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/stage-mapping/refresh-hubspot-pipelines");
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || "Failed to refresh pipelines");
      }
      return res.json();
    },
    onSuccess: (data) => {
      refetchStages();
      toast({ title: "HubSpot Stages Refreshed", description: `Found ${data.stages?.length || 0} stages` });
    },
    onError: (e: Error) => {
      toast({ title: "Failed to refresh", description: e.message, variant: "destructive" });
    },
  });

  // Convert API response to dropdown format
  const hubspotStages = (hubspotStagesData || []).map(s => ({
    value: s.stageId,
    label: `${s.label} (${s.pipelineLabel})`,
  }));

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("POST", "/api/stage-mappings", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/stage-mappings"] });
      setDialogOpen(false);
      toast({ title: "Stage mapping created" });
    },
    onError: (e: Error) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/stage-mappings/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/stage-mappings"] });
      toast({ title: "Stage mapping deleted" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, isActive }: { id: number; isActive: boolean }) => {
      const res = await apiRequest("PATCH", `/api/stage-mappings/${id}`, { isActive });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/stage-mappings"] });
    },
  });

  const configMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("PUT", "/api/automation-config", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/automation-config"] });
      toast({ title: "Configuration updated" });
    },
  });

  const getConfigValue = (key: string): boolean => {
    const config = configs?.find((c: any) => c.key === key);
    return config?.isActive ?? true;
  };

  const automationToggles = [
    { key: "sync_client_data", label: "Auto-sync client data to Bid Board", description: "Push HubSpot deal/company/contact data to Procore project overview" },
    { key: "transfer_attachments", label: "Transfer attachments on project creation", description: "Copy HubSpot deal attachments to Procore Bid Board documents" },
    { key: "send_to_portfolio", label: "Send to Portfolio on stage change", description: "Auto-push project to Procore Portfolio at configured stage" },
    { key: "sync_change_orders", label: "Update HubSpot deal amount on Change Orders", description: "Sync approved Procore change order amounts back to HubSpot deals" },
    { key: "companycam_dedup", label: "CompanyCam deduplication enabled", description: "Prevent duplicate CompanyCam projects across HubSpot and Procore" },
    { key: "auto_number_contracts", label: "Auto-number Prime Contracts & Commitments", description: "Generate contract numbers using project number prefix (e.g., 05926-aa-01)" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold" data-testid="text-sync-config-title">Sync Configuration</h2>
          <p className="text-muted-foreground text-sm mt-1">Configure stage mappings and automation rules</p>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3 flex flex-row items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <MoveHorizontal className="w-4 h-4" />
            Stage Mappings
            {hubspotStages.length > 0 && (
              <Badge variant="secondary" className="text-xs font-normal">
                {hubspotStages.length} HubSpot stages
              </Badge>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => refreshPipelinesMutation.mutate()}
              disabled={refreshPipelinesMutation.isPending}
              title="Refresh HubSpot Stages"
            >
              {refreshPipelinesMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4" />
              )}
            </Button>
            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <DialogTrigger asChild>
                <Button size="sm" data-testid="button-add-mapping">
                  <Plus className="w-4 h-4 mr-1" />
                  Add Mapping
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Add Stage Mapping</DialogTitle>
                </DialogHeader>
                <AddMappingForm
                  hubspotStages={hubspotStages}
                  onSubmit={(data) => createMutation.mutate(data)}
                  isPending={createMutation.isPending}
                  isLoadingStages={stagesLoading}
                />
              </DialogContent>
            </Dialog>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : !mappings || mappings.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">
              No stage mappings configured yet. Add your first mapping to start syncing stages between HubSpot and Procore.
            </p>
          ) : (
            <div className="space-y-2">
              {mappings.map((mapping) => (
                <div
                  key={mapping.id}
                  className="flex items-center justify-between py-3 px-4 rounded-lg border"
                  data-testid={`mapping-${mapping.id}`}
                >
                  <div className="flex items-center gap-3 flex-1">
                    <Badge variant="secondary" className="font-mono text-xs">
                      {mapping.hubspotStageLabel}
                    </Badge>
                    <ArrowRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                    <Badge variant="secondary" className="font-mono text-xs">
                      {mapping.procoreStageLabel}
                    </Badge>
                    {mapping.triggerPortfolio && (
                      <Badge className="text-xs bg-primary/10 text-primary border-primary/20">
                        Portfolio Trigger
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge variant="outline" className="text-xs">
                      {mapping.direction}
                    </Badge>
                    <Switch
                      checked={mapping.isActive}
                      onCheckedChange={(checked) => toggleMutation.mutate({ id: mapping.id, isActive: checked })}
                      data-testid={`toggle-mapping-${mapping.id}`}
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => deleteMutation.mutate(mapping.id)}
                      data-testid={`button-delete-mapping-${mapping.id}`}
                    >
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">Automation Toggles</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {automationToggles.map((toggle) => (
            <div
              key={toggle.key}
              className="flex items-center justify-between py-2"
              data-testid={`config-${toggle.key}`}
            >
              <div className="flex-1">
                <p className="text-sm font-medium">{toggle.label}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{toggle.description}</p>
              </div>
              <Switch
                checked={getConfigValue(toggle.key)}
                onCheckedChange={(checked) =>
                  configMutation.mutate({
                    key: toggle.key,
                    value: { enabled: checked },
                    description: toggle.description,
                    isActive: checked,
                  })
                }
                data-testid={`toggle-${toggle.key}`}
              />
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

interface AddMappingFormProps {
  hubspotStages: { value: string; label: string }[];
  onSubmit: (data: any) => void;
  isPending: boolean;
  isLoadingStages?: boolean;
}

function AddMappingForm({ hubspotStages, onSubmit, isPending, isLoadingStages }: AddMappingFormProps) {
  const [hubspotStage, setHubspotStage] = useState("");
  const [procoreStage, setProcoreStage] = useState("");
  const [direction, setDirection] = useState("bidirectional");
  const [triggerPortfolio, setTriggerPortfolio] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const hsLabel = hubspotStages.find((s) => s.value === hubspotStage)?.label || hubspotStage;
    const pcLabel = procoreStages.find((s) => s.value === procoreStage)?.label || procoreStage;
    onSubmit({
      hubspotStage,
      hubspotStageLabel: hsLabel,
      procoreStage,
      procoreStageLabel: pcLabel,
      direction,
      isActive: true,
      sortOrder: 0,
      triggerPortfolio,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 pt-2">
      <div>
        <label className="text-sm font-medium mb-1.5 block">HubSpot Deal Stage</label>
        {isLoadingStages ? (
          <Skeleton className="h-10 w-full" />
        ) : hubspotStages.length === 0 ? (
          <p className="text-sm text-muted-foreground py-2">
            No HubSpot stages found. Click the refresh button to fetch stages from HubSpot.
          </p>
        ) : (
          <Select value={hubspotStage} onValueChange={setHubspotStage}>
            <SelectTrigger data-testid="select-hubspot-stage">
              <SelectValue placeholder="Select HubSpot stage" />
            </SelectTrigger>
            <SelectContent>
              {hubspotStages.map((s) => (
                <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      <div>
        <label className="text-sm font-medium mb-1.5 block">Procore Bid Board Stage</label>
        <Select value={procoreStage} onValueChange={setProcoreStage}>
          <SelectTrigger data-testid="select-procore-stage">
            <SelectValue placeholder="Select Procore stage" />
          </SelectTrigger>
          <SelectContent>
            {procoreStages.map((s) => (
              <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <label className="text-sm font-medium mb-1.5 block">Direction</label>
        <Select value={direction} onValueChange={setDirection}>
          <SelectTrigger data-testid="select-direction">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="bidirectional">Bidirectional</SelectItem>
            <SelectItem value="hubspot_to_procore">HubSpot → Procore</SelectItem>
            <SelectItem value="procore_to_hubspot">Procore → HubSpot</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center justify-between">
        <label className="text-sm font-medium">Triggers Send to Portfolio</label>
        <Switch checked={triggerPortfolio} onCheckedChange={setTriggerPortfolio} data-testid="toggle-portfolio-trigger" />
      </div>
      <Button type="submit" className="w-full" disabled={!hubspotStage || !procoreStage || isPending} data-testid="button-save-mapping">
        {isPending ? "Saving..." : "Save Mapping"}
      </Button>
    </form>
  );
}
