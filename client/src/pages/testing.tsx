import { useState, useRef, useEffect } from 'react';
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
import { AlertCircle, CheckCircle2, Mail, Play, Camera, FileText, Loader2, AlertTriangle, Settings } from 'lucide-react';
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
      if (!res.ok) throw new Error('Failed to extract documents');
      return res.json();
    },
    onSuccess: (data) => {
      setExtractionResult(data.data);
      if (data.data?.screenshot) setScreenshotResult(data.data.screenshot);
    },
  });

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
      </Tabs>
    </div>
  );
}
