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
import { Plus, ArrowRight, Trash2, MoveHorizontal } from "lucide-react";
import { useState } from "react";
import type { StageMapping } from "@shared/schema";

const hubspotStages = [
  { value: "qualifiedtobuy", label: "Qualified to Buy" },
  { value: "presentationscheduled", label: "Presentation Scheduled" },
  { value: "decisionmakerboughtin", label: "Decision Maker Bought-In" },
  { value: "contractsent", label: "Contract Sent" },
  { value: "closedwon", label: "Closed Won" },
  { value: "closedlost", label: "Closed Lost" },
  { value: "inproduction", label: "In Production" },
  { value: "projectcomplete", label: "Project Complete" },
];

const procoreStages = [
  { value: "preconstruction", label: "Pre-Construction" },
  { value: "bidding", label: "Bidding" },
  { value: "awarded", label: "Awarded" },
  { value: "active", label: "Active Project" },
  { value: "sendtoportfolio", label: "Send to Portfolio" },
  { value: "production", label: "Production" },
  { value: "closeout", label: "Closeout" },
  { value: "complete", label: "Complete" },
];

export default function SyncConfigPage() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { toast } = useToast();

  const { data: mappings, isLoading } = useQuery<StageMapping[]>({
    queryKey: ["/api/stage-mappings"],
  });

  const { data: configs } = useQuery<any[]>({
    queryKey: ["/api/automation-config"],
  });

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
          </CardTitle>
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
                onSubmit={(data) => createMutation.mutate(data)}
                isPending={createMutation.isPending}
              />
            </DialogContent>
          </Dialog>
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

function AddMappingForm({ onSubmit, isPending }: { onSubmit: (data: any) => void; isPending: boolean }) {
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
