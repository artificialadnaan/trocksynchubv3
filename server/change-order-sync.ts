/**
 * Change Order Sync Module
 * ========================
 * 
 * This module synchronizes change order data from Procore to HubSpot.
 * It calculates total contract values including approved and pending changes.
 * 
 * What are Change Orders?
 * Change orders represent modifications to the original contract scope and price.
 * They can be:
 * - Approved: Confirmed additional work/cost
 * - Pending: Requested but not yet approved
 * - Rejected: Denied changes
 * 
 * Contract Value Calculation:
 * totalContractValue = primeContractAmount + approvedChangeOrders
 *
 * Only approved change orders affect the deal amount. Pending change
 * orders are tracked separately in the change_order_pending field.
 * 
 * Data Flow:
 * 1. Fetch change orders from Procore API
 * 2. Calculate approved and pending amounts
 * 3. Update HubSpot deal with total contract value
 * 4. Store change order details for reference
 * 
 * Key Functions:
 * - getProjectChangeOrders(): Fetch change orders from Procore
 * - getPrimeContractAmount(): Get original contract value
 * - calculateTotalContractValue(): Compute total with changes
 * - syncChangeOrdersToHubSpot(): Push values to HubSpot deal
 * 
 * HubSpot Properties Updated:
 * - amount: Total contract value
 * - change_order_approved: Approved changes total
 * - change_order_pending: Pending changes total
 * 
 * Automation Config:
 * - sync_change_orders: Enable/disable (Sync Config: "Update HubSpot deal amount on Change Orders")
 * 
 * @module change-order-sync
 */

import { storage } from './storage';
import { getProcoreClient, getCompanyId } from './procore';

/** Change order record from Procore */
export interface ChangeOrder {
  id: string;
  number: string;
  title: string;
  status: string;
  approvedAmount: number;
  pendingAmount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ContractValue {
  primeContractAmount: number;
  approvedChangeOrders: number;
  pendingChangeOrders: number;
  totalContractValue: number;
  changeOrders: ChangeOrder[];
}

export async function getProjectChangeOrders(projectId: string): Promise<ChangeOrder[]> {
  const client = await getProcoreClient();
  const companyId = await getCompanyId();

  let packages: any[] = [];
  try {
    // Use the top-level endpoint — the project-scoped path 404s on some live projects
    const response = await client.get(`/rest/v1.0/change_order_packages`, {
      params: { project_id: projectId, company_id: companyId },
    });
    packages = response.data || [];
  } catch (err: any) {
    if (err?.message?.includes('404')) {
      try {
        const response2 = await client.get(`/rest/v1.0/projects/${projectId}/change_order_packages`, {
          params: { company_id: companyId },
        });
        packages = response2.data || [];
      } catch (err2: any) {
        // Procore returns 404 when Change Orders tool isn't enabled on the project
        if (err2?.message?.includes('404')) {
          console.log(`[ChangeOrder] Change orders not available for project ${projectId} (404 — tool may not be enabled)`);
          return [];
        }
        throw err2;
      }
    } else {
      throw err;
    }
  }

  const changeOrders: ChangeOrder[] = [];

  for (const pkg of packages) {
    const status = (pkg.status || 'pending').toLowerCase();
    const amount = parseFloat(pkg.grand_total || pkg.amount || 0);
    changeOrders.push({
      id: String(pkg.id),
      number: pkg.number || '',
      title: pkg.title || pkg.description || '',
      status: pkg.status || 'pending',
      approvedAmount: status === 'approved' ? amount : 0,
      pendingAmount: status !== 'approved' ? amount : 0,
      createdAt: pkg.created_at || '',
      updatedAt: pkg.updated_at || '',
    });
  }

  return changeOrders;
}

export async function getPrimeContractAmount(projectId: string): Promise<number> {
  const client = await getProcoreClient();
  const companyId = await getCompanyId();

  let contracts: any[] = [];
  try {
    // Use top-level endpoint — project-level endpoint returns 404 on many projects
    const response = await client.get(`/rest/v1.0/prime_contracts`, {
      params: { project_id: projectId, company_id: companyId },
    });
    contracts = response.data || [];
  } catch (err: any) {
    if (err?.message?.includes('404')) {
      // Fallback: try project-level endpoint
      try {
        const response2 = await client.get(`/rest/v1.0/projects/${projectId}/prime_contracts`, {
          params: { company_id: companyId },
        });
        contracts = response2.data || [];
      } catch (err2: any) {
        if (err2?.message?.includes('404')) {
          console.log(`[ChangeOrder] Prime contracts not available for project ${projectId} (404)`);
          return 0;
        }
        throw err2;
      }
    } else {
      throw err;
    }
  }

  if (contracts.length === 0) return 0;

  const totalAmount = contracts.reduce((sum: number, contract: any) => {
    return sum + parseFloat(contract.grand_total || contract.revised_contract_amount || contract.signed_contract_value || contract.contract_amount || 0);
  }, 0);

  return totalAmount;
}

export async function calculateTotalContractValue(projectId: string): Promise<ContractValue> {
  const primeContractAmount = await getPrimeContractAmount(projectId);
  const changeOrders = await getProjectChangeOrders(projectId);

  const approvedChangeOrders = changeOrders.reduce((sum, co) => sum + co.approvedAmount, 0);
  const pendingChangeOrders = changeOrders.reduce((sum, co) => sum + co.pendingAmount, 0);
  // Only include approved change orders in the deal amount (per T-Rock confirmation)
  const totalContractValue = primeContractAmount + approvedChangeOrders;

  return {
    primeContractAmount,
    approvedChangeOrders,
    pendingChangeOrders,
    totalContractValue,
    changeOrders,
  };
}

export async function updateHubSpotDealAmount(
  dealId: string,
  amount: number,
  approvedChangeOrders?: number,
  pendingChangeOrders?: number,
): Promise<{ success: boolean; error?: string }> {
  try {
    const { updateHubSpotDeal } = await import('./hubspot');
    const properties: Record<string, string> = { amount: String(amount) };
    if (approvedChangeOrders !== undefined) {
      properties.change_order_approved = String(approvedChangeOrders);
    }
    if (pendingChangeOrders !== undefined) {
      properties.change_order_pending = String(pendingChangeOrders);
    }
    const result = await updateHubSpotDeal(dealId, properties);
    if (!result.success) {
      return { success: false, error: result.message };
    }

    console.log(`[ChangeOrder] Updated HubSpot deal ${dealId} — amount: $${amount.toLocaleString()}, approved COs: $${(approvedChangeOrders ?? 0).toLocaleString()}, pending COs: $${(pendingChangeOrders ?? 0).toLocaleString()}`);
    return { success: true };
  } catch (error: any) {
    console.error(`[ChangeOrder] Error updating HubSpot deal amount:`, error.message);
    return { success: false, error: error.message };
  }
}

export async function syncChangeOrdersToHubSpot(procoreProjectId: string): Promise<{
  success: boolean;
  dealId?: string;
  previousAmount?: number;
  newAmount?: number;
  contractValue?: ContractValue;
  error?: string;
}> {
  // Check if change order sync is enabled (Sync Config: "Update HubSpot deal amount on Change Orders")
  const changeOrderSyncConfig = await storage.getAutomationConfig("sync_change_orders");
  const syncEnabled = (changeOrderSyncConfig?.value as any)?.enabled === true || (changeOrderSyncConfig as any)?.isActive === true;
  
  if (!syncEnabled) {
    console.log(`[ChangeOrder] Change order sync disabled - skipping HubSpot update for project ${procoreProjectId}`);
    return { success: false, error: 'Change order sync is disabled' };
  }
  
  try {
    const mapping = await storage.getSyncMappingByProcoreProjectId(procoreProjectId);
    
    if (!mapping?.hubspotDealId) {
      await storage.createAuditLog({
        action: 'change_order_sync',
        entityType: 'deal_amount',
        entityId: procoreProjectId,
        source: 'procore',
        destination: 'hubspot',
        status: 'skipped',
        errorMessage: 'No HubSpot deal linked to this project',
      });
      return { success: false, error: 'No HubSpot deal linked to this project' };
    }

    const deal = await storage.getHubspotDealByHubspotId(mapping.hubspotDealId);
    const previousAmount = deal?.amount ? parseFloat(deal.amount) : 0;

    const contractValue = await calculateTotalContractValue(procoreProjectId);

    if (contractValue.totalContractValue === previousAmount) {
      console.log(`[ChangeOrder] No amount change for project ${procoreProjectId}`);
      return {
        success: true,
        dealId: mapping.hubspotDealId,
        previousAmount,
        newAmount: contractValue.totalContractValue,
        contractValue,
      };
    }

    // Safety: never overwrite a real amount with $0 (likely a 404 or API issue)
    if (contractValue.totalContractValue === 0 && previousAmount > 0) {
      console.warn(`[ChangeOrder] Refusing to zero out deal ${mapping.hubspotDealId} (was $${previousAmount.toLocaleString()}) for project ${procoreProjectId} — likely API error`);
      return { success: false, error: 'Refusing to zero out deal amount — possible API error' };
    }

    const updateResult = await updateHubSpotDealAmount(
      mapping.hubspotDealId,
      contractValue.totalContractValue,
      contractValue.approvedChangeOrders,
      contractValue.pendingChangeOrders,
    );

    if (updateResult.success) {
      await storage.createAuditLog({
        action: 'change_order_sync',
        entityType: 'deal_amount',
        entityId: mapping.hubspotDealId,
        source: 'procore',
        destination: 'hubspot',
        status: 'success',
        details: {
          procoreProjectId,
          previousAmount,
          newAmount: contractValue.totalContractValue,
          primeContractAmount: contractValue.primeContractAmount,
          approvedChangeOrders: contractValue.approvedChangeOrders,
          changeOrderCount: contractValue.changeOrders.length,
        },
      });

      return {
        success: true,
        dealId: mapping.hubspotDealId,
        previousAmount,
        newAmount: contractValue.totalContractValue,
        contractValue,
      };
    } else {
      return {
        success: false,
        dealId: mapping.hubspotDealId,
        error: updateResult.error,
        contractValue,
      };
    }
  } catch (error: any) {
    console.error(`[ChangeOrder] Error syncing change orders:`, error.message);
    return { success: false, error: error.message };
  }
}

export async function handleChangeOrderWebhook(payload: {
  resource_name: string;
  event_type: string;
  resource_id: string;
  project_id: string;
  user_id?: string;
  metadata?: any;
}): Promise<{ processed: boolean; result?: any; error?: string }> {
  const validResources = ['Change Order', 'Change Order Package', 'Change Orders', 'Change Order Packages', 'Change Events', 'Change Event',
    'change_order', 'change_order_package', 'change_orders', 'change_order_packages', 'change_events', 'change_event'];
  if (!validResources.includes(payload.resource_name)) {
    return { processed: false, error: 'Not a change order event' };
  }

  const relevantEvents = ['create', 'update', 'delete'];
  if (!relevantEvents.includes(payload.event_type)) {
    return { processed: false, error: `Event type ${payload.event_type} not processed` };
  }

  console.log(`[ChangeOrder] Processing ${payload.resource_name} ${payload.event_type} for project ${payload.project_id}`);

  const result = await syncChangeOrdersToHubSpot(payload.project_id);

  return { processed: true, result };
}

export async function syncAllProjectChangeOrders(): Promise<{
  projectsChecked: number;
  projectsUpdated: number;
  errors: string[];
}> {
  const result = {
    projectsChecked: 0,
    projectsUpdated: 0,
    errors: [] as string[],
  };

  try {
    const mappings = await storage.getSyncMappings();
    // Only sync projects that have a Portfolio project ID — change orders and prime contracts
    // live on Portfolio projects, not Bid Board projects. Bid Board IDs return 404 from Procore API.
    const projectsWithPortfolio = mappings.filter(m => m.portfolioProjectId && m.hubspotDealId);

    // Filter to active projects only — skip closed/inactive projects to reduce API calls
    const activeProjects = [];
    for (const m of projectsWithPortfolio) {
      const project = await storage.getProcoreProjectByProcoreId(m.portfolioProjectId!);
      if (!project || project.active !== false) {
        activeProjects.push(m);
      }
    }

    console.log(`[ChangeOrder] Found ${activeProjects.length} active Portfolio projects to check (skipped ${projectsWithPortfolio.length - activeProjects.length} inactive, ${mappings.length - projectsWithPortfolio.length} without Portfolio ID)`);

    for (const mapping of activeProjects) {
      const projectId = mapping.portfolioProjectId!;
      if (!projectId) continue;
      
      result.projectsChecked++;
      
      try {
        const syncResult = await syncChangeOrdersToHubSpot(projectId);
        
        if (syncResult.success && syncResult.previousAmount !== syncResult.newAmount) {
          result.projectsUpdated++;
        }
      } catch (err: any) {
        result.errors.push(`Project ${projectId}: ${err.message}`);
      }
    }

    console.log(`[ChangeOrder] Sync complete: ${result.projectsChecked} checked, ${result.projectsUpdated} updated`);
    return result;
  } catch (error: any) {
    result.errors.push(error.message);
    return result;
  }
}
