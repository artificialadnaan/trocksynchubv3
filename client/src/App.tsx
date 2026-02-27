import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import AppSidebar, { MobileHeader } from "@/components/app-sidebar";
import LoginPage from "@/pages/login";
import DashboardPage from "@/pages/dashboard";
import SyncConfigPage from "@/pages/sync-config";
import WebhooksPage from "@/pages/webhooks";
import ProjectsPage from "@/pages/projects";
import AuditLogsPage from "@/pages/audit-logs";
import SettingsPage from "@/pages/settings";
import DataBrowserPage from "@/pages/data-browser";
import BidDetailPage from "@/pages/bid-detail";
import EmailNotificationsPage from "@/pages/email-notifications";
import ProjectSyncPage from "@/pages/project-sync";
import ProjectArchivePage from "@/pages/project-archive";
import SurveyPage from "@/pages/survey";
import ReportsPage from "@/pages/reports";
import TestingPage from "@/pages/testing";
import NotFound from "@/pages/not-found";
import { Skeleton } from "@/components/ui/skeleton";
import { getQueryFn } from "@/lib/queryClient";

function AuthenticatedLayout() {
  return (
    <div className="flex flex-col md:flex-row min-h-screen">
      <MobileHeader />
      <AppSidebar />
      <main className="flex-1 p-4 md:p-6 overflow-auto">
        <Switch>
          <Route path="/" component={DashboardPage} />
          <Route path="/sync-config" component={SyncConfigPage} />
          <Route path="/webhooks" component={WebhooksPage} />
          <Route path="/projects" component={ProjectsPage} />
          <Route path="/audit-logs" component={AuditLogsPage} />
          <Route path="/data-browser" component={DataBrowserPage} />
          <Route path="/procore-data/bids/:bidId" component={BidDetailPage} />
          <Route path="/project-sync" component={ProjectSyncPage} />
          <Route path="/email-notifications" component={EmailNotificationsPage} />
          <Route path="/project-archive" component={ProjectArchivePage} />
          <Route path="/reports" component={ReportsPage} />
          <Route path="/testing" component={TestingPage} />
          <Route path="/settings" component={SettingsPage} />
          <Route component={NotFound} />
        </Switch>
      </main>
    </div>
  );
}

function AppContent() {
  const [location] = useLocation();
  
  // Public routes that don't require authentication
  if (location.startsWith('/survey/')) {
    return <SurveyPage />;
  }

  const { data: user, isLoading } = useQuery<any>({
    queryKey: ["/api/auth/me"],
    queryFn: getQueryFn({ on401: "returnNull" }),
    retry: false,
    staleTime: 60000,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="space-y-4 w-64">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  return <AuthenticatedLayout />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <AppContent />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
