import { Page } from "playwright";
import { ensureLoggedIn } from "./auth";
import { PROCORE_SELECTORS } from "./selectors";
import { randomDelay, takeScreenshot } from "./browser";
import { navigateToProject } from "./bidboard";
import { navigateToPortfolioProject } from "./portfolio";
import { log } from "../index";
import { storage } from "../storage";
import fs from "fs/promises";
import path from "path";
import https from "https";
import http from "http";

const TEMP_DIR = process.env.TEMP_DIR || ".playwright-temp";

export interface DocumentInfo {
  name: string;
  url?: string;
  localPath?: string;
  type?: string;
  size?: number;
}

export interface DocumentSyncResult {
  success: boolean;
  documentsUploaded: number;
  documentsDownloaded: number;
  errors: string[];
}

async function ensureTempDir(): Promise<void> {
  try {
    await fs.mkdir(TEMP_DIR, { recursive: true });
  } catch {
    // Directory may already exist
  }
}

async function logDocumentAction(
  projectId: string,
  action: string,
  status: "success" | "failed",
  details?: Record<string, any>,
  errorMessage?: string
): Promise<void> {
  await storage.createBidboardAutomationLog({
    projectId,
    action,
    status,
    details,
    errorMessage,
  });
}

async function downloadFile(url: string, destPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const protocol = url.startsWith("https") ? https : http;
    const file = require("fs").createWriteStream(destPath);
    
    protocol.get(url, (response) => {
      if (response.statusCode === 200) {
        response.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve(true);
        });
      } else {
        file.close();
        resolve(false);
      }
    }).on("error", () => {
      file.close();
      resolve(false);
    });
  });
}

export async function getHubSpotDealAttachments(dealId: string): Promise<DocumentInfo[]> {
  const documents: DocumentInfo[] = [];
  
  try {
    // Query local database for deal
    const deal = await storage.getHubspotDealByHubspotId(dealId);
    
    if (deal?.properties) {
      const properties = deal.properties as Record<string, any>;
      if (properties.attachments && Array.isArray(properties.attachments)) {
        for (const attachment of properties.attachments) {
          documents.push({
            name: attachment.name || "Unknown",
            url: attachment.url,
            type: attachment.type,
            size: attachment.size,
          });
        }
      }
    }
    
    log(`Found ${documents.length} attachments for HubSpot deal ${dealId}`, "playwright");
  } catch (error) {
    log(`Error getting HubSpot attachments: ${error}`, "playwright");
  }
  
  return documents;
}

export async function uploadDocumentToBidBoard(
  page: Page,
  projectId: string,
  document: DocumentInfo
): Promise<boolean> {
  try {
    await navigateToProject(page, projectId);
    
    // Click on Documents tab
    const documentsTab = await page.$(PROCORE_SELECTORS.bidboard.documentsTab);
    if (documentsTab) {
      await documentsTab.click();
      await randomDelay(2000, 3000);
    }
    
    // Click upload button
    const uploadButton = await page.$(PROCORE_SELECTORS.documents.uploadButton);
    if (!uploadButton) {
      log("Upload button not found in BidBoard documents", "playwright");
      return false;
    }
    
    await uploadButton.click();
    await randomDelay(1000, 2000);
    
    // Get file path - download if needed
    let filePath = document.localPath;
    
    if (!filePath && document.url) {
      await ensureTempDir();
      filePath = path.join(TEMP_DIR, document.name);
      const downloaded = await downloadFile(document.url, filePath);
      if (!downloaded) {
        log(`Failed to download file from ${document.url}`, "playwright");
        return false;
      }
    }
    
    if (!filePath) {
      log("No file path available for upload", "playwright");
      return false;
    }
    
    // Upload file
    const fileInput = await page.$(PROCORE_SELECTORS.documents.fileInput);
    if (fileInput) {
      await fileInput.setInputFiles(filePath);
      await randomDelay(2000, 5000);
    }
    
    // Wait for upload to complete
    await page.waitForLoadState("networkidle");
    
    // Verify upload
    const documentList = await page.$(PROCORE_SELECTORS.documents.documentList);
    const documentText = documentList ? await documentList.textContent() : null;
    
    if (documentText && documentText.includes(document.name)) {
      log(`Successfully uploaded ${document.name} to BidBoard project ${projectId}`, "playwright");
      await logDocumentAction(projectId, "upload_to_bidboard", "success", { documentName: document.name });
      return true;
    }
    
    return false;
  } catch (error) {
    log(`Error uploading document to BidBoard: ${error}`, "playwright");
    await logDocumentAction(projectId, "upload_to_bidboard", "failed", { documentName: document.name }, String(error));
    return false;
  }
}

export async function downloadBidBoardDocuments(
  page: Page,
  projectId: string
): Promise<DocumentInfo[]> {
  const documents: DocumentInfo[] = [];
  
  try {
    await navigateToProject(page, projectId);
    
    // Click on Documents tab
    const documentsTab = await page.$(PROCORE_SELECTORS.bidboard.documentsTab);
    if (documentsTab) {
      await documentsTab.click();
      await randomDelay(2000, 3000);
    }
    
    // Get list of documents
    const documentRows = await page.$$(PROCORE_SELECTORS.documents.documentRow);
    
    await ensureTempDir();
    
    for (const row of documentRows) {
      try {
        // Get document name
        const nameElement = await row.$("td:first-child, .document-name");
        const name = nameElement ? (await nameElement.textContent())?.trim() : null;
        
        if (!name) continue;
        
        // Click download button
        const downloadButton = await row.$(PROCORE_SELECTORS.documents.downloadButton);
        if (downloadButton) {
          const [download] = await Promise.all([
            page.waitForEvent("download", { timeout: 30000 }),
            downloadButton.click(),
          ]);
          
          const downloadPath = path.join(TEMP_DIR, name);
          await download.saveAs(downloadPath);
          
          documents.push({
            name,
            localPath: downloadPath,
          });
          
          log(`Downloaded ${name} from BidBoard project ${projectId}`, "playwright");
        }
        
        await randomDelay(1000, 2000);
      } catch (error) {
        log(`Error downloading document: ${error}`, "playwright");
      }
    }
    
    log(`Downloaded ${documents.length} documents from BidBoard project ${projectId}`, "playwright");
  } catch (error) {
    log(`Error downloading BidBoard documents: ${error}`, "playwright");
  }
  
  return documents;
}

export async function uploadDocumentToPortfolio(
  page: Page,
  projectId: string,
  document: DocumentInfo
): Promise<boolean> {
  try {
    await navigateToPortfolioProject(page, projectId);
    
    // Click on Documents tab
    const documentsTab = await page.$(PROCORE_SELECTORS.portfolio.documentsTab);
    if (documentsTab) {
      await documentsTab.click();
      await randomDelay(2000, 3000);
    }
    
    // Click upload button
    const uploadButton = await page.$(PROCORE_SELECTORS.documents.uploadButton);
    if (!uploadButton) {
      log("Upload button not found in Portfolio documents", "playwright");
      return false;
    }
    
    await uploadButton.click();
    await randomDelay(1000, 2000);
    
    // Get file path
    let filePath = document.localPath;
    
    if (!filePath && document.url) {
      await ensureTempDir();
      filePath = path.join(TEMP_DIR, document.name);
      const downloaded = await downloadFile(document.url, filePath);
      if (!downloaded) {
        log(`Failed to download file from ${document.url}`, "playwright");
        return false;
      }
    }
    
    if (!filePath) {
      log("No file path available for upload", "playwright");
      return false;
    }
    
    // Upload file
    const fileInput = await page.$(PROCORE_SELECTORS.documents.fileInput);
    if (fileInput) {
      await fileInput.setInputFiles(filePath);
      await randomDelay(2000, 5000);
    }
    
    // Wait for upload to complete
    await page.waitForLoadState("networkidle");
    
    log(`Uploaded ${document.name} to Portfolio project ${projectId}`, "playwright");
    await logDocumentAction(projectId, "upload_to_portfolio", "success", { documentName: document.name });
    return true;
  } catch (error) {
    log(`Error uploading document to Portfolio: ${error}`, "playwright");
    await logDocumentAction(projectId, "upload_to_portfolio", "failed", { documentName: document.name }, String(error));
    return false;
  }
}

export async function syncHubSpotAttachmentsToBidBoard(
  bidboardProjectId: string,
  hubspotDealId: string
): Promise<DocumentSyncResult> {
  const result: DocumentSyncResult = {
    success: false,
    documentsUploaded: 0,
    documentsDownloaded: 0,
    errors: [],
  };
  
  try {
    const { page, success, error } = await ensureLoggedIn();
    
    if (!success) {
      result.errors.push(error || "Failed to log in");
      return result;
    }
    
    // Get attachments from HubSpot
    const attachments = await getHubSpotDealAttachments(hubspotDealId);
    result.documentsDownloaded = attachments.length;
    
    // Upload each attachment to BidBoard
    for (const attachment of attachments) {
      const uploaded = await uploadDocumentToBidBoard(page, bidboardProjectId, attachment);
      if (uploaded) {
        result.documentsUploaded++;
      } else {
        result.errors.push(`Failed to upload ${attachment.name}`);
      }
    }
    
    result.success = result.errors.length === 0;
    
    log(`Synced ${result.documentsUploaded}/${attachments.length} documents from HubSpot to BidBoard`, "playwright");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    result.errors.push(errorMessage);
    log(`Error syncing HubSpot attachments: ${errorMessage}`, "playwright");
  }
  
  return result;
}

export async function syncBidBoardDocumentsToPortfolio(
  bidboardProjectId: string,
  portfolioProjectId: string
): Promise<DocumentSyncResult> {
  const result: DocumentSyncResult = {
    success: false,
    documentsUploaded: 0,
    documentsDownloaded: 0,
    errors: [],
  };
  
  try {
    const { page, success, error } = await ensureLoggedIn();
    
    if (!success) {
      result.errors.push(error || "Failed to log in");
      return result;
    }
    
    // Download documents from BidBoard
    const documents = await downloadBidBoardDocuments(page, bidboardProjectId);
    result.documentsDownloaded = documents.length;
    
    // Upload each document to Portfolio
    for (const document of documents) {
      const uploaded = await uploadDocumentToPortfolio(page, portfolioProjectId, document);
      if (uploaded) {
        result.documentsUploaded++;
      } else {
        result.errors.push(`Failed to upload ${document.name}`);
      }
    }
    
    result.success = result.errors.length === 0;
    
    log(`Synced ${result.documentsUploaded}/${documents.length} documents from BidBoard to Portfolio`, "playwright");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    result.errors.push(errorMessage);
    log(`Error syncing BidBoard documents to Portfolio: ${errorMessage}`, "playwright");
  }
  
  // Clean up temp files
  try {
    await fs.rm(TEMP_DIR, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
  
  return result;
}

// ============= Archive Export Functions =============

export interface ArchiveExportResult {
  success: boolean;
  files: DocumentInfo[];
  errors: string[];
}

export async function exportSpecificationsViaUI(
  page: Page,
  projectId: string,
  outputDir: string
): Promise<ArchiveExportResult> {
  const result: ArchiveExportResult = {
    success: false,
    files: [],
    errors: [],
  };

  try {
    await ensureTempDir();

    // Navigate to project specifications
    const specsUrl = `${PROCORE_SELECTORS.baseUrls.production}/projects/${projectId}/specifications`;
    await page.goto(specsUrl, { waitUntil: "networkidle" });
    await randomDelay(2000, 3000);

    // Check if specifications tab exists
    const specsContent = await page.$('[data-testid="specifications-list"], .specifications-container, [class*="specification"]');
    if (!specsContent) {
      result.errors.push("Specifications page not found or no specifications available");
      return result;
    }

    // Try to find export/download all button
    const exportAllButton = await page.$('[data-testid="export-specs"], button:has-text("Export"), button:has-text("Download All"), .bulk-download');

    if (exportAllButton) {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 60000 }),
        exportAllButton.click(),
      ]);

      const fileName = download.suggestedFilename() || `specifications-${projectId}.zip`;
      const downloadPath = path.join(outputDir, fileName);
      await download.saveAs(downloadPath);

      result.files.push({
        name: fileName,
        localPath: downloadPath,
        type: "specifications",
      });

      log(`Exported specifications for project ${projectId}`, "playwright");
    } else {
      // Try to download individual specifications
      const specItems = await page.$$('[data-testid="spec-item"], .specification-item, .spec-row');

      for (const item of specItems) {
        try {
          const downloadBtn = await item.$('button[data-testid="download"], a[download], .download-button');
          if (downloadBtn) {
            const [download] = await Promise.all([
              page.waitForEvent("download", { timeout: 30000 }),
              downloadBtn.click(),
            ]);

            const fileName = download.suggestedFilename() || `spec-${Date.now()}.pdf`;
            const downloadPath = path.join(outputDir, fileName);
            await download.saveAs(downloadPath);

            result.files.push({
              name: fileName,
              localPath: downloadPath,
              type: "specification",
            });
          }
          await randomDelay(500, 1000);
        } catch (e) {
          // Continue with other specs
        }
      }
    }

    result.success = result.files.length > 0;
    log(`Downloaded ${result.files.length} specification files for project ${projectId}`, "playwright");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    result.errors.push(errorMessage);
    log(`Error exporting specifications: ${errorMessage}`, "playwright");
  }

  return result;
}

export async function exportDrawingSetPdfsViaUI(
  page: Page,
  projectId: string,
  outputDir: string
): Promise<ArchiveExportResult> {
  const result: ArchiveExportResult = {
    success: false,
    files: [],
    errors: [],
  };

  try {
    await ensureTempDir();

    // Navigate to project drawings
    const drawingsUrl = `${PROCORE_SELECTORS.baseUrls.production}/projects/${projectId}/drawings`;
    await page.goto(drawingsUrl, { waitUntil: "networkidle" });
    await randomDelay(2000, 3000);

    // Try to find bulk export button
    const exportButton = await page.$('[data-testid="export-drawings"], button:has-text("Export"), button:has-text("Download All"), .drawing-export-button');

    if (exportButton) {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 120000 }), // Drawings can be large
        exportButton.click(),
      ]);

      const fileName = download.suggestedFilename() || `drawings-${projectId}.zip`;
      const downloadPath = path.join(outputDir, fileName);
      await download.saveAs(downloadPath);

      result.files.push({
        name: fileName,
        localPath: downloadPath,
        type: "drawings",
      });

      log(`Exported drawing set for project ${projectId}`, "playwright");
    } else {
      result.errors.push("Bulk drawing export button not found - individual downloads may be required");
    }

    result.success = result.files.length > 0;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    result.errors.push(errorMessage);
    log(`Error exporting drawings via UI: ${errorMessage}`, "playwright");
  }

  return result;
}

export async function exportProjectReportViaUI(
  page: Page,
  projectId: string,
  reportType: "budget" | "submittal_log" | "rfi_log" | "daily_log",
  outputDir: string
): Promise<ArchiveExportResult> {
  const result: ArchiveExportResult = {
    success: false,
    files: [],
    errors: [],
  };

  try {
    await ensureTempDir();

    const reportUrls: Record<string, string> = {
      budget: `${PROCORE_SELECTORS.baseUrls.production}/projects/${projectId}/budget`,
      submittal_log: `${PROCORE_SELECTORS.baseUrls.production}/projects/${projectId}/submittals`,
      rfi_log: `${PROCORE_SELECTORS.baseUrls.production}/projects/${projectId}/rfis`,
      daily_log: `${PROCORE_SELECTORS.baseUrls.production}/projects/${projectId}/daily_log`,
    };

    await page.goto(reportUrls[reportType], { waitUntil: "networkidle" });
    await randomDelay(2000, 3000);

    // Look for export menu/button
    const exportTrigger = await page.$('[data-testid="export-menu"], button:has-text("Export"), button:has-text("Report"), .export-dropdown-trigger');

    if (exportTrigger) {
      await exportTrigger.click();
      await randomDelay(500, 1000);

      // Look for PDF export option
      const pdfOption = await page.$('button:has-text("PDF"), [data-testid="export-pdf"], a:has-text("PDF")');

      if (pdfOption) {
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: 60000 }),
          pdfOption.click(),
        ]);

        const fileName = download.suggestedFilename() || `${reportType}-report-${projectId}.pdf`;
        const downloadPath = path.join(outputDir, fileName);
        await download.saveAs(downloadPath);

        result.files.push({
          name: fileName,
          localPath: downloadPath,
          type: reportType,
        });

        log(`Exported ${reportType} report for project ${projectId}`, "playwright");
      } else {
        // Try Excel export as fallback
        const excelOption = await page.$('button:has-text("Excel"), button:has-text("CSV"), [data-testid="export-excel"]');

        if (excelOption) {
          const [download] = await Promise.all([
            page.waitForEvent("download", { timeout: 60000 }),
            excelOption.click(),
          ]);

          const fileName = download.suggestedFilename() || `${reportType}-report-${projectId}.xlsx`;
          const downloadPath = path.join(outputDir, fileName);
          await download.saveAs(downloadPath);

          result.files.push({
            name: fileName,
            localPath: downloadPath,
            type: reportType,
          });

          log(`Exported ${reportType} report (Excel) for project ${projectId}`, "playwright");
        } else {
          result.errors.push(`No export option found for ${reportType}`);
        }
      }
    } else {
      result.errors.push(`Export button not found for ${reportType}`);
    }

    result.success = result.files.length > 0;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    result.errors.push(errorMessage);
    log(`Error exporting ${reportType} report: ${errorMessage}`, "playwright");
  }

  return result;
}

export async function exportAllProjectDataViaUI(
  page: Page,
  projectId: string,
  outputDir: string,
  options: {
    includeSpecs?: boolean;
    includeDrawings?: boolean;
    includeBudgetReport?: boolean;
    includeSubmittalLog?: boolean;
    includeRfiLog?: boolean;
    includeDailyLog?: boolean;
  } = {}
): Promise<ArchiveExportResult> {
  const result: ArchiveExportResult = {
    success: false,
    files: [],
    errors: [],
  };

  const opts = {
    includeSpecs: options.includeSpecs ?? true,
    includeDrawings: options.includeDrawings ?? true,
    includeBudgetReport: options.includeBudgetReport ?? true,
    includeSubmittalLog: options.includeSubmittalLog ?? true,
    includeRfiLog: options.includeRfiLog ?? true,
    includeDailyLog: options.includeDailyLog ?? false,
  };

  // Create output directory
  await fs.mkdir(outputDir, { recursive: true });

  log(`Starting UI-based export for project ${projectId}`, "playwright");

  // Export specifications (API not available)
  if (opts.includeSpecs) {
    const specsResult = await exportSpecificationsViaUI(page, projectId, path.join(outputDir, "Specifications"));
    result.files.push(...specsResult.files);
    result.errors.push(...specsResult.errors);
  }

  // Export full drawing set PDFs
  if (opts.includeDrawings) {
    const drawingsResult = await exportDrawingSetPdfsViaUI(page, projectId, path.join(outputDir, "Drawings"));
    result.files.push(...drawingsResult.files);
    result.errors.push(...drawingsResult.errors);
  }

  // Export reports
  if (opts.includeBudgetReport) {
    const budgetResult = await exportProjectReportViaUI(page, projectId, "budget", path.join(outputDir, "Reports"));
    result.files.push(...budgetResult.files);
    result.errors.push(...budgetResult.errors);
  }

  if (opts.includeSubmittalLog) {
    const submittalResult = await exportProjectReportViaUI(page, projectId, "submittal_log", path.join(outputDir, "Reports"));
    result.files.push(...submittalResult.files);
    result.errors.push(...submittalResult.errors);
  }

  if (opts.includeRfiLog) {
    const rfiResult = await exportProjectReportViaUI(page, projectId, "rfi_log", path.join(outputDir, "Reports"));
    result.files.push(...rfiResult.files);
    result.errors.push(...rfiResult.errors);
  }

  if (opts.includeDailyLog) {
    const dailyResult = await exportProjectReportViaUI(page, projectId, "daily_log", path.join(outputDir, "Reports"));
    result.files.push(...dailyResult.files);
    result.errors.push(...dailyResult.errors);
  }

  result.success = result.files.length > 0;

  log(`UI export complete for project ${projectId}: ${result.files.length} files, ${result.errors.length} errors`, "playwright");

  return result;
}

export async function exportAndSaveEstimatePdf(
  page: Page,
  bidboardProjectId: string,
  portfolioProjectId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await navigateToProject(page, bidboardProjectId);
    
    // Click on Estimate tab
    const estimateTab = await page.$(PROCORE_SELECTORS.bidboard.estimateTab);
    if (estimateTab) {
      await estimateTab.click();
      await randomDelay(2000, 3000);
    }
    
    // Click export button
    const exportButton = await page.$(PROCORE_SELECTORS.estimate.exportButton);
    if (!exportButton) {
      return { success: false, error: "Export button not found" };
    }
    
    await exportButton.click();
    await randomDelay(500, 1000);
    
    // Select PDF option
    const pdfOption = await page.$(PROCORE_SELECTORS.estimate.exportPdfOption);
    
    await ensureTempDir();
    
    let downloadPath: string;
    
    if (pdfOption) {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 30000 }),
        pdfOption.click(),
      ]);
      
      downloadPath = path.join(TEMP_DIR, `estimate-${bidboardProjectId}.pdf`);
      await download.saveAs(downloadPath);
    } else {
      // Direct download
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 30000 }),
      ]);
      
      downloadPath = path.join(TEMP_DIR, `estimate-${bidboardProjectId}.pdf`);
      await download.saveAs(downloadPath);
    }
    
    // Upload to Portfolio documents
    const uploaded = await uploadDocumentToPortfolio(page, portfolioProjectId, {
      name: `Estimate-${bidboardProjectId}.pdf`,
      localPath: downloadPath,
    });
    
    // Clean up
    try {
      await fs.unlink(downloadPath);
    } catch {
      // Ignore cleanup errors
    }
    
    if (uploaded) {
      return { success: true };
    } else {
      return { success: false, error: "Failed to upload estimate PDF to Portfolio" };
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
