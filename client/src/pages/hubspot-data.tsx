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
  Users,
  Handshake,
  GitBranch,
  History,
  Search,
  ChevronDown,
  RefreshCw,
} from "lucide-react";
import { useState } from "react";
import { format } from "date-fns";
import type {
  HubspotCompany,
  HubspotContact,
  HubspotDeal,
  HubspotPipeline,
  HubspotChangeHistory,
} from "@shared/schema";

type TabType = "companies" | "contacts" | "deals" | "pipelines" | "history";

const tabs: { id: TabType; label: string; icon: any }[] = [
  { id: "companies", label: "Companies", icon: Building2 },
  { id: "contacts", label: "Contacts", icon: Users },
  { id: "deals", label: "Deals", icon: Handshake },
  { id: "pipelines", label: "Pipelines", icon: GitBranch },
  { id: "history", label: "Change History", icon: History },
];

export default function HubspotDataPage() {
  const [activeTab, setActiveTab] = useState<TabType>("companies");

  const { data: counts, isLoading: countsLoading } = useQuery<{
    companies: number;
    contacts: number;
    deals: number;
    pipelines: number;
    changeHistory: number;
  }>({
    queryKey: ["/api/integrations/hubspot/data-counts"],
  });

  const countMap: Record<TabType, number> = {
    companies: counts?.companies || 0,
    contacts: counts?.contacts || 0,
    deals: counts?.deals || 0,
    pipelines: counts?.pipelines || 0,
    history: counts?.changeHistory || 0,
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold flex items-center gap-2" data-testid="text-hubspot-data-title">
          <Database className="w-6 h-6" />
          HubSpot Data
        </h2>
        <p className="text-muted-foreground text-sm mt-1">
          Browse all data from the last HubSpot sync with 2-week change history
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
            data-testid={`tab-${tab.id}`}
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

      {activeTab === "companies" && <CompaniesTab />}
      {activeTab === "contacts" && <ContactsTab />}
      {activeTab === "deals" && <DealsTab />}
      {activeTab === "pipelines" && <PipelinesTab />}
      {activeTab === "history" && <ChangeHistoryTab />}
    </div>
  );
}

function CompaniesTab() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const limit = 50;

  const params = new URLSearchParams();
  if (search) params.set("search", search);
  params.set("limit", String(limit));
  params.set("offset", String(page * limit));

  const { data, isLoading, refetch } = useQuery<{ data: HubspotCompany[]; total: number }>({
    queryKey: [`/api/hubspot/companies?${params.toString()}`],
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
            <Building2 className="w-4 h-4" />
            Companies
            {data && <span className="text-xs font-normal text-muted-foreground">({data.total.toLocaleString()} total)</span>}
          </CardTitle>
          <div className="flex gap-2 items-center">
            <div className="relative">
              <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                placeholder="Search companies..."
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                className="h-8 w-[200px] pl-8 text-sm"
                data-testid="input-search-companies"
              />
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-companies">
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : !data?.data?.length ? (
          <p className="text-sm text-muted-foreground py-12 text-center">No companies found. Run a HubSpot sync from Settings to pull data.</p>
        ) : (
          <>
            <div className="rounded-lg border">
              <div className="grid grid-cols-[1fr_1fr_1fr_1fr_auto] gap-3 px-4 py-2.5 bg-muted/50 text-xs font-medium text-muted-foreground border-b">
                <span>Company Name</span>
                <span>Domain</span>
                <span>Industry</span>
                <span>Location</span>
                <span className="w-8"></span>
              </div>
              {data.data.map((company) => (
                <Collapsible key={company.id} open={expandedIds.has(company.id)} onOpenChange={() => toggleExpand(company.id)}>
                  <CollapsibleTrigger className="w-full" data-testid={`company-row-${company.id}`}>
                    <div className="grid grid-cols-[1fr_1fr_1fr_1fr_auto] gap-3 px-4 py-3 text-sm hover:bg-muted/30 transition-colors items-center border-b last:border-0">
                      <span className="font-medium truncate text-left">{company.name || "—"}</span>
                      <span className="text-muted-foreground truncate text-left">{company.domain || "—"}</span>
                      <span className="text-muted-foreground truncate text-left">{company.industry || "—"}</span>
                      <span className="text-muted-foreground truncate text-left">
                        {[company.city, company.state].filter(Boolean).join(", ") || "—"}
                      </span>
                      <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${expandedIds.has(company.id) ? "rotate-180" : ""}`} />
                    </div>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="px-4 py-3 bg-muted/10 border-b space-y-2">
                      <div className="grid grid-cols-3 gap-4 text-sm">
                        <div><span className="text-muted-foreground">HubSpot ID:</span> <span className="font-mono text-xs ml-1">{company.hubspotId}</span></div>
                        <div><span className="text-muted-foreground">Phone:</span> <span className="ml-1">{company.phone || "—"}</span></div>
                        <div><span className="text-muted-foreground">Address:</span> <span className="ml-1">{company.address || "—"}</span></div>
                        <div><span className="text-muted-foreground">ZIP:</span> <span className="ml-1">{company.zip || "—"}</span></div>
                        <div><span className="text-muted-foreground">Owner ID:</span> <span className="ml-1">{company.ownerId || "—"}</span></div>
                        <div><span className="text-muted-foreground">Last Synced:</span> <span className="ml-1">{company.lastSyncedAt ? format(new Date(company.lastSyncedAt), "MMM d, h:mm a") : "—"}</span></div>
                      </div>
                      {!!company.properties && (
                        <details className="text-xs">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Raw Properties</summary>
                          <ScrollArea className="h-32 mt-1 rounded border bg-card p-2">
                            <pre className="font-mono whitespace-pre-wrap">{String(JSON.stringify(company.properties, null, 2))}</pre>
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

function ContactsTab() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const limit = 50;

  const params = new URLSearchParams();
  if (search) params.set("search", search);
  params.set("limit", String(limit));
  params.set("offset", String(page * limit));

  const { data, isLoading, refetch } = useQuery<{ data: HubspotContact[]; total: number }>({
    queryKey: [`/api/hubspot/contacts?${params.toString()}`],
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
            Contacts
            {data && <span className="text-xs font-normal text-muted-foreground">({data.total.toLocaleString()} total)</span>}
          </CardTitle>
          <div className="flex gap-2 items-center">
            <div className="relative">
              <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                placeholder="Search contacts..."
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                className="h-8 w-[200px] pl-8 text-sm"
                data-testid="input-search-contacts"
              />
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-contacts">
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : !data?.data?.length ? (
          <p className="text-sm text-muted-foreground py-12 text-center">No contacts found. Run a HubSpot sync from Settings to pull data.</p>
        ) : (
          <>
            <div className="rounded-lg border">
              <div className="grid grid-cols-[1fr_1fr_1fr_1fr_1fr_auto] gap-3 px-4 py-2.5 bg-muted/50 text-xs font-medium text-muted-foreground border-b">
                <span>Name</span>
                <span>Email</span>
                <span>Contact Owner</span>
                <span>Primary Company</span>
                <span>Job Title</span>
                <span className="w-8"></span>
              </div>
              {data.data.map((contact) => (
                <Collapsible key={contact.id} open={expandedIds.has(contact.id)} onOpenChange={() => toggleExpand(contact.id)}>
                  <CollapsibleTrigger className="w-full" data-testid={`contact-row-${contact.id}`}>
                    <div className="grid grid-cols-[1fr_1fr_1fr_1fr_1fr_auto] gap-3 px-4 py-3 text-sm hover:bg-muted/30 transition-colors items-center border-b last:border-0">
                      <span className="font-medium truncate text-left">{[contact.firstName, contact.lastName].filter(Boolean).join(" ") || "—"}</span>
                      <span className="text-muted-foreground truncate text-left">{contact.email || "—"}</span>
                      <span className="text-muted-foreground truncate text-left" data-testid={`contact-owner-${contact.id}`}>{contact.ownerName || (contact.ownerId ? `Owner #${contact.ownerId}` : "No owner")}</span>
                      <span className="text-muted-foreground truncate text-left" data-testid={`contact-company-${contact.id}`}>{contact.associatedCompanyName || contact.company || "—"}</span>
                      <span className="text-muted-foreground truncate text-left">{contact.jobTitle || "—"}</span>
                      <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${expandedIds.has(contact.id) ? "rotate-180" : ""}`} />
                    </div>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="px-4 py-3 bg-muted/10 border-b space-y-2">
                      <div className="grid grid-cols-3 gap-4 text-sm">
                        <div><span className="text-muted-foreground">HubSpot ID:</span> <span className="font-mono text-xs ml-1">{contact.hubspotId}</span></div>
                        <div><span className="text-muted-foreground">Phone:</span> <span className="ml-1">{contact.phone || "—"}</span></div>
                        <div><span className="text-muted-foreground">Lifecycle Stage:</span> <span className="ml-1">{contact.lifecycleStage || "—"}</span></div>
                        <div><span className="text-muted-foreground">Contact Owner:</span> <span className="ml-1">{contact.ownerName || (contact.ownerId ? `Owner #${contact.ownerId}` : "—")}</span></div>
                        <div><span className="text-muted-foreground">Primary Company:</span> <span className="ml-1">{contact.associatedCompanyName || contact.associatedCompanyId || "—"}</span></div>
                        <div><span className="text-muted-foreground">Last Synced:</span> <span className="ml-1">{contact.lastSyncedAt ? format(new Date(contact.lastSyncedAt), "MMM d, h:mm a") : "—"}</span></div>
                      </div>
                      {!!contact.properties && (
                        <details className="text-xs">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Raw Properties</summary>
                          <ScrollArea className="h-32 mt-1 rounded border bg-card p-2">
                            <pre className="font-mono whitespace-pre-wrap">{String(JSON.stringify(contact.properties, null, 2))}</pre>
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

function DealsTab() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const limit = 50;

  const params = new URLSearchParams();
  if (search) params.set("search", search);
  params.set("limit", String(limit));
  params.set("offset", String(page * limit));

  const { data, isLoading, refetch } = useQuery<{ data: HubspotDeal[]; total: number }>({
    queryKey: [`/api/hubspot/deals?${params.toString()}`],
  });

  const toggleExpand = (id: number) => {
    const next = new Set(expandedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setExpandedIds(next);
  };

  const formatAmount = (amount: string | null) => {
    if (!amount) return "—";
    const num = parseFloat(amount);
    if (isNaN(num)) return amount;
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(num);
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Handshake className="w-4 h-4" />
            Deals
            {data && <span className="text-xs font-normal text-muted-foreground">({data.total.toLocaleString()} total)</span>}
          </CardTitle>
          <div className="flex gap-2 items-center">
            <div className="relative">
              <Search className="absolute left-2.5 top-2 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                placeholder="Search deals..."
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                className="h-8 w-[200px] pl-8 text-sm"
                data-testid="input-search-deals"
              />
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-deals">
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : !data?.data?.length ? (
          <p className="text-sm text-muted-foreground py-12 text-center">No deals found. Run a HubSpot sync from Settings to pull data.</p>
        ) : (
          <>
            <div className="rounded-lg border">
              <div className="grid grid-cols-[1.5fr_0.8fr_1fr_1fr_1fr_auto] gap-3 px-4 py-2.5 bg-muted/50 text-xs font-medium text-muted-foreground border-b">
                <span>Deal Name</span>
                <span>Amount</span>
                <span>Stage</span>
                <span>Pipeline</span>
                <span>Company</span>
                <span className="w-8"></span>
              </div>
              {data.data.map((deal) => (
                <Collapsible key={deal.id} open={expandedIds.has(deal.id)} onOpenChange={() => toggleExpand(deal.id)}>
                  <CollapsibleTrigger className="w-full" data-testid={`deal-row-${deal.id}`}>
                    <div className="grid grid-cols-[1.5fr_0.8fr_1fr_1fr_1fr_auto] gap-3 px-4 py-3 text-sm hover:bg-muted/30 transition-colors items-center border-b last:border-0">
                      <span className="font-medium truncate text-left">{deal.dealName || "—"}</span>
                      <span className="text-left font-medium">{formatAmount(deal.amount)}</span>
                      <span className="text-left">
                        <Badge variant="outline" className="text-xs">{deal.dealStageName || deal.dealStage || "—"}</Badge>
                      </span>
                      <span className="text-muted-foreground truncate text-left">{deal.pipelineName || deal.pipeline || "—"}</span>
                      <span className="text-muted-foreground truncate text-left" data-testid={`deal-company-${deal.id}`}>{deal.associatedCompanyName || "—"}</span>
                      <ChevronDown className={`w-4 h-4 text-muted-foreground transition-transform ${expandedIds.has(deal.id) ? "rotate-180" : ""}`} />
                    </div>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="px-4 py-3 bg-muted/10 border-b space-y-2">
                      <div className="grid grid-cols-3 gap-4 text-sm">
                        <div><span className="text-muted-foreground">HubSpot ID:</span> <span className="font-mono text-xs ml-1">{deal.hubspotId}</span></div>
                        <div><span className="text-muted-foreground">Close Date:</span> <span className="ml-1">{deal.closeDate || "—"}</span></div>
                        <div><span className="text-muted-foreground">Deal Owner:</span> <span className="ml-1">{deal.ownerName || (deal.ownerId ? `Owner #${deal.ownerId}` : "—")}</span></div>
                        <div><span className="text-muted-foreground">Associated Company:</span> <span className="ml-1">{deal.associatedCompanyName || deal.associatedCompanyId || "—"}</span></div>
                        <div><span className="text-muted-foreground">Associated Contacts:</span> <span className="ml-1">{deal.associatedContactIds || "—"}</span></div>
                        <div><span className="text-muted-foreground">Last Synced:</span> <span className="ml-1">{deal.lastSyncedAt ? format(new Date(deal.lastSyncedAt), "MMM d, h:mm a") : "—"}</span></div>
                      </div>
                      {!!deal.properties && (
                        <details className="text-xs">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">Raw Properties</summary>
                          <ScrollArea className="h-32 mt-1 rounded border bg-card p-2">
                            <pre className="font-mono whitespace-pre-wrap">{String(JSON.stringify(deal.properties, null, 2))}</pre>
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

function PipelinesTab() {
  const { data: pipelines, isLoading } = useQuery<HubspotPipeline[]>({
    queryKey: ["/api/hubspot/pipelines"],
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <GitBranch className="w-4 h-4" />
          Pipelines & Deal Stages
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : !pipelines?.length ? (
          <p className="text-sm text-muted-foreground py-12 text-center">No pipelines found. Run a HubSpot sync from Settings to pull data.</p>
        ) : (
          <div className="space-y-4">
            {pipelines.map((pipeline) => {
              const stages = (pipeline.stages as any[]) || [];
              return (
                <div key={pipeline.id} className="rounded-lg border" data-testid={`pipeline-${pipeline.id}`}>
                  <div className="px-4 py-3 bg-muted/50 border-b flex items-center justify-between">
                    <div>
                      <span className="text-sm font-semibold">{pipeline.label}</span>
                      <span className="text-xs text-muted-foreground ml-2">(ID: {pipeline.hubspotId})</span>
                    </div>
                    <Badge variant="secondary" className="text-xs">{stages.length} stages</Badge>
                  </div>
                  {stages.length > 0 && (
                    <div className="divide-y">
                      {stages.map((stage: any, idx: number) => (
                        <div key={stage.id || idx} className="px-4 py-2.5 flex items-center justify-between text-sm">
                          <div className="flex items-center gap-3">
                            <span className="w-6 h-6 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-medium">
                              {idx + 1}
                            </span>
                            <span className="font-medium">{stage.label}</span>
                          </div>
                          <span className="text-xs text-muted-foreground font-mono">{stage.id}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
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

  const { data, isLoading, refetch } = useQuery<{ data: HubspotChangeHistory[]; total: number }>({
    queryKey: [`/api/hubspot/change-history?${params.toString()}`],
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
              <SelectTrigger className="w-[130px] h-8" data-testid="filter-history-entity">
                <SelectValue placeholder="Entity Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                <SelectItem value="company">Companies</SelectItem>
                <SelectItem value="contact">Contacts</SelectItem>
                <SelectItem value="deal">Deals</SelectItem>
              </SelectContent>
            </Select>
            <Select value={changeTypeFilter} onValueChange={(v) => { setChangeTypeFilter(v); setPage(0); }}>
              <SelectTrigger className="w-[130px] h-8" data-testid="filter-history-change">
                <SelectValue placeholder="Change Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Changes</SelectItem>
                <SelectItem value="created">Created</SelectItem>
                <SelectItem value="updated">Updated</SelectItem>
                <SelectItem value="field_changed">Field Changed</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-refresh-history">
              <RefreshCw className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : !data?.data?.length ? (
          <p className="text-sm text-muted-foreground py-12 text-center">No change history yet. Changes are recorded automatically during each HubSpot sync.</p>
        ) : (
          <>
            <div className="space-y-1">
              {data.data.map((entry) => (
                <Collapsible key={entry.id} open={expandedIds.has(entry.id)} onOpenChange={() => toggleExpand(entry.id)}>
                  <CollapsibleTrigger className="w-full" data-testid={`history-row-${entry.id}`}>
                    <div className="flex items-center justify-between py-2.5 px-3 rounded-lg hover:bg-muted/30 transition-colors text-left">
                      <div className="flex items-center gap-3 flex-1">
                        <ChangeTypeDot type={entry.changeType} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium">
                            {entry.entityType} #{entry.entityHubspotId}
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
                        <div><span className="text-muted-foreground">HubSpot ID:</span> <span className="ml-1 font-mono text-xs">{entry.entityHubspotId}</span></div>
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
        <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(page - 1)} data-testid="button-prev-page">
          Previous
        </Button>
        <Button variant="outline" size="sm" disabled={(page + 1) * limit >= total} onClick={() => setPage(page + 1)} data-testid="button-next-page">
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
