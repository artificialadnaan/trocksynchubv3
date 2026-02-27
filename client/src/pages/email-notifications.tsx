import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Mail,
  Send,
  FileText,
  History,
  CheckCircle,
  XCircle,
  Eye,
  Pencil,
  Save,
  X,
  Loader2,
  AlertCircle,
  Settings2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { format } from "date-fns";

type TabType = "config" | "templates" | "sendLog";

const tabs: { id: TabType; label: string; icon: any }[] = [
  { id: "config", label: "Configuration", icon: Settings2 },
  { id: "templates", label: "Templates", icon: FileText },
  { id: "sendLog", label: "Send History", icon: History },
];

export default function EmailNotificationsPage() {
  const [activeTab, setActiveTab] = useState<TabType>("config");

  const { data: stats, isLoading: statsLoading } = useQuery<{
    total: number;
    sent: number;
    failed: number;
    gmailConnected: boolean;
    outlookConnected: boolean;
    activeProvider: string;
  }>({
    queryKey: ["/api/email/stats"],
  });

  const activeProvider = stats?.activeProvider || 'gmail';
  const isConnected = activeProvider === 'gmail' ? stats?.gmailConnected : stats?.outlookConnected;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold" data-testid="text-email-title">
            Email Notifications
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Manage email templates and view notification history
          </p>
        </div>
        <div className="flex items-center gap-3">
          {statsLoading ? (
            <Skeleton className="h-8 w-32" />
          ) : (
            <>
              <Badge
                variant={isConnected ? "default" : "destructive"}
                className="gap-1"
                data-testid="badge-email-status"
              >
                {isConnected ? (
                  <CheckCircle className="w-3 h-3" />
                ) : (
                  <AlertCircle className="w-3 h-3" />
                )}
                {isConnected 
                  ? `${activeProvider === 'gmail' ? 'Gmail' : 'Outlook'} Connected` 
                  : `${activeProvider === 'gmail' ? 'Gmail' : 'Outlook'} Not Connected`}
              </Badge>
              <Badge variant="outline" data-testid="badge-emails-sent">
                {stats?.sent || 0} Sent
              </Badge>
              {(stats?.failed || 0) > 0 && (
                <Badge variant="destructive" data-testid="badge-emails-failed">
                  {stats.failed} Failed
                </Badge>
              )}
            </>
          )}
        </div>
      </div>

      <div className="flex gap-2 border-b">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
              data-testid={`tab-email-${tab.id}`}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab === "config" && <ConfigTab />}
      {activeTab === "templates" && <TemplatesTab />}
      {activeTab === "sendLog" && <SendLogTab />}
    </div>
  );
}

function ConfigTab() {
  const { toast } = useToast();

  const { data: config, isLoading } = useQuery<{
    activeProvider: string;
    gmailConnected: boolean;
    gmailEmail?: string;
    outlookConnected: boolean;
    outlookEmail?: string;
  }>({
    queryKey: ["/api/email/config"],
  });

  const saveMutation = useMutation({
    mutationFn: async (provider: string) => {
      const res = await apiRequest("POST", "/api/email/config", { activeProvider: provider });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/email/config"] });
      queryClient.invalidateQueries({ queryKey: ["/api/email/stats"] });
      toast({ title: "Email provider updated" });
    },
    onError: (e: Error) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const testMutation = useMutation({
    mutationFn: async (data: { to: string }) => {
      const res = await apiRequest("POST", "/api/email/test", data);
      return res.json();
    },
    onSuccess: (data: any) => {
      if (data.success) {
        toast({ title: "Test email sent successfully" });
      } else {
        toast({ title: "Test failed", description: data.error, variant: "destructive" });
      }
    },
    onError: (e: Error) => {
      toast({ title: "Error", description: e.message, variant: "destructive" });
    },
  });

  const [testEmail, setTestEmail] = useState("");

  if (isLoading) {
    return <Skeleton className="h-64 w-full" />;
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Mail className="w-4 h-4" />
            Email Provider
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Active Email Provider</Label>
            <Select
              value={config?.activeProvider || "gmail"}
              onValueChange={(value) => saveMutation.mutate(value)}
              disabled={saveMutation.isPending}
            >
              <SelectTrigger className="w-64" data-testid="select-email-provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="gmail">
                  <div className="flex items-center gap-2">
                    <span className="w-4 h-4 rounded bg-red-500/20 flex items-center justify-center text-[10px] font-bold text-red-600">G</span>
                    Gmail
                    {config?.gmailConnected && <Badge variant="outline" className="ml-2 text-xs">Connected</Badge>}
                  </div>
                </SelectItem>
                <SelectItem value="outlook">
                  <div className="flex items-center gap-2">
                    <span className="w-4 h-4 rounded bg-blue-500/20 flex items-center justify-center text-[10px] font-bold text-blue-600">O</span>
                    Outlook
                    {config?.outlookConnected && <Badge variant="outline" className="ml-2 text-xs">Connected</Badge>}
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              All automated emails will be sent through the selected provider.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4 pt-2">
            <div className={`p-4 rounded-lg border ${config?.activeProvider === 'gmail' ? 'border-primary bg-primary/5' : ''}`}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="w-6 h-6 rounded bg-red-500/20 flex items-center justify-center text-xs font-bold text-red-600">G</span>
                  <span className="font-medium text-sm">Gmail</span>
                </div>
                <Badge variant={config?.gmailConnected ? "default" : "secondary"} className={config?.gmailConnected ? "bg-green-500/10 text-green-600" : ""}>
                  {config?.gmailConnected ? "Connected" : "Not Connected"}
                </Badge>
              </div>
              {config?.gmailEmail && (
                <p className="text-xs text-muted-foreground">{config.gmailEmail}</p>
              )}
              {!config?.gmailConnected && (
                <p className="text-xs text-muted-foreground mt-1">Configure in Settings → API Connections</p>
              )}
            </div>

            <div className={`p-4 rounded-lg border ${config?.activeProvider === 'outlook' ? 'border-primary bg-primary/5' : ''}`}>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="w-6 h-6 rounded bg-blue-500/20 flex items-center justify-center text-xs font-bold text-blue-600">O</span>
                  <span className="font-medium text-sm">Outlook</span>
                </div>
                <Badge variant={config?.outlookConnected ? "default" : "secondary"} className={config?.outlookConnected ? "bg-green-500/10 text-green-600" : ""}>
                  {config?.outlookConnected ? "Connected" : "Not Connected"}
                </Badge>
              </div>
              {config?.outlookEmail && (
                <p className="text-xs text-muted-foreground">{config.outlookEmail}</p>
              )}
              {!config?.outlookConnected && (
                <p className="text-xs text-muted-foreground mt-1">Configure in Settings → API Connections</p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Send className="w-4 h-4" />
            Test Email
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Send a test email using the currently selected provider ({config?.activeProvider === 'outlook' ? 'Outlook' : 'Gmail'}).
          </p>
          <div className="flex gap-2">
            <Input
              type="email"
              placeholder="recipient@example.com"
              value={testEmail}
              onChange={(e) => setTestEmail(e.target.value)}
              className="max-w-sm"
              data-testid="input-test-email"
            />
            <Button
              onClick={() => testMutation.mutate({ to: testEmail })}
              disabled={!testEmail || testMutation.isPending}
              data-testid="button-send-test"
            >
              {testMutation.isPending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Send className="w-4 h-4 mr-1" />}
              Send Test
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function TemplatesTab() {
  const { toast } = useToast();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editSubject, setEditSubject] = useState("");
  const [editBody, setEditBody] = useState("");
  const [previewId, setPreviewId] = useState<number | null>(null);
  const [testEmail, setTestEmail] = useState("");

  const { data: templates, isLoading } = useQuery<any[]>({
    queryKey: ["/api/email/templates"],
  });

  const updateMutation = useMutation({
    mutationFn: async ({
      id,
      data,
    }: {
      id: number;
      data: any;
    }) => {
      const res = await apiRequest("PATCH", `/api/email/templates/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/email/templates"] });
      setEditingId(null);
      toast({ title: "Template updated" });
    },
    onError: (e: Error) => {
      toast({
        title: "Update failed",
        description: e.message,
        variant: "destructive",
      });
    },
  });

  const testMutation = useMutation({
    mutationFn: async ({
      to,
      templateKey,
    }: {
      to: string;
      templateKey: string;
    }) => {
      const res = await apiRequest("POST", "/api/email/test", {
        to,
        templateKey,
      });
      if (!res.ok) throw new Error((await res.json()).message);
      return res.json();
    },
    onSuccess: () => {
      setTestEmail("");
      toast({ title: "Test email sent" });
    },
    onError: (e: Error) => {
      toast({
        title: "Test failed",
        description: e.message,
        variant: "destructive",
      });
    },
  });

  const startEditing = (template: any) => {
    setEditingId(template.id);
    setEditSubject(template.subject);
    setEditBody(template.bodyHtml);
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {templates?.map((template) => (
        <Card key={template.id} data-testid={`card-template-${template.templateKey}`}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Mail className="w-5 h-5 text-primary" />
                <div>
                  <CardTitle className="text-base">{template.name}</CardTitle>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {template.description}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <Label htmlFor={`enabled-${template.id}`} className="text-sm">
                    Enabled
                  </Label>
                  <Switch
                    id={`enabled-${template.id}`}
                    checked={template.enabled}
                    onCheckedChange={(checked) =>
                      updateMutation.mutate({
                        id: template.id,
                        data: { enabled: checked },
                      })
                    }
                    data-testid={`switch-template-enabled-${template.templateKey}`}
                  />
                </div>
                <Badge variant="outline" className="font-mono text-xs">
                  {template.templateKey}
                </Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {editingId === template.id ? (
              <>
                <div>
                  <Label className="text-sm font-medium">Subject Line</Label>
                  <Input
                    value={editSubject}
                    onChange={(e) => setEditSubject(e.target.value)}
                    className="mt-1"
                    data-testid={`input-edit-subject-${template.templateKey}`}
                  />
                </div>
                <div>
                  <Label className="text-sm font-medium">
                    HTML Body
                  </Label>
                  <p className="text-xs text-muted-foreground mb-1">
                    Available variables:{" "}
                    {(template.variables as string[])?.map((v: string) => (
                      <code
                        key={v}
                        className="bg-muted px-1 py-0.5 rounded text-xs mx-0.5"
                      >{`{{${v}}}`}</code>
                    ))}
                  </p>
                  <Textarea
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    rows={12}
                    className="mt-1 font-mono text-xs"
                    data-testid={`textarea-edit-body-${template.templateKey}`}
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={() =>
                      updateMutation.mutate({
                        id: template.id,
                        data: {
                          subject: editSubject,
                          bodyHtml: editBody,
                        },
                      })
                    }
                    disabled={updateMutation.isPending}
                    data-testid={`button-save-template-${template.templateKey}`}
                  >
                    <Save className="w-4 h-4 mr-1" />
                    Save Changes
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setEditingId(null)}
                    data-testid={`button-cancel-edit-${template.templateKey}`}
                  >
                    <X className="w-4 h-4 mr-1" />
                    Cancel
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="grid grid-cols-[100px,1fr] gap-2 text-sm">
                  <span className="font-medium text-muted-foreground">Subject:</span>
                  <span>{template.subject}</span>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => startEditing(template)}
                    data-testid={`button-edit-template-${template.templateKey}`}
                  >
                    <Pencil className="w-4 h-4 mr-1" />
                    Edit Template
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setPreviewId(
                        previewId === template.id ? null : template.id
                      )
                    }
                    data-testid={`button-preview-template-${template.templateKey}`}
                  >
                    <Eye className="w-4 h-4 mr-1" />
                    {previewId === template.id ? "Hide Preview" : "Preview"}
                  </Button>
                  <div className="flex items-center gap-1 ml-auto">
                    <Input
                      placeholder="test@email.com"
                      value={testEmail}
                      onChange={(e) => setTestEmail(e.target.value)}
                      className="w-48 h-8 text-sm"
                      data-testid={`input-test-email-${template.templateKey}`}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        testMutation.mutate({
                          to: testEmail,
                          templateKey: template.templateKey,
                        })
                      }
                      disabled={
                        !testEmail ||
                        testMutation.isPending
                      }
                      data-testid={`button-send-test-${template.templateKey}`}
                    >
                      {testMutation.isPending ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Send className="w-4 h-4" />
                      )}
                    </Button>
                  </div>
                </div>
                {previewId === template.id && (
                  <div className="mt-2 border rounded-lg p-4 bg-white dark:bg-zinc-900">
                    <p className="text-xs text-muted-foreground mb-2">
                      Email Preview (variables shown as placeholders):
                    </p>
                    <div
                      dangerouslySetInnerHTML={{
                        __html: template.bodyHtml.replace(
                          /\{\{(\w+)\}\}/g,
                          (_: string, key: string) =>
                            `<span style="background:#dbeafe;padding:1px 4px;border-radius:3px;font-size:12px;">[${key}]</span>`
                        ),
                      }}
                    />
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      ))}

      {(!templates || templates.length === 0) && (
        <Card>
          <CardContent className="py-12 text-center">
            <Mail className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
            <p className="text-lg font-medium">No email templates yet</p>
            <p className="text-sm text-muted-foreground mt-1">
              Templates will be created automatically when notification features
              are enabled.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function SendLogTab() {
  const [page, setPage] = useState(0);
  const limit = 50;

  const { data, isLoading } = useQuery<{
    data: any[];
    total: number;
  }>({
    queryKey: ["/api/email/send-log", page],
    queryFn: async () => {
      const params = new URLSearchParams({
        limit: String(limit),
        offset: String(page * limit),
      });
      const res = await fetch(`/api/email/send-log?${params}`, {
        credentials: "include",
      });
      return res.json();
    },
  });

  const logs = data?.data || [];
  const total = data?.total || 0;
  const totalPages = Math.ceil(total / limit);

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[...Array(5)].map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  if (logs.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <History className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
          <p className="text-lg font-medium">No emails sent yet</p>
          <p className="text-sm text-muted-foreground mt-1">
            Email notifications will appear here once triggered by sync events.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="pt-4">
        <div className="space-y-1">
          <div className="grid grid-cols-[1fr,1fr,200px,100px,140px] gap-2 px-3 py-2 text-xs font-medium text-muted-foreground uppercase">
            <span>Recipient</span>
            <span>Subject</span>
            <span>Template</span>
            <span>Status</span>
            <span>Sent At</span>
          </div>
          {logs.map((log: any) => (
            <div
              key={log.id}
              className="grid grid-cols-[1fr,1fr,200px,100px,140px] gap-2 px-3 py-2.5 text-sm border-t items-center"
              data-testid={`row-email-log-${log.id}`}
            >
              <div>
                <p className="font-medium truncate">
                  {log.recipientName || log.recipientEmail}
                </p>
                {log.recipientName && (
                  <p className="text-xs text-muted-foreground truncate">
                    {log.recipientEmail}
                  </p>
                )}
              </div>
              <span className="truncate text-muted-foreground">
                {log.subject}
              </span>
              <Badge variant="outline" className="w-fit text-xs font-mono">
                {log.templateKey}
              </Badge>
              <div>
                {log.status === "sent" ? (
                  <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 gap-1">
                    <CheckCircle className="w-3 h-3" />
                    Sent
                  </Badge>
                ) : (
                  <Badge variant="destructive" className="gap-1">
                    <XCircle className="w-3 h-3" />
                    Failed
                  </Badge>
                )}
              </div>
              <span className="text-xs text-muted-foreground">
                {log.sentAt
                  ? format(new Date(log.sentAt), "MMM d, h:mm a")
                  : "-"}
              </span>
            </div>
          ))}
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4 pt-4 border-t">
            <span className="text-sm text-muted-foreground">
              Showing {page * limit + 1}-
              {Math.min((page + 1) * limit, total)} of {total}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(page - 1)}
                disabled={page === 0}
                data-testid="button-email-log-prev"
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(page + 1)}
                disabled={page >= totalPages - 1}
                data-testid="button-email-log-next"
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
