import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { FolderSync, Search, Plus, RefreshCw, ExternalLink } from "lucide-react";
import { useState } from "react";
import { format } from "date-fns";
import type { SyncMapping } from "@shared/schema";

export default function ProjectsPage() {
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const { toast } = useToast();

  const { data: mappings, isLoading } = useQuery<SyncMapping[]>({
    queryKey: [search ? `/api/sync-mappings?search=${encodeURIComponent(search)}` : "/api/sync-mappings"],
  });

  const createMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("POST", "/api/sync-mappings", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sync-mappings"] });
      setDialogOpen(false);
      toast({ title: "Project link created" });
    },
    onError: (e: Error) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const syncMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("PATCH", `/api/sync-mappings/${id}`, {
        lastSyncAt: new Date().toISOString(),
        lastSyncStatus: "syncing",
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sync-mappings"] });
      toast({ title: "Manual sync triggered" });
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold" data-testid="text-projects-title">Project Mapper</h2>
          <p className="text-muted-foreground text-sm mt-1">View and manage linked projects across platforms</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button size="sm" data-testid="button-create-link">
              <Plus className="w-4 h-4 mr-1" />
              Create Manual Link
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Manual Link</DialogTitle>
            </DialogHeader>
            <ManualLinkForm
              onSubmit={(data) => createMutation.mutate(data)}
              isPending={createMutation.isPending}
            />
          </DialogContent>
        </Dialog>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Search by deal name, project name, or project number..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
          data-testid="input-search-projects"
        />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <FolderSync className="w-4 h-4" />
            Linked Projects
            {mappings && <span className="text-xs font-normal text-muted-foreground">({mappings.length})</span>}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : !mappings || mappings.length === 0 ? (
            <p className="text-sm text-muted-foreground py-12 text-center">
              {search ? "No projects match your search." : "No linked projects yet. Projects will appear here when syncs are established."}
            </p>
          ) : (
            <div className="space-y-3">
              {mappings.map((mapping) => (
                <div
                  key={mapping.id}
                  className="border rounded-lg p-4"
                  data-testid={`project-mapping-${mapping.id}`}
                >
                  <div className="grid grid-cols-3 gap-4">
                    <PlatformCard
                      platform="HubSpot"
                      name={mapping.hubspotDealName || "Not linked"}
                      id={mapping.hubspotDealId}
                      color="text-orange-600"
                    />
                    <PlatformCard
                      platform="Procore"
                      name={mapping.procoreProjectName || "Not linked"}
                      id={mapping.procoreProjectId}
                      number={mapping.procoreProjectNumber}
                      color="text-blue-600"
                    />
                    <PlatformCard
                      platform="CompanyCam"
                      name={mapping.companyCamProjectId ? `Project #${mapping.companyCamProjectId}` : "Not linked"}
                      id={mapping.companyCamProjectId}
                      color="text-purple-600"
                    />
                  </div>
                  <div className="flex items-center justify-between mt-3 pt-3 border-t">
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>Last sync: {mapping.lastSyncAt ? format(new Date(mapping.lastSyncAt), "MMM d, h:mm a") : "Never"}</span>
                      {mapping.lastSyncStatus && (
                        <Badge variant="outline" className="text-xs">
                          {mapping.lastSyncStatus}
                        </Badge>
                      )}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => syncMutation.mutate(mapping.id)}
                      disabled={syncMutation.isPending}
                      data-testid={`button-sync-${mapping.id}`}
                    >
                      <RefreshCw className="w-3.5 h-3.5 mr-1" />
                      Manual Sync
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function PlatformCard({ platform, name, id, number, color }: {
  platform: string; name: string; id?: string | null; number?: string | null; color: string;
}) {
  return (
    <div className="space-y-1">
      <p className={`text-xs font-semibold ${color}`}>{platform}</p>
      <p className="text-sm font-medium truncate">{name}</p>
      {number && <p className="text-xs text-muted-foreground font-mono">{number}</p>}
      {id && (
        <p className="text-xs text-muted-foreground flex items-center gap-1">
          ID: {id}
          <ExternalLink className="w-3 h-3" />
        </p>
      )}
    </div>
  );
}

function ManualLinkForm({ onSubmit, isPending }: { onSubmit: (data: any) => void; isPending: boolean }) {
  const [formData, setFormData] = useState({
    hubspotDealId: "",
    hubspotDealName: "",
    procoreProjectId: "",
    procoreProjectName: "",
    procoreProjectNumber: "",
    companyCamProjectId: "",
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      ...formData,
      lastSyncStatus: "manual",
      lastSyncAt: new Date().toISOString(),
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 pt-2">
      <div className="space-y-3">
        <p className="text-sm font-semibold text-orange-600">HubSpot</p>
        <Input
          placeholder="Deal ID"
          value={formData.hubspotDealId}
          onChange={(e) => setFormData({ ...formData, hubspotDealId: e.target.value })}
          data-testid="input-hubspot-deal-id"
        />
        <Input
          placeholder="Deal Name"
          value={formData.hubspotDealName}
          onChange={(e) => setFormData({ ...formData, hubspotDealName: e.target.value })}
          data-testid="input-hubspot-deal-name"
        />
      </div>
      <div className="space-y-3">
        <p className="text-sm font-semibold text-blue-600">Procore</p>
        <Input
          placeholder="Project ID"
          value={formData.procoreProjectId}
          onChange={(e) => setFormData({ ...formData, procoreProjectId: e.target.value })}
          data-testid="input-procore-project-id"
        />
        <Input
          placeholder="Project Name"
          value={formData.procoreProjectName}
          onChange={(e) => setFormData({ ...formData, procoreProjectName: e.target.value })}
          data-testid="input-procore-project-name"
        />
        <Input
          placeholder="Project Number (e.g., 05926-aa)"
          value={formData.procoreProjectNumber}
          onChange={(e) => setFormData({ ...formData, procoreProjectNumber: e.target.value })}
          data-testid="input-procore-project-number"
        />
      </div>
      <div className="space-y-3">
        <p className="text-sm font-semibold text-purple-600">CompanyCam</p>
        <Input
          placeholder="Project ID (optional)"
          value={formData.companyCamProjectId}
          onChange={(e) => setFormData({ ...formData, companyCamProjectId: e.target.value })}
          data-testid="input-companycam-project-id"
        />
      </div>
      <Button type="submit" className="w-full" disabled={isPending} data-testid="button-save-link">
        {isPending ? "Saving..." : "Create Link"}
      </Button>
    </form>
  );
}
