import { useState, useEffect } from "react";
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
  Archive,
  Cloud,
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
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface Project {
  id: string;
  name: string;
  status: string;
  stage?: string;
}

interface ArchiveProgress {
  projectId: string;
  projectName: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  progress: number;
  currentStep: string;
  totalFiles: number;
  filesUploaded: number;
  errors: string[];
  startedAt: string;
  completedAt?: string;
  sharePointUrl?: string;
}

interface DocumentSummary {
  folders: number;
  drawings: number;
  submittals: number;
  rfis: number;
  bidPackages: number;
  photos: number;
  hasBudget: boolean;
}

export default function ProjectArchivePage() {
  const { toast } = useToast();
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [activeArchiveId, setActiveArchiveId] = useState<string | null>(null);

  const { data: sharePointStatus, isLoading: statusLoading } = useQuery<{
    connected: boolean;
    microsoftConnected: boolean;
    email?: string;
    config?: { siteUrl?: string; siteName?: string; documentLibrary?: string };
  }>({
    queryKey: ["/api/archive/sharepoint/status"],
  });

  const { data: projects, isLoading: projectsLoading } = useQuery<Project[]>({
    queryKey: ["/api/archive/projects"],
    enabled: !!sharePointStatus?.connected,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-archive-title">
            Project Archive
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Extract and archive completed project documents to SharePoint
          </p>
        </div>
        <div className="flex items-center gap-3">
          {statusLoading ? (
            <Skeleton className="h-8 w-32" />
          ) : (
            <Badge
              variant={sharePointStatus?.connected ? "default" : "destructive"}
              className="gap-1"
            >
              {sharePointStatus?.connected ? (
                <CheckCircle className="w-3 h-3" />
              ) : (
                <AlertCircle className="w-3 h-3" />
              )}
              {sharePointStatus?.connected ? "SharePoint Connected" : "SharePoint Not Connected"}
            </Badge>
          )}
        </div>
      </div>

      {!sharePointStatus?.connected ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Cloud className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">SharePoint Configuration Required</h3>
            <p className="text-muted-foreground mb-4">
              {!sharePointStatus?.microsoftConnected 
                ? "Connect your Microsoft 365 account in Settings first, then configure SharePoint."
                : "Configure SharePoint site in Settings to enable project archiving."
              }
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
              {projectsLoading ? (
                <Skeleton className="h-40 w-full" />
              ) : !projects || projects.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No projects found. Make sure Procore is connected.
                </p>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                    {projects.slice(0, 12).map((project) => (
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
                        <div className="flex items-center gap-2 mt-1">
                          <Badge variant="outline" className="text-xs">
                            {project.status}
                          </Badge>
                          {project.stage && (
                            <Badge variant="secondary" className="text-xs">
                              {project.stage}
                            </Badge>
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                  {projects.length > 12 && (
                    <p className="text-xs text-muted-foreground text-center">
                      Showing 12 of {projects.length} projects
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
            />
          )}
        </>
      )}

      <ArchiveDialog
        open={archiveDialogOpen}
        onOpenChange={setArchiveDialogOpen}
        project={selectedProject}
        onStartArchive={(archiveId) => {
          setActiveArchiveId(archiveId);
          setArchiveDialogOpen(false);
        }}
      />
    </div>
  );
}

function ArchiveDialog({
  open,
  onOpenChange,
  project,
  onStartArchive,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: Project | null;
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
    baseFolderPath: "T-Rock Projects",
  });

  const { data: summary, isLoading: summaryLoading } = useQuery<DocumentSummary>({
    queryKey: ["/api/archive/project", project?.id, "summary"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/archive/project/${project?.id}/summary`);
      return res.json();
    },
    enabled: !!project?.id && open,
  });

  const startMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/archive/start", {
        projectId: project?.id,
        options,
      });
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Archive started" });
      onStartArchive(data.archiveId);
    },
    onError: (e: Error) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  if (!project) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Archive className="w-5 h-5" />
            Archive Project
          </DialogTitle>
          <DialogDescription>
            Extract documents from Procore and upload to SharePoint.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="p-3 rounded-lg bg-muted/50 border">
            <p className="font-medium text-sm">{project.name}</p>
            <p className="text-xs text-muted-foreground">ID: {project.id}</p>
          </div>

          {summaryLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : summary ? (
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="p-2 rounded bg-muted/30 text-center">
                <FolderOpen className="w-4 h-4 mx-auto mb-1 text-muted-foreground" />
                <p className="font-medium">{summary.folders}</p>
                <p className="text-muted-foreground">Folders</p>
              </div>
              <div className="p-2 rounded bg-muted/30 text-center">
                <FileText className="w-4 h-4 mx-auto mb-1 text-muted-foreground" />
                <p className="font-medium">{summary.drawings}</p>
                <p className="text-muted-foreground">Drawings</p>
              </div>
              <div className="p-2 rounded bg-muted/30 text-center">
                <FileText className="w-4 h-4 mx-auto mb-1 text-muted-foreground" />
                <p className="font-medium">{summary.submittals}</p>
                <p className="text-muted-foreground">Submittals</p>
              </div>
              <div className="p-2 rounded bg-muted/30 text-center">
                <FileText className="w-4 h-4 mx-auto mb-1 text-muted-foreground" />
                <p className="font-medium">{summary.rfis}</p>
                <p className="text-muted-foreground">RFIs</p>
              </div>
              <div className="p-2 rounded bg-muted/30 text-center">
                <Image className="w-4 h-4 mx-auto mb-1 text-muted-foreground" />
                <p className="font-medium">{summary.photos}</p>
                <p className="text-muted-foreground">Photos</p>
              </div>
              <div className="p-2 rounded bg-muted/30 text-center">
                <FileSpreadsheet className="w-4 h-4 mx-auto mb-1 text-muted-foreground" />
                <p className="font-medium">{summary.hasBudget ? "Yes" : "No"}</p>
                <p className="text-muted-foreground">Budget</p>
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
                    checked={(options as any)[key]}
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
              SharePoint Base Folder:
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

function ArchiveProgressCard({
  archiveId,
  onComplete,
}: {
  archiveId: string;
  onComplete: () => void;
}) {
  const [pollInterval, setPollInterval] = useState(2000);

  const { data: progress, isLoading } = useQuery<ArchiveProgress>({
    queryKey: ["/api/archive/progress", archiveId],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/archive/progress/${archiveId}`);
      return res.json();
    },
    refetchInterval: progress?.status === "completed" || progress?.status === "failed" ? false : pollInterval,
  });

  useEffect(() => {
    if (progress?.status === "completed" || progress?.status === "failed") {
      setPollInterval(0);
    }
  }, [progress?.status]);

  if (isLoading || !progress) {
    return <Skeleton className="h-40 w-full" />;
  }

  const isComplete = progress.status === "completed";
  const isFailed = progress.status === "failed";

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
            <span>{progress.filesUploaded} / {progress.totalFiles} files</span>
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

        {isComplete && progress.sharePointUrl && (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" asChild>
              <a href={progress.sharePointUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="w-3 h-3 mr-1" />
                Open in SharePoint
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
