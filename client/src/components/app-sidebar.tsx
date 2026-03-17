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
  Database,
  Mail,
  Link2,
  Archive,
  BarChart3,
  Menu,
  FlaskConical,
  Activity,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";

const navGroups = [
  {
    label: "Overview",
    items: [
      { path: "/", label: "Dashboard", icon: LayoutDashboard },
    ],
  },
  {
    label: "Operations",
    items: [
      { path: "/sync-config", label: "Sync Config", icon: ArrowLeftRight },
      { path: "/webhooks", label: "Webhooks", icon: Webhook },
      { path: "/projects", label: "Projects", icon: FolderSync },
      { path: "/project-sync", label: "Project Sync", icon: Link2 },
    ],
  },
  {
    label: "Data",
    items: [
      { path: "/data-browser", label: "Data Browser", icon: Database },
      { path: "/data-health", label: "Data Health", icon: Activity },
    ],
  },
  {
    label: "Outputs",
    items: [
      { path: "/email-notifications", label: "Emails", icon: Mail },
      { path: "/project-archive", label: "Archive", icon: Archive },
      { path: "/reports", label: "Reports", icon: BarChart3 },
    ],
  },
  {
    label: "System",
    items: [
      { path: "/audit-logs", label: "Audit Logs", icon: ScrollText },
      { path: "/testing", label: "Testing", icon: FlaskConical },
      { path: "/settings", label: "Settings", icon: Settings },
    ],
  },
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
      {/* Red accent bar */}
      <div className="h-0.5 bg-primary flex-shrink-0" />

      {/* Logo header */}
      <div className="px-5 py-5 flex-shrink-0">
        <div className="flex items-center gap-3">
          <img src="/favicon.png" alt="T-Rock" className="w-9 h-9 flex-shrink-0" />
          <div className="min-w-0">
            <h1 className="text-[13px] font-bold text-sidebar-foreground leading-none tracking-tight truncate">
              T-Rock Construction
            </h1>
            <p className="text-[10px] font-medium text-sidebar-foreground/30 tracking-widest uppercase mt-1">
              Sync Hub
            </p>
          </div>
        </div>
      </div>

      {/* Nav groups */}
      <nav className="flex-1 px-3 pb-3 space-y-5 overflow-y-auto" data-testid="nav-menu">
        {navGroups.map((group) => (
          <div key={group.label}>
            <p className="px-3 mb-1.5 text-[10px] font-semibold tracking-widest uppercase text-sidebar-foreground/25">
              {group.label}
            </p>
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const isActive =
                  item.path === "/"
                    ? location === "/"
                    : location.startsWith(item.path);
                return (
                  <Link key={item.path} href={item.path}>
                    <div
                      onClick={onNavigate}
                      className={cn(
                        "flex items-center gap-3 px-3 py-2 md:py-[7px] rounded-md text-[13px] font-medium transition-all cursor-pointer active:scale-[0.98]",
                        isActive
                          ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm border-l-2 border-primary ml-0 pl-[10px]"
                          : "text-sidebar-foreground/50 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground/80 border-l-2 border-transparent ml-0 pl-[10px]"
                      )}
                      data-testid={`nav-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
                    >
                      <item.icon className={cn(
                        "w-4 h-4 flex-shrink-0",
                        isActive ? "text-primary" : ""
                      )} />
                      <span className="truncate">{item.label}</span>
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Sign out */}
      <div className="p-3 border-t border-sidebar-border flex-shrink-0">
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 px-3 py-2 rounded-md text-[13px] font-medium text-sidebar-foreground/35 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground/70 w-full transition-colors active:scale-[0.98]"
          data-testid="button-logout"
        >
          <LogOut className="w-4 h-4 flex-shrink-0" />
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
      {/* Red accent bar */}
      <div className="h-0.5 bg-primary" />
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2.5">
          <img src="/favicon.png" alt="T-Rock" className="w-8 h-8" />
          <div>
            <span className="text-[13px] font-bold text-sidebar-foreground leading-none block">
              T-Rock Construction
            </span>
            <span className="text-[10px] font-medium text-sidebar-foreground/30 tracking-widest uppercase">
              Sync Hub
            </span>
          </div>
        </div>

        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" className="h-10 w-10 text-sidebar-foreground/60 hover:text-sidebar-foreground">
              <Menu className="h-5 w-5" />
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
      className="hidden md:flex w-60 min-h-screen bg-sidebar flex-col flex-shrink-0"
      data-testid="app-sidebar"
    >
      <SidebarContent />
    </aside>
  );
}
