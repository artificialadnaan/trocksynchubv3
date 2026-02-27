import { Link, useLocation } from "wouter";
import { useState } from "react";
import {
  LayoutDashboard,
  ArrowLeftRight,
  Webhook,
  FolderSync,
  ScrollText,
  Settings,
  LogOut,
  Zap,
  Database,
  Mail,
  Link2,
  Archive,
  BarChart3,
  Menu,
  X,
  FlaskConical,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";

const navItems = [
  { path: "/", label: "Dashboard", icon: LayoutDashboard },
  { path: "/sync-config", label: "Sync Config", icon: ArrowLeftRight },
  { path: "/webhooks", label: "Webhooks", icon: Webhook },
  { path: "/projects", label: "Projects", icon: FolderSync },
  { path: "/data-browser", label: "Data Browser", icon: Database },
  { path: "/project-sync", label: "Project Sync", icon: Link2 },
  { path: "/email-notifications", label: "Emails", icon: Mail },
  { path: "/project-archive", label: "Archive", icon: Archive },
  { path: "/reports", label: "Reports", icon: BarChart3 },
  { path: "/audit-logs", label: "Audit Logs", icon: ScrollText },
  { path: "/testing", label: "Testing", icon: FlaskConical },
  { path: "/settings", label: "Settings", icon: Settings },
];

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const [location] = useLocation();

  const handleLogout = async () => {
    await apiRequest("POST", "/api/auth/logout");
    queryClient.clear();
    window.location.href = "/";
  };

  return (
    <>
      <div className="p-4 md:p-5 border-b border-sidebar-border">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center flex-shrink-0">
            <Zap className="w-4 h-4 text-primary-foreground" />
          </div>
          <div className="min-w-0">
            <h1 className="text-base font-semibold text-sidebar-foreground leading-tight truncate">
              Trock Sync Hub
            </h1>
            <p className="text-xs text-muted-foreground">v2.0</p>
          </div>
        </div>
      </div>

      <nav className="flex-1 p-2 md:p-3 space-y-0.5 overflow-y-auto" data-testid="nav-menu">
        {navItems.map((item) => {
          const isActive =
            item.path === "/"
              ? location === "/"
              : location.startsWith(item.path);
          return (
            <Link key={item.path} href={item.path}>
              <div
                onClick={onNavigate}
                className={cn(
                  "flex items-center gap-3 px-3 py-3 md:py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer active:scale-[0.98]",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                )}
                data-testid={`nav-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
              >
                <item.icon className="w-5 h-5 md:w-4 md:h-4 flex-shrink-0" />
                <span className="truncate">{item.label}</span>
              </div>
            </Link>
          );
        })}
      </nav>

      <div className="p-2 md:p-3 border-t border-sidebar-border">
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 px-3 py-3 md:py-2.5 rounded-lg text-sm font-medium text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground w-full transition-colors active:scale-[0.98]"
          data-testid="button-logout"
        >
          <LogOut className="w-5 h-5 md:w-4 md:h-4 flex-shrink-0" />
          Sign Out
        </button>
      </div>
    </>
  );
}

export function MobileHeader() {
  const [open, setOpen] = useState(false);

  return (
    <header className="md:hidden sticky top-0 z-40 bg-sidebar border-b border-sidebar-border">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
            <Zap className="w-4 h-4 text-primary-foreground" />
          </div>
          <span className="text-base font-semibold text-sidebar-foreground">
            Trock Sync Hub
          </span>
        </div>
        
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="h-10 w-10">
              <Menu className="h-6 w-6" />
              <span className="sr-only">Toggle menu</span>
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-72 p-0 bg-sidebar">
            <div className="flex flex-col h-full">
              <SidebarContent onNavigate={() => setOpen(false)} />
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </header>
  );
}

export default function AppSidebar() {
  return (
    <aside
      className="hidden md:flex w-64 min-h-screen bg-sidebar border-r border-sidebar-border flex-col"
      data-testid="app-sidebar"
    >
      <SidebarContent />
    </aside>
  );
}
