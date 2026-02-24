import { useQuery, useMutation } from "@tanstack/react-query";
import { useRoute, useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowLeft,
  FileText,
  Download,
  DollarSign,
  User,
  Building2,
  Calendar,
  Paperclip,
  MessageSquare,
  CheckCircle2,
  XCircle,
  Clock,
  Gavel,
  Hash,
  ExternalLink,
  ListChecks,
  ShieldCheck,
  ShieldX,
} from "lucide-react";
import { format } from "date-fns";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface BidItem {
  id: number;
  bid_form_item_id: number;
  cost_code_id: number;
  cost_code_name: string;
  cost_code_number: string;
  position: number;
  amount: number;
  unit_cost: string;
  quantity: string;
  uom: string;
  included: boolean;
}

interface Attachment {
  id: number;
  item_type: string;
  item_id: number;
  prostore_file_id: number;
  url: string;
  name: string;
}

interface CostCode {
  id: number;
  name: string;
}

interface BidDetail {
  id: number;
  bid_package_id: number;
  awarded: boolean | null;
  bid_status: string;
  is_bidder_committed: boolean;
  lump_sum_enabled: boolean;
  submitted: boolean;
  created_at: string;
  updated_at: string;
  show_bid_in_estimating: boolean;
  lump_sum_amount: number;
  bidder_comments: string | null;
  deleted_at: string | null;
  recipient_list: { first: string; last: string; email: string; numbers: string }[];
  recipient_list_with_email_and_number: string[];
  mailto: string;
  links: Record<string, string | null>;
  bidders_can_add_line_items: boolean;
  bid_convertible_to_subcontract: boolean;
  bid_convertible_to_purchase_order: boolean;
  contract_button_disabled_reason: string | null;
  po_button_disabled_reason: string | null;
  bid_items: BidItem[];
  attachments: Attachment[];
  bidder_notes: string | null;
  attachments_count: number;
  bidder_inclusion: string | null;
  bidder_exclusion: string | null;
  attachments_zip_streaming_url: string | null;
  require_nda: boolean;
  bid_package_title: string;
  company_id: number;
  invitation_last_sent_at: string | null;
  bid_requester: {
    company: string;
    contact: string;
    company_address: string;
    company_phone: string;
    company_website: string | null;
    email_address: string;
    first_name: string;
    last_name: string;
    mobile_phone: string | null;
    vendor_address: string;
    business_phone: string | null;
    fax_number: string;
  };
  bid_form_title: string;
  bid_form_id: number;
  nda_email_last_sent_at: string | null;
  project: { name: string; address: string };
  display_project_name: boolean;
  nda_first_name: string | null;
  nda_last_name: string | null;
  nda_updated_at: string | null;
  nda_status: string | null;
  nda_signed_at: string | null;
  due_date: string | null;
  vendor: { id: number; name: string; avatar_url: string; trades: string };
  cost_codes: CostCode[];
}

const statusColor = (status: string | null) => {
  const colors: Record<string, string> = {
    submitted: "bg-green-500/10 text-green-600 border-green-500/20",
    will_bid: "bg-blue-500/10 text-blue-600 border-blue-500/20",
    will_not_bid: "bg-red-500/10 text-red-600 border-red-500/20",
    undecided: "bg-yellow-500/10 text-yellow-600 border-yellow-500/20",
  };
  return colors[status || ""] || "";
};

const formatCurrency = (val: number | string | null) => {
  if (val == null) return "$0";
  const num = typeof val === "string" ? parseFloat(val) : val;
  if (isNaN(num)) return "$0";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(num);
};

const formatDate = (dateStr: string | null | undefined) => {
  if (!dateStr) return "—";
  try { return format(new Date(dateStr), "MMM d, yyyy h:mm a"); } catch { return dateStr; }
};

const stripHtml = (html: string | null) => {
  if (!html) return "";
  return html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, "").trim();
};

export default function BidDetailPage() {
  const [, params] = useRoute("/procore-data/bids/:bidId");
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const bidId = params?.bidId;

  const { data: detail, isLoading, error } = useQuery<BidDetail>({
    queryKey: ["/api/procore/bids", bidId, "detail"],
    queryFn: async () => {
      const res = await fetch(`/api/procore/bids/${bidId}/detail`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load bid detail");
      return res.json();
    },
    enabled: !!bidId,
  });

  const awardMutation = useMutation({
    mutationFn: async (awarded: boolean | null) => {
      const res = await apiRequest("PATCH", `/api/procore/bids/${bidId}`, { awarded });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/procore/bids", bidId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/procore/bids"] });
      toast({ title: "Award status updated", description: "Change synced to Procore in real-time." });
    },
    onError: (e: Error) => {
      toast({ title: "Failed to update", description: e.message, variant: "destructive" });
    },
  });

  const bidStatusMutation = useMutation({
    mutationFn: async (bid_status: string) => {
      const res = await apiRequest("PATCH", `/api/procore/bids/${bidId}`, { bid_status });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/procore/bids", bidId, "detail"] });
      queryClient.invalidateQueries({ queryKey: ["/api/procore/bids"] });
      toast({ title: "Bid status updated", description: "Change synced to Procore in real-time." });
    },
    onError: (e: Error) => {
      toast({ title: "Failed to update", description: e.message, variant: "destructive" });
    },
  });

  const handleAwardChange = (value: string) => {
    const awarded = value === "awarded" ? true : value === "rejected" ? false : null;
    awardMutation.mutate(awarded);
  };

  const awardedValue = detail?.awarded === true ? "awarded" : detail?.awarded === false ? "rejected" : "pending";

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => navigate("/procore-data")} data-testid="button-back-to-bids">
          <ArrowLeft className="w-4 h-4 mr-2" /> Back to Procore Data
        </Button>
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Failed to load bid detail. The bid may not exist or the Procore token may have expired.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate("/procore-data")} data-testid="button-back-to-bids">
            <ArrowLeft className="w-4 h-4 mr-1" /> Back
          </Button>
          <div>
            <h2 className="text-xl font-bold flex items-center gap-2" data-testid="text-bid-title">
              <FileText className="w-5 h-5" />
              {detail.vendor?.name || "Unknown Vendor"}
            </h2>
            <p className="text-sm text-muted-foreground">
              {detail.bid_package_title} — {detail.bid_form_title}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Status:</span>
            <Select value={detail.bid_status || "undecided"} onValueChange={(v) => bidStatusMutation.mutate(v)} disabled={bidStatusMutation.isPending}>
              <SelectTrigger className="w-[140px] h-9" data-testid="select-bid-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="submitted">Submitted</SelectItem>
                <SelectItem value="will_bid">Will Bid</SelectItem>
                <SelectItem value="will_not_bid">Won't Bid</SelectItem>
                <SelectItem value="undecided">Undecided</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Award:</span>
            <Select value={awardedValue} onValueChange={handleAwardChange} disabled={awardMutation.isPending}>
              <SelectTrigger className="w-[140px] h-9" data-testid="select-bid-award-status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="pending">Pending</SelectItem>
                <SelectItem value="awarded">Awarded</SelectItem>
                <SelectItem value="rejected">Rejected</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <DollarSign className="w-4 h-4" /> Bid Amount
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold" data-testid="text-bid-amount">{formatCurrency(detail.lump_sum_amount)}</p>
            <p className="text-xs text-muted-foreground mt-1">
              {detail.lump_sum_enabled ? "Lump Sum" : "Line Item"} Bid
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Building2 className="w-4 h-4" /> Project
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm font-medium" data-testid="text-bid-project">{detail.project?.name || "—"}</p>
            <p className="text-xs text-muted-foreground mt-1">
              {stripHtml(detail.project?.address) || "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Calendar className="w-4 h-4" /> Due Date
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm font-medium" data-testid="text-bid-due-date">{detail.due_date ? format(new Date(detail.due_date), "MMM d, yyyy") : "No due date"}</p>
            <p className="text-xs text-muted-foreground mt-1">
              Submitted: {detail.submitted ? "Yes" : "No"} | Committed: {detail.is_bidder_committed ? "Yes" : "No"}
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <User className="w-4 h-4" /> Vendor
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div><span className="text-muted-foreground">Name:</span> <span className="ml-1 font-medium">{detail.vendor?.name}</span></div>
              <div><span className="text-muted-foreground">ID:</span> <span className="ml-1 font-mono text-xs">{detail.vendor?.id}</span></div>
              <div><span className="text-muted-foreground">Trades:</span> <span className="ml-1">{detail.vendor?.trades || "—"}</span></div>
            </div>
            {detail.recipient_list?.length > 0 && (
              <div className="border-t pt-2 mt-2">
                <p className="text-xs text-muted-foreground mb-1">Contacts:</p>
                {detail.recipient_list.map((r, i) => (
                  <p key={i} className="text-sm">{r.first} {r.last} ({r.email})</p>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Gavel className="w-4 h-4" /> Bid Requester
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div><span className="text-muted-foreground">Name:</span> <span className="ml-1 font-medium">{detail.bid_requester?.first_name} {detail.bid_requester?.last_name}</span></div>
            <div><span className="text-muted-foreground">Company:</span> <span className="ml-1">{detail.bid_requester?.company}</span></div>
            <div><span className="text-muted-foreground">Email:</span> <span className="ml-1">{detail.bid_requester?.email_address}</span></div>
            <div><span className="text-muted-foreground">Phone:</span> <span className="ml-1">{detail.bid_requester?.company_phone || "—"}</span></div>
            <div><span className="text-muted-foreground">Invitation Sent:</span> <span className="ml-1">{formatDate(detail.invitation_last_sent_at)}</span></div>
          </CardContent>
        </Card>
      </div>

      {detail.bid_items && detail.bid_items.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <ListChecks className="w-4 h-4" /> Bid Items ({detail.bid_items.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-lg border">
              <div className="grid grid-cols-[auto_1fr_0.8fr_0.6fr_0.5fr_0.5fr_0.6fr_0.5fr] gap-3 px-4 py-2 bg-muted/50 text-xs font-medium text-muted-foreground border-b">
                <span>#</span>
                <span>Cost Code</span>
                <span>Code #</span>
                <span>Amount</span>
                <span>Unit Cost</span>
                <span>Qty</span>
                <span>UoM</span>
                <span>Included</span>
              </div>
              {detail.bid_items.map((item) => (
                <div key={item.id} className="grid grid-cols-[auto_1fr_0.8fr_0.6fr_0.5fr_0.5fr_0.6fr_0.5fr] gap-3 px-4 py-2.5 text-sm border-b last:border-0 items-center" data-testid={`bid-item-row-${item.id}`}>
                  <span className="text-muted-foreground">{item.position}</span>
                  <span className="font-medium">{item.cost_code_name || "—"}</span>
                  <span className="text-muted-foreground font-mono text-xs">{item.cost_code_number || "—"}</span>
                  <span className="font-medium">{formatCurrency(item.amount)}</span>
                  <span className="text-muted-foreground">{formatCurrency(item.unit_cost)}</span>
                  <span className="text-muted-foreground">{item.quantity}</span>
                  <span className="text-muted-foreground">{item.uom || "—"}</span>
                  <span>{item.included ? <CheckCircle2 className="w-4 h-4 text-green-500" /> : <XCircle className="w-4 h-4 text-muted-foreground/40" />}</span>
                </div>
              ))}
              <div className="grid grid-cols-[auto_1fr_0.8fr_0.6fr_0.5fr_0.5fr_0.6fr_0.5fr] gap-3 px-4 py-2.5 text-sm bg-muted/30 font-semibold border-t">
                <span></span>
                <span>Total</span>
                <span></span>
                <span>{formatCurrency(detail.bid_items.reduce((sum, i) => sum + (i.amount || 0), 0))}</span>
                <span></span>
                <span></span>
                <span></span>
                <span></span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {detail.cost_codes && detail.cost_codes.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Hash className="w-4 h-4" /> Cost Codes ({detail.cost_codes.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {detail.cost_codes.map((cc) => (
                <Badge key={cc.id} variant="outline" className="text-xs py-1 px-2" data-testid={`cost-code-${cc.id}`}>
                  {cc.name}
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {detail.attachments && detail.attachments.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Paperclip className="w-4 h-4" /> Attachments ({detail.attachments.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {detail.attachments.map((att) => (
                <div key={att.id} className="flex items-center justify-between p-3 rounded-lg border bg-muted/10 hover:bg-muted/20 transition-colors" data-testid={`attachment-row-${att.id}`}>
                  <div className="flex items-center gap-3">
                    <FileText className="w-5 h-5 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-medium">{att.name}</p>
                      <p className="text-xs text-muted-foreground">ID: {att.id}</p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => window.open(`/api/procore/attachments/proxy?url=${encodeURIComponent(att.url)}`, '_blank')}
                      data-testid={`button-view-attachment-${att.id}`}
                    >
                      <ExternalLink className="w-3.5 h-3.5 mr-1" /> View
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const a = document.createElement('a');
                        a.href = `/api/procore/attachments/proxy?url=${encodeURIComponent(att.url)}`;
                        a.download = att.name;
                        a.click();
                      }}
                      data-testid={`button-download-attachment-${att.id}`}
                    >
                      <Download className="w-3.5 h-3.5 mr-1" /> Download
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {(detail.bidder_comments || detail.bidder_notes) && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <MessageSquare className="w-4 h-4" /> Bidder Comments & Notes
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {detail.bidder_comments && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Comments:</p>
                  <div className="text-sm p-3 bg-muted/20 rounded-lg whitespace-pre-wrap" data-testid="text-bidder-comments">
                    {stripHtml(detail.bidder_comments)}
                  </div>
                </div>
              )}
              {detail.bidder_notes && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Notes:</p>
                  <div className="text-sm p-3 bg-muted/20 rounded-lg whitespace-pre-wrap" data-testid="text-bidder-notes">
                    {detail.bidder_notes}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              {detail.bidder_inclusion || detail.bidder_exclusion ? <ShieldCheck className="w-4 h-4" /> : <ShieldX className="w-4 h-4" />}
              Inclusions & Exclusions
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <p className="text-xs text-muted-foreground mb-1">Inclusions:</p>
              <div className="text-sm p-3 bg-green-500/5 rounded-lg border border-green-500/10 min-h-[40px]" data-testid="text-bid-inclusion">
                {detail.bidder_inclusion ? stripHtml(detail.bidder_inclusion) : "None specified"}
              </div>
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">Exclusions:</p>
              <div className="text-sm p-3 bg-red-500/5 rounded-lg border border-red-500/10 min-h-[40px]" data-testid="text-bid-exclusion">
                {detail.bidder_exclusion ? stripHtml(detail.bidder_exclusion) : "None specified"}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Clock className="w-4 h-4" /> Additional Details
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
            <div><span className="text-muted-foreground">Procore ID:</span> <span className="ml-1 font-mono text-xs">{detail.id}</span></div>
            <div><span className="text-muted-foreground">Bid Package ID:</span> <span className="ml-1 font-mono text-xs">{detail.bid_package_id}</span></div>
            <div><span className="text-muted-foreground">Bid Form ID:</span> <span className="ml-1 font-mono text-xs">{detail.bid_form_id}</span></div>
            <div><span className="text-muted-foreground">Company ID:</span> <span className="ml-1 font-mono text-xs">{detail.company_id}</span></div>
            <div><span className="text-muted-foreground">Created:</span> <span className="ml-1">{formatDate(detail.created_at)}</span></div>
            <div><span className="text-muted-foreground">Updated:</span> <span className="ml-1">{formatDate(detail.updated_at)}</span></div>
            <div><span className="text-muted-foreground">NDA Required:</span> <span className="ml-1">{detail.require_nda ? "Yes" : "No"}</span></div>
            <div><span className="text-muted-foreground">NDA Status:</span> <span className="ml-1">{detail.nda_status || "—"}</span></div>
            <div><span className="text-muted-foreground">Show in Estimating:</span> <span className="ml-1">{detail.show_bid_in_estimating ? "Yes" : "No"}</span></div>
            <div><span className="text-muted-foreground">Convert to SC:</span> <span className="ml-1">{detail.bid_convertible_to_subcontract ? "Yes" : "No"}</span></div>
            <div><span className="text-muted-foreground">Convert to PO:</span> <span className="ml-1">{detail.bid_convertible_to_purchase_order ? "Yes" : "No"}</span></div>
            <div><span className="text-muted-foreground">Add Line Items:</span> <span className="ml-1">{detail.bidders_can_add_line_items ? "Yes" : "No"}</span></div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Full Raw Data</CardTitle>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-60 rounded border bg-card p-3">
            <pre className="font-mono text-xs whitespace-pre-wrap">{JSON.stringify(detail, null, 2)}</pre>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
