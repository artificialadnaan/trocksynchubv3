import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
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
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Archive,
  Cloud,
  HardDrive,
  FolderArchive,
  FileText,
  Image,
  FileSpreadsheet,
  FolderOpen,
  Loader2,
  CheckCircle,
  XCircle,
  AlertCircle,
  ExternalLink,
  RefreshCw,
  Info,
  Search,
} from "lucide-react";
import { format, formatDistanceToNow, formatDistance } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Project {
  id: string;
  name: string;
  status: string;
  stage?: string;
}

interface ArchiveProgress {
  archiveId: string;
  projectId: string;
  projectName: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  progress: number;
  currentStep: string;
  totalFiles: number;
  filesUploaded: number;
  errors: string[];
  startedAt: string;
  completedAt?: string;
  storageUrl?: string;
  providerType?: string;
}

interface ArchivePreview {
  projectId: string;
  projectName: string;
  folderStructure: string[];
  fileCounts: {
    documents: number;
    drawings: number;
    submittals: number;
    rfis: number;
    bidPackages: number;
    photos: number;
    budget: number;
    total: number;
  };
}

interface StorageConfig {
  activeProvider: "google-drive" | "sharepoint" | "local";
  archiveBaseFolderName: string;
  autoArchive?: {
    enabled: boolean;
    triggerStage: string;
  };
}

interface TestResult {
  connected: boolean;
  provider: string;
  details?: Record<string, string>;
  error?: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  "google-drive": "Google Drive",
  sharepoint: "SharePoint",
  local: "Local Storage",
};

function getStageBadgeStyle(stage: string | undefined): string {
  if (!stage) return "bg-secondary text-secondary-foreground";
  const s = stage.toLowerCase();
  if (s.includes("estimating")) return "bg-blue-500/10 text-blue-700 border-blue-500/20";
  if (s.includes("pre-construction") || s.includes("preconstruction")) return "bg-purple-500/10 text-purple-700 border-purple-500/20";
  if (s.includes("active")) return "bg-green-500/10 text-green-700 border-green-500/20";
  if (s.includes("closeout")) return "bg-amber-500/10 text-amber-700 border-amber-500/20";
  if (s.includes("complete")) return "bg-muted text-muted-foreground";
  return "bg-secondary text-secondary-foreground";
}

function getProviderIcon(provider: string | undefined) {
  switch (provider) {
    case "google-drive":
      return <Cloud className="w-3 h-3" />;
    case "sharepoint":
      return <FolderArchive className="w-3 h-3" />;
    case "local":
      return <HardDrive className="w-3 h-3" />;
    default:
      return <Cloud className="w-3 h-3" />;
  }
}

function getStorageLinkLabel(provider: string | undefined): string {
  switch (provider) {
    case "google-drive":
      return "Open in Google Drive";
    case "sharepoint":
      return "Open in SharePoint";
    case "local":
      return "Open Folder";
    default:
      return "Open in Storage";
  }
}

function getBaseFolderLabel(provider: string | undefined): string {
  switch (provider) {
    case "google-drive":
      return "Google Drive Base Folder";
    case "sharepoint":
      return "SharePoint Base Folder";
    case "local":
      return "Local Output Folder";
    default:
      return "Base Folder";
  }
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function ProjectArchivePage() {
  const { toast } = useToast();
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [activeArchiveId, setActiveArchiveId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState<string>("all");

  const { data: storageConfig } = useQuery<StorageConfig>({
    queryKey: ["/api/settings/storage"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/settings/storage");
      return res.json();
    },
  });

  const { data: testResult } = useQuery<TestResult>({
    queryKey: ["/api/settings/storage/test"],
    queryFn: async () => {
      const res = await apiRequest("POST", "/api/settings/storage/test");
      return res.json();
    },
    staleTime: 60000,
    enabled: !!storageConfig?.activeProvider,
  });

  // Derive connection status from storage config + test
  const storageConnected = testResult?.connected ?? false;
  const activeProvider = storageConfig?.activeProvider ?? "sharepoint";

  const { data: projects, isLoading: projectsLoading } = useQuery<Project[]>({
    queryKey: ["/api/archive/projects"],
    enabled: storageConnected,
  });

  const filteredProjects = useMemo(() => {
    if (!projects) return [];
    let list = projects;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((p) => p.name.toLowerCase().includes(q));
    }
    if (stageFilter && stageFilter !== "all") {
      list = list.filter((p) => (p.stage ?? "").toLowerCase() === stageFilter.toLowerCase());
    }
    return list;
  }, [projects, search, stageFilter]);

  const stageOptions = useMemo(() => {
    const stages = new Set<string>();
    projects?.forEach((p) => {
      if (p.stage) stages.add(p.stage);
    });
    return Array.from(stages).sort();
  }, [projects]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-archive-title">
            Project Archive
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Extract and archive completed project documents to {PROVIDER_LABELS[activeProvider] ?? "storage"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Badge
            variant={storageConnected ? "default" : "destructive"}
            className="gap-1"
          >
            {storageConnected ? (
              <>
                {getProviderIcon(activeProvider)}
                <CheckCircle className="w-3 h-3" />
                {PROVIDER_LABELS[activeProvider]} Connected
              </>
            ) : (
              <>
                <AlertCircle className="w-3 h-3" />
                Storage Not Connected
              </>
            )}
          </Badge>
        </div>
      </div>

      {storageConfig?.autoArchive?.enabled && (
        <div className="rounded-lg border bg-blue-500/10 border-blue-500/20 text-blue-700 px-4 py-3 flex items-center gap-2 text-sm">
          <Info className="w-4 h-4 shrink-0" />
          <span>
            Auto-archive enabled — projects will be archived automatically when they reach the &quot;{storageConfig.autoArchive.triggerStage}&quot; stage
          </span>
        </div>
      )}

      {!storageConnected ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Cloud className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">Storage Provider Not Connected</h3>
            <p className="text-muted-foreground mb-4">
              {activeProvider === "google-drive"
                ? "Configure Google Drive credentials in Settings (Storage) to enable project archiving."
                : activeProvider === "sharepoint"
                  ? "Connect your Microsoft 365 account and configure SharePoint in Settings to enable project archiving."
                  : "Configure storage in Settings to enable project archiving."}
            </p>
            <Button asChild>
              <a href="/#/settings">Go to Settings</a>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Archive className="w-4 h-4" />
                Select Project to Archive
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2 mb-4">
                <div className="relative flex-1 min-w-[200px]">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search projects by name..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="pl-8"
                  />
                </div>
                <Select value={stageFilter} onValueChange={setStageFilter}>
                  <SelectTrigger className="w-[180px]">
                    <SelectValue placeholder="Filter by stage" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All stages</SelectItem>
                    {stageOptions.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {projectsLoading ? (
                <Skeleton className="h-40 w-full" />
              ) : !projects || projects.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No projects found. Make sure Procore is connected.
                </p>
              ) : filteredProjects.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No projects match your filters.
                </p>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                    {filteredProjects.slice(0, 24).map((project) => (
                      <button
                        key={project.id}
                        onClick={() => {
                          setSelectedProject(project);
                          setArchiveDialogOpen(true);
                        }}
                        className={`p-4 rounded-lg border text-left transition-colors hover:bg-muted/50 ${
                          selectedProject?.id === project.id ? "border-primary bg-primary/5" : ""
                        }`}
                        data-testid={`project-${project.id}`}
                      >
                        <p className="font-medium text-sm truncate">{project.name}</p>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          <Badge variant="outline" className="text-xs">
                            {project.status}
                          </Badge>
                          {project.stage && (
                            <Badge
                              variant="outline"
                              className={`text-xs ${getStageBadgeStyle(project.stage)}`}
                            >
                              {project.stage}
                            </Badge>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                  {filteredProjects.length > 24 && (
                    <p className="text-xs text-muted-foreground text-center">
                      Showing 24 of {filteredProjects.length} projects
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {activeArchiveId && (
            <ArchiveProgressCard
              archiveId={activeArchiveId}
              onComplete={() => setActiveArchiveId(null)}
              providerType={undefined}
            />
          )}

          <ArchiveHistorySection
            activeArchiveId={activeArchiveId}
            onSelectArchive={(id) => setActiveArchiveId(id)}
          />
        </>
      )}

      <ArchiveDialog
        open={archiveDialogOpen}
        onOpenChange={setArchiveDialogOpen}
        project={selectedProject}
        activeProvider={activeProvider}
        baseFolderName={storageConfig?.archiveBaseFolderName ?? "T-Rock Projects"}
        onStartArchive={(archiveId) => {
          setActiveArchiveId(archiveId);
          setArchiveDialogOpen(false);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Archive Dialog
// ---------------------------------------------------------------------------

function ArchiveDialog({
  open,
  onOpenChange,
  project,
  activeProvider,
  baseFolderName,
  onStartArchive,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project | null;
  activeProvider: string;
  baseFolderName: string;
  onStartArchive: (archiveId: string) => void;
}) {
  const { toast } = useToast();
  const [options, setOptions] = useState({
    includeDocuments: true,
    includeDrawings: true,
    includeSubmittals: true,
    includeRFIs: true,
    includeBidPackages: true,
    includePhotos: true,
    includeBudget: true,
    baseFolderPath: baseFolderName,
  });

  useEffect(() => {
    setOptions((prev) => ({ ...prev, baseFolderPath: baseFolderName }));
  }, [baseFolderName]);

  const previewParams = useMemo(() => {
    const p = new URLSearchParams();
    p.set("includeDocuments", String(options.includeDocuments));
    p.set("includeDrawings", String(options.includeDrawings));
    p.set("includeSubmittals", String(options.includeSubmittals));
    p.set("includeRFIs", String(options.includeRFIs));
    p.set("includeBidPackages", String(options.includeBidPackages));
    p.set("includePhotos", String(options.includePhotos));
    p.set("includeBudget", String(options.includeBudget));
    return p.toString();
  }, [options]);

  const { data: preview, isLoading: previewLoading } = useQuery<ArchivePreview>({
    queryKey: ["/api/archive/projects", project?.id, "preview", previewParams],
    queryFn: async () => {
      const url = `/api/archive/projects/${project?.id}/preview${previewParams ? `?${previewParams}` : ""}`;
      const res = await apiRequest("GET", url);
      return res.json();
    },
    enabled: !!project?.id && open,
  });

  const startMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/archive/start", {
        projectId: project?.id,
        options: {
          includeDocuments: options.includeDocuments,
          includeDrawings: options.includeDrawings,
          includeSubmittals: options.includeSubmittals,
          includeRFIs: options.includeRFIs,
          includeBidPackages: options.includeBidPackages,
          includePhotos: options.includePhotos,
          includeBudget: options.includeBudget,
          baseFolderPath: options.baseFolderPath,
        },
      });
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Archive started" });
      queryClient.invalidateQueries({ queryKey: ["/api/archive/progress"] });
      onStartArchive(data.archiveId);
    },
    onError: (e: Error) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  if (!project) return null;

  const breakdown = preview?.fileCounts ?? {
    documents: 0,
    drawings: 0,
    submittals: 0,
    rfis: 0,
    bidPackages: 0,
    photos: 0,
    budget: 0,
    total: 0,
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Archive className="w-5 h-5" />
            Archive Project
          </DialogTitle>
          <DialogDescription>
            Extract documents from Procore and upload to {PROVIDER_LABELS[activeProvider] ?? "storage"}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="p-3 rounded-lg bg-muted/50 border">
            <p className="font-medium text-sm">{project.name}</p>
            <p className="text-xs text-muted-foreground">ID: {project.id}</p>
          </div>

          {previewLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : preview ? (
            <div className="space-y-3">
              <p className="text-sm font-medium">
                {breakdown.total} files total
              </p>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="p-2 rounded bg-muted/30 text-center">
                  <FolderOpen className="w-4 h-4 mx-auto mb-1 text-muted-foreground" />
                  <p className="font-medium">{breakdown.documents}</p>
                  <p className="text-muted-foreground">Documents</p>
                </div>
                <div className="p-2 rounded bg-muted/30 text-center">
                  <FileText className="w-4 h-4 mx-auto mb-1 text-muted-foreground" />
                  <p className="font-medium">{breakdown.drawings}</p>
                  <p className="text-muted-foreground">Drawings</p>
                </div>
                <div className="p-2 rounded bg-muted/30 text-center">
                  <FileText className="w-4 h-4 mx-auto mb-1 text-muted-foreground" />
                  <p className="font-medium">{breakdown.submittals}</p>
                  <p className="text-muted-foreground">Submittals</p>
                </div>
                <div className="p-2 rounded bg-muted/30 text-center">
                  <FileText className="w-4 h-4 mx-auto mb-1 text-muted-foreground" />
                  <p className="font-medium">{breakdown.rfis}</p>
                  <p className="text-muted-foreground">RFIs</p>
                </div>
                <div className="p-2 rounded bg-muted/30 text-center">
                  <FileText className="w-4 h-4 mx-auto mb-1 text-muted-foreground" />
                  <p className="font-medium">{breakdown.bidPackages}</p>
                  <p className="text-muted-foreground">Bid Packages</p>
                </div>
                <div className="p-2 rounded bg-muted/30 text-center">
                  <Image className="w-4 h-4 mx-auto mb-1 text-muted-foreground" />
                  <p className="font-medium">{breakdown.photos}</p>
                  <p className="text-muted-foreground">Photos</p>
                </div>
                <div className="p-2 rounded bg-muted/30 text-center">
                  <FileSpreadsheet className="w-4 h-4 mx-auto mb-1 text-muted-foreground" />
                  <p className="font-medium">{breakdown.budget}</p>
                  <p className="text-muted-foreground">Budget</p>
                </div>
              </div>
            </div>
          ) : null}

          <div className="space-y-3">
            <Label className="text-xs font-medium">Include in Archive:</Label>
            <div className="grid grid-cols-2 gap-2">
              {[
                { key: "includeDocuments", label: "Documents" },
                { key: "includeDrawings", label: "Drawings" },
                { key: "includeSubmittals", label: "Submittals" },
                { key: "includeRFIs", label: "RFIs" },
                { key: "includeBidPackages", label: "Bid Packages" },
                { key: "includePhotos", label: "Photos" },
                { key: "includeBudget", label: "Budget Data" },
              ].map(({ key, label }) => (
                <div key={key} className="flex items-center gap-2">
                  <Checkbox
                    id={key}
                    checked={options[key as keyof typeof options] as boolean}
                    onCheckedChange={(checked) =>
                      setOptions((prev) => ({ ...prev, [key]: !!checked }))
                    }
                  />
                  <Label htmlFor={key} className="text-xs cursor-pointer">
                    {label}
                  </Label>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="basePath" className="text-xs font-medium">
              {getBaseFolderLabel(activeProvider)}
            </Label>
            <Input
              id="basePath"
              value={options.baseFolderPath}
              onChange={(e) =>
                setOptions((prev) => ({ ...prev, baseFolderPath: e.target.value }))
              }
              placeholder="T-Rock Projects"
              className="h-8 text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Project will be archived to: {options.baseFolderPath}/{project.name}
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => startMutation.mutate()} disabled={startMutation.isPending}>
            {startMutation.isPending ? (
              <Loader2 className="w-4 h-4 mr-1 animate-spin" />
            ) : (
              <Archive className="w-4 h-4 mr-1" />
            )}
            Start Archive
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Archive Progress Card (current job)
// ---------------------------------------------------------------------------

function ArchiveProgressCard({
  archiveId,
  onComplete,
  providerType,
}: {
  archiveId: string;
  onComplete: () => void;
  providerType?: string;
}) {
  const { data: progress, isLoading } = useQuery<ArchiveProgress>({
    queryKey: ["/api/archive/progress", archiveId],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/archive/progress/${archiveId}`);
      return res.json();
    },
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "completed" || status === "failed" ? false : 2000;
    },
  });

  if (isLoading || !progress) {
    return <Skeleton className="h-40 w-full" />;
  }

  const isComplete = progress.status === "completed";
  const isFailed = progress.status === "failed";
  const provider = progress.providerType ?? providerType;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            {progress.status === "in_progress" && (
              <Loader2 className="w-4 h-4 animate-spin" />
            )}
            {isComplete && <CheckCircle className="w-4 h-4 text-green-500" />}
            {isFailed && <XCircle className="w-4 h-4 text-red-500" />}
            Archive Progress
          </CardTitle>
          <Badge
            variant={isComplete ? "default" : isFailed ? "destructive" : "secondary"}
            className={isComplete ? "bg-green-500/10 text-green-600" : ""}
          >
            {progress.status}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="font-medium text-sm">{progress.projectName || progress.projectId}</p>
          <p className="text-xs text-muted-foreground">{progress.currentStep}</p>
        </div>

        <div className="space-y-2">
          <div className="flex justify-between text-xs">
            <span>
              {progress.filesUploaded} / {progress.totalFiles} files
            </span>
            <span>{progress.progress}%</span>
          </div>
          <Progress value={progress.progress} className="h-2" />
        </div>

        {progress.errors.length > 0 && (
          <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20">
            <p className="text-xs font-medium text-red-600 mb-1">
              {progress.errors.length} errors
            </p>
            <ul className="text-xs text-red-600/80 list-disc list-inside max-h-20 overflow-y-auto">
              {progress.errors.slice(0, 5).map((error, i) => (
                <li key={i}>{error}</li>
              ))}
              {progress.errors.length > 5 && (
                <li>...and {progress.errors.length - 5} more</li>
              )}
            </ul>
          </div>
        )}

        {isComplete && progress.storageUrl && (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <a href={progress.storageUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="w-3 h-3 mr-1" />
                {getStorageLinkLabel(provider)}
              </a>
            </Button>
            <Button variant="ghost" size="sm" onClick={onComplete}>
              Dismiss
            </Button>
          </div>
        )}

        {isFailed && (
          <Button variant="ghost" size="sm" onClick={onComplete}>
            Dismiss
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Archive History Section
// ---------------------------------------------------------------------------

function ArchiveHistorySection({
  activeArchiveId,
  onSelectArchive,
}: {
  activeArchiveId: string | null;
  onSelectArchive: (archiveId: string) => void;
}) {
  const { data: progressList } = useQuery<ArchiveProgress[]>({
    queryKey: ["/api/archive/progress"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/archive/progress");
      return res.json();
    },
    refetchInterval: (query) => {
      const list = query.state.data ?? [];
      const hasActive = list.some(
        (p) => p.status === "pending" || p.status === "in_progress"
      );
      return hasActive ? 5000 : false;
    },
  });

  const list = progressList ?? [];
  if (list.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <RefreshCw className="w-4 h-4" />
          Archive History
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Past and current archive jobs
        </p>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Project</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Files</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list
              .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
              .map((p) => {
                const isActive = p.status === "pending" || p.status === "in_progress";
                const duration =
                  p.completedAt && p.startedAt
                    ? formatDistance(new Date(p.startedAt), new Date(p.completedAt), {
                        includeSeconds: true,
                      })
                    : null;
                return (
                  <TableRow key={p.archiveId}>
                    <TableCell className="font-medium text-sm">
                      {p.projectName || p.projectId}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="gap-1 text-xs">
                        {getProviderIcon(p.providerType)}
                        {PROVIDER_LABELS[p.providerType ?? ""] ?? p.providerType ?? "—"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          p.status === "completed"
                            ? "default"
                            : p.status === "failed"
                              ? "destructive"
                              : p.status === "in_progress"
                                ? "secondary"
                                : "outline"
                        }
                        className={
                          p.status === "completed"
                            ? "bg-green-500/10 text-green-600"
                            : p.status === "in_progress"
                              ? "bg-blue-500/10 text-blue-700"
                              : ""
                        }
                      >
                        {isActive && p.status === "in_progress" && (
                          <Loader2 className="w-3 h-3 mr-1 animate-spin inline" />
                        )}
                        {p.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {p.filesUploaded} / {p.totalFiles}
                      {p.errors.length > 0 && (
                        <span className="text-red-600 ml-1">({p.errors.length} err)</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDistanceToNow(new Date(p.startedAt), { addSuffix: true })}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {duration ?? "—"}
                    </TableCell>
                    <TableCell>
                      {p.storageUrl && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7"
                          asChild
                        >
                          <a
                            href={p.storageUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        </Button>
                      )}
                      {isActive && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7"
                          onClick={() => onSelectArchive(p.archiveId)}
                        >
                          View
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
