import { useQuery } from "@tanstack/react-query";
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
  Camera,
  Users,
  Image,
  History,
  Search,
  RefreshCw,
  ChevronDown,
  Loader2,
  ExternalLink,
  MapPin,
} from "lucide-react";
import { useState } from "react";
import { format } from "date-fns";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type {
  CompanycamProject,
  CompanycamUser,
  CompanycamPhoto,
  CompanycamChangeHistory,
} from "@shared/schema";

type TabType = "projects" | "users" | "photos" | "changeHistory";

const tabs: { id: TabType; label: string; icon: any }[] = [
  { id: "projects", label: "Projects", icon: Camera },
  { id: "users", label: "Users", icon: Users },
  { id: "photos", label: "Photos", icon: Image },
  { id: "changeHistory", label: "Change History", icon: History },
];

export function CompanyCamDataContent() {
  const [activeTab, setActiveTab] = useState<TabType>("projects");
  const [syncing, setSyncing] = useState(false);
  const { toast } = useToast();

  const { data: counts, isLoading: countsLoading } = useQuery<{
    projects: number;
    users: number;
    photos: number;
    changeHistory: number;
  }>({
    queryKey: ["/api/integrations/companycam/data-counts"],
  });

  const countMap: Record<TabType, number> = {
    projects: counts?.projects || 0,
    users: counts?.users || 0,
    photos: counts?.photos || 0,
    changeHistory: counts?.changeHistory || 0,
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await apiRequest("POST", "/api/integrations/companycam/sync");
      const result = await res.json();
      queryClient.invalidateQueries({ queryKey: ["/api/integrations/companycam/data-counts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/companycam"] });
      toast({
        title: "CompanyCam sync complete",
        description: `Projects: ${result.projects?.synced || 0}, Users: ${result.users?.synced || 0}, Photos: ${result.photos?.synced || 0}`,
      });
    } catch (e: any) {
      toast({ title: "Sync failed", description: e.message, variant: "destructive" });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-sm text-muted-foreground">
          Browse and manage CompanyCam data synced to the local database
        </p>
        <Button 
          onClick={handleSync} 
          disabled={syncing}
          data-testid="button-sync-from-companycam"
        >
          {syncing ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Syncing...
            </>
          ) : (
            <>
              <RefreshCw className="w-4 h-4 mr-2" />
              Sync from CompanyCam
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
            data-testid={`tab-companycam-${tab.id}`}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
            {!countsLoading && (
              <Badge variant="secondary" className="text-xs ml-1 px-1.5 py-0">
                {countMap[tab.id].toLocaleString()}
              </Badge>
            )}
          </button>
        ))}
      </div>

      {activeTab === "projects" && <ProjectsTab />}
      {activeTab === "users" && <UsersTab />}
      {activeTab === "photos" && <PhotosTab />}
      {activeTab === "changeHistory" && <ChangeHistoryTab />}
    </div>
  );
}

function ProjectsTab() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const limit = 50;

  const params = new URLSearchParams();
  if (search) params.set("search", search);
  params.set("limit", String(limit));
  params.set("offset", String(page * limit));

  const { data, isLoading, refetch } = useQuery<{ data: CompanycamProject[]; total: number }>({
    queryKey: [`/api/companycam/projects?${params.toString()}`],
  });

  const toggleExpand = (id: number) => {
    const next = new Set(expandedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpandedIds(next);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Camera className="w-4 h-4" />
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
                data-testid="input-search-companycam-projects"
              />
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-companycam-projects">
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : !data?.data?.length ? (
          <p className="text-sm text-muted-foreground py-12 text-center">No projects found. Run a CompanyCam sync to pull data.</p>
        ) : (
          <>
            <div className="rounded-lg border">
              <div className="grid grid-cols-[1fr_200px_80px_80px_150px_40px] gap-3 px-4 py-2.5 bg-muted/50 text-xs font-medium text-muted-foreground border-b">
                <span>Project Name</span>
                <span>Location</span>
                <span>Photos</span>
                <span>Status</span>
                <span>Creator</span>
                <span className="w-8"></span>
              </div>
              {data.data.map((project) => (
                <Collapsible key={project.id} open={expandedIds.has(project.id)} onOpenChange={() => toggleExpand(project.id)}>
                  <CollapsibleTrigger className="w-full" data-testid={`companycam-project-row-${project.id}`}>
                    <div className="grid grid-cols-[1fr_200px_80px_80px_150px_40px] gap-3 px-4 py-3 text-sm hover:bg-muted/30 transition-colors items-center border-b last:border-0">
                      <span className="font-medium truncate text-left">{project.name || "—"}</span>
                      <span className="text-muted-foreground truncate text-left">
                        {[project.city, project.state].filter(Boolean).join(", ") || "—"}
                      </span>
                      <span className="text-muted-foreground text-left">{project.photoCount ?? 0}</span>
                      <span className="text-left">
                        <Badge variant={project.archived ? "outline" : "secondary"} className="text-xs">
                          {project.archived ? "Archived" : project.status || "Active"}
                        </Badge>
                      </span>
                      <span className="text-muted-foreground truncate text-left">{project.creatorName || "—"}</span>
                      <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${expandedIds.has(project.id) ? "rotate-180" : ""}`} />
                    </div>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="px-4 py-3 bg-muted/10 border-b space-y-2">
                      <div className="grid grid-cols-3 gap-4 text-sm">
                        <div><span className="text-muted-foreground">CompanyCam ID:</span> <span className="font-mono text-xs ml-1">{project.companycamId}</span></div>
                        <div><span className="text-muted-foreground">Full Address:</span> <span className="ml-1">{[project.streetAddress, project.city, project.state, project.postalCode, project.country].filter(Boolean).join(", ") || "—"}</span></div>
                        <div className="flex items-center gap-1">
                          <MapPin className="w-3 h-3 text-muted-foreground" />
                          <span className="text-muted-foreground">Coordinates:</span>
                          <span className="ml-1">{project.latitude && project.longitude ? `${project.latitude}, ${project.longitude}` : "—"}</span>
                        </div>
                        {project.projectUrl && (
                          <div>
                            <span className="text-muted-foreground">Project URL:</span>
                            <a href={project.projectUrl} target="_blank" rel="noopener noreferrer" className="ml-1 text-primary hover:underline inline-flex items-center gap-1" data-testid={`link-project-url-${project.id}`}>
                              View <ExternalLink className="w-3 h-3" />
                            </a>
                          </div>
                        )}
                        {project.publicUrl && (
                          <div>
                            <span className="text-muted-foreground">Public URL:</span>
                            <a href={project.publicUrl} target="_blank" rel="noopener noreferrer" className="ml-1 text-primary hover:underline inline-flex items-center gap-1" data-testid={`link-public-url-${project.id}`}>
                              View <ExternalLink className="w-3 h-3" />
                            </a>
                          </div>
                        )}
                        <div>
                          <span className="text-muted-foreground">Notepad:</span>
                          <span className="ml-1">
                            {project.notepad 
                              ? project.notepad
                                  .replace(/<br\s*\/?>/gi, '\n')
                                  .replace(/<[^>]*>/g, '')
                                  .split('\n')
                                  .map((line, i) => (
                                    <span key={i}>{line}{i < project.notepad!.split('<br').length - 1 && <br />}</span>
                                  ))
                              : "—"}
                          </span>
                        </div>
                        {project.featureImageUrl && (
                          <div><span className="text-muted-foreground">Feature Image:</span> <span className="ml-1 text-xs font-mono truncate">{project.featureImageUrl}</span></div>
                        )}
                        <div><span className="text-muted-foreground">Created:</span> <span className="ml-1">{project.companycamCreatedAt ? format(new Date(project.companycamCreatedAt), "MMM d, yyyy") : "—"}</span></div>
                        <div><span className="text-muted-foreground">Updated:</span> <span className="ml-1">{project.companycamUpdatedAt ? format(new Date(project.companycamUpdatedAt), "MMM d, yyyy") : "—"}</span></div>
                        <div><span className="text-muted-foreground">Last Synced:</span> <span className="ml-1">{project.lastSyncedAt ? format(new Date(project.lastSyncedAt), "MMM d, h:mm a") : "—"}</span></div>
                      </div>
                      {!!project.integrations && (
                        <details className="text-xs">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Procore Integrations</summary>
                          <ScrollArea className="h-24 mt-1 rounded border bg-card p-2">
                            <pre className="font-mono whitespace-pre-wrap">{String(JSON.stringify(project.integrations, null, 2))}</pre>
                          </ScrollArea>
                        </details>
                      )}
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

  const { data, isLoading, refetch } = useQuery<{ data: CompanycamUser[]; total: number }>({
    queryKey: [`/api/companycam/users?${params.toString()}`],
  });

  const toggleExpand = (id: number) => {
    const next = new Set(expandedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpandedIds(next);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
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
                data-testid="input-search-companycam-users"
              />
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-companycam-users">
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : !data?.data?.length ? (
          <p className="text-sm text-muted-foreground py-12 text-center">No users found. Run a CompanyCam sync to pull data.</p>
        ) : (
          <>
            <div className="rounded-lg border">
              <div className="grid grid-cols-[1fr_1fr_150px_100px_80px_40px] gap-3 px-4 py-2.5 bg-muted/50 text-xs font-medium text-muted-foreground border-b">
                <span>Name</span>
                <span>Email</span>
                <span>Phone</span>
                <span>Role</span>
                <span>Status</span>
                <span className="w-8"></span>
              </div>
              {data.data.map((user) => (
                <Collapsible key={user.id} open={expandedIds.has(user.id)} onOpenChange={() => toggleExpand(user.id)}>
                  <CollapsibleTrigger className="w-full" data-testid={`companycam-user-row-${user.id}`}>
                    <div className="grid grid-cols-[1fr_1fr_150px_100px_80px_40px] gap-3 px-4 py-3 text-sm hover:bg-muted/30 transition-colors items-center border-b last:border-0">
                      <span className="font-medium truncate text-left">{[user.firstName, user.lastName].filter(Boolean).join(" ") || "—"}</span>
                      <span className="text-muted-foreground truncate text-left">{user.email || "—"}</span>
                      <span className="text-muted-foreground truncate text-left">{user.phoneNumber || "—"}</span>
                      <span className="text-muted-foreground truncate text-left">{user.userRole || "—"}</span>
                      <span className="text-left">
                        <Badge variant={user.status === "active" ? "secondary" : "outline"} className="text-xs">
                          {user.status || "—"}
                        </Badge>
                      </span>
                      <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${expandedIds.has(user.id) ? "rotate-180" : ""}`} />
                    </div>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="px-4 py-3 bg-muted/10 border-b space-y-2">
                      <div className="grid grid-cols-3 gap-4 text-sm">
                        <div><span className="text-muted-foreground">CompanyCam ID:</span> <span className="font-mono text-xs ml-1">{user.companycamId}</span></div>
                        {user.userUrl && (
                          <div>
                            <span className="text-muted-foreground">User URL:</span>
                            <a href={user.userUrl} target="_blank" rel="noopener noreferrer" className="ml-1 text-primary hover:underline inline-flex items-center gap-1" data-testid={`link-user-url-${user.id}`}>
                              View <ExternalLink className="w-3 h-3" />
                            </a>
                          </div>
                        )}
                        {!!user.profileImage && (
                          <div><span className="text-muted-foreground">Profile Image:</span> <span className="ml-1 text-xs font-mono">{String(JSON.stringify(user.profileImage))}</span></div>
                        )}
                        <div><span className="text-muted-foreground">Created:</span> <span className="ml-1">{user.companycamCreatedAt ? format(new Date(user.companycamCreatedAt), "MMM d, yyyy") : "—"}</span></div>
                        <div><span className="text-muted-foreground">Updated:</span> <span className="ml-1">{user.companycamUpdatedAt ? format(new Date(user.companycamUpdatedAt), "MMM d, yyyy") : "—"}</span></div>
                        <div><span className="text-muted-foreground">Last Synced:</span> <span className="ml-1">{user.lastSyncedAt ? format(new Date(user.lastSyncedAt), "MMM d, h:mm a") : "—"}</span></div>
                      </div>
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

function PhotosTab() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const limit = 50;

  const params = new URLSearchParams();
  if (search) params.set("search", search);
  params.set("limit", String(limit));
  params.set("offset", String(page * limit));

  const { data, isLoading, refetch } = useQuery<{ data: CompanycamPhoto[]; total: number }>({
    queryKey: [`/api/companycam/photos?${params.toString()}`],
  });

  const toggleExpand = (id: number) => {
    const next = new Set(expandedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpandedIds(next);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Image className="w-4 h-4" />
            Photos
            {data && <span className="text-xs font-normal text-muted-foreground">({data.total.toLocaleString()} total)</span>}
          </CardTitle>
          <div className="flex gap-2 items-center">
            <div className="relative">
              <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                placeholder="Search photos..."
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                className="h-8 w-[200px] pl-8 text-sm"
                data-testid="input-search-companycam-photos"
              />
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-companycam-photos">
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : !data?.data?.length ? (
          <p className="text-sm text-muted-foreground py-12 text-center">No photos found. Run a CompanyCam sync to pull data.</p>
        ) : (
          <>
            <div className="rounded-lg border">
              <div className="grid grid-cols-[1fr_150px_1fr_150px_80px_40px] gap-3 px-4 py-2.5 bg-muted/50 text-xs font-medium text-muted-foreground border-b">
                <span>Project</span>
                <span>Creator</span>
                <span>Description</span>
                <span>Captured</span>
                <span>Status</span>
                <span className="w-8"></span>
              </div>
              {data.data.map((photo) => (
                <Collapsible key={photo.id} open={expandedIds.has(photo.id)} onOpenChange={() => toggleExpand(photo.id)}>
                  <CollapsibleTrigger className="w-full" data-testid={`companycam-photo-row-${photo.id}`}>
                    <div className="grid grid-cols-[1fr_150px_1fr_150px_80px_40px] gap-3 px-4 py-3 text-sm hover:bg-muted/30 transition-colors items-center border-b last:border-0">
                      <span className="font-medium truncate text-left">{photo.projectName || "—"}</span>
                      <span className="text-muted-foreground truncate text-left">{photo.creatorName || "—"}</span>
                      <span className="text-muted-foreground truncate text-left">{photo.description || "—"}</span>
                      <span className="text-muted-foreground text-left">{photo.capturedAt ? format(new Date(photo.capturedAt), "MMM d, yyyy") : "—"}</span>
                      <span className="text-left">
                        <Badge variant="secondary" className="text-xs">{photo.status || "—"}</Badge>
                      </span>
                      <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${expandedIds.has(photo.id) ? "rotate-180" : ""}`} />
                    </div>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="px-4 py-3 bg-muted/10 border-b space-y-2">
                      {photo.thumbnailUrl && (
                        <div className="mb-2">
                          <img
                            src={photo.thumbnailUrl}
                            alt={photo.description || "Photo thumbnail"}
                            className="rounded-lg border max-h-48 object-contain"
                            data-testid={`img-photo-thumbnail-${photo.id}`}
                          />
                        </div>
                      )}
                      <div className="grid grid-cols-3 gap-4 text-sm">
                        <div><span className="text-muted-foreground">CompanyCam ID:</span> <span className="font-mono text-xs ml-1">{photo.companycamId}</span></div>
                        <div className="flex items-center gap-1">
                          <MapPin className="w-3 h-3 text-muted-foreground" />
                          <span className="text-muted-foreground">Coordinates:</span>
                          <span className="ml-1">{photo.latitude && photo.longitude ? `${photo.latitude}, ${photo.longitude}` : "—"}</span>
                        </div>
                        {photo.photoUrl && (
                          <div>
                            <span className="text-muted-foreground">Photo URL:</span>
                            <a href={photo.photoUrl} target="_blank" rel="noopener noreferrer" className="ml-1 text-primary hover:underline inline-flex items-center gap-1" data-testid={`link-photo-url-${photo.id}`}>
                              View <ExternalLink className="w-3 h-3" />
                            </a>
                          </div>
                        )}
                        {photo.webUrl && (
                          <div>
                            <span className="text-muted-foreground">Web URL:</span>
                            <a href={photo.webUrl} target="_blank" rel="noopener noreferrer" className="ml-1 text-primary hover:underline inline-flex items-center gap-1">
                              View <ExternalLink className="w-3 h-3" />
                            </a>
                          </div>
                        )}
                        {photo.originalUrl && (
                          <div>
                            <span className="text-muted-foreground">Original URL:</span>
                            <a href={photo.originalUrl} target="_blank" rel="noopener noreferrer" className="ml-1 text-primary hover:underline inline-flex items-center gap-1">
                              View <ExternalLink className="w-3 h-3" />
                            </a>
                          </div>
                        )}
                        <div><span className="text-muted-foreground">Created:</span> <span className="ml-1">{photo.companycamCreatedAt ? format(new Date(photo.companycamCreatedAt), "MMM d, yyyy") : "—"}</span></div>
                        <div><span className="text-muted-foreground">Updated:</span> <span className="ml-1">{photo.companycamUpdatedAt ? format(new Date(photo.companycamUpdatedAt), "MMM d, yyyy") : "—"}</span></div>
                        <div><span className="text-muted-foreground">Last Synced:</span> <span className="ml-1">{photo.lastSyncedAt ? format(new Date(photo.lastSyncedAt), "MMM d, h:mm a") : "—"}</span></div>
                      </div>
                      {!!(photo.tags && Array.isArray(photo.tags) && (photo.tags as any[]).length > 0) && (
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs text-muted-foreground">Tags:</span>
                          {(photo.tags as any[]).map((tag: any, idx: number) => {
                            const label: string = tag.display_value || tag.value || String(tag);
                            return (
                              <Badge key={idx} variant="outline" className="text-xs">
                                {label}
                              </Badge>
                            );
                          })}
                        </div>
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

  const { data, isLoading, refetch } = useQuery<{ data: CompanycamChangeHistory[]; total: number }>({
    queryKey: [`/api/companycam/change-history?${params.toString()}`],
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
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <History className="w-4 h-4" />
            Change History
            {data && <span className="text-xs font-normal text-muted-foreground">({data.total.toLocaleString()} total, 2-week rolling window)</span>}
          </CardTitle>
          <div className="flex gap-2 items-center">
            <Select value={entityTypeFilter} onValueChange={(v) => { setEntityTypeFilter(v); setPage(0); }}>
              <SelectTrigger className="w-[130px] h-8" data-testid="filter-companycam-history-entity">
                <SelectValue placeholder="Entity Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                <SelectItem value="project">Projects</SelectItem>
                <SelectItem value="user">Users</SelectItem>
                <SelectItem value="photo">Photos</SelectItem>
              </SelectContent>
            </Select>
            <Select value={changeTypeFilter} onValueChange={(v) => { setChangeTypeFilter(v); setPage(0); }}>
              <SelectTrigger className="w-[130px] h-8" data-testid="filter-companycam-history-change">
                <SelectValue placeholder="Change Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Changes</SelectItem>
                <SelectItem value="created">Created</SelectItem>
                <SelectItem value="updated">Updated</SelectItem>
                <SelectItem value="field_changed">Field Changed</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-companycam-history">
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : !data?.data?.length ? (
          <p className="text-sm text-muted-foreground py-12 text-center">No change history yet. Changes are recorded automatically during each CompanyCam sync.</p>
        ) : (
          <>
            <div className="space-y-1">
              {data.data.map((entry) => (
                <Collapsible key={entry.id} open={expandedIds.has(entry.id)} onOpenChange={() => toggleExpand(entry.id)}>
                  <CollapsibleTrigger className="w-full" data-testid={`companycam-history-row-${entry.id}`}>
                    <div className="flex items-center justify-between py-2.5 px-3 rounded-lg hover:bg-muted/30 transition-colors text-left">
                      <div className="flex items-center gap-3 flex-1">
                        <ChangeTypeDot type={entry.changeType} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium">
                            {entry.entityType} #{entry.entityCompanycamId}
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
                        <div><span className="text-muted-foreground">CompanyCam ID:</span> <span className="ml-1 font-mono text-xs">{entry.entityCompanycamId}</span></div>
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
        <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)} data-testid="button-prev-page">
          Previous
        </Button>
        <Button variant="outline" size="sm" disabled={(page + 1) * limit >= total} onClick={() => setPage(page + 1)} data-testid="button-next-page">
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
