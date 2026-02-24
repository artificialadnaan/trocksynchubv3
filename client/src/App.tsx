import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import AppSidebar from "@/components/app-sidebar";
import LoginPage from "@/pages/login";
import DashboardPage from "@/pages/dashboard";
import SyncConfigPage from "@/pages/sync-config";
import WebhooksPage from "@/pages/webhooks";
import ProjectsPage from "@/pages/projects";
import AuditLogsPage from "@/pages/audit-logs";
import SettingsPage from "@/pages/settings";
import HubspotDataPage from "@/pages/hubspot-data";
import ProcoreDataPage from "@/pages/procore-data";
import BidDetailPage from "@/pages/bid-detail";
import NotFound from "@/pages/not-found";
import { Skeleton } from "@/components/ui/skeleton";
import { getQueryFn } from "@/lib/queryClient";

function AuthenticatedLayout() {
  return (
    <div className="flex min-h-screen">
      <AppSidebar />
      <main className="flex-1 p-6 overflow-auto">
        <Switch>
          <Route path="/" component={DashboardPage} />
          <Route path="/sync-config" component={SyncConfigPage} />
          <Route path="/webhooks" component={WebhooksPage} />
          <Route path="/projects" component={ProjectsPage} />
          <Route path="/audit-logs" component={AuditLogsPage} />
          <Route path="/hubspot-data" component={HubspotDataPage} />
          <Route path="/procore-data" component={ProcoreDataPage} />
          <Route path="/procore-data/bids/:bidId" component={BidDetailPage} />
          <Route path="/settings" component={SettingsPage} />
          <Route component={NotFound} />
        </Switch>
      </main>
    </div>
  );
}

function AppContent() {
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
