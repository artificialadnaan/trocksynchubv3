import { Link, useLocation } from "wouter";
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
  Camera,
  Mail,
  Link2,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

const navItems = [
  { path: "/", label: "Dashboard", icon: LayoutDashboard },
  { path: "/sync-config", label: "Sync Config", icon: ArrowLeftRight },
  { path: "/webhooks", label: "Webhook Monitor", icon: Webhook },
  { path: "/projects", label: "Project Mapper", icon: FolderSync },
  { path: "/hubspot-data", label: "HubSpot Data", icon: Database },
  { path: "/procore-data", label: "Procore Data", icon: Database },
  { path: "/companycam-data", label: "CompanyCam Data", icon: Camera },
  { path: "/project-sync", label: "Project Sync", icon: Link2 },
  { path: "/email-notifications", label: "Email Notifications", icon: Mail },
  { path: "/audit-logs", label: "Audit Logs", icon: ScrollText },
  { path: "/settings", label: "Settings", icon: Settings },
];

export default function AppSidebar() {
  const [location] = useLocation();

  const handleLogout = async () => {
    await apiRequest("POST", "/api/auth/logout");
    queryClient.clear();
    window.location.href = "/";
  };

  return (
    <aside
      className="w-64 min-h-screen bg-sidebar border-r border-sidebar-border flex flex-col"
      data-testid="app-sidebar"
    >
      <div className="p-5 border-b border-sidebar-border">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center">
            <Zap className="w-4 h-4 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-sidebar-foreground leading-tight">
              Trock Sync Hub
            </h1>
            <p className="text-xs text-muted-foreground">v2.0</p>
          </div>
        </div>
      </div>

      <nav className="flex-1 p-3 space-y-0.5" data-testid="nav-menu">
        {navItems.map((item) => {
          const isActive =
            item.path === "/"
              ? location === "/"
              : location.startsWith(item.path);
          return (
            <Link key={item.path} href={item.path}>
              <div
                className={cn(
                  "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                )}
                data-testid={`nav-${item.label.toLowerCase().replace(/\s+/g, "-")}`}
              >
                <item.icon className="w-4 h-4" />
                {item.label}
              </div>
            </Link>
          );
        })}
      </nav>

      <div className="p-3 border-t border-sidebar-border">
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground w-full transition-colors"
          data-testid="button-logout"
        >
          <LogOut className="w-4 h-4" />
          Sign Out
        </button>
      </div>
    </aside>
  );
}
