import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Database,
  Building2,
  Truck,
  Users,
  History,
  Search,
  ChevronDown,
  RefreshCw,
  Gavel,
  FileText,
  ClipboardList,
} from "lucide-react";
import { useState } from "react";
import { format } from "date-fns";
import type {
  ProcoreProject,
  ProcoreVendor,
  ProcoreUser,
  ProcoreChangeHistory,
  ProcoreBidPackage,
  ProcoreBid,
  ProcoreBidForm,
} from "@shared/schema";

type TabType = "projects" | "vendors" | "users" | "bidPackages" | "bids" | "bidForms" | "history";

const tabs: { id: TabType; label: string; icon: any }[] = [
  { id: "projects", label: "Projects", icon: Building2 },
  { id: "vendors", label: "Vendors", icon: Truck },
  { id: "users", label: "Users", icon: Users },
  { id: "bidPackages", label: "Bid Packages", icon: Gavel },
  { id: "bids", label: "Bids", icon: FileText },
  { id: "bidForms", label: "Bid Forms", icon: ClipboardList },
  { id: "history", label: "Change History", icon: History },
];

export default function ProcoreDataPage() {
  const [activeTab, setActiveTab] = useState<TabType>("projects");

  const { data: counts, isLoading: countsLoading } = useQuery<{
    projects: number;
    vendors: number;
    users: number;
    changeHistory: number;
    bidPackages: number;
    bids: number;
    bidForms: number;
  }>({
    queryKey: ["/api/integrations/procore/data-counts"],
  });

  const countMap: Record<TabType, number> = {
    projects: counts?.projects || 0,
    vendors: counts?.vendors || 0,
    users: counts?.users || 0,
    bidPackages: counts?.bidPackages || 0,
    bids: counts?.bids || 0,
    bidForms: counts?.bidForms || 0,
    history: counts?.changeHistory || 0,
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold flex items-center gap-2" data-testid="text-procore-data-title">
          <Database className="w-6 h-6" />
          Procore Data
        </h2>
        <p className="text-muted-foreground text-sm mt-1">
          Browse all data from the last Procore sync with 2-week change history
        </p>
      </div>

      <div className="flex gap-2 border-b pb-0">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-[1px] ${
              activeTab === tab.id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30"
            }`}
            data-testid={`tab-procore-${tab.id}`}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
            {!countsLoading && (
              <Badge variant="secondary" className="text-xs ml-1 px-1.5 py-0">
                {countMap[tab.id].toLocaleString()}
              </Badge>
            )}
          </button>
        ))}
      </div>

      {activeTab === "projects" && <ProjectsTab />}
      {activeTab === "vendors" && <VendorsTab />}
      {activeTab === "users" && <UsersTab />}
      {activeTab === "bidPackages" && <BidPackagesTab />}
      {activeTab === "bids" && <BidsTab />}
      {activeTab === "bidForms" && <BidFormsTab />}
      {activeTab === "history" && <ChangeHistoryTab />}
    </div>
  );
}

function ProjectsTab() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const limit = 50;

  const params = new URLSearchParams();
  if (search) params.set("search", search);
  params.set("limit", String(limit));
  params.set("offset", String(page * limit));

  const { data, isLoading, refetch } = useQuery<{ data: ProcoreProject[]; total: number }>({
    queryKey: [`/api/procore/projects?${params.toString()}`],
  });

  const toggleExpand = (id: number) => {
    const next = new Set(expandedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpandedIds(next);
  };

  const formatValue = (val: string | null) => {
    if (!val) return "—";
    const num = parseFloat(val);
    if (isNaN(num)) return val;
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(num);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Building2 className="w-4 h-4" />
            Projects
            {data && <span className="text-xs font-normal text-muted-foreground">({data.total.toLocaleString()} total)</span>}
          </CardTitle>
          <div className="flex gap-2 items-center">
            <div className="relative">
              <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                placeholder="Search projects..."
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                className="h-8 w-[200px] pl-8 text-sm"
                data-testid="input-search-procore-projects"
              />
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-procore-projects">
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : !data?.data?.length ? (
          <p className="text-sm text-muted-foreground py-12 text-center">No projects found. Run a Procore sync from Settings to pull data.</p>
        ) : (
          <>
            <div className="rounded-lg border">
              <div className="grid grid-cols-[1.5fr_0.8fr_0.8fr_0.8fr_1fr_0.8fr_auto] gap-3 px-4 py-2.5 bg-muted/50 text-xs font-medium text-muted-foreground border-b">
                <span>Project Name</span>
                <span>Number</span>
                <span>Stage</span>
                <span>Status</span>
                <span>Location</span>
                <span>Value</span>
                <span className="w-8"></span>
              </div>
              {data.data.map((project) => (
                <Collapsible key={project.id} open={expandedIds.has(project.id)} onOpenChange={() => toggleExpand(project.id)}>
                  <CollapsibleTrigger className="w-full" data-testid={`procore-project-row-${project.id}`}>
                    <div className="grid grid-cols-[1.5fr_0.8fr_0.8fr_0.8fr_1fr_0.8fr_auto] gap-3 px-4 py-3 text-sm hover:bg-muted/30 transition-colors items-center border-b last:border-0">
                      <span className="font-medium truncate text-left">{project.name || "—"}</span>
                      <span className="text-muted-foreground truncate text-left">{project.projectNumber || "—"}</span>
                      <span className="text-left">
                        <Badge variant="outline" className="text-xs">{project.stage || "—"}</Badge>
                      </span>
                      <span className="text-left">
                        <Badge variant={project.active ? "secondary" : "outline"} className="text-xs">
                          {project.active ? "Active" : "Inactive"}
                        </Badge>
                      </span>
                      <span className="text-muted-foreground truncate text-left">
                        {[project.city, project.stateCode].filter(Boolean).join(", ") || "—"}
                      </span>
                      <span className="text-left font-medium">{formatValue(project.totalValue || project.estimatedValue)}</span>
                      <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${expandedIds.has(project.id) ? "rotate-180" : ""}`} />
                    </div>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="px-4 py-3 bg-muted/10 border-b space-y-2">
                      <div className="grid grid-cols-3 gap-4 text-sm">
                        <div><span className="text-muted-foreground">Procore ID:</span> <span className="font-mono text-xs ml-1">{project.procoreId}</span></div>
                        <div><span className="text-muted-foreground">Phone:</span> <span className="ml-1">{project.phone || "—"}</span></div>
                        <div><span className="text-muted-foreground">Address:</span> <span className="ml-1">{project.address || "—"}</span></div>
                        <div><span className="text-muted-foreground">ZIP:</span> <span className="ml-1">{project.zip || "—"}</span></div>
                        <div><span className="text-muted-foreground">Start Date:</span> <span className="ml-1">{project.startDate || "—"}</span></div>
                        <div><span className="text-muted-foreground">Completion Date:</span> <span className="ml-1">{project.completionDate || "—"}</span></div>
                        <div><span className="text-muted-foreground">Estimated Value:</span> <span className="ml-1">{formatValue(project.estimatedValue)}</span></div>
                        <div><span className="text-muted-foreground">Total Value:</span> <span className="ml-1">{formatValue(project.totalValue)}</span></div>
                        <div><span className="text-muted-foreground">Delivery Method:</span> <span className="ml-1">{project.deliveryMethod || "—"}</span></div>
                        <div><span className="text-muted-foreground">Company:</span> <span className="ml-1">{project.companyName || "—"}</span></div>
                        <div><span className="text-muted-foreground">Stage Name:</span> <span className="ml-1">{project.projectStageName || "—"}</span></div>
                        <div><span className="text-muted-foreground">Last Synced:</span> <span className="ml-1">{project.lastSyncedAt ? format(new Date(project.lastSyncedAt), "MMM d, h:mm a") : "—"}</span></div>
                      </div>
                      {!!project.properties && (
                        <details className="text-xs">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Raw Properties</summary>
                          <ScrollArea className="h-32 mt-1 rounded border bg-card p-2">
                            <pre className="font-mono whitespace-pre-wrap">{String(JSON.stringify(project.properties, null, 2))}</pre>
                          </ScrollArea>
                        </details>
                      )}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
            <Pagination page={page} setPage={setPage} total={data.total} limit={limit} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function VendorsTab() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const limit = 50;

  const params = new URLSearchParams();
  if (search) params.set("search", search);
  params.set("limit", String(limit));
  params.set("offset", String(page * limit));

  const { data, isLoading, refetch } = useQuery<{ data: ProcoreVendor[]; total: number }>({
    queryKey: [`/api/procore/vendors?${params.toString()}`],
  });

  const toggleExpand = (id: number) => {
    const next = new Set(expandedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpandedIds(next);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Truck className="w-4 h-4" />
            Vendors
            {data && <span className="text-xs font-normal text-muted-foreground">({data.total.toLocaleString()} total)</span>}
          </CardTitle>
          <div className="flex gap-2 items-center">
            <div className="relative">
              <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                placeholder="Search vendors..."
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                className="h-8 w-[200px] pl-8 text-sm"
                data-testid="input-search-procore-vendors"
              />
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-procore-vendors">
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : !data?.data?.length ? (
          <p className="text-sm text-muted-foreground py-12 text-center">No vendors found. Run a Procore sync from Settings to pull data.</p>
        ) : (
          <>
            <div className="rounded-lg border">
              <div className="grid grid-cols-[1.5fr_1fr_1fr_1fr_0.6fr_auto] gap-3 px-4 py-2.5 bg-muted/50 text-xs font-medium text-muted-foreground border-b">
                <span>Vendor Name</span>
                <span>Trade</span>
                <span>Email</span>
                <span>Phone</span>
                <span>Status</span>
                <span className="w-8"></span>
              </div>
              {data.data.map((vendor) => (
                <Collapsible key={vendor.id} open={expandedIds.has(vendor.id)} onOpenChange={() => toggleExpand(vendor.id)}>
                  <CollapsibleTrigger className="w-full" data-testid={`procore-vendor-row-${vendor.id}`}>
                    <div className="grid grid-cols-[1.5fr_1fr_1fr_1fr_0.6fr_auto] gap-3 px-4 py-3 text-sm hover:bg-muted/30 transition-colors items-center border-b last:border-0">
                      <span className="font-medium truncate text-left">{vendor.name || "—"}</span>
                      <span className="text-muted-foreground truncate text-left">{vendor.tradeName || "—"}</span>
                      <span className="text-muted-foreground truncate text-left">{vendor.emailAddress || "—"}</span>
                      <span className="text-muted-foreground truncate text-left">{vendor.businessPhone || "—"}</span>
                      <span className="text-left">
                        <Badge variant={vendor.isActive ? "secondary" : "outline"} className="text-xs">
                          {vendor.isActive ? "Active" : "Inactive"}
                        </Badge>
                      </span>
                      <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${expandedIds.has(vendor.id) ? "rotate-180" : ""}`} />
                    </div>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="px-4 py-3 bg-muted/10 border-b space-y-2">
                      <div className="grid grid-cols-3 gap-4 text-sm">
                        <div><span className="text-muted-foreground">Procore ID:</span> <span className="font-mono text-xs ml-1">{vendor.procoreId}</span></div>
                        <div><span className="text-muted-foreground">Legal Name:</span> <span className="ml-1">{vendor.legalName || "—"}</span></div>
                        <div><span className="text-muted-foreground">Abbreviated:</span> <span className="ml-1">{vendor.abbreviatedName || "—"}</span></div>
                        <div><span className="text-muted-foreground">Address:</span> <span className="ml-1">{vendor.address || "—"}</span></div>
                        <div><span className="text-muted-foreground">City:</span> <span className="ml-1">{[vendor.city, vendor.stateCode].filter(Boolean).join(", ") || "—"}</span></div>
                        <div><span className="text-muted-foreground">ZIP:</span> <span className="ml-1">{vendor.zip || "—"}</span></div>
                        <div><span className="text-muted-foreground">Mobile:</span> <span className="ml-1">{vendor.mobilePhone || "—"}</span></div>
                        <div><span className="text-muted-foreground">Fax:</span> <span className="ml-1">{vendor.faxNumber || "—"}</span></div>
                        <div><span className="text-muted-foreground">Website:</span> <span className="ml-1">{vendor.website || "—"}</span></div>
                        <div><span className="text-muted-foreground">License #:</span> <span className="ml-1">{vendor.licenseNumber || "—"}</span></div>
                        <div><span className="text-muted-foreground">Labor Union:</span> <span className="ml-1">{vendor.laborUnion || "—"}</span></div>
                        <div><span className="text-muted-foreground">Last Synced:</span> <span className="ml-1">{vendor.lastSyncedAt ? format(new Date(vendor.lastSyncedAt), "MMM d, h:mm a") : "—"}</span></div>
                      </div>
                      {!!vendor.properties && (
                        <details className="text-xs">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Raw Properties</summary>
                          <ScrollArea className="h-32 mt-1 rounded border bg-card p-2">
                            <pre className="font-mono whitespace-pre-wrap">{String(JSON.stringify(vendor.properties, null, 2))}</pre>
                          </ScrollArea>
                        </details>
                      )}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
            <Pagination page={page} setPage={setPage} total={data.total} limit={limit} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function UsersTab() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const limit = 50;

  const params = new URLSearchParams();
  if (search) params.set("search", search);
  params.set("limit", String(limit));
  params.set("offset", String(page * limit));

  const { data, isLoading, refetch } = useQuery<{ data: ProcoreUser[]; total: number }>({
    queryKey: [`/api/procore/users?${params.toString()}`],
  });

  const toggleExpand = (id: number) => {
    const next = new Set(expandedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpandedIds(next);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Users className="w-4 h-4" />
            Users
            {data && <span className="text-xs font-normal text-muted-foreground">({data.total.toLocaleString()} total)</span>}
          </CardTitle>
          <div className="flex gap-2 items-center">
            <div className="relative">
              <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                placeholder="Search users..."
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                className="h-8 w-[200px] pl-8 text-sm"
                data-testid="input-search-procore-users"
              />
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-procore-users">
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : !data?.data?.length ? (
          <p className="text-sm text-muted-foreground py-12 text-center">No users found. Run a Procore sync from Settings to pull data.</p>
        ) : (
          <>
            <div className="rounded-lg border">
              <div className="grid grid-cols-[1.2fr_1.2fr_1fr_1fr_0.6fr_auto] gap-3 px-4 py-2.5 bg-muted/50 text-xs font-medium text-muted-foreground border-b">
                <span>Name</span>
                <span>Email</span>
                <span>Job Title</span>
                <span>Phone</span>
                <span>Status</span>
                <span className="w-8"></span>
              </div>
              {data.data.map((user) => (
                <Collapsible key={user.id} open={expandedIds.has(user.id)} onOpenChange={() => toggleExpand(user.id)}>
                  <CollapsibleTrigger className="w-full" data-testid={`procore-user-row-${user.id}`}>
                    <div className="grid grid-cols-[1.2fr_1.2fr_1fr_1fr_0.6fr_auto] gap-3 px-4 py-3 text-sm hover:bg-muted/30 transition-colors items-center border-b last:border-0">
                      <span className="font-medium truncate text-left">{user.name || [user.firstName, user.lastName].filter(Boolean).join(" ") || "—"}</span>
                      <span className="text-muted-foreground truncate text-left">{user.emailAddress || "—"}</span>
                      <span className="text-muted-foreground truncate text-left">{user.jobTitle || "—"}</span>
                      <span className="text-muted-foreground truncate text-left">{user.businessPhone || user.mobilePhone || "—"}</span>
                      <span className="text-left">
                        <Badge variant={user.isActive ? "secondary" : "outline"} className="text-xs">
                          {user.isActive ? "Active" : "Inactive"}
                        </Badge>
                      </span>
                      <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${expandedIds.has(user.id) ? "rotate-180" : ""}`} />
                    </div>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="px-4 py-3 bg-muted/10 border-b space-y-2">
                      <div className="grid grid-cols-3 gap-4 text-sm">
                        <div><span className="text-muted-foreground">Procore ID:</span> <span className="font-mono text-xs ml-1">{user.procoreId}</span></div>
                        <div><span className="text-muted-foreground">First Name:</span> <span className="ml-1">{user.firstName || "—"}</span></div>
                        <div><span className="text-muted-foreground">Last Name:</span> <span className="ml-1">{user.lastName || "—"}</span></div>
                        <div><span className="text-muted-foreground">Mobile:</span> <span className="ml-1">{user.mobilePhone || "—"}</span></div>
                        <div><span className="text-muted-foreground">Address:</span> <span className="ml-1">{[user.address, user.city, user.stateCode].filter(Boolean).join(", ") || "—"}</span></div>
                        <div><span className="text-muted-foreground">ZIP:</span> <span className="ml-1">{user.zip || "—"}</span></div>
                        <div><span className="text-muted-foreground">Employee:</span> <span className="ml-1">{user.isEmployee ? "Yes" : "No"}</span></div>
                        <div><span className="text-muted-foreground">Employee ID:</span> <span className="ml-1">{user.employeeId || "—"}</span></div>
                        <div><span className="text-muted-foreground">Vendor:</span> <span className="ml-1">{user.vendorName || user.vendorId || "—"}</span></div>
                        <div><span className="text-muted-foreground">Last Login:</span> <span className="ml-1">{user.lastLoginAt || "—"}</span></div>
                        <div><span className="text-muted-foreground">Last Synced:</span> <span className="ml-1">{user.lastSyncedAt ? format(new Date(user.lastSyncedAt), "MMM d, h:mm a") : "—"}</span></div>
                      </div>
                      {!!user.properties && (
                        <details className="text-xs">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Raw Properties</summary>
                          <ScrollArea className="h-32 mt-1 rounded border bg-card p-2">
                            <pre className="font-mono whitespace-pre-wrap">{String(JSON.stringify(user.properties, null, 2))}</pre>
                          </ScrollArea>
                        </details>
                      )}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
            <Pagination page={page} setPage={setPage} total={data.total} limit={limit} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function BidPackagesTab() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const limit = 50;

  const params = new URLSearchParams();
  if (search) params.set("search", search);
  params.set("limit", String(limit));
  params.set("offset", String(page * limit));

  const { data, isLoading, refetch } = useQuery<{ data: ProcoreBidPackage[]; total: number }>({
    queryKey: [`/api/procore/bid-packages?${params.toString()}`],
  });

  const toggleExpand = (id: number) => {
    const next = new Set(expandedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpandedIds(next);
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return "—";
    try { return format(new Date(dateStr), "MMM d, yyyy"); } catch { return dateStr; }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Gavel className="w-4 h-4" />
            Bid Packages
            {data && <span className="text-xs font-normal text-muted-foreground">({data.total.toLocaleString()} total)</span>}
          </CardTitle>
          <div className="flex gap-2 items-center">
            <div className="relative">
              <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                placeholder="Search bid packages..."
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                className="h-8 w-[200px] pl-8 text-sm"
                data-testid="input-search-procore-bid-packages"
              />
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-procore-bid-packages">
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : !data?.data?.length ? (
          <p className="text-sm text-muted-foreground py-12 text-center">No bid packages found. Run a Procore sync to pull Bid Board data.</p>
        ) : (
          <>
            <div className="rounded-lg border">
              <div className="grid grid-cols-[1.5fr_1.2fr_0.8fr_0.8fr_0.6fr_0.6fr_auto] gap-3 px-4 py-2.5 bg-muted/50 text-xs font-medium text-muted-foreground border-b">
                <span>Title</span>
                <span>Project</span>
                <span>Due Date</span>
                <span>Status</span>
                <span>Invites</span>
                <span>Bids</span>
                <span className="w-8"></span>
              </div>
              {data.data.map((pkg) => (
                <Collapsible key={pkg.id} open={expandedIds.has(pkg.id)} onOpenChange={() => toggleExpand(pkg.id)}>
                  <CollapsibleTrigger className="w-full" data-testid={`procore-bid-package-row-${pkg.id}`}>
                    <div className="grid grid-cols-[1.5fr_1.2fr_0.8fr_0.8fr_0.6fr_0.6fr_auto] gap-3 px-4 py-3 text-sm hover:bg-muted/30 transition-colors items-center border-b last:border-0">
                      <span className="font-medium truncate text-left">{pkg.title || "—"}</span>
                      <span className="text-muted-foreground truncate text-left">{pkg.projectName || "—"}</span>
                      <span className="text-muted-foreground text-left">{formatDate(pkg.bidDueDate)}</span>
                      <span className="text-left">
                        <Badge variant={pkg.sealed ? "destructive" : "secondary"} className="text-xs">
                          {pkg.sealed ? "Sealed" : pkg.open ? "Open" : "Closed"}
                        </Badge>
                      </span>
                      <span className="text-center font-medium">{pkg.bidInvitesSentCount ?? 0}</span>
                      <span className="text-center font-medium">{pkg.bidsReceivedCount ?? 0}</span>
                      <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${expandedIds.has(pkg.id) ? "rotate-180" : ""}`} />
                    </div>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="mx-4 mb-2 p-3 rounded-lg border bg-muted/20 space-y-2">
                      <div className="grid grid-cols-2 gap-3 text-sm">
                        <div><span className="text-muted-foreground">Procore ID:</span> <span className="ml-1 font-mono text-xs">{pkg.procoreId}</span></div>
                        <div><span className="text-muted-foreground">Project ID:</span> <span className="ml-1 font-mono text-xs">{pkg.projectId || "—"}</span></div>
                        <div><span className="text-muted-foreground">Package #:</span> <span className="ml-1">{pkg.number ?? "—"}</span></div>
                        <div><span className="text-muted-foreground">Accounting:</span> <span className="ml-1">{pkg.accountingMethod || "—"}</span></div>
                        <div><span className="text-muted-foreground">Has Bid Docs:</span> <span className="ml-1">{pkg.hasBidDocs ? "Yes" : "No"}</span></div>
                        <div><span className="text-muted-foreground">Accept Late:</span> <span className="ml-1">{pkg.acceptPostDueSubmissions ? "Yes" : "No"}</span></div>
                        <div><span className="text-muted-foreground">Pre-bid Walkthrough:</span> <span className="ml-1">{pkg.enablePrebidWalkthrough ? "Yes" : "No"}</span></div>
                        <div><span className="text-muted-foreground">Pre-bid RFI:</span> <span className="ml-1">{pkg.enablePrebidRfiDeadline ? "Yes" : "No"}</span></div>
                      </div>
                      {pkg.projectLocation && (
                        <div className="text-sm"><span className="text-muted-foreground">Location:</span> <span className="ml-1">{pkg.projectLocation.replace(/<br\s*\/?>/gi, ", ").replace(/<[^>]*>/g, "")}</span></div>
                      )}
                      {!!pkg.properties && (
                        <details className="text-xs">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Full Data</summary>
                          <ScrollArea className="h-40 mt-1 rounded border bg-card p-2">
                            <pre className="font-mono whitespace-pre-wrap">{String(JSON.stringify(pkg.properties, null, 2))}</pre>
                          </ScrollArea>
                        </details>
                      )}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
            <Pagination page={page} setPage={setPage} total={data.total} limit={limit} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function BidsTab() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const limit = 50;

  const params = new URLSearchParams();
  if (search) params.set("search", search);
  if (statusFilter !== "all") params.set("bidStatus", statusFilter);
  params.set("limit", String(limit));
  params.set("offset", String(page * limit));

  const { data, isLoading, refetch } = useQuery<{ data: ProcoreBid[]; total: number }>({
    queryKey: [`/api/procore/bids?${params.toString()}`],
  });

  const toggleExpand = (id: number) => {
    const next = new Set(expandedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpandedIds(next);
  };

  const statusColor = (status: string | null) => {
    const colors: Record<string, string> = {
      submitted: "bg-green-500/10 text-green-600 border-green-500/20",
      will_bid: "bg-blue-500/10 text-blue-600 border-blue-500/20",
      will_not_bid: "bg-red-500/10 text-red-600 border-red-500/20",
      undecided: "bg-yellow-500/10 text-yellow-600 border-yellow-500/20",
    };
    return colors[status || ""] || "";
  };

  const formatAmount = (val: string | null) => {
    if (!val || val === "0") return "—";
    const num = parseFloat(val);
    if (isNaN(num)) return val;
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(num);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <FileText className="w-4 h-4" />
            Bids
            {data && <span className="text-xs font-normal text-muted-foreground">({data.total.toLocaleString()} total)</span>}
          </CardTitle>
          <div className="flex gap-2 items-center">
            <div className="relative">
              <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                placeholder="Search bids..."
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                className="h-8 w-[200px] pl-8 text-sm"
                data-testid="input-search-procore-bids"
              />
            </div>
            <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(0); }}>
              <SelectTrigger className="w-[140px] h-8" data-testid="filter-procore-bid-status">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Statuses</SelectItem>
                <SelectItem value="submitted">Submitted</SelectItem>
                <SelectItem value="will_bid">Will Bid</SelectItem>
                <SelectItem value="will_not_bid">Will Not Bid</SelectItem>
                <SelectItem value="undecided">Undecided</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-procore-bids">
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : !data?.data?.length ? (
          <p className="text-sm text-muted-foreground py-12 text-center">No bids found. Run a Procore sync to pull Bid Board data.</p>
        ) : (
          <>
            <div className="rounded-lg border">
              <div className="grid grid-cols-[1.2fr_1fr_1fr_0.8fr_0.7fr_0.6fr_auto] gap-3 px-4 py-2.5 bg-muted/50 text-xs font-medium text-muted-foreground border-b">
                <span>Vendor</span>
                <span>Bid Package</span>
                <span>Bid Form</span>
                <span>Status</span>
                <span>Amount</span>
                <span>Committed</span>
                <span className="w-8"></span>
              </div>
              {data.data.map((bid) => (
                <Collapsible key={bid.id} open={expandedIds.has(bid.id)} onOpenChange={() => toggleExpand(bid.id)}>
                  <CollapsibleTrigger className="w-full" data-testid={`procore-bid-row-${bid.id}`}>
                    <div className="grid grid-cols-[1.2fr_1fr_1fr_0.8fr_0.7fr_0.6fr_auto] gap-3 px-4 py-3 text-sm hover:bg-muted/30 transition-colors items-center border-b last:border-0">
                      <span className="font-medium truncate text-left">{bid.vendorName || "—"}</span>
                      <span className="text-muted-foreground truncate text-left">{bid.bidPackageTitle || "—"}</span>
                      <span className="text-muted-foreground truncate text-left">{bid.bidFormTitle || "—"}</span>
                      <span className="text-left">
                        <Badge className={`text-xs ${statusColor(bid.bidStatus)}`}>{bid.bidStatus?.replace(/_/g, " ") || "—"}</Badge>
                      </span>
                      <span className="text-left font-medium">{formatAmount(bid.lumpSumAmount)}</span>
                      <span className="text-center">
                        {bid.isBidderCommitted ? <Badge variant="secondary" className="text-xs">Yes</Badge> : <span className="text-muted-foreground text-xs">No</span>}
                      </span>
                      <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${expandedIds.has(bid.id) ? "rotate-180" : ""}`} />
                    </div>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="mx-4 mb-2 p-3 rounded-lg border bg-muted/20 space-y-2">
                      <div className="grid grid-cols-2 gap-3 text-sm">
                        <div><span className="text-muted-foreground">Procore ID:</span> <span className="ml-1 font-mono text-xs">{bid.procoreId}</span></div>
                        <div><span className="text-muted-foreground">Vendor ID:</span> <span className="ml-1 font-mono text-xs">{bid.vendorId || "—"}</span></div>
                        <div><span className="text-muted-foreground">Project:</span> <span className="ml-1">{bid.projectName || "—"}</span></div>
                        <div><span className="text-muted-foreground">Due Date:</span> <span className="ml-1">{bid.dueDate ? format(new Date(bid.dueDate), "MMM d, yyyy") : "—"}</span></div>
                        <div><span className="text-muted-foreground">Submitted:</span> <span className="ml-1">{bid.submitted ? "Yes" : "No"}</span></div>
                        <div><span className="text-muted-foreground">Awarded:</span> <span className="ml-1">{bid.awarded === true ? "Yes" : bid.awarded === false ? "No" : "Pending"}</span></div>
                        <div><span className="text-muted-foreground">Requester:</span> <span className="ml-1">{bid.bidRequesterName || "—"} {bid.bidRequesterEmail ? `(${bid.bidRequesterEmail})` : ""}</span></div>
                        <div><span className="text-muted-foreground">Company:</span> <span className="ml-1">{bid.bidRequesterCompany || "—"}</span></div>
                        <div><span className="text-muted-foreground">Invitation Sent:</span> <span className="ml-1">{bid.invitationLastSentAt ? format(new Date(bid.invitationLastSentAt), "MMM d, yyyy h:mm a") : "—"}</span></div>
                        <div><span className="text-muted-foreground">NDA Required:</span> <span className="ml-1">{bid.requireNda ? "Yes" : "No"}</span></div>
                      </div>
                      {bid.bidderComments && (
                        <div className="text-sm"><span className="text-muted-foreground">Comments:</span> <span className="ml-1">{bid.bidderComments}</span></div>
                      )}
                      {!!bid.properties && (
                        <details className="text-xs">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Full Data</summary>
                          <ScrollArea className="h-40 mt-1 rounded border bg-card p-2">
                            <pre className="font-mono whitespace-pre-wrap">{String(JSON.stringify(bid.properties, null, 2))}</pre>
                          </ScrollArea>
                        </details>
                      )}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
            <Pagination page={page} setPage={setPage} total={data.total} limit={limit} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function BidFormsTab() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const limit = 50;

  const params = new URLSearchParams();
  if (search) params.set("search", search);
  params.set("limit", String(limit));
  params.set("offset", String(page * limit));

  const { data, isLoading, refetch } = useQuery<{ data: ProcoreBidForm[]; total: number }>({
    queryKey: [`/api/procore/bid-forms?${params.toString()}`],
  });

  const toggleExpand = (id: number) => {
    const next = new Set(expandedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpandedIds(next);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <ClipboardList className="w-4 h-4" />
            Bid Forms
            {data && <span className="text-xs font-normal text-muted-foreground">({data.total.toLocaleString()} total)</span>}
          </CardTitle>
          <div className="flex gap-2 items-center">
            <div className="relative">
              <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                placeholder="Search bid forms..."
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                className="h-8 w-[200px] pl-8 text-sm"
                data-testid="input-search-procore-bid-forms"
              />
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-procore-bid-forms">
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : !data?.data?.length ? (
          <p className="text-sm text-muted-foreground py-12 text-center">No bid forms found. Run a Procore sync to pull Bid Board data.</p>
        ) : (
          <>
            <div className="rounded-lg border">
              <div className="grid grid-cols-[1.5fr_1fr_1fr_0.8fr_auto] gap-3 px-4 py-2.5 bg-muted/50 text-xs font-medium text-muted-foreground border-b">
                <span>Form Title</span>
                <span>Bid Package ID</span>
                <span>Project ID</span>
                <span>Proposal</span>
                <span className="w-8"></span>
              </div>
              {data.data.map((form) => (
                <Collapsible key={form.id} open={expandedIds.has(form.id)} onOpenChange={() => toggleExpand(form.id)}>
                  <CollapsibleTrigger className="w-full" data-testid={`procore-bid-form-row-${form.id}`}>
                    <div className="grid grid-cols-[1.5fr_1fr_1fr_0.8fr_auto] gap-3 px-4 py-3 text-sm hover:bg-muted/30 transition-colors items-center border-b last:border-0">
                      <span className="font-medium truncate text-left">{form.title || "—"}</span>
                      <span className="text-muted-foreground truncate text-left font-mono text-xs">{form.bidPackageId || "—"}</span>
                      <span className="text-muted-foreground truncate text-left font-mono text-xs">{form.projectId || "—"}</span>
                      <span className="text-muted-foreground text-left">{form.proposalName || "—"}</span>
                      <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${expandedIds.has(form.id) ? "rotate-180" : ""}`} />
                    </div>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="mx-4 mb-2 p-3 rounded-lg border bg-muted/20 space-y-2">
                      <div className="grid grid-cols-2 gap-3 text-sm">
                        <div><span className="text-muted-foreground">Procore ID:</span> <span className="ml-1 font-mono text-xs">{form.procoreId}</span></div>
                        <div><span className="text-muted-foreground">Proposal ID:</span> <span className="ml-1 font-mono text-xs">{form.proposalId || "—"}</span></div>
                      </div>
                      {!!form.properties && (
                        <details className="text-xs">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Full Data</summary>
                          <ScrollArea className="h-40 mt-1 rounded border bg-card p-2">
                            <pre className="font-mono whitespace-pre-wrap">{String(JSON.stringify(form.properties, null, 2))}</pre>
                          </ScrollArea>
                        </details>
                      )}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
            <Pagination page={page} setPage={setPage} total={data.total} limit={limit} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ChangeHistoryTab() {
  const [entityTypeFilter, setEntityTypeFilter] = useState("all");
  const [changeTypeFilter, setChangeTypeFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const limit = 50;

  const params = new URLSearchParams();
  if (entityTypeFilter !== "all") params.set("entityType", entityTypeFilter);
  if (changeTypeFilter !== "all") params.set("changeType", changeTypeFilter);
  params.set("limit", String(limit));
  params.set("offset", String(page * limit));

  const { data, isLoading, refetch } = useQuery<{ data: ProcoreChangeHistory[]; total: number }>({
    queryKey: [`/api/procore/change-history?${params.toString()}`],
  });

  const toggleExpand = (id: number) => {
    const next = new Set(expandedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpandedIds(next);
  };

  const changeTypeColor = (type: string) => {
    const colors: Record<string, string> = {
      created: "bg-green-500/10 text-green-600 border-green-500/20",
      updated: "bg-blue-500/10 text-blue-600 border-blue-500/20",
      field_changed: "bg-yellow-500/10 text-yellow-600 border-yellow-500/20",
    };
    return colors[type] || "";
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <History className="w-4 h-4" />
            Change History
            {data && <span className="text-xs font-normal text-muted-foreground">({data.total.toLocaleString()} total, 2-week rolling window)</span>}
          </CardTitle>
          <div className="flex gap-2 items-center">
            <Select value={entityTypeFilter} onValueChange={(v) => { setEntityTypeFilter(v); setPage(0); }}>
              <SelectTrigger className="w-[130px] h-8" data-testid="filter-procore-history-entity">
                <SelectValue placeholder="Entity Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                <SelectItem value="project">Projects</SelectItem>
                <SelectItem value="vendor">Vendors</SelectItem>
                <SelectItem value="user">Users</SelectItem>
                <SelectItem value="bid_package">Bid Packages</SelectItem>
              </SelectContent>
            </Select>
            <Select value={changeTypeFilter} onValueChange={(v) => { setChangeTypeFilter(v); setPage(0); }}>
              <SelectTrigger className="w-[130px] h-8" data-testid="filter-procore-history-change">
                <SelectValue placeholder="Change Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Changes</SelectItem>
                <SelectItem value="created">Created</SelectItem>
                <SelectItem value="updated">Updated</SelectItem>
                <SelectItem value="field_changed">Field Changed</SelectItem>
                <SelectItem value="synced">Synced</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-procore-history">
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : !data?.data?.length ? (
          <p className="text-sm text-muted-foreground py-12 text-center">No change history yet. Changes are recorded automatically during each Procore sync.</p>
        ) : (
          <>
            <div className="space-y-1">
              {data.data.map((entry) => (
                <Collapsible key={entry.id} open={expandedIds.has(entry.id)} onOpenChange={() => toggleExpand(entry.id)}>
                  <CollapsibleTrigger className="w-full" data-testid={`procore-history-row-${entry.id}`}>
                    <div className="flex items-center justify-between py-2.5 px-3 rounded-lg hover:bg-muted/30 transition-colors text-left">
                      <div className="flex items-center gap-3 flex-1">
                        <ChangeTypeDot type={entry.changeType} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium">
                            {entry.entityType} #{entry.entityProcoreId}
                            {entry.fieldName && <span className="text-muted-foreground font-normal"> — {entry.fieldName}</span>}
                          </p>
                          {entry.changeType === "field_changed" && (
                            <p className="text-xs text-muted-foreground truncate">
                              <span className="text-red-400 line-through">{entry.oldValue || "empty"}</span>
                              {" → "}
                              <span className="text-green-500">{entry.newValue || "empty"}</span>
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <Badge className={`text-xs ${changeTypeColor(entry.changeType)}`}>{entry.changeType}</Badge>
                        <Badge variant="outline" className="text-xs">{entry.entityType}</Badge>
                        <span className="text-xs text-muted-foreground whitespace-nowrap">
                          {entry.createdAt ? format(new Date(entry.createdAt), "MMM d, h:mm a") : ""}
                        </span>
                        <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${expandedIds.has(entry.id) ? "rotate-180" : ""}`} />
                      </div>
                    </div>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="ml-8 mr-3 mb-2 p-3 rounded-lg border bg-muted/20 space-y-2">
                      <div className="grid grid-cols-2 gap-3 text-sm">
                        <div><span className="text-muted-foreground">Entity Type:</span> <span className="ml-1 font-medium">{entry.entityType}</span></div>
                        <div><span className="text-muted-foreground">Procore ID:</span> <span className="ml-1 font-mono text-xs">{entry.entityProcoreId}</span></div>
                        {entry.fieldName && (
                          <div><span className="text-muted-foreground">Field:</span> <span className="ml-1">{entry.fieldName}</span></div>
                        )}
                        <div><span className="text-muted-foreground">Change Type:</span> <span className="ml-1">{entry.changeType}</span></div>
                      </div>
                      {entry.changeType === "field_changed" && (
                        <div className="grid grid-cols-2 gap-3 text-sm">
                          <div className="p-2 bg-red-500/5 rounded border border-red-500/10">
                            <span className="text-xs text-muted-foreground">Old Value:</span>
                            <p className="font-mono text-xs mt-0.5 break-all">{entry.oldValue || "—"}</p>
                          </div>
                          <div className="p-2 bg-green-500/5 rounded border border-green-500/10">
                            <span className="text-xs text-muted-foreground">New Value:</span>
                            <p className="font-mono text-xs mt-0.5 break-all">{entry.newValue || "—"}</p>
                          </div>
                        </div>
                      )}
                      {!!entry.fullSnapshot && (
                        <details className="text-xs">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Full Snapshot</summary>
                          <ScrollArea className="h-40 mt-1 rounded border bg-card p-2">
                            <pre className="font-mono whitespace-pre-wrap">{String(JSON.stringify(entry.fullSnapshot, null, 2))}</pre>
                          </ScrollArea>
                        </details>
                      )}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
            <Pagination page={page} setPage={setPage} total={data.total} limit={limit} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Pagination({ page, setPage, total, limit }: { page: number; setPage: (p: number) => void; total: number; limit: number }) {
  if (total <= limit) return null;
  return (
    <div className="flex items-center justify-between mt-4">
      <p className="text-xs text-muted-foreground">
        Showing {page * limit + 1}-{Math.min((page + 1) * limit, total)} of {total.toLocaleString()}
      </p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)} data-testid="button-procore-prev-page">
          Previous
        </Button>
        <Button variant="outline" size="sm" disabled={(page + 1) * limit >= total} onClick={() => setPage(page + 1)} data-testid="button-procore-next-page">
          Next
        </Button>
      </div>
    </div>
  );
}

function ChangeTypeDot({ type }: { type: string }) {
  const color = type === "created" ? "bg-green-500" : type === "field_changed" ? "bg-yellow-500" : "bg-blue-500";
  return <div className={`w-2 h-2 rounded-full ${color} flex-shrink-0`} />;
}
