/**
 * RFP Automation Card — Reporting & Email Summaries
 * Extends the RFP Automation settings with instant reports and scheduled emails.
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
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import {
  FileText,
  ChevronDown,
  ChevronRight,
  Loader2,
  Download,
  Mail,
  Clock,
  CheckCircle2,
  XCircle,
  AlertCircle,
  X,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import React, { useState, useMemo } from "react";

interface RfpReportRow {
  id: number;
  hubspotDealId: string;
  projectName: string;
  projectNumber: string;
  recipient: string;
  dateSent: string;
  bidboardStage: string;
  approvalStatus: string;
  changeCount: number;
}

interface ChangeLogEntry {
  id: string;
  fieldChanged: string;
  oldValue: string | null;
  newValue: string;
  changedBy: string | null;
  changedAt: string;
}

interface ApprovalEntry {
  approverEmail: string;
  status: "pending" | "approved" | "rejected";
  comments: string | null;
  decidedAt: string | null;
}

interface ScheduleConfig {
  id: string;
  enabled: boolean;
  frequency: string;
  dayOfWeek: number | null;
  timeOfDay: string;
  timezone: string;
  recipients: string[];
  includeRfpLog: boolean;
  includeChangeHistory: boolean;
  includeApprovalSummary: boolean;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const FREQUENCIES = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Biweekly" },
  { value: "monthly", label: "Monthly" },
];

const TIMEZONES = [
  "America/Chicago",
  "America/New_York",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
];

function NextRunDisplay({
  enabled,
  frequency,
  dayOfWeek,
  timeOfDay,
  timezone,
  recipients,
}: {
  enabled: boolean;
  frequency: string;
  dayOfWeek: number | null;
  timeOfDay: string;
  timezone: string;
  recipients: string[];
}) {
  const { data, isLoading } = useQuery<{ nextRun: string }>({
    queryKey: ["/api/reports/schedule/next-run", enabled, frequency, dayOfWeek ?? 1, timeOfDay, timezone, recipients.length],
    queryFn: async () => {
      const params = new URLSearchParams({
        enabled: String(enabled),
        frequency,
        dayOfWeek: String(dayOfWeek ?? 1),
        timeOfDay,
        timezone,
        recipients: recipients.join(","),
      });
      const res = await fetch(`/api/reports/schedule/next-run?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    enabled: true,
  });
  const nextRun = !enabled || !recipients.length ? "Not scheduled" : (isLoading ? "…" : data?.nextRun ?? "…");
  return (
    <div className="rounded-lg border shadow-sm p-3 flex items-center gap-2 text-sm bg-card">
      <Clock className="w-4 h-4 text-muted-foreground shrink-0" />
      <span className="text-muted-foreground">Next scheduled report:</span>
      <span className="font-medium">{nextRun}</span>
    </div>
  );
}

type SortKey = "projectName" | "projectNumber" | "recipient" | "dateSent" | "bidboardStage" | "approvalStatus" | "changeCount";
type SortDir = "asc" | "desc";

export function RfpAutomationCard() {
  const [reportOpen, setReportOpen] = useState(false);

  return (
    <Card className="shadow-sm rounded-lg border">
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <FileText className="w-4 h-4" />
          RFP Automation
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          RFP approval flow, reporting, and scheduled email summaries.
        </p>
        <Collapsible open={reportOpen} onOpenChange={setReportOpen}>
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="flex items-center gap-2 -ml-2 mt-2 w-fit text-muted-foreground hover:text-foreground"
            >
              {reportOpen ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
              Reporting & Email Summaries
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="pt-4 pb-4 border-t">
              <Tabs defaultValue="instant">
                <TabsList className="grid w-full grid-cols-2 mb-4">
                  <TabsTrigger value="instant">Instant Report</TabsTrigger>
                  <TabsTrigger value="schedule">Scheduled Emails</TabsTrigger>
                </TabsList>
                <TabsContent value="instant" className="mt-0">
                  <InstantReportTab />
                </TabsContent>
                <TabsContent value="schedule" className="mt-0">
                  <ScheduledEmailsTab />
                </TabsContent>
              </Tabs>
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      </CardHeader>
    </Card>
  );
}

function InstantReportTab() {
  const { toast } = useToast();
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [projectNumber, setProjectNumber] = useState("");
  const [status, setStatus] = useState("");
  const [recipient, setRecipient] = useState("");
  const [page, setPage] = useState(1);
  const [sortKey, setSortKey] = useState<SortKey>("dateSent");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const { data, isLoading } = useQuery<{ data: RfpReportRow[]; total: number }>({
    queryKey: [
      "/api/reports/rfps",
      dateFrom,
      dateTo,
      projectNumber,
      status,
      recipient,
      page,
    ],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);
      if (projectNumber) params.set("projectNumber", projectNumber);
      if (status) params.set("status", status);
      if (recipient) params.set("recipient", recipient);
      params.set("page", String(page));
      params.set("limit", "50");
      const res = await fetch(`/api/reports/rfps?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
  });

  const handleExport = async (format: "csv" | "pdf") => {
    const params = new URLSearchParams({
      format,
      ...(dateFrom && { dateFrom }),
      ...(dateTo && { dateTo }),
      ...(projectNumber && { projectNumber }),
      ...(status && { status }),
      ...(recipient && { recipient }),
    });
    const res = await fetch(`/api/reports/export?${params}`, { credentials: "include" });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      toast({ title: "Export failed", description: err?.message ?? String(res.status), variant: "destructive" });
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `rfp-report-${new Date().toISOString().slice(0, 10)}.${format === "pdf" ? "html" : "csv"}`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: `Exported as ${format.toUpperCase()}` });
  };

  const sortedData = useMemo(() => {
    const rows = data?.data ?? [];
    return [...rows].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "projectName":
          cmp = (a.projectName || "").localeCompare(b.projectName || "");
          break;
        case "projectNumber":
          cmp = (a.projectNumber || "").localeCompare(b.projectNumber || "");
          break;
        case "recipient":
          cmp = (a.recipient || "").localeCompare(b.recipient || "");
          break;
        case "dateSent":
          cmp = (a.dateSent || "").localeCompare(b.dateSent || "");
          break;
        case "bidboardStage":
          cmp = (a.bidboardStage || "").localeCompare(b.bidboardStage || "");
          break;
        case "approvalStatus":
          cmp = (a.approvalStatus || "").localeCompare(b.approvalStatus || "");
          break;
        case "changeCount":
          cmp = (a.changeCount || 0) - (b.changeCount || 0);
          break;
        default:
          return 0;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [data?.data, sortKey, sortDir]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const SortHeader = ({ id, children }: { id: SortKey; children: React.ReactNode }) => (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-3 h-8 data-[state=open]:bg-accent"
      onClick={() => toggleSort(id)}
    >
      {children}
      {sortKey === id ? (
        sortDir === "asc" ? (
          <ArrowUp className="ml-1 h-3.5 w-3.5" />
        ) : (
          <ArrowDown className="ml-1 h-3.5 w-3.5" />
        )
      ) : (
        <ArrowUpDown className="ml-1 h-3.5 w-3.5 opacity-50" />
      )}
    </Button>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 items-end">
        <div>
          <Label className="text-xs">From</Label>
          <Input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="h-8 w-36"
          />
        </div>
        <div>
          <Label className="text-xs">To</Label>
          <Input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="h-8 w-36"
          />
        </div>
        <div>
          <Label className="text-xs">Project #</Label>
          <Input
            placeholder="Search"
            value={projectNumber}
            onChange={(e) => setProjectNumber(e.target.value)}
            className="h-8 w-28"
          />
        </div>
        <div>
          <Label className="text-xs">Status</Label>
          <Select value={status || "all"} onValueChange={(v) => setStatus(v === "all" ? "" : v)}>
            <SelectTrigger className="h-8 w-32">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
              <SelectItem value="declined">Declined</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">Recipient</Label>
          <Input
            placeholder="Search"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            className="h-8 w-32"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8">
              <Download className="w-3 h-3 mr-1" /> Export
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onClick={() => handleExport("csv")}>
              Export CSV
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleExport("pdf")}>
              Export PDF
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="rounded-lg border overflow-hidden">
          <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50 hover:bg-muted/50">
                  <TableHead>
                    <SortHeader id="projectName">Project Name</SortHeader>
                  </TableHead>
                  <TableHead>
                    <SortHeader id="projectNumber">Project #</SortHeader>
                  </TableHead>
                  <TableHead>
                    <SortHeader id="recipient">Recipient</SortHeader>
                  </TableHead>
                  <TableHead>
                    <SortHeader id="dateSent">Date Sent</SortHeader>
                  </TableHead>
                  <TableHead>
                    <SortHeader id="bidboardStage">Bid Board Stage</SortHeader>
                  </TableHead>
                  <TableHead>
                    <SortHeader id="approvalStatus">Approval</SortHeader>
                  </TableHead>
                  <TableHead>
                    <SortHeader id="changeCount"># Changes</SortHeader>
                  </TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedData.map((row, idx) => (
                  <RfpTableRow key={row.id} row={row} isEven={idx % 2 === 0} />
                ))}
              </TableBody>
            </Table>
          </div>
          {data && data.total > 0 && (
            <div className="flex items-center justify-between px-3 py-2 border-t text-xs text-muted-foreground bg-muted/20">
              <span>
                Showing {(page - 1) * 50 + 1}–{Math.min(page * 50, data.total)} of {data.total}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7"
                  disabled={page * 50 >= data.total}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RfpTableRow({ row, isEven }: { row: RfpReportRow; isEven: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const { data: changes } = useQuery<ChangeLogEntry[]>({
    queryKey: ["/api/reports/rfps", String(row.id), "changes"],
    queryFn: async () => {
      const res = await fetch(`/api/reports/rfps/${row.id}/changes`, { credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    enabled: expanded,
  });
  const { data: approvals } = useQuery<ApprovalEntry[]>({
    queryKey: ["/api/reports/rfps", String(row.id), "approvals"],
    queryFn: async () => {
      const res = await fetch(`/api/reports/rfps/${row.id}/approvals`, { credentials: "include" });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    enabled: expanded,
  });

  const statusBadgeClass =
    row.approvalStatus === "approved"
      ? "bg-green-500/10 text-green-700 border-green-500/20"
      : row.approvalStatus === "rejected"
      ? "bg-red-500/10 text-red-700 border-red-500/20"
      : "bg-amber-500/10 text-amber-700 border-amber-500/20";

  return (
    <>
      <TableRow
        className={`cursor-pointer hover:bg-muted/30 transition-colors ${expanded ? "bg-muted/20" : ""} ${!expanded && isEven ? "bg-muted/5" : ""}`}
        onClick={() => setExpanded(!expanded)}
      >
        <TableCell className="py-2">{row.projectName}</TableCell>
        <TableCell className="py-2 font-mono text-xs">{row.projectNumber}</TableCell>
        <TableCell className="py-2 text-muted-foreground">{row.recipient}</TableCell>
        <TableCell className="py-2 text-muted-foreground">
          {row.dateSent ? new Date(row.dateSent).toLocaleDateString() : "—"}
        </TableCell>
        <TableCell className="py-2">{row.bidboardStage}</TableCell>
        <TableCell className="py-2">
          <Badge variant="secondary" className={statusBadgeClass}>
            {row.approvalStatus === "approved" && <CheckCircle2 className="w-3 h-3 mr-1" />}
            {row.approvalStatus === "rejected" && <XCircle className="w-3 h-3 mr-1" />}
            {row.approvalStatus === "pending" && <AlertCircle className="w-3 h-3 mr-1" />}
            {row.approvalStatus}
          </Badge>
        </TableCell>
        <TableCell className="py-2">{row.changeCount}</TableCell>
        <TableCell className="py-2">
          {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={8} className="p-0 bg-muted/5 border-b">
            <div className="p-4 grid md:grid-cols-2 gap-6 animate-in fade-in duration-200">
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                  Change History
                </h4>
                <div className="relative pl-4 space-y-4">
                  {(changes ?? []).length === 0 ? (
                    <p className="text-sm text-muted-foreground">No changes recorded</p>
                  ) : (
                    <>
                      <div className="absolute left-0 top-1 bottom-1 w-px bg-border" />
                      {(changes ?? []).map((c) => (
                        <div key={c.id} className="relative flex flex-col gap-0.5">
                          <div className="absolute -left-4 top-1.5 w-2 h-2 rounded-full bg-primary/60 border-2 border-background" />
                          <span className="text-xs text-muted-foreground">
                            {new Date(c.changedAt).toLocaleString()}
                            {c.changedBy && ` · ${c.changedBy}`}
                          </span>
                          <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs">
                            <span className="font-medium text-blue-600">{c.fieldChanged}</span>
                            {c.oldValue && (
                              <span className="text-red-600 line-through">
                                {String(c.oldValue).slice(0, 50)}
                                {String(c.oldValue).length > 50 ? "…" : ""}
                              </span>
                            )}
                            <span className="text-green-600">
                              → {String(c.newValue || "").slice(0, 50)}
                              {String(c.newValue || "").length > 50 ? "…" : ""}
                            </span>
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </div>
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                  Approval Chain
                </h4>
                <div className="flex flex-wrap items-center gap-2">
                  {(approvals ?? []).length === 0 ? (
                    <p className="text-sm text-muted-foreground">No approvals</p>
                  ) : (
                    (approvals ?? []).map((a, i) => (
                      <React.Fragment key={i}>
                        {i > 0 && (
                          <span className="text-muted-foreground/50">→</span>
                        )}
                        <div
                          className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs ${
                            a.status === "approved"
                              ? "bg-green-500/10 border-green-500/20 text-green-700"
                              : a.status === "rejected"
                              ? "bg-red-500/10 border-red-500/20 text-red-700"
                              : "bg-amber-500/10 border-amber-500/20 text-amber-700"
                          }`}
                        >
                          {a.status === "approved" && <CheckCircle2 className="w-4 h-4 shrink-0" />}
                          {a.status === "rejected" && <XCircle className="w-4 h-4 shrink-0" />}
                          {a.status === "pending" && <AlertCircle className="w-4 h-4 shrink-0" />}
                          <div>
                            <span className="font-medium">{a.approverEmail}</span>
                            {a.decidedAt && (
                              <span className="block text-muted-foreground text-[10px]">
                                {new Date(a.decidedAt).toLocaleString()}
                              </span>
                            )}
                            {a.comments && (
                              <span className="block mt-0.5 text-muted-foreground">{a.comments}</span>
                            )}
                          </div>
                        </div>
                      </React.Fragment>
                    ))
                  )}
                </div>
              </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function ScheduledEmailsTab() {
  const { toast } = useToast();
  const { data: config, isLoading } = useQuery<ScheduleConfig | null>({
    queryKey: ["/api/reports/schedule"],
  });

  const [enabled, setEnabled] = useState(config?.enabled ?? false);
  const [frequency, setFrequency] = useState(config?.frequency ?? "weekly");
  const [dayOfWeek, setDayOfWeek] = useState<number | null>(config?.dayOfWeek ?? 1);
  const [timeOfDay, setTimeOfDay] = useState(config?.timeOfDay ?? "08:00");
  const [timezone, setTimezone] = useState(config?.timezone ?? "America/Chicago");
  const [recipients, setRecipients] = useState<string[]>(config?.recipients ?? []);
  const [recipientInput, setRecipientInput] = useState("");
  const [includeRfpLog, setIncludeRfpLog] = useState(config?.includeRfpLog ?? true);
  const [includeChangeHistory, setIncludeChangeHistory] = useState(config?.includeChangeHistory ?? true);
  const [includeApprovalSummary, setIncludeApprovalSummary] = useState(config?.includeApprovalSummary ?? true);

  React.useEffect(() => {
    if (config) {
      setEnabled(config.enabled);
      setFrequency(config.frequency ?? "weekly");
      setDayOfWeek(config.dayOfWeek ?? 1);
      setTimeOfDay(config.timeOfDay ?? "08:00");
      setTimezone(config.timezone ?? "America/Chicago");
      setRecipients(config.recipients ?? []);
      setIncludeRfpLog(config.includeRfpLog ?? true);
      setIncludeChangeHistory(config.includeChangeHistory ?? true);
      setIncludeApprovalSummary(config.includeApprovalSummary ?? true);
    }
  }, [config]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PUT", "/api/reports/schedule", {
        enabled,
        frequency,
        dayOfWeek: frequency === "weekly" || frequency === "biweekly" ? dayOfWeek : null,
        timeOfDay,
        timezone,
        recipients,
        includeRfpLog,
        includeChangeHistory,
        includeApprovalSummary,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/reports/schedule"] });
      toast({ title: "Schedule saved" });
    },
    onError: (e: Error) => toast({ title: "Failed to save", description: e.message, variant: "destructive" }),
  });

  const testMutation = useMutation({
    mutationFn: async () => {
      const email = recipients[0] || (recipientInput.trim().includes("@") ? recipientInput.trim() : undefined);
      const res = await apiRequest("POST", "/api/reports/schedule/test", email ? { email } : {});
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Test email sent to your address" });
    },
    onError: (e: Error) => toast({ title: "Failed to send test", description: e.message, variant: "destructive" }),
  });

  const addRecipient = () => {
    const email = recipientInput.trim();
    if (email && email.includes("@") && !recipients.includes(email)) {
      setRecipients([...recipients, email]);
      setRecipientInput("");
    }
  };

  if (isLoading) return <Skeleton className="h-48" />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Label htmlFor="enabled">Enable scheduled email reports</Label>
        <Switch id="enabled" checked={enabled} onCheckedChange={setEnabled} />
      </div>
      {enabled && (
        <>
          <div className="space-y-3">
            <Label className="text-xs">Frequency</Label>
            <RadioGroup
              value={frequency}
              onValueChange={setFrequency}
              className="grid grid-cols-2 sm:grid-cols-4 gap-2"
            >
              {FREQUENCIES.map((f) => (
                <label
                  key={f.value}
                  className="flex items-center space-x-2 rounded-lg border p-3 cursor-pointer has-[:checked]:border-primary has-[:checked]:bg-primary/5"
                >
                  <RadioGroupItem value={f.value} id={`freq-${f.value}`} />
                  <span className="text-sm font-medium">{f.label}</span>
                </label>
              ))}
            </RadioGroup>
          </div>
          {(frequency === "weekly" || frequency === "biweekly") && (
            <div>
              <Label className="text-xs">Day of week</Label>
              <Select
                value={String(dayOfWeek ?? 1)}
                onValueChange={(v) => setDayOfWeek(parseInt(v, 10))}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DAYS.map((d, i) => (
                    <SelectItem key={i} value={String(i)}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label className="text-xs">Time of day</Label>
              <Input
                type="time"
                value={timeOfDay}
                onChange={(e) => setTimeOfDay(e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <Label className="text-xs">Timezone</Label>
              <Select value={timezone} onValueChange={setTimezone}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIMEZONES.map((tz) => (
                    <SelectItem key={tz} value={tz}>
                      {tz.split("/")[1]?.replace("_", " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label className="text-xs">Recipients</Label>
            <div className="flex gap-2 mt-1">
              <Input
                type="email"
                placeholder="email@example.com"
                value={recipientInput}
                onChange={(e) => setRecipientInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addRecipient())}
              />
              <Button type="button" size="sm" variant="outline" onClick={addRecipient}>
                Add
              </Button>
            </div>
            <div className="flex flex-wrap gap-2 mt-2">
              {recipients.map((r) => (
                <Badge
                  key={r}
                  variant="secondary"
                  className="pl-2 pr-1 py-1 gap-1 font-normal cursor-pointer hover:bg-destructive/10"
                  onClick={() => setRecipients(recipients.filter((x) => x !== r))}
                >
                  {r}
                  <X className="w-3 h-3" />
                </Badge>
              ))}
            </div>
          </div>
          <div className="space-y-3">
            <Label className="text-xs">Include in report</Label>
            <div className="flex flex-col sm:flex-row sm:flex-wrap gap-3">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="include-rfp-log"
                  checked={includeRfpLog}
                  onCheckedChange={(v) => setIncludeRfpLog(!!v)}
                />
                <label htmlFor="include-rfp-log" className="text-sm cursor-pointer">
                  RFP Send Log
                </label>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="include-change-history"
                  checked={includeChangeHistory}
                  onCheckedChange={(v) => setIncludeChangeHistory(!!v)}
                />
                <label htmlFor="include-change-history" className="text-sm cursor-pointer">
                  Change History
                </label>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="include-approval-summary"
                  checked={includeApprovalSummary}
                  onCheckedChange={(v) => setIncludeApprovalSummary(!!v)}
                />
                <label htmlFor="include-approval-summary" className="text-sm cursor-pointer">
                  Approval Summary
                </label>
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
              {saveMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
              Save Schedule
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => testMutation.mutate()}
              disabled={testMutation.isPending}
            >
              {testMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Mail className="w-3 h-3 mr-1" />}
              Send Test Email
            </Button>
          </div>
        </>
      )}
      <NextRunDisplay
        enabled={enabled}
        frequency={frequency}
        dayOfWeek={dayOfWeek}
        timeOfDay={timeOfDay}
        timezone={timezone}
        recipients={recipients}
      />
    </div>
  );
}
