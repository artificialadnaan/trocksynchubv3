import { useState, useRef, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { AlertCircle, CheckCircle2, Mail, Play, Camera, FileText, Loader2, AlertTriangle, Settings, Code, StopCircle, Navigation, MousePointer, Type, RefreshCw, Copy, Eye } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface TestingMode {
  enabled: boolean;
  testEmail: string;
}

interface PlaywrightStatus {
  playwrightInstalled: boolean;
  browserAvailable: boolean;
  browserVersion?: string;
  error?: string;
}

interface EmailTemplate {
  id: number;
  templateKey: string;
  name: string;
  description: string;
  enabled: boolean;
}

interface BidBoardConfig {
  enabled: boolean;
  pollingIntervalMinutes: number;
  hasCredentials: boolean;
}

interface WorkshopStatus {
  active: boolean;
  isRecording: boolean;
  actionsRecorded?: number;
  startTime?: string;
  uptime?: number;
  message?: string;
}

interface WorkshopResponse {
  success: boolean;
  screenshot?: string;
  currentUrl?: string;
  message?: string;
  error?: string;
  result?: any;
}

interface RecordedScript {
  script: string;
  actions: string[];
  actionsCount: number;
}

export default function TestingPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const screenshotRef = useRef<HTMLDivElement>(null);
  const [testEmail, setTestEmail] = useState('adnaan.iqbal@gmail.com');
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [projectId, setProjectId] = useState('');
  const [screenshotResult, setScreenshotResult] = useState<string | null>(null);
  const [extractionResult, setExtractionResult] = useState<any>(null);
  
  // Procore credentials state
  const [procoreEmail, setProcoreEmail] = useState('');
  const [procorePassword, setProcorePassword] = useState('');
  const [procoreSandbox, setProcoreSandbox] = useState(false);
  
  // Workshop state
  const [workshopUrl, setWorkshopUrl] = useState('');
  const [workshopSelector, setWorkshopSelector] = useState('');
  const [workshopText, setWorkshopText] = useState('');
  const [workshopScript, setWorkshopScript] = useState('');
  const [workshopScreenshot, setWorkshopScreenshot] = useState<string | null>(null);
  const [workshopCurrentUrl, setWorkshopCurrentUrl] = useState<string>('');
  const [isPollingScreenshot, setIsPollingScreenshot] = useState(false);
  const workshopScreenshotRef = useRef<HTMLDivElement>(null);

  // Scroll to screenshot when captured
  useEffect(() => {
    if (screenshotResult && screenshotRef.current) {
      screenshotRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [screenshotResult]);

  // Fetch testing mode status
  const { data: testingMode, isLoading: loadingMode } = useQuery<TestingMode>({
    queryKey: ['/api/testing/mode'],
  });

  // Fetch Playwright status
  const { data: playwrightStatus, isLoading: loadingPlaywright } = useQuery<PlaywrightStatus>({
    queryKey: ['/api/testing/playwright/status'],
  });

  // Fetch BidBoard config (includes hasCredentials)
  const { data: bidboardConfig, isLoading: loadingBidboardConfig } = useQuery<BidBoardConfig>({
    queryKey: ['/api/bidboard/config'],
  });

  // Save Procore credentials
  const saveCredentials = useMutation({
    mutationFn: async ({ email, password, sandbox }: { email: string; password: string; sandbox: boolean }) => {
      const res = await fetch('/api/bidboard/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password, sandbox }),
      });
      if (!res.ok) throw new Error('Failed to save credentials');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/bidboard/config'] });
      setProcorePassword(''); // Clear password after save
    },
  });

  // Test Procore login
  const testLogin = useMutation({
    mutationFn: async ({ email, password, sandbox }: { email: string; password: string; sandbox: boolean }) => {
      const res = await fetch('/api/bidboard/test-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password, sandbox }),
      });
      if (!res.ok) throw new Error('Failed to test login');
      return res.json();
    },
    onSuccess: (data) => {
      if (data.success) {
        queryClient.invalidateQueries({ queryKey: ['/api/bidboard/config'] });
        setProcorePassword('');
      }
    },
  });

  // Fetch email templates
  const { data: templates } = useQuery<EmailTemplate[]>({
    queryKey: ['/api/email-templates'],
  });

  // Toggle testing mode mutation
  const toggleTestingMode = useMutation({
    mutationFn: async ({ enabled, email }: { enabled: boolean; email: string }) => {
      const res = await fetch('/api/testing/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ enabled, testEmail: email }),
      });
      if (!res.ok) throw new Error('Failed to update testing mode');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/testing/mode'] });
    },
  });

  // Send test email mutation
  const sendTestEmail = useMutation({
    mutationFn: async ({ templateKey, recipient }: { templateKey: string; recipient: string }) => {
      const res = await fetch('/api/testing/send-test-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ templateKey, testRecipient: recipient }),
      });
      if (!res.ok) throw new Error('Failed to send test email');
      return res.json();
    },
  });

  // Playwright screenshot mutations
  const bidboardScreenshot = useMutation({
    mutationFn: async (projectId?: string) => {
      const res = await fetch('/api/testing/playwright/bidboard-screenshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ projectId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to capture screenshot');
      }
      return res.json();
    },
    onSuccess: (data) => {
      if (data.screenshot) {
        setScreenshotResult(data.screenshot);
        toast({ title: "Screenshot Captured", description: "BidBoard screenshot captured successfully" });
      } else if (data.error) {
        toast({ title: "Screenshot Failed", description: data.error, variant: "destructive" });
      }
    },
    onError: (error: any) => {
      toast({ title: "Screenshot Failed", description: error.message, variant: "destructive" });
    },
  });

  const portfolioScreenshot = useMutation({
    mutationFn: async (projectId?: string) => {
      const res = await fetch('/api/testing/playwright/portfolio-screenshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ projectId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to capture screenshot');
      }
      return res.json();
    },
    onSuccess: (data) => {
      if (data.screenshot) {
        setScreenshotResult(data.screenshot);
        toast({ title: "Screenshot Captured", description: "Portfolio screenshot captured successfully" });
      } else if (data.error) {
        toast({ title: "Screenshot Failed", description: data.error, variant: "destructive" });
      }
    },
    onError: (error: any) => {
      toast({ title: "Screenshot Failed", description: error.message, variant: "destructive" });
    },
  });

  const bidboardExtract = useMutation({
    mutationFn: async (projectId: string) => {
      const res = await fetch('/api/testing/playwright/bidboard-extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ projectId }),
      });
      if (!res.ok) throw new Error('Failed to extract data');
      return res.json();
    },
    onSuccess: (data) => {
      setExtractionResult(data.data);
      if (data.data?.screenshot) setScreenshotResult(data.data.screenshot);
    },
  });

  const documentsExtract = useMutation({
    mutationFn: async (projectId: string) => {
      const res = await fetch('/api/testing/playwright/documents-extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ projectId }),
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to extract documents');
      }
      
      // Check if response is a ZIP file or JSON
      const contentType = res.headers.get('Content-Type') || '';
      if (contentType.includes('application/zip')) {
        // Download the ZIP file
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `project-${projectId}-documents.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
        return { success: true, data: { message: 'Documents downloaded as ZIP file', downloadedFiles: 1 } };
      }
      
      // JSON response - no files downloaded
      const jsonData = await res.json();
      return jsonData;
    },
    onSuccess: (data) => {
      setExtractionResult(data.data);
      if (data.data?.screenshot) setScreenshotResult(data.data.screenshot);
    },
  });

  // ==================== WORKSHOP QUERIES & MUTATIONS ====================
  
  // Workshop status query
  const { data: workshopStatus, refetch: refetchWorkshopStatus } = useQuery<WorkshopStatus>({
    queryKey: ['/api/testing/playwright/workshop/status'],
    refetchInterval: (query) => query.state.data?.active ? 3000 : false,
  });
  
  // Recorded script query
  const { data: recordedScript, refetch: refetchRecordedScript } = useQuery<RecordedScript>({
    queryKey: ['/api/testing/playwright/workshop/recorded-script'],
    enabled: workshopStatus?.active ?? false,
  });

  // Start workshop session
  const startWorkshop = useMutation({
    mutationFn: async ({ url, loginFirst }: { url?: string; loginFirst?: boolean }) => {
      const res = await fetch('/api/testing/playwright/workshop/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ url, loginFirst }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to start workshop');
      }
      return res.json();
    },
    onSuccess: (data: WorkshopResponse) => {
      queryClient.invalidateQueries({ queryKey: ['/api/testing/playwright/workshop/status'] });
      if (data.screenshot) setWorkshopScreenshot(data.screenshot);
      if (data.currentUrl) setWorkshopCurrentUrl(data.currentUrl);
      toast({ title: "Workshop Started", description: "Browser window is now open and ready" });
    },
    onError: (error: any) => {
      toast({ title: "Failed to Start", description: error.message, variant: "destructive" });
    },
  });

  // Stop workshop session
  const stopWorkshop = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/testing/playwright/workshop/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to stop workshop');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/testing/playwright/workshop/status'] });
      setWorkshopScreenshot(null);
      setWorkshopCurrentUrl('');
      toast({ title: "Workshop Stopped", description: "Browser has been closed" });
    },
  });

  // Refresh screenshot
  const refreshScreenshot = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/testing/playwright/workshop/screenshot', {
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Failed to get screenshot');
      return res.json();
    },
    onSuccess: (data: WorkshopResponse) => {
      if (data.screenshot) setWorkshopScreenshot(data.screenshot);
      if (data.currentUrl) setWorkshopCurrentUrl(data.currentUrl);
    },
  });

  // Navigate in workshop
  const workshopNavigate = useMutation({
    mutationFn: async (url: string) => {
      const res = await fetch('/api/testing/playwright/workshop/navigate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ url }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to navigate');
      }
      return res.json();
    },
    onSuccess: (data: WorkshopResponse) => {
      if (data.screenshot) setWorkshopScreenshot(data.screenshot);
      if (data.currentUrl) setWorkshopCurrentUrl(data.currentUrl);
      refetchRecordedScript();
      toast({ title: "Navigated", description: `Went to ${data.currentUrl}` });
    },
    onError: (error: any) => {
      toast({ title: "Navigation Failed", description: error.message, variant: "destructive" });
    },
  });

  // Click in workshop
  const workshopClick = useMutation({
    mutationFn: async (selector: string) => {
      const res = await fetch('/api/testing/playwright/workshop/click', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ selector }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to click');
      }
      return res.json();
    },
    onSuccess: (data: WorkshopResponse) => {
      if (data.screenshot) setWorkshopScreenshot(data.screenshot);
      if (data.currentUrl) setWorkshopCurrentUrl(data.currentUrl);
      refetchRecordedScript();
      toast({ title: "Clicked", description: "Click action executed" });
    },
    onError: (error: any) => {
      toast({ title: "Click Failed", description: error.message, variant: "destructive" });
    },
  });

  // Type in workshop
  const workshopType = useMutation({
    mutationFn: async ({ selector, text }: { selector: string; text: string }) => {
      const res = await fetch('/api/testing/playwright/workshop/type', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ selector, text }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to type');
      }
      return res.json();
    },
    onSuccess: (data: WorkshopResponse) => {
      if (data.screenshot) setWorkshopScreenshot(data.screenshot);
      refetchRecordedScript();
      toast({ title: "Typed", description: "Text entered successfully" });
    },
    onError: (error: any) => {
      toast({ title: "Type Failed", description: error.message, variant: "destructive" });
    },
  });

  // Run script in workshop
  const workshopRunScript = useMutation({
    mutationFn: async (script: string) => {
      const res = await fetch('/api/testing/playwright/workshop/run-script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ script }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to run script');
      }
      return res.json();
    },
    onSuccess: (data: WorkshopResponse) => {
      if (data.screenshot) setWorkshopScreenshot(data.screenshot);
      if (data.currentUrl) setWorkshopCurrentUrl(data.currentUrl);
      refetchRecordedScript();
      toast({ title: "Script Executed", description: "Custom script ran successfully" });
    },
    onError: (error: any) => {
      toast({ title: "Script Failed", description: error.message, variant: "destructive" });
    },
  });

  // Copy script to clipboard
  const copyScriptToClipboard = useCallback(() => {
    if (recordedScript?.script) {
      navigator.clipboard.writeText(recordedScript.script);
      toast({ title: "Copied", description: "Script copied to clipboard" });
    }
  }, [recordedScript, toast]);

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl md:text-2xl font-bold">Testing & Configuration</h1>
          <p className="text-muted-foreground text-xs md:text-sm mt-1">Test email notifications and Playwright automation</p>
        </div>
        {testingMode?.enabled && (
          <Badge variant="destructive" className="text-sm px-3 py-1">
            <AlertTriangle className="w-4 h-4 mr-2" />
            Testing Mode Active
          </Badge>
        )}
      </div>

      <Tabs defaultValue="email" className="space-y-4">
        <TabsList className="w-full md:w-auto">
          <TabsTrigger value="email" className="flex-1 md:flex-none">
            <Mail className="w-4 h-4 mr-2" />
            <span className="hidden sm:inline">Email Testing</span>
            <span className="sm:hidden">Email</span>
          </TabsTrigger>
          <TabsTrigger value="playwright" className="flex-1 md:flex-none">
            <Play className="w-4 h-4 mr-2" />
            <span className="hidden sm:inline">Playwright</span>
            <span className="sm:hidden">Browser</span>
          </TabsTrigger>
          <TabsTrigger value="workshop" className="flex-1 md:flex-none">
            <Code className="w-4 h-4 mr-2" />
            <span className="hidden sm:inline">Workshop</span>
            <span className="sm:hidden">Workshop</span>
            {workshopStatus?.active && (
              <span className="ml-2 w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            )}
          </TabsTrigger>
        </TabsList>

        {/* Email Testing Tab */}
        <TabsContent value="email" className="space-y-4">
          {/* Testing Mode Toggle */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <Settings className="w-5 h-5 text-primary" />
                Testing Mode
              </CardTitle>
              <CardDescription>
                When enabled, all emails are redirected to the test email address
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {loadingMode ? (
                <Skeleton className="h-10 w-full" />
              ) : (
                <>
                  <div className="flex items-center justify-between p-4 rounded-lg border bg-muted/30">
                    <div className="flex items-center gap-3">
                      <div className={`w-3 h-3 rounded-full ${testingMode?.enabled ? 'bg-destructive animate-pulse' : 'bg-muted-foreground/30'}`} />
                      <div>
                        <p className="font-medium">Testing Mode</p>
                        <p className="text-sm text-muted-foreground">
                          {testingMode?.enabled 
                            ? `All emails redirect to ${testingMode.testEmail}` 
                            : 'Emails sent to actual recipients'}
                        </p>
                      </div>
                    </div>
                    <Switch
                      checked={testingMode?.enabled ?? false}
                      onCheckedChange={(checked) => {
                        toggleTestingMode.mutate({ enabled: checked, email: testEmail });
                      }}
                      disabled={toggleTestingMode.isPending}
                    />
                  </div>
                  
                  <div className="grid gap-2">
                    <Label htmlFor="testEmail">Test Email Address</Label>
                    <div className="flex gap-2">
                      <Input
                        id="testEmail"
                        value={testEmail}
                        onChange={(e) => setTestEmail(e.target.value)}
                        placeholder="adnaan.iqbal@gmail.com"
                      />
                      <Button
                        onClick={() => toggleTestingMode.mutate({ enabled: true, email: testEmail })}
                        disabled={toggleTestingMode.isPending || !testEmail}
                        variant="outline"
                      >
                        {toggleTestingMode.isPending ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          'Update'
                        )}
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Send Test Email */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <Mail className="w-5 h-5 text-primary" />
                Send Test Email
              </CardTitle>
              <CardDescription>
                Send a test email using sample data to verify templates
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Email Template</Label>
                  <Select value={selectedTemplate} onValueChange={setSelectedTemplate}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a template" />
                    </SelectTrigger>
                    <SelectContent>
                      {templates?.map((t) => (
                        <SelectItem key={t.templateKey} value={t.templateKey}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Recipient Email</Label>
                  <Input
                    value={testEmail}
                    onChange={(e) => setTestEmail(e.target.value)}
                    placeholder="adnaan.iqbal@gmail.com"
                  />
                </div>
              </div>
              
              <Button
                onClick={() => sendTestEmail.mutate({ templateKey: selectedTemplate, recipient: testEmail })}
                disabled={sendTestEmail.isPending || !selectedTemplate}
                className="w-full md:w-auto"
              >
                {sendTestEmail.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Sending...
                  </>
                ) : (
                  <>
                    <Mail className="w-4 h-4 mr-2" />
                    Send Test Email
                  </>
                )}
              </Button>
              
              {sendTestEmail.isSuccess && (
                <div className="p-3 bg-green-500/10 border border-green-500/30 rounded-lg flex items-center gap-2">
                  <CheckCircle2 className="w-5 h-5 text-green-500" />
                  <span className="text-green-600 dark:text-green-400">Test email sent successfully via {sendTestEmail.data.provider}</span>
                </div>
              )}
              
              {sendTestEmail.isError && (
                <div className="p-3 bg-destructive/10 border border-destructive/30 rounded-lg flex items-center gap-2">
                  <AlertCircle className="w-5 h-5 text-destructive" />
                  <span className="text-destructive">Failed to send test email</span>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Playwright Testing Tab */}
        <TabsContent value="playwright" className="space-y-4">
          {/* Procore Browser Credentials */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <Settings className="w-5 h-5 text-primary" />
                Procore Browser Login
              </CardTitle>
              <CardDescription>
                Configure Procore credentials for Playwright automation (BidBoard scraping, document extraction)
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {loadingBidboardConfig ? (
                <Skeleton className="h-32 w-full" />
              ) : (
                <>
                  <div className="flex items-center gap-2 p-3 rounded-lg border bg-muted/30">
                    {bidboardConfig?.hasCredentials ? (
                      <>
                        <CheckCircle2 className="w-5 h-5 text-green-500" />
                        <span className="text-green-600 dark:text-green-400">Procore credentials configured</span>
                      </>
                    ) : (
                      <>
                        <AlertCircle className="w-5 h-5 text-amber-500" />
                        <span className="text-amber-600 dark:text-amber-400">No Procore credentials saved</span>
                      </>
                    )}
                  </div>

                  <div className="grid gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="procore-email">Procore Email</Label>
                      <Input
                        id="procore-email"
                        type="email"
                        value={procoreEmail}
                        onChange={(e) => setProcoreEmail(e.target.value)}
                        placeholder="your-email@company.com"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="procore-password">Procore Password</Label>
                      <Input
                        id="procore-password"
                        type="password"
                        value={procorePassword}
                        onChange={(e) => setProcorePassword(e.target.value)}
                        placeholder="••••••••"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch
                        id="procore-sandbox"
                        checked={procoreSandbox}
                        onCheckedChange={setProcoreSandbox}
                      />
                      <Label htmlFor="procore-sandbox">Use Sandbox Environment</Label>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      onClick={() => testLogin.mutate({ email: procoreEmail, password: procorePassword, sandbox: procoreSandbox })}
                      disabled={testLogin.isPending || !procoreEmail || !procorePassword}
                    >
                      {testLogin.isPending ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Testing...
                        </>
                      ) : (
                        <>
                          <Play className="w-4 h-4 mr-2" />
                          Test Login & Save
                        </>
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => saveCredentials.mutate({ email: procoreEmail, password: procorePassword, sandbox: procoreSandbox })}
                      disabled={saveCredentials.isPending || !procoreEmail || !procorePassword}
                    >
                      {saveCredentials.isPending ? (
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                      ) : (
                        'Save Without Testing'
                      )}
                    </Button>
                  </div>

                  {testLogin.isSuccess && (
                    <div className={`p-3 rounded-lg flex items-center gap-2 ${testLogin.data.success ? 'bg-green-500/10 border border-green-500/30' : 'bg-destructive/10 border border-destructive/30'}`}>
                      {testLogin.data.success ? (
                        <>
                          <CheckCircle2 className="w-5 h-5 text-green-500" />
                          <span className="text-green-600 dark:text-green-400">Login successful! Credentials saved.</span>
                        </>
                      ) : (
                        <>
                          <AlertCircle className="w-5 h-5 text-destructive" />
                          <span className="text-destructive">{testLogin.data.error || 'Login failed'}</span>
                        </>
                      )}
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          {/* Playwright Status */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <Play className="w-5 h-5 text-primary" />
                Playwright Status
              </CardTitle>
              <CardDescription>
                Browser automation availability for BidBoard and Procore
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loadingPlaywright ? (
                <Skeleton className="h-20 w-full" />
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="p-4 rounded-lg border bg-muted/30">
                    <div className="flex items-center gap-2 mb-2">
                      {playwrightStatus?.playwrightInstalled ? (
                        <CheckCircle2 className="w-5 h-5 text-green-500" />
                      ) : (
                        <AlertCircle className="w-5 h-5 text-destructive" />
                      )}
                      <span className="font-medium">Playwright</span>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {playwrightStatus?.playwrightInstalled ? 'Installed' : 'Not installed'}
                    </p>
                  </div>
                  <div className="p-4 rounded-lg border bg-muted/30">
                    <div className="flex items-center gap-2 mb-2">
                      {playwrightStatus?.browserAvailable ? (
                        <CheckCircle2 className="w-5 h-5 text-green-500" />
                      ) : (
                        <AlertCircle className="w-5 h-5 text-destructive" />
                      )}
                      <span className="font-medium">Browser</span>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {playwrightStatus?.browserAvailable 
                        ? `Chromium ${playwrightStatus.browserVersion}` 
                        : playwrightStatus?.error || 'Not available'}
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Screenshot Tests */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <Camera className="w-5 h-5 text-primary" />
                Capture Screenshots
              </CardTitle>
              <CardDescription>
                Capture screenshots of Procore pages to verify navigation
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Project ID (optional)</Label>
                <Input
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  placeholder="Enter Procore Project ID"
                />
              </div>
              
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => bidboardScreenshot.mutate(projectId || undefined)}
                  disabled={bidboardScreenshot.isPending}
                  variant="outline"
                >
                  {bidboardScreenshot.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Camera className="w-4 h-4 mr-2" />
                  )}
                  BidBoard
                </Button>
                <Button
                  onClick={() => portfolioScreenshot.mutate(projectId || undefined)}
                  disabled={portfolioScreenshot.isPending}
                  variant="outline"
                >
                  {portfolioScreenshot.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Camera className="w-4 h-4 mr-2" />
                  )}
                  Portfolio
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Data Extraction Tests */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <FileText className="w-5 h-5 text-primary" />
                Data Extraction Tests
              </CardTitle>
              <CardDescription>
                Test extracting data from BidBoard projects and documents
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Project ID (required)</Label>
                <Input
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  placeholder="Enter Procore Project ID"
                />
              </div>
              
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => bidboardExtract.mutate(projectId)}
                  disabled={bidboardExtract.isPending || !projectId}
                  variant="outline"
                >
                  {bidboardExtract.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <FileText className="w-4 h-4 mr-2" />
                  )}
                  Extract BidBoard Data
                </Button>
                <Button
                  onClick={() => documentsExtract.mutate(projectId)}
                  disabled={documentsExtract.isPending || !projectId}
                  variant="outline"
                >
                  {documentsExtract.isPending ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <FileText className="w-4 h-4 mr-2" />
                  )}
                  Extract Documents
                </Button>
              </div>
              
              {/* Extraction Results */}
              {extractionResult && (
                <div className="p-4 rounded-lg border bg-muted/30 overflow-auto max-h-64">
                  <p className="text-sm font-medium mb-2">Extraction Results:</p>
                  <pre className="text-xs text-muted-foreground whitespace-pre-wrap">
                    {JSON.stringify(extractionResult, null, 2)}
                  </pre>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Screenshot Preview */}
          {screenshotResult && (
            <Card ref={screenshotRef}>
              <CardHeader>
                <CardTitle className="text-base font-semibold flex items-center gap-2">
                  <CheckCircle2 className="w-5 h-5 text-green-500" />
                  Screenshot Preview
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="border rounded-lg overflow-hidden bg-muted">
                  <img 
                    src={screenshotResult} 
                    alt="Screenshot" 
                    className="w-full h-auto"
                  />
                </div>
                <Button
                  onClick={() => setScreenshotResult(null)}
                  variant="outline"
                  className="mt-4"
                >
                  Clear Screenshot
                </Button>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Playwright Workshop Tab */}
        <TabsContent value="workshop" className="space-y-4">
          {/* Session Status & Controls */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <Code className="w-5 h-5 text-primary" />
                Playwright Workshop
              </CardTitle>
              <CardDescription>
                Interactive browser session where you can demonstrate actions for Playwright to record
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Session status */}
              <div className="flex items-center gap-2 p-3 rounded-lg border bg-muted/30">
                {workshopStatus?.active ? (
                  <>
                    <div className="w-3 h-3 rounded-full bg-green-500 animate-pulse" />
                    <span className="text-green-600 dark:text-green-400 flex-1">
                      Session active ({workshopStatus.actionsRecorded || 0} actions recorded)
                    </span>
                    {workshopStatus.uptime && (
                      <span className="text-muted-foreground text-sm">
                        {Math.floor(workshopStatus.uptime / 60)}:{String(workshopStatus.uptime % 60).padStart(2, '0')}
                      </span>
                    )}
                  </>
                ) : (
                  <>
                    <div className="w-3 h-3 rounded-full bg-muted-foreground/30" />
                    <span className="text-muted-foreground">No active session</span>
                  </>
                )}
              </div>

              {/* Start/Stop controls */}
              {!workshopStatus?.active ? (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label>Starting URL (optional)</Label>
                    <Input
                      value={workshopUrl}
                      onChange={(e) => setWorkshopUrl(e.target.value)}
                      placeholder="https://us02.procore.com/..."
                    />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      onClick={() => startWorkshop.mutate({ url: workshopUrl || undefined, loginFirst: true })}
                      disabled={startWorkshop.isPending}
                    >
                      {startWorkshop.isPending ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Starting...
                        </>
                      ) : (
                        <>
                          <Play className="w-4 h-4 mr-2" />
                          Start with Procore Login
                        </>
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => startWorkshop.mutate({ url: workshopUrl || undefined, loginFirst: false })}
                      disabled={startWorkshop.isPending}
                    >
                      <Play className="w-4 h-4 mr-2" />
                      Start Without Login
                    </Button>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    A visible browser window will open. You can interact with it directly, 
                    or use the controls below to record actions programmatically.
                  </p>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Button
                    variant="destructive"
                    onClick={() => stopWorkshop.mutate()}
                    disabled={stopWorkshop.isPending}
                  >
                    {stopWorkshop.isPending ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <StopCircle className="w-4 h-4 mr-2" />
                    )}
                    Stop Session
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => refreshScreenshot.mutate()}
                    disabled={refreshScreenshot.isPending}
                  >
                    {refreshScreenshot.isPending ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <RefreshCw className="w-4 h-4 mr-2" />
                    )}
                    Refresh Screenshot
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Browser Controls - Only show when session active */}
          {workshopStatus?.active && (
            <>
              {/* Navigation */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base font-semibold flex items-center gap-2">
                    <Navigation className="w-5 h-5 text-primary" />
                    Navigation
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {workshopCurrentUrl && (
                    <div className="text-sm text-muted-foreground truncate">
                      Current: {workshopCurrentUrl}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Input
                      value={workshopUrl}
                      onChange={(e) => setWorkshopUrl(e.target.value)}
                      placeholder="Enter URL to navigate to..."
                      className="flex-1"
                    />
                    <Button
                      onClick={() => workshopNavigate.mutate(workshopUrl)}
                      disabled={workshopNavigate.isPending || !workshopUrl}
                    >
                      {workshopNavigate.isPending ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        'Go'
                      )}
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* Actions */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base font-semibold flex items-center gap-2">
                    <MousePointer className="w-5 h-5 text-primary" />
                    Actions
                  </CardTitle>
                  <CardDescription>
                    Execute Playwright actions and record them
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Click action */}
                  <div className="space-y-2">
                    <Label>Click Element</Label>
                    <div className="flex gap-2">
                      <Input
                        value={workshopSelector}
                        onChange={(e) => setWorkshopSelector(e.target.value)}
                        placeholder="CSS selector (e.g., button.submit, #login-btn)"
                        className="flex-1"
                      />
                      <Button
                        variant="outline"
                        onClick={() => workshopClick.mutate(workshopSelector)}
                        disabled={workshopClick.isPending || !workshopSelector}
                      >
                        {workshopClick.isPending ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <>
                            <MousePointer className="w-4 h-4 mr-2" />
                            Click
                          </>
                        )}
                      </Button>
                    </div>
                  </div>

                  {/* Type action */}
                  <div className="space-y-2">
                    <Label>Type Text</Label>
                    <div className="flex gap-2">
                      <Input
                        value={workshopSelector}
                        onChange={(e) => setWorkshopSelector(e.target.value)}
                        placeholder="Selector"
                        className="w-1/3"
                      />
                      <Input
                        value={workshopText}
                        onChange={(e) => setWorkshopText(e.target.value)}
                        placeholder="Text to type"
                        className="flex-1"
                      />
                      <Button
                        variant="outline"
                        onClick={() => workshopType.mutate({ selector: workshopSelector, text: workshopText })}
                        disabled={workshopType.isPending || !workshopSelector || !workshopText}
                      >
                        {workshopType.isPending ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <>
                            <Type className="w-4 h-4 mr-2" />
                            Type
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Custom Script */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base font-semibold flex items-center gap-2">
                    <Code className="w-5 h-5 text-primary" />
                    Custom Script
                  </CardTitle>
                  <CardDescription>
                    Run custom Playwright code (page object is available)
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <Textarea
                    value={workshopScript}
                    onChange={(e) => setWorkshopScript(e.target.value)}
                    placeholder={`// Example:\nawait page.waitForSelector('.some-element');\nawait page.click('button.submit');\nconst text = await page.textContent('h1');\nreturn text;`}
                    className="font-mono text-sm min-h-[120px]"
                  />
                  <Button
                    onClick={() => workshopRunScript.mutate(workshopScript)}
                    disabled={workshopRunScript.isPending || !workshopScript}
                  >
                    {workshopRunScript.isPending ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Running...
                      </>
                    ) : (
                      <>
                        <Play className="w-4 h-4 mr-2" />
                        Run Script
                      </>
                    )}
                  </Button>
                </CardContent>
              </Card>

              {/* Recorded Script */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base font-semibold flex items-center gap-2">
                    <FileText className="w-5 h-5 text-primary" />
                    Recorded Script
                    {recordedScript?.actionsCount ? (
                      <Badge variant="secondary">{recordedScript.actionsCount} actions</Badge>
                    ) : null}
                  </CardTitle>
                  <CardDescription>
                    Generated Playwright code from your actions
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="relative">
                    <pre className="p-4 rounded-lg border bg-muted/30 overflow-auto max-h-[300px] text-xs font-mono whitespace-pre-wrap">
                      {recordedScript?.script || '// No actions recorded yet.\n// Start interacting with the browser to record actions.'}
                    </pre>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="absolute top-2 right-2"
                      onClick={copyScriptToClipboard}
                      disabled={!recordedScript?.script}
                    >
                      <Copy className="w-4 h-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* Live Screenshot */}
              {workshopScreenshot && (
                <Card ref={workshopScreenshotRef}>
                  <CardHeader>
                    <CardTitle className="text-base font-semibold flex items-center gap-2">
                      <Eye className="w-5 h-5 text-primary" />
                      Browser Screenshot
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="border rounded-lg overflow-hidden bg-muted">
                      <img 
                        src={workshopScreenshot} 
                        alt="Workshop Screenshot" 
                        className="w-full h-auto"
                      />
                    </div>
                    <p className="text-xs text-muted-foreground mt-2">
                      This is a snapshot. The actual browser window is interactive - use it directly or via the controls above.
                    </p>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
