import { storage } from './storage';
import { getProcoreClient, getCompanyId } from './procore';

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
  try {
    const client = await getProcoreClient();
    const companyId = await getCompanyId();

    const response = await client.get(`/rest/v1.0/projects/${projectId}/change_order_packages`);
    const packages = response.data || [];

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
  } catch (error: any) {
    console.error(`[ChangeOrder] Error fetching change orders for project ${projectId}:`, error.message);
    return [];
  }
}

export async function getPrimeContractAmount(projectId: string): Promise<number> {
  try {
    const client = await getProcoreClient();
    
    const response = await client.get(`/rest/v1.0/projects/${projectId}/prime_contracts`);
    const contracts = response.data || [];

    if (contracts.length === 0) return 0;

    const totalAmount = contracts.reduce((sum: number, contract: any) => {
      return sum + parseFloat(contract.signed_contract_value || contract.contract_amount || 0);
    }, 0);

    return totalAmount;
  } catch (error: any) {
    console.error(`[ChangeOrder] Error fetching prime contract for project ${projectId}:`, error.message);
    return 0;
  }
}

export async function calculateTotalContractValue(projectId: string): Promise<ContractValue> {
  const primeContractAmount = await getPrimeContractAmount(projectId);
  const changeOrders = await getProjectChangeOrders(projectId);

  const approvedChangeOrders = changeOrders.reduce((sum, co) => sum + co.approvedAmount, 0);
  const pendingChangeOrders = changeOrders.reduce((sum, co) => sum + co.pendingAmount, 0);
  // Include both approved and pending change orders in total (pending represents expected work)
  const totalContractValue = primeContractAmount + approvedChangeOrders + pendingChangeOrders;

  return {
    primeContractAmount,
    approvedChangeOrders,
    pendingChangeOrders,
    totalContractValue,
    changeOrders,
  };
}

export async function updateHubSpotDealAmount(dealId: string, amount: number): Promise<{ success: boolean; error?: string }> {
  try {
    const { updateHubSpotDeal } = await import('./hubspot');
    await updateHubSpotDeal(dealId, { amount: String(amount) });
    
    console.log(`[ChangeOrder] Updated HubSpot deal ${dealId} amount to $${amount.toLocaleString()}`);
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
  // Check if change order sync is enabled (disabled by default)
  const changeOrderSyncConfig = await storage.getAutomationConfig("change_order_hubspot_sync");
  const syncEnabled = (changeOrderSyncConfig?.value as any)?.enabled === true;
  
  if (!syncEnabled) {
    console.log(`[ChangeOrder] Change order sync disabled - skipping HubSpot update for project ${procoreProjectId}`);
    return { success: false, error: 'Change order sync is disabled' };
  }
  
  try {
    const mapping = await storage.getSyncMappingByProcoreProjectId(procoreProjectId);
    
    if (!mapping?.hubspotDealId) {
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

    const updateResult = await updateHubSpotDealAmount(mapping.hubspotDealId, contractValue.totalContractValue);

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
  if (payload.resource_name !== 'Change Order' && payload.resource_name !== 'Change Order Package') {
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
    const projectsWithHubspot = mappings.filter(m => m.procoreProjectId && m.hubspotDealId);

    for (const mapping of projectsWithHubspot) {
      if (!mapping.procoreProjectId) continue;
      
      result.projectsChecked++;
      
      try {
        const syncResult = await syncChangeOrdersToHubSpot(mapping.procoreProjectId);
        
        if (syncResult.success && syncResult.previousAmount !== syncResult.newAmount) {
          result.projectsUpdated++;
        }
      } catch (err: any) {
        result.errors.push(`Project ${mapping.procoreProjectId}: ${err.message}`);
      }
    }

    console.log(`[ChangeOrder] Sync complete: ${result.projectsChecked} checked, ${result.projectsUpdated} updated`);
    return result;
  } catch (error: any) {
    result.errors.push(error.message);
    return result;
  }
}
