/**
 * Playwright Documents Module
 * ===========================
 * 
 * This module handles document operations in Procore via browser automation.
 * It manages uploads, downloads, and exports for both BidBoard and Portfolio.
 * 
 * Document Operations:
 * 
 * 1. Upload Documents:
 *    - Upload files to BidBoard projects
 *    - Upload files to Portfolio projects
 *    - Sync HubSpot attachments to Procore
 * 
 * 2. Download Documents:
 *    - Download files from Procore projects
 *    - Handle authentication headers for downloads
 * 
 * 3. Export Operations:
 *    - Export project specifications as PDF
 *    - Export project drawings as ZIP
 *    - Export project reports
 *    - Export estimates as PDF
 * 
 * HubSpot → Procore Document Sync:
 * When a BidBoard project is created from HubSpot, this module can
 * automatically upload all HubSpot deal attachments to the new project.
 * 
 * Key Functions:
 * - uploadDocumentToBidBoard(): Upload file to BidBoard project
 * - uploadDocumentToPortfolio(): Upload file to Portfolio project
 * - syncHubSpotAttachmentsToBidBoard(): Sync all deal attachments
 * - downloadFile(): Download file from URL to local path
 * - downloadProcoreFile(): Download file from Procore API
 * - exportProjectSpecifications(): Export specs as PDF
 * - exportProjectDrawings(): Export drawings as ZIP
 * - exportAndSaveEstimatePdf(): Export estimate as PDF
 * 
 * File Handling:
 * - Temporary files stored in TEMP_DIR (default: .playwright-temp)
 * - Automatic cleanup of temp files after processing
 * 
 * @module playwright/documents
 */

import { Page } from "playwright";
import { ensureLoggedIn } from "./auth";
import { PROCORE_SELECTORS, PROCORE_URLS } from "./selectors";
import { randomDelay, takeScreenshot } from "./browser";
import { navigateToProject } from "./bidboard";
import { navigateToPortfolioProject } from "./portfolio";
import { log } from "../index";
import { storage } from "../storage";
import { fetchWithTimeout } from "../lib/fetch-with-timeout";
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

const DOWNLOAD_TIMEOUT_MS = 120_000; // 2 min for large files
const UPLOAD_ACTION_TIMEOUT_MS = 180_000; // 3 min for upload + Procore processing

/** Multiple fallback selectors for file input - Procore BidBoard uses dropzone in modal */
const FILE_INPUT_SELECTORS = [
  'body > div:nth-of-type(2) input[type="file"]', // From Puppeteer recording
  '[class*="StyledDropzoneContainer"] input[type="file"]',
  '[class*="StyledDropzoneWrapper"] input[type="file"]',
  '[class*="StyledDropzone"] input[type="file"]',
  '[class*="StyledModal"] input[type="file"]',
  '[class*="StyledPortal"] input[type="file"]',
  PROCORE_SELECTORS.documents.fileInput,
  'input[type="file"]',
  '[role="dialog"] input[type="file"]',
  '.modal input[type="file"], [class*="Modal"] input[type="file"]',
  'input[type="file"][accept]',
];

/** Dismiss toast/notification overlays that block clicks. Call before any click in Procore BidBoard. */
async function dismissOverlays(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    try {
      const closeBtn = page.locator('[data-internal="close-button"][aria-label="Close"], [class*="StyledPortal"] button[aria-label="Close"]');
      const count = await closeBtn.count();
      if (count === 0) break;
      await closeBtn.first().click({ force: true });
      await new Promise((r) => setTimeout(r, 500));
    } catch {
      break;
    }
  }
}

/** Find file input with fallbacks and optional wait. Returns null if not found. */
async function findFileInputForUpload(page: Page, waitMs: number = 8000): Promise<Awaited<ReturnType<Page["$"]>>> {
  const endTime = Date.now() + waitMs;
  while (Date.now() < endTime) {
    for (const sel of FILE_INPUT_SELECTORS) {
      try {
        const el = await page.$(sel);
        if (el) return el;
      } catch {
        /* ignore */
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  // Final fallback: use locator with wait (better for React/SPA that renders async)
  try {
    const loc = page.locator('input[type="file"]').first();
    await loc.waitFor({ state: "attached", timeout: 3000 });
    return await loc.elementHandle();
  } catch {
    return null;
  }
}

/** Download file from URL. Returns { success, finalPath }. For HubSpot, may append extension from headers. */
async function downloadFile(
  url: string,
  destPath: string,
  options?: { accessToken?: string; fileName?: string; logPrefix?: string }
): Promise<{ success: boolean; finalPath: string }> {
  const isHubSpot = /hubspot\.com/i.test(url);
  if (isHubSpot && options?.accessToken) {
    try {
      if (options.fileName) {
        log(`Downloading HubSpot file: ${options.fileName} from ${url}`, "playwright");
      }
      const response = await fetchWithTimeout(url, {
        headers: { Authorization: `Bearer ${options.accessToken}` },
        redirect: "follow",
      }, 60000);
      if (!response.ok) return { success: false, finalPath: destPath };

      const contentType = response.headers.get("content-type") || "";
      const contentDisp = response.headers.get("content-disposition") || "";
      log(`HubSpot download headers — Content-Type: ${contentType}, Content-Disposition: ${contentDisp}`, "playwright");

      // Extract extension from Content-Disposition filename
      const filenameMatch = contentDisp.match(/filename[*]?=(?:UTF-8''|"?)([^";]+)/i);
      if (filenameMatch) {
        const origExt = path.extname(filenameMatch[1].replace(/"/g, ""));
        if (origExt && !destPath.toLowerCase().endsWith(origExt.toLowerCase())) {
          destPath = destPath + origExt;
        }
      } else if (!path.extname(destPath)) {
        // Use Content-Type as fallback (don't add .txt for text/plain — let magic bytes handle it)
        if (contentType.includes("pdf")) destPath += ".pdf";
        else if (contentType.includes("png")) destPath += ".png";
        else if (contentType.includes("jpeg") || contentType.includes("jpg")) destPath += ".jpg";
        else if (contentType.includes("spreadsheet") || contentType.includes("excel")) destPath += ".xlsx";
        else if (contentType.includes("msword") || contentType.includes("wordprocessing")) destPath += ".docx";
        else if (contentType.includes("csv")) destPath += ".csv";
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      await fs.writeFile(destPath, buffer);
      return { success: true, finalPath: destPath };
    } catch {
      return { success: false, finalPath: destPath };
    }
  }
  return new Promise<{ success: boolean; finalPath: string }>((resolve) => {
    const protocol = url.startsWith("https") ? https : http;
    const file = require("fs").createWriteStream(destPath);
    let settled = false;
    const done = (result: { success: boolean; finalPath: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        file.close();
      } catch {
        /* ignore */
      }
      resolve(result);
    };
    const timer = setTimeout(() => done({ success: false, finalPath: destPath }), DOWNLOAD_TIMEOUT_MS);

    file.on("error", () => done({ success: false, finalPath: destPath }));

    const request = protocol.get(url, (response) => {
      if (response.statusCode === 200) {
        response.pipe(file);
        file.on("finish", () => done({ success: true, finalPath: destPath }));
      } else {
        response.destroy();
        done({ success: false, finalPath: destPath });
      }
    });

    request.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      request.destroy();
      done({ success: false, finalPath: destPath });
    });
    request.on("error", () => done({ success: false, finalPath: destPath }));
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

/** Resolve file paths from documents; download URLs to temp when needed. Failures are isolated — skip failed files, continue with rest. */
async function resolveDocumentPaths(documents: DocumentInfo[]): Promise<{ paths: string[]; names: string[]; tempDirs: string[] }> {
  const paths: string[] = [];
  const names: string[] = [];
  const tempDirs: string[] = [];
  await ensureTempDir();
  let accessToken: string | undefined;
  const needsHubSpotToken = documents.some((d) => d.url && /hubspot\.com/i.test(d.url));
  if (needsHubSpotToken) {
    try {
      const { getAccessToken } = await import("../hubspot");
      accessToken = await getAccessToken();
    } catch (e: any) {
      log(`Could not get HubSpot token for download: ${e.message}`, "playwright");
    }
  }
  for (const doc of documents) {
    let filePath = doc.localPath;
    if (!filePath && doc.url) {
      try {
        const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const subDir = path.join(TEMP_DIR, uploadId);
        await fs.mkdir(subDir, { recursive: true });
        tempDirs.push(subDir);
        const baseName = (doc.name || "file").replace(/[/\\]/g, "_") || "file";
        filePath = path.join(subDir, baseName);
        const isHubSpot = /hubspot\.com/i.test(doc.url);
        const downloadResult = await downloadFile(doc.url, filePath, {
          accessToken: isHubSpot ? accessToken : undefined,
          fileName: doc.name,
        });
        if (!downloadResult.success) throw new Error(`Failed to download from ${doc.url}`);
        filePath = downloadResult.finalPath;

        // After download, ensure file has a recognized extension (Procore rejects files without one)
        const ext = path.extname(filePath).toLowerCase();
        const RECOGNIZED_EXTENSIONS = [".pdf", ".png", ".jpg", ".jpeg", ".gif", ".csv", ".txt", ".xlsx", ".xls", ".doc", ".docx"];
        if (!ext || !RECOGNIZED_EXTENSIONS.includes(ext)) {
          const fileBuffer = await fs.readFile(filePath);
          const header = fileBuffer.subarray(0, 8);
          const hex = header.toString("hex").toLowerCase();
          let detectedExt = "";
          if (hex.startsWith("25504446")) detectedExt = ".pdf"; // %PDF
          else if (hex.startsWith("89504e47")) detectedExt = ".png"; // PNG
          else if (hex.startsWith("ffd8ff")) detectedExt = ".jpg"; // JPEG
          else if (hex.startsWith("504b0304")) detectedExt = ".xlsx"; // ZIP-based (xlsx/docx)
          else if (hex.startsWith("d0cf11e0")) detectedExt = ".doc"; // OLE compound
          else if (hex.startsWith("47494638")) detectedExt = ".gif"; // GIF
          else {
            const firstChars = fileBuffer.subarray(0, 100).toString("utf8");
            if (firstChars.includes(",") && firstChars.includes("\n")) detectedExt = ".csv";
            else detectedExt = ".pdf"; // Final fallback — most HubSpot deal attachments are PDFs
          }
          log(`File type detection for ${doc.name}: hex=${hex.substring(0, 16)}, detected=${detectedExt}`, "playwright");
          const newFilePath = filePath + detectedExt;
          await fs.rename(filePath, newFilePath);
          filePath = newFilePath;
          log(`Added extension ${detectedExt} to ${doc.name} (detected from file header)`, "playwright");
        }
        log(`Ready to upload: ${doc.name}`, "playwright");
      } catch (err: any) {
        log(`Skipping ${doc.name}: ${err.message}`, "playwright");
        continue;
      }
    }
    if (filePath) {
      paths.push(filePath);
      names.push(doc.name);
    }
  }
  return { paths, names, tempDirs };
}

export async function uploadDocumentToBidBoard(
  page: Page,
  projectId: string,
  documentOrDocuments: DocumentInfo | DocumentInfo[]
): Promise<boolean> {
  const documents = Array.isArray(documentOrDocuments) ? documentOrDocuments : [documentOrDocuments];
  if (documents.length === 0) return true;

  try {
    page.setDefaultTimeout(UPLOAD_ACTION_TIMEOUT_MS);
    await navigateToProject(page, projectId);
    await takeScreenshot(page, "upload-1-after-navigate");
    await randomDelay(2000, 3000);

    const isNewBidBoard = page.url().includes("/tools/bid-board");

    const { paths: filePaths, names: documentNames, tempDirs } = await resolveDocumentPaths(documents);
    if (filePaths.length === 0) {
      log(`No attachments could be downloaded for project ${projectId}`, "playwright");
      return false;
    }

    if (isNewBidBoard) {
      // Wait for SPA content to fully render before looking for the upload button
      try {
        await page.waitForSelector('bid-board-app#spaContent, #spaContent', { timeout: 15000 });
      } catch {
        log("SPA content container not found, continuing anyway", "playwright");
      }
      await randomDelay(2000, 3000);

      // New BidBoard UI: Upload (header) → Upload Attachments → Upload Files → Attach
      await dismissOverlays(page);
      await takeScreenshot(page, "upload-2-after-toast-dismiss");
      let uploadBtn = await page.$("div.aid-upload-documents button");
      if (!uploadBtn) {
        uploadBtn = await page.$("button:has-text('Upload')");
      }
      if (!uploadBtn) {
        try {
          await page.waitForSelector("div.aid-upload-documents button, button:has-text('Upload')", { timeout: 15000 });
          uploadBtn = await page.$("div.aid-upload-documents button, button:has-text('Upload')");
        } catch {
          // Take screenshot for debugging
          const { takeScreenshot } = await import("./browser");
          const ssPath = await takeScreenshot(page, "upload-button-not-found");
          log(`Upload button not found in BidBoard (new UI). Screenshot: ${ssPath}`, "playwright");
          return false;
        }
      }
      if (!uploadBtn) {
        const { takeScreenshot } = await import("./browser");
        const ssPath = await takeScreenshot(page, "upload-button-not-found");
        log(`Upload button not found in BidBoard (new UI). Screenshot: ${ssPath}`, "playwright");
        return false;
      }
      await uploadBtn.click({ force: true });
      await takeScreenshot(page, "upload-3-after-upload-click");
      await randomDelay(1000, 1500);
      await dismissOverlays(page);
      const uploadAttachments = page.locator('li.aid-upload-attachments, [role="menuitem"]').filter({ hasText: /Upload Attachments/i }).first();
      try {
        await uploadAttachments.click({ timeout: 8000, force: true });
      } catch {
        const uploadDrawings = page.locator('li.aid-upload-drawings, [role="menuitem"]').filter({ hasText: /Upload Drawings/i }).first();
        await uploadDrawings.click({ timeout: 8000, force: true });
      }
      await takeScreenshot(page, "upload-4-after-menu-click");
      await randomDelay(2000, 3000);
      // Wait for upload modal and dropzone to appear
      await page.waitForSelector('[class*="StyledDropzoneContainer"], button.StyledUploadButton, button:has-text("Upload Files"), button:has-text("Attach Files")', { timeout: 10000 }).catch(() => {});
      await takeScreenshot(page, "upload-5-dropzone-ready");
    } else {
      // Legacy: Documents tab then upload
      const documentsTab = await page.$(PROCORE_SELECTORS.bidboard.documentsTab);
      if (documentsTab) {
        await documentsTab.click();
        await randomDelay(2000, 3000);
      }
    }

    // Legacy: click upload button. New BidBoard: click "Upload Files" to open native file picker,
    // then intercept with page.waitForEvent('filechooser') — setInputFiles on hidden input closes the modal.
    if (!isNewBidBoard) {
      const uploadButton = await page.$(PROCORE_SELECTORS.documents.uploadButton);
      if (!uploadButton) {
        log("Upload button not found in BidBoard documents", "playwright");
        return false;
      }
      await dismissOverlays(page);
      await uploadButton.click({ force: true });
    }
    await randomDelay(1000, 2000);

    // Upload files: New BidBoard — batch all files in one modal cycle.
    // Flow: Upload → Upload Attachments → Upload Files (filechooser with ALL files) → wait for progress → Attach
    let success: boolean;
    if (isNewBidBoard) {
      try {
        log(`Uploading ${filePaths.length} file(s) to BidBoard project ${projectId}`, "playwright");

        // Ensure "My Computer" tab is active in the Attach Files modal
        // The modal may default to a different tab (e.g., Procore files)
        const myComputerTab = page.locator('text="My Computer"').first();
        try {
          await myComputerTab.click({ timeout: 5000 });
          await randomDelay(1000, 1500);
          log("Clicked 'My Computer' tab in upload modal", "playwright");
        } catch {
          log("'My Computer' tab not found or already active", "playwright");
        }

        // Click "Upload Files" button to trigger native file picker
        const uploadFilesBtn = page.locator(
          'button:has-text("Upload Files"), button:has-text("Attach Files"), ' +
          '[class*="StyledDropzoneMessage"] button, [class*="StyledDropzone"] button'
        ).first();
        await uploadFilesBtn.waitFor({ state: 'visible', timeout: 20000 });
        await randomDelay(1000, 1500);

        // Use filechooser event — set ALL files at once
        const [fileChooser] = await Promise.all([
          page.waitForEvent('filechooser', { timeout: 25000 }),
          uploadFilesBtn.click({ force: true, timeout: 15000 }),
        ]);
        log(`Setting ${filePaths.length} file(s) in file chooser`, "playwright");
        await fileChooser.setFiles(filePaths);

        // Wait for all uploads to complete — poll for "Total Progress: 100%" or all progress bars done
        // Procore shows "Uploaded X of Y" status text
        const fileCount = filePaths.length;
        await page.waitForFunction(
          (count) => {
            const statusEl = document.querySelector('[role="status"]');
            if (statusEl?.textContent?.includes(`Uploaded ${count} of ${count}`)) return true;
            if (statusEl?.textContent?.includes('Total Progress: 100%')) return true;
            // Check if all progress bars are complete
            const bars = document.querySelectorAll('[role="progressbar"]');
            if (bars.length === count) {
              return Array.from(bars).every((b) => {
                const val = b.getAttribute('aria-valuenow');
                return val === '100';
              });
            }
            return false;
          },
          fileCount,
          { timeout: 120000 } // 2 min max for large files
        ).catch(() => {
          log(`Upload progress check timed out — continuing to click Attach anyway`, "playwright");
        });
        await randomDelay(2000, 3000);
        await takeScreenshot(page, "upload-progress-complete");

        // Click Attach button — try multiple selectors
        const attachButton = page.locator(
          'button:has-text("Attach"):not([disabled]), ' +
          '[data-qa="qa-attach-button"]:not([disabled])'
        ).first();
        await attachButton.waitFor({ state: 'visible', timeout: 20000 });
        await attachButton.click({ force: true });
        log(`Clicked Attach for ${filePaths.length} file(s)`, "playwright");

        // Wait for modal to close — the Attach Files dialog disappears after successful attach
        await page.waitForFunction(
          () => {
            // Check that no "Attach Files" modal header is visible
            const headers = document.querySelectorAll('div, h2, h3');
            for (const h of headers) {
              if (h.textContent?.trim() === 'Attach Files' && (h as HTMLElement).offsetParent !== null) return false;
            }
            return true;
          },
          undefined,
          { timeout: 60000 }
        ).catch(() => {
          log("Attach Files modal did not close within timeout", "playwright");
        });
        await randomDelay(3000, 5000);

        success = true;
        log(`Successfully uploaded ${filePaths.length} file(s) to BidBoard project ${projectId}`, "playwright");
        await takeScreenshot(page, "upload-complete");
      } catch (err: any) {
        log(`Failed to upload files: ${err.message}`, "playwright");
        await takeScreenshot(page, "upload-error");
        success = false;

        // Try to dismiss modal if still open
        try {
          const cancelBtn = page.locator('button:has-text("Cancel")').first();
          if (await cancelBtn.isVisible({ timeout: 2000 })) {
            await cancelBtn.click();
            await randomDelay(1000, 1500);
          }
        } catch { /* modal may already be closed */ }
      }
      log(`Upload complete: ${success ? filePaths.length : 0}/${filePaths.length} files uploaded to BidBoard project ${projectId}`, "playwright");
      if (success) {
        await logDocumentAction(projectId, "upload_to_bidboard", "success", { documentNames, count: filePaths.length });
      } else {
        log(`Failed to upload files to BidBoard project ${projectId}`, "playwright");
      }
    } else {
      const fileInput = await findFileInputForUpload(page, 8000);
      if (!fileInput) {
        const ssPath = await takeScreenshot(page, "file-input-not-found-bidboard");
        log(`File input not found in BidBoard upload modal. Screenshot: ${ssPath}`, "playwright");
        return false;
      }
      try {
        await fileInput.setInputFiles(filePaths.length === 1 ? filePaths[0] : filePaths);
      } finally {
        try { await fileInput.dispose(); } catch { /* ignore */ }
      }
      await takeScreenshot(page, "upload-7-after-file-set");
      await randomDelay(2000, 5000);

      await page.waitForLoadState("load").catch(() => {});

      const documentList = await page.$(PROCORE_SELECTORS.documents.documentList);
      const documentText = documentList ? await documentList.textContent() : null;
      success = !!documentText && documentNames.some((n) => documentText.includes(n));

      if (success) {
        const namesStr = documentNames.join(", ");
        log(`Successfully uploaded ${documentNames.length} file(s) to BidBoard project ${projectId}: ${namesStr}`, "playwright");
        await logDocumentAction(projectId, "upload_to_bidboard", "success", { documentNames, count: documentNames.length });
      }
    }

    await page.waitForLoadState("load").catch(() => {});

    for (const dir of tempDirs) {
      try {
        if (dir.startsWith(path.resolve(TEMP_DIR))) await fs.rm(dir, { recursive: true });
      } catch (e) {
        log(`Failed to delete temp dir after upload: ${dir}`, "playwright");
      }
    }

    return success;
  } catch (error) {
    const names = documents.map((d) => d.name).join(", ");
    await takeScreenshot(page, "error-upload-bidboard").catch(() => {});
    log(`Error uploading document(s) to BidBoard: ${error}`, "playwright");
    await logDocumentAction(projectId, "upload_to_bidboard", "failed", { documentNames: names }, String(error));
    return false;
  } finally {
    page.setDefaultTimeout(30000);
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
        await takeScreenshot(page, "error-download-document").catch(() => {});
        log(`Error downloading document: ${error}`, "playwright");
      }
    }

    log(`Downloaded ${documents.length} documents from BidBoard project ${projectId}`, "playwright");
  } catch (error) {
    await takeScreenshot(page, "error-download-bidboard-documents").catch(() => {});
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
    page.setDefaultTimeout(UPLOAD_ACTION_TIMEOUT_MS);
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
    
    // Get file path - download if needed, keep until upload succeeds
    let filePath = document.localPath;
    let tempFileCreated = false;
    
    if (!filePath && document.url) {
      await ensureTempDir();
      const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const subDir = path.join(TEMP_DIR, uploadId);
      await fs.mkdir(subDir, { recursive: true });
      const baseName = path.basename((document.name || "file").replace(/[/\\]/g, "_")) || "file";
      filePath = path.join(subDir, baseName);
      const downloadResult = await downloadFile(document.url, filePath);
      if (!downloadResult.success) {
        try { await fs.rm(subDir, { recursive: true }); } catch { /* ignore */ }
        log(`Failed to download file from ${document.url}`, "playwright");
        return false;
      }
      filePath = downloadResult.finalPath;
      tempFileCreated = true;
    }
    
    if (!filePath) {
      log("No file path available for upload", "playwright");
      return false;
    }

    // Upload file - use fallbacks and wait for input
    let fileInput = await findFileInputForUpload(page, 8000);
    if (!fileInput) {
      const ssPath = await takeScreenshot(page, "file-input-not-found-portfolio");
      log(`File input not found in Portfolio upload. Screenshot: ${ssPath}`, "playwright");
      return false;
    }
    try {
      await fileInput.setInputFiles(filePath);
    } finally {
      try { await fileInput.dispose(); } catch { /* ignore */ }
    }
    await randomDelay(2000, 5000);

    // Wait for upload to complete
    await page.waitForLoadState("networkidle");
    
    // Verify upload by checking if document appears in the list
    const documentList = await page.$(PROCORE_SELECTORS.documents.documentList);
    const documentText = documentList ? await documentList.textContent() : null;
    
    if (documentText && documentText.includes(document.name)) {
      log(`Successfully uploaded ${document.name} to Portfolio project ${projectId}`, "playwright");
      await logDocumentAction(projectId, "upload_to_portfolio", "success", { documentName: document.name });
      if (tempFileCreated && filePath) {
        try {
          const dir = path.dirname(filePath);
          if (dir.startsWith(path.resolve(TEMP_DIR))) {
            await fs.rm(dir, { recursive: true });
          }
        } catch (e) {
          log(`Failed to delete temp file after upload: ${filePath}`, "playwright");
        }
      }
      return true;
    }
    
    log(`Upload verification failed: ${document.name} not found in Portfolio document list`, "playwright");
    await logDocumentAction(projectId, "upload_to_portfolio", "failed", { documentName: document.name }, "Document not found in list after upload");
    return false;
  } catch (error) {
    await takeScreenshot(page, "error-upload-portfolio").catch(() => {});
    log(`Error uploading document to Portfolio: ${error}`, "playwright");
    await logDocumentAction(projectId, "upload_to_portfolio", "failed", { documentName: document.name }, String(error));
    return false;
  } finally {
    page.setDefaultTimeout(30000);
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
    
    // Batch upload all attachments in one modal session
    if (attachments.length > 0) {
      const uploaded = await uploadDocumentToBidBoard(page, bidboardProjectId, attachments);
      result.documentsUploaded = uploaded ? attachments.length : 0;
      if (!uploaded) result.errors.push(`Failed to upload ${attachments.length} attachment(s)`);
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

/** Sync an explicit list of attachments to a BidBoard project. Used by RFP approval flow.
 * Attachments with localPath (RFP temp files) are used directly; URL-based are downloaded and stored temporarily until upload. */
export async function syncAttachmentsListToBidBoard(
  bidboardProjectId: string,
  attachments: DocumentInfo[]
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
    result.documentsDownloaded = attachments.length;
    if (attachments.length > 0) {
      const docs: DocumentInfo[] = attachments.map((att) => ({
        name: att.name,
        url: att.url,
        localPath: att.localPath,
        type: att.type,
        size: att.size,
      }));
      const uploaded = await uploadDocumentToBidBoard(page, bidboardProjectId, docs);
      result.documentsUploaded = uploaded ? docs.length : 0;
      if (!uploaded) result.errors.push(`Failed to upload ${docs.length} attachment(s)`);
    }
    result.success = result.errors.length === 0;
  } catch (e: any) {
    result.errors.push(e.message || String(e));
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
    const specsUrl = `${PROCORE_URLS.app}/projects/${projectId}/specifications`;
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
    await takeScreenshot(page, "error-export-specifications").catch(() => {});
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
    const drawingsUrl = `${PROCORE_URLS.app}/projects/${projectId}/drawings`;
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
    await takeScreenshot(page, "error-export-drawings").catch(() => {});
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
      budget: `${PROCORE_URLS.app}/projects/${projectId}/budget`,
      submittal_log: `${PROCORE_URLS.app}/projects/${projectId}/submittals`,
      rfi_log: `${PROCORE_URLS.app}/projects/${projectId}/rfis`,
      daily_log: `${PROCORE_URLS.app}/projects/${projectId}/daily_log`,
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
    await takeScreenshot(page, `error-export-report-${reportType}`).catch(() => {});
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
      // No PDF option found - the export button itself may trigger direct download
      // Re-click export button to trigger the download
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 30000 }),
        exportButton.click(),
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
