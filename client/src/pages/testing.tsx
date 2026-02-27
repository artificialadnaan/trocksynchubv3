import { useState } from 'react';
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

export default function TestingPage() {
  const queryClient = useQueryClient();
  const [testEmail, setTestEmail] = useState('adnaan.iqbal@gmail.com');
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [projectId, setProjectId] = useState('');
  const [screenshotResult, setScreenshotResult] = useState<string | null>(null);
  const [extractionResult, setExtractionResult] = useState<any>(null);

  // Fetch testing mode status
  const { data: testingMode, isLoading: loadingMode } = useQuery<TestingMode>({
    queryKey: ['/api/testing/mode'],
  });

  // Fetch Playwright status
  const { data: playwrightStatus, isLoading: loadingPlaywright } = useQuery<PlaywrightStatus>({
    queryKey: ['/api/testing/playwright/status'],
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
      if (!res.ok) throw new Error('Failed to capture screenshot');
      return res.json();
    },
    onSuccess: (data) => {
      if (data.screenshot) setScreenshotResult(data.screenshot);
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
      if (!res.ok) throw new Error('Failed to capture screenshot');
      return res.json();
    },
    onSuccess: (data) => {
      if (data.screenshot) setScreenshotResult(data.screenshot);
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
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-slate-100">Testing & Configuration</h1>
          <p className="text-slate-400 text-sm md:text-base">Test email notifications and Playwright automation</p>
        </div>
        {testingMode?.enabled && (
          <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 text-sm px-3 py-1">
            <AlertTriangle className="w-4 h-4 mr-2" />
            Testing Mode Active
          </Badge>
        )}
      </div>

      <Tabs defaultValue="email" className="space-y-4">
        <TabsList className="bg-slate-800/50 border border-slate-700/50 w-full md:w-auto">
          <TabsTrigger value="email" className="flex-1 md:flex-none data-[state=active]:bg-red-600">
            <Mail className="w-4 h-4 mr-2" />
            <span className="hidden sm:inline">Email Testing</span>
            <span className="sm:hidden">Email</span>
          </TabsTrigger>
          <TabsTrigger value="playwright" className="flex-1 md:flex-none data-[state=active]:bg-red-600">
            <Play className="w-4 h-4 mr-2" />
            <span className="hidden sm:inline">Playwright</span>
            <span className="sm:hidden">Browser</span>
          </TabsTrigger>
        </TabsList>

        {/* Email Testing Tab */}
        <TabsContent value="email" className="space-y-4">
          {/* Testing Mode Toggle */}
          <Card className="bg-slate-800/50 border-slate-700/50">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Settings className="w-5 h-5 text-amber-500" />
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
                  <div className="flex items-center justify-between p-4 bg-slate-900/50 rounded-lg border border-slate-700/50">
                    <div className="flex items-center gap-3">
                      <div className={`w-3 h-3 rounded-full ${testingMode?.enabled ? 'bg-amber-500 animate-pulse' : 'bg-slate-600'}`} />
                      <div>
                        <p className="font-medium text-slate-200">Testing Mode</p>
                        <p className="text-sm text-slate-400">
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
                        className="bg-slate-900/50 border-slate-700"
                      />
                      <Button
                        onClick={() => toggleTestingMode.mutate({ enabled: true, email: testEmail })}
                        disabled={toggleTestingMode.isPending || !testEmail}
                        variant="outline"
                        className="border-slate-700"
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
          <Card className="bg-slate-800/50 border-slate-700/50">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Mail className="w-5 h-5 text-blue-500" />
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
                    <SelectTrigger className="bg-slate-900/50 border-slate-700">
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
                    className="bg-slate-900/50 border-slate-700"
                  />
                </div>
              </div>
              
              <Button
                onClick={() => sendTestEmail.mutate({ templateKey: selectedTemplate, recipient: testEmail })}
                disabled={sendTestEmail.isPending || !selectedTemplate}
                className="w-full md:w-auto bg-gradient-to-r from-blue-600 to-blue-700"
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
                  <span className="text-green-400">Test email sent successfully via {sendTestEmail.data.provider}</span>
                </div>
              )}
              
              {sendTestEmail.isError && (
                <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg flex items-center gap-2">
                  <AlertCircle className="w-5 h-5 text-red-500" />
                  <span className="text-red-400">Failed to send test email</span>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Playwright Testing Tab */}
        <TabsContent value="playwright" className="space-y-4">
          {/* Playwright Status */}
          <Card className="bg-slate-800/50 border-slate-700/50">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Play className="w-5 h-5 text-purple-500" />
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
                  <div className="p-4 bg-slate-900/50 rounded-lg border border-slate-700/50">
                    <div className="flex items-center gap-2 mb-2">
                      {playwrightStatus?.playwrightInstalled ? (
                        <CheckCircle2 className="w-5 h-5 text-green-500" />
                      ) : (
                        <AlertCircle className="w-5 h-5 text-red-500" />
                      )}
                      <span className="font-medium text-slate-200">Playwright</span>
                    </div>
                    <p className="text-sm text-slate-400">
                      {playwrightStatus?.playwrightInstalled ? 'Installed' : 'Not installed'}
                    </p>
                  </div>
                  <div className="p-4 bg-slate-900/50 rounded-lg border border-slate-700/50">
                    <div className="flex items-center gap-2 mb-2">
                      {playwrightStatus?.browserAvailable ? (
                        <CheckCircle2 className="w-5 h-5 text-green-500" />
                      ) : (
                        <AlertCircle className="w-5 h-5 text-red-500" />
                      )}
                      <span className="font-medium text-slate-200">Browser</span>
                    </div>
                    <p className="text-sm text-slate-400">
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
          <Card className="bg-slate-800/50 border-slate-700/50">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <Camera className="w-5 h-5 text-cyan-500" />
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
                  className="bg-slate-900/50 border-slate-700"
                />
              </div>
              
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => bidboardScreenshot.mutate(projectId || undefined)}
                  disabled={bidboardScreenshot.isPending}
                  variant="outline"
                  className="border-slate-700"
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
                  className="border-slate-700"
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
          <Card className="bg-slate-800/50 border-slate-700/50">
            <CardHeader>
              <CardTitle className="text-lg flex items-center gap-2">
                <FileText className="w-5 h-5 text-orange-500" />
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
                  className="bg-slate-900/50 border-slate-700"
                />
              </div>
              
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => bidboardExtract.mutate(projectId)}
                  disabled={bidboardExtract.isPending || !projectId}
                  variant="outline"
                  className="border-slate-700"
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
                  className="border-slate-700"
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
                <div className="p-4 bg-slate-900/50 rounded-lg border border-slate-700/50 overflow-auto max-h-64">
                  <p className="text-sm font-medium text-slate-300 mb-2">Extraction Results:</p>
                  <pre className="text-xs text-slate-400 whitespace-pre-wrap">
                    {JSON.stringify(extractionResult, null, 2)}
                  </pre>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Screenshot Preview */}
          {screenshotResult && (
            <Card className="bg-slate-800/50 border-slate-700/50">
              <CardHeader>
                <CardTitle className="text-lg">Screenshot Preview</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="border border-slate-700 rounded-lg overflow-hidden">
                  <img 
                    src={screenshotResult} 
                    alt="Screenshot" 
                    className="w-full h-auto"
                  />
                </div>
                <Button
                  onClick={() => setScreenshotResult(null)}
                  variant="outline"
                  className="mt-4 border-slate-700"
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
