/**
 * Portfolio Automation Card — Settings & Run History
 * Manages portfolio automation, view runs, documents, and email reports.
 */

import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Download,
  FileSpreadsheet,
  FileText,
  Camera,
  Play,
  Mail,
  X,
} from "lucide-react";
import React, { useState, useEffect } from "react";

const DEFAULT_RECIPIENTS = [
  "sgibson@trockgc.com",
  "jhelms@trockgc.com",
  "bbell@trockgc.com",
  "adnaan.iqbal@gmail.com",
];

interface PortfolioRunStep {
  step: string;
  status: string;
  duration: number;
  error?: string;
  screenshotPath?: string;
  pageUrl?: string;
  diagnostics?: Record<string, unknown>;
}

interface PortfolioRun {
  id: string;
  projectId: string;
  projectName: string;
  startedAt: string;
  completedAt: string;
  status: "success" | "failed" | "partial";
  duration: number;
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  steps: PortfolioRunStep[];
}

interface PortfolioDocument {
  filename: string;
  type: "estimate-excel" | "proposal-pdf";
  createdAt: string;
  size: number;
  downloadUrl: string;
}

interface PortfolioConfig {
  enabled: boolean;
  emailConfig: {
    enabled: boolean;
    recipients: string[];
    frequency: string;
  };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getScreenshotFilename(path: string): string {
  const parts = path?.split(/[/\\]/) || [];
  return parts[parts.length - 1] || path;
}

export function PortfolioAutomationCard() {
  const { toast } = useToast();
  const [emailConfigOpen, setEmailConfigOpen] = useState(false);
  const [triggerInput, setTriggerInput] = useState("");
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [emailRecipients, setEmailRecipients] = useState<string[]>([]);
  const [emailRecipientInput, setEmailRecipientInput] = useState("");
  const [emailFrequency, setEmailFrequency] = useState("on_failure");

  const { data: config, isLoading } = useQuery<PortfolioConfig>({
    queryKey: ["/api/portfolio-automation/config"],
  });

  const { data: runsData, refetch: refetchRuns } = useQuery<{ runs: PortfolioRun[] }>({
    queryKey: ["/api/portfolio-automation/runs"],
  });

  const { data: docsData } = useQuery<{ documents: PortfolioDocument[] }>({
    queryKey: ["/api/portfolio-automation/documents"],
  });

  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (config) {
      setEnabled(config.enabled);
      setEmailEnabled(config.emailConfig?.enabled ?? false);
      setEmailRecipients(config.emailConfig?.recipients?.length ? config.emailConfig.recipients : DEFAULT_RECIPIENTS);
      setEmailFrequency(config.emailConfig?.frequency ?? "on_failure");
    }
  }, [config]);

  const saveConfig = useMutation({
    mutationFn: async (vars: { enabled?: boolean; emailConfig?: PortfolioConfig["emailConfig"] }) => {
      const res = await apiRequest("POST", "/api/portfolio-automation/config", vars);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/portfolio-automation/config"] });
      toast({ title: "Settings saved" });
    },
    onError: (e: Error) => {
      toast({ title: "Failed to save", description: e.message, variant: "destructive" });
    },
  });

  const triggerMutation = useMutation({
    mutationFn: async () => {
      const val = triggerInput.trim();
      const isProjectNumber = /^[A-Za-z0-9-]+$/.test(val) && (val.includes("-") || val.length > 10);
      const res = await apiRequest("POST", "/api/portfolio-automation/trigger", {
        projectNumber: isProjectNumber ? val : undefined,
        bidboardProjectId: !isProjectNumber && val ? val : undefined,
      });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Automation started", description: "Check Recent Runs for results." });
      setTriggerInput("");
      setTimeout(() => refetchRuns(), 3000);
    },
    onError: (e: Error) => {
      toast({ title: "Trigger failed", description: e.message, variant: "destructive" });
    },
  });

  const handleToggle = (val: boolean) => {
    setEnabled(val);
    saveConfig.mutate({ enabled: val });
  };

  const handleSaveEmailConfig = () => {
    saveConfig.mutate({
      emailConfig: {
        enabled: emailEnabled,
        recipients: emailRecipients,
        frequency: emailFrequency,
      },
    });
  };

  const addRecipient = () => {
    const email = emailRecipientInput.trim();
    if (email && email.includes("@") && !emailRecipients.includes(email)) {
      setEmailRecipients([...emailRecipients, email]);
      setEmailRecipientInput("");
    }
  };

  const runs = runsData?.runs ?? [];
  const documents = docsData?.documents ?? [];

  if (isLoading) return <Skeleton className="h-48" />;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Play className="w-4 h-4" />
            Portfolio Automation
          </CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {enabled ? (
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-green-500 inline-block animate-pulse" />
                  Active
                </span>
              ) : (
                "Off"
              )}
            </span>
            <Switch checked={enabled} onCheckedChange={handleToggle} />
          </div>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Automates Add to Portfolio, Send to Budget, Create Prime Contract, Document Upload, and Directory setup
          when a Bid Board project is sent to production.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        <div>
          <h4 className="text-sm font-medium mb-2">Recent Runs</h4>
          <div className="rounded-lg border overflow-hidden max-h-[320px] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  <TableHead className="w-8" />
                  <TableHead>Date/Time</TableHead>
                  <TableHead>Project Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Steps</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                      No runs yet
                    </TableCell>
                  </TableRow>
                ) : (
                  runs.map((run) => (
                    <PortfolioRunRow key={run.id} run={run} />
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>

        <Separator />

        <div>
          <h4 className="text-sm font-medium mb-2">Exported Documents</h4>
          {documents.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">No documents yet</p>
          ) : (
            <div className="space-y-2 max-h-40 overflow-y-auto">
              {documents.map((doc) => (
                <div
                  key={doc.filename}
                  className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
                >
                  <div className="flex items-center gap-2">
                    {doc.type === "estimate-excel" ? (
                      <FileSpreadsheet className="w-4 h-4 text-green-600" />
                    ) : (
                      <FileText className="w-4 h-4 text-red-600" />
                    )}
                    <span>{doc.filename}</span>
                    <span className="text-muted-foreground text-xs">
                      {new Date(doc.createdAt).toLocaleDateString()} · {formatFileSize(doc.size)}
                    </span>
                  </div>
                  <a href={doc.downloadUrl} download>
                    <Button variant="ghost" size="sm" className="h-8">
                      <Download className="w-3 h-3 mr-1" /> Download
                    </Button>
                  </a>
                </div>
              ))}
            </div>
          )}
        </div>

        <Collapsible open={emailConfigOpen} onOpenChange={setEmailConfigOpen}>
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="flex items-center gap-2 -ml-2 text-muted-foreground hover:text-foreground"
            >
              {emailConfigOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              <Mail className="w-4 h-4" />
              Email Report Configuration
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-4 space-y-4 rounded-lg border p-4 bg-muted/20">
              <div className="flex items-center justify-between">
                <Label>Enable email reports</Label>
                <Switch checked={emailEnabled} onCheckedChange={setEmailEnabled} />
              </div>
              <div>
                <Label className="text-xs">Report frequency</Label>
                <Select value={emailFrequency} onValueChange={setEmailFrequency}>
                  <SelectTrigger className="mt-1 w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="each_run">After each run</SelectItem>
                    <SelectItem value="daily">Daily summary</SelectItem>
                    <SelectItem value="weekly">Weekly summary</SelectItem>
                    <SelectItem value="on_failure">On failure only</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-xs">Recipients</Label>
                <div className="flex gap-2 mt-1">
                  <Input
                    type="email"
                    placeholder="email@example.com"
                    value={emailRecipientInput}
                    onChange={(e) => setEmailRecipientInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addRecipient())}
                  />
                  <Button type="button" size="sm" variant="outline" onClick={addRecipient}>
                    Add
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2 mt-2">
                  {emailRecipients.map((r) => (
                    <Badge
                      key={r}
                      variant="secondary"
                      className="pl-2 pr-1 py-1 gap-1 font-normal cursor-pointer hover:bg-destructive/10"
                      onClick={() => setEmailRecipients(emailRecipients.filter((x) => x !== r))}
                    >
                      {r}
                      <X className="w-3 h-3" />
                    </Badge>
                  ))}
                </div>
              </div>
              <Button size="sm" onClick={handleSaveEmailConfig} disabled={saveConfig.isPending}>
                {saveConfig.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
                Save
              </Button>
            </div>
          </CollapsibleContent>
        </Collapsible>

        <Separator />

        <div>
          <h4 className="text-sm font-medium mb-2">Manual Trigger</h4>
          <div className="flex gap-2">
            <Input
              placeholder="Bid Board Project ID or Project Number"
              value={triggerInput}
              onChange={(e) => setTriggerInput(e.target.value)}
              className="flex-1"
            />
            <Button
              onClick={() => triggerMutation.mutate()}
              disabled={!triggerInput.trim() || triggerMutation.isPending}
            >
              {triggerMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Play className="w-4 h-4 mr-1" />
              )}
              Run Portfolio Automation
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function PortfolioRunRow({ run }: { run: PortfolioRun }) {
  const [expanded, setExpanded] = useState(false);

  const statusBadgeClass =
    run.status === "success"
      ? "bg-green-100 text-green-800"
      : run.status === "failed"
      ? "bg-red-100 text-red-800"
      : "bg-yellow-100 text-yellow-800";

  const stepsSummary =
    run.failedSteps > 0
      ? `${run.completedSteps}/${run.totalSteps} steps completed`
      : `All ${run.totalSteps} steps completed`;

  return (
    <>
      <TableRow
        className="cursor-pointer hover:bg-muted/30"
        onClick={() => setExpanded(!expanded)}
      >
        <TableCell className="py-2 w-8">
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </TableCell>
        <TableCell className="py-2 text-sm">
          {new Date(run.startedAt).toLocaleString()}
        </TableCell>
        <TableCell className="py-2">{run.projectName || run.projectId}</TableCell>
        <TableCell className="py-2">
          <Badge variant="secondary" className={statusBadgeClass}>
            {run.status}
          </Badge>
        </TableCell>
        <TableCell className="py-2 text-muted-foreground">{formatDuration(run.duration)}</TableCell>
        <TableCell className="py-2 text-muted-foreground text-xs">{stepsSummary}</TableCell>
      </TableRow>
      {expanded && (
        <TableRow>
          <TableCell colSpan={5} className="p-0 bg-muted/5 border-b">
            <div className="p-4 space-y-4">
              <h5 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Step Details
              </h5>
              <div className="space-y-2">
                {run.steps.map((s, i) => (
                  <div key={i} className="flex items-start gap-3 text-sm">
                    <span
                      className={
                        s.status === "success"
                          ? "text-green-600"
                          : s.status === "failed"
                          ? "text-red-600"
                          : "text-gray-500"
                      }
                    >
                      {s.status === "success" ? "✓" : s.status === "failed" ? "✗" : "⊘"}
                    </span>
                    <div className="flex-1 min-w-0">
                      <span className="font-mono text-xs">{s.step}</span>
                      {s.duration > 0 && (
                        <span className="text-muted-foreground ml-2 text-xs">{formatDuration(s.duration)}</span>
                      )}
                      {s.error && (
                        <p className="text-red-600 text-xs mt-1">{s.error}</p>
                      )}
                      {s.pageUrl && (
                        <p className="text-muted-foreground text-xs truncate mt-0.5" title={s.pageUrl}>
                          {s.pageUrl}
                        </p>
                      )}
                      {s.screenshotPath && (
                        <a
                          href={`/api/portfolio-automation/screenshots/${encodeURIComponent(getScreenshotFilename(s.screenshotPath))}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline mt-1"
                        >
                          <Camera className="w-3 h-3" /> View screenshot
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {run.steps.some((s) => s.diagnostics && Object.keys(s.diagnostics || {}).length > 0) && (
                <div className="pt-2 border-t">
                  <h5 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Diagnostics
                  </h5>
                  <pre className="text-xs bg-muted/50 p-2 rounded overflow-x-auto max-h-32 overflow-y-auto">
                    {JSON.stringify(
                      run.steps
                        .filter((s) => s.diagnostics)
                        .map((s) => s.diagnostics)
                        .find((d) => d && Object.keys(d).length > 0),
                      null,
                      2
                    )}
                  </pre>
                </div>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
