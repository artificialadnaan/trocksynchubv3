import type { Express, RequestHandler } from "express";
import { asyncHandler } from "../lib/async-handler";
import { storage } from "../storage";
import { DEFAULT_PROCORE_COMPANY_ID } from "../constants";

export function registerTestingRoutes(app: Express, requireAuth: RequestHandler) {
  // ==================== TESTING MODE ====================

  app.get("/api/testing/mode", requireAuth, asyncHandler(async (_req, res) => {
    const mode = await storage.getTestingMode();
    res.json(mode);
  }));

  app.post("/api/testing/mode", requireAuth, asyncHandler(async (req, res) => {
    const { enabled, testEmail } = req.body;
    if (!testEmail && enabled) {
      return res.status(400).json({ error: "testEmail is required when enabling testing mode" });
    }
    await storage.setTestingMode(enabled, testEmail || '');

    await storage.createAuditLog({
      action: enabled ? 'testing_mode_enabled' : 'testing_mode_disabled',
      entityType: 'settings',
      source: 'admin',
      status: 'success',
      details: { testEmail },
    });

    res.json({ success: true, enabled, testEmail });
  }));

  app.post("/api/testing/send-test-email", requireAuth, asyncHandler(async (req, res) => {
    const { templateKey, testRecipient } = req.body;
    const { sendEmail, renderTemplate } = await import('../email-service');

    const template = await storage.getEmailTemplate(templateKey);
    if (!template) {
      return res.status(404).json({ error: `Template '${templateKey}' not found` });
    }

    const sampleVariables: Record<string, string> = {
      assigneeName: 'Test User',
      projectName: 'Sample Project - Test',
      roleName: 'Project Manager',
      projectId: '12345678',
      companyId: DEFAULT_PROCORE_COMPANY_ID,
      procoreUrl: `https://us02.procore.com/webclients/host/companies/${DEFAULT_PROCORE_COMPANY_ID}/projects/12345678/tools/projecthome`,
      hubspotUrl: 'https://app-na2.hubspot.com/contacts/45644695/objects/0-3',
      companycamUrl: 'https://app.companycam.com/projects',
      previousStage: 'Estimating',
      newStage: 'Internal Review',
      hubspotStage: 'Internal Review',
      timestamp: new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
      recipientName: 'Test User',
      clientName: 'Test Client Inc.',
      projectAddress: '123 Test Street, Dallas, TX 75001',
      pmName: 'John PM',
      superName: 'Mike Super',
      date: new Date().toLocaleDateString('en-US', { dateStyle: 'long' }),
      projectsScanned: '15',
      stageChanges: '3',
      portfolioTransitions: '1',
      hubspotUpdates: '2',
      bidboardUrl: `https://us02.procore.com/webclients/host/companies/${DEFAULT_PROCORE_COMPANY_ID}/projects`,
      hubspotDealsUrl: 'https://app-na2.hubspot.com/contacts/45644695/objects/0-3/views/all/list',
      syncHubUrl: process.env.APP_URL || 'http://localhost:5000',
      nextSyncTime: '1 hour',
      changedProjects: '',
      surveyUrl: `${process.env.APP_URL || 'http://localhost:5000'}/survey/test-token`,
      googleReviewUrl: 'https://g.page/r/YOUR_GOOGLE_REVIEW_LINK/review',
      ownerName: 'Deal Owner',
      dealName: 'Sample Deal - Test',
    };

    if (!testRecipient) {
      return res.status(400).json({ error: "testRecipient is required" });
    }
    const subject = renderTemplate(template.subject, sampleVariables);
    const htmlBody = renderTemplate(template.bodyHtml, sampleVariables);

    const result = await sendEmail({
      to: testRecipient,
      subject,
      htmlBody,
      fromName: 'T-Rock Sync Hub (Test)',
    });

    await storage.createAuditLog({
      action: 'test_email_sent',
      entityType: 'email',
      source: 'admin',
      status: result.success ? 'success' : 'failed',
      details: { templateKey, recipient: testRecipient, provider: result.provider },
    });

    res.json(result);
  }));

  // ==================== PLAYWRIGHT SCREENSHOTS ====================

  app.get("/api/testing/playwright/screenshots", requireAuth, asyncHandler(async (_req, res) => {
    const fs = await import('fs/promises');
    const path = await import('path');
    const storageDir = process.env.PLAYWRIGHT_STORAGE_DIR || ".playwright-storage";
    try {
      await fs.access(storageDir);
    } catch {
      return res.json({ screenshots: [] });
    }
    const files = await fs.readdir(storageDir);
    const screenshots = [];
    for (const file of files) {
      if (!file.match(/\.(png|jpg|jpeg)$/i)) continue;
      const stat = await fs.stat(path.join(storageDir, file));
      screenshots.push({
        filename: file,
        size: stat.size,
        createdAt: stat.mtime.toISOString(),
      });
    }
    screenshots.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    res.json({ screenshots });
  }));

  app.get("/api/testing/playwright/screenshots/:filename", requireAuth, asyncHandler(async (req, res) => {
    const fs = await import('fs/promises');
    const path = await import('path');
    const storageDir = process.env.PLAYWRIGHT_STORAGE_DIR || ".playwright-storage";
    const filename = path.basename(req.params.filename);
    const filePath = path.join(storageDir, filename);
    try {
      await fs.access(filePath);
    } catch {
      return res.status(404).json({ error: "Screenshot not found" });
    }
    const ext = path.extname(filename).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'application/octet-stream';
    res.setHeader('Content-Type', mimeType);
    if (req.query.download === 'true') {
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    }
    const data = await fs.readFile(filePath);
    res.send(data);
  }));

  app.delete("/api/testing/playwright/screenshots/:filename", requireAuth, asyncHandler(async (req, res) => {
    const fs = await import('fs/promises');
    const path = await import('path');
    const storageDir = process.env.PLAYWRIGHT_STORAGE_DIR || ".playwright-storage";
    const filename = path.basename(req.params.filename);
    const filePath = path.join(storageDir, filename);
    await fs.unlink(filePath);
    res.json({ success: true });
  }));

  // ==================== PLAYWRIGHT TESTING ====================

  app.get("/api/testing/playwright/status", requireAuth, asyncHandler(async (_req, res) => {
    try {
      const { chromium } = await import('playwright');
      let browserAvailable = false;
      let browserVersion = '';

      try {
        const browser = await chromium.launch({ headless: true });
        browserVersion = browser.version();
        await browser.close();
        browserAvailable = true;
      } catch {
        browserAvailable = false;
      }

      res.json({
        playwrightInstalled: true,
        browserAvailable,
        browserVersion,
      });
    } catch (e: any) {
      res.json({
        playwrightInstalled: false,
        browserAvailable: false,
        error: e.message,
      });
    }
  }));

  app.post("/api/testing/playwright/bidboard-screenshot", requireAuth, asyncHandler(async (req, res) => {
    const { projectId } = req.body;
    const { chromium } = await import('playwright');
    const { loginToProcore } = await import('../playwright/auth');

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
    });
    const page = await context.newPage();

    const loggedIn = await loginToProcore(page);
    if (!loggedIn) {
      await browser.close();
      return res.status(400).json({ error: 'Failed to login to Procore' });
    }

    const companyId = DEFAULT_PROCORE_COMPANY_ID;
    const bidboardUrl = projectId
      ? `https://us02.procore.com/webclients/host/companies/${companyId}/projects/${projectId}/tools/estimating`
      : `https://us02.procore.com/webclients/host/companies/${companyId}/tools/bid-board`;

    console.log(`[playwright] Navigating to BidBoard: ${bidboardUrl}`);
    await page.goto(bidboardUrl, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    const screenshotBuffer = await page.screenshot({ fullPage: true });
    const base64 = screenshotBuffer.toString('base64');

    await browser.close();

    await storage.createAuditLog({
      action: 'playwright_test_bidboard_screenshot',
      entityType: 'playwright',
      source: 'admin',
      status: 'success',
      details: { projectId, url: bidboardUrl },
    });

    res.json({
      success: true,
      screenshot: `data:image/png;base64,${base64}`,
      url: bidboardUrl,
    });
  }));

  app.post("/api/testing/playwright/bidboard-extract", requireAuth, asyncHandler(async (req, res) => {
    const { projectId } = req.body;
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    const { chromium } = await import('playwright');
    const { loginToProcore } = await import('../playwright/auth');
    const { getBidBoardUrlNew, getPortfolioProjectUrlNew } = await import('../playwright/selectors');

    const procoreConfig = await storage.getAutomationConfig("procore_config");
    const companyId = (procoreConfig?.value as any)?.companyId;
    if (!companyId) {
      return res.status(400).json({ error: 'Procore company ID not configured' });
    }

    const credentialsConfig = await storage.getAutomationConfig("procore_browser_credentials");
    const sandbox = (credentialsConfig?.value as any)?.sandbox || false;

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
    });
    const page = await context.newPage();

    const loggedIn = await loginToProcore(page);
    if (!loggedIn) {
      await browser.close();
      return res.status(400).json({ error: 'Failed to login to Procore' });
    }

    const bidboardUrl = getBidBoardUrlNew(companyId, sandbox);
    console.log(`[bidboard-extract] Navigating to BidBoard: ${bidboardUrl}`);
    await page.goto(bidboardUrl, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    const projectUrl = getPortfolioProjectUrlNew(companyId, projectId, sandbox);
    console.log(`[bidboard-extract] Navigating to project: ${projectUrl}`);
    await page.goto(projectUrl, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    const extractedData: Record<string, any> = {
      url: projectUrl,
      timestamp: new Date().toISOString(),
      pageTitle: await page.title(),
      elements: {},
    };

    try {
      const projectNameEl = await page.$('h1, [data-testid="project-name"], .project-name');
      if (projectNameEl) {
        extractedData.elements.projectName = await projectNameEl.textContent();
      }

      const stageEl = await page.$('[data-testid="project-stage"], .project-stage, .status-badge');
      if (stageEl) {
        extractedData.elements.stage = await stageEl.textContent();
      }

      const docLinks = await page.$$('a[href*="documents"], a[href*="files"], .document-link');
      extractedData.elements.documentCount = docLinks.length;
      extractedData.elements.documents = await Promise.all(
        docLinks.slice(0, 10).map(async (link) => ({
          text: await link.textContent(),
          href: await link.getAttribute('href'),
        }))
      );

      const tabs = await page.$$('[role="tab"], .tab-item, nav a');
      extractedData.elements.tabs = await Promise.all(
        tabs.slice(0, 10).map(async (tab) => await tab.textContent())
      );
    } catch (extractError: any) {
      extractedData.extractionError = extractError.message;
    }

    const screenshotBuffer = await page.screenshot({ fullPage: false });
    extractedData.screenshot = `data:image/png;base64,${screenshotBuffer.toString('base64')}`;

    await browser.close();

    await storage.createAuditLog({
      action: 'playwright_test_bidboard_extract',
      entityType: 'playwright',
      source: 'admin',
      status: 'success',
      details: { projectId, elementsFound: Object.keys(extractedData.elements).length },
    });

    res.json({ success: true, data: extractedData });
  }));

  app.post("/api/testing/playwright/portfolio-screenshot", requireAuth, asyncHandler(async (req, res) => {
    const { projectId } = req.body;
    const { chromium } = await import('playwright');
    const { loginToProcore } = await import('../playwright/auth');

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
    });
    const page = await context.newPage();

    const loggedIn = await loginToProcore(page);
    if (!loggedIn) {
      await browser.close();
      return res.status(400).json({ error: 'Failed to login to Procore' });
    }

    const companyId = DEFAULT_PROCORE_COMPANY_ID;
    const portfolioUrl = projectId
      ? `https://us02.procore.com/webclients/host/companies/${companyId}/projects/${projectId}/tools/projecthome`
      : `https://us02.procore.com/webclients/host/companies/${companyId}/tools/hubs/company-hub/views/portfolio`;

    console.log(`[playwright] Navigating to Portfolio: ${portfolioUrl}`);
    await page.goto(portfolioUrl, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    const screenshotBuffer = await page.screenshot({ fullPage: true });
    const base64 = screenshotBuffer.toString('base64');

    await browser.close();

    res.json({
      success: true,
      screenshot: `data:image/png;base64,${base64}`,
      url: portfolioUrl,
    });
  }));

  app.post("/api/testing/playwright/bidboard-new-project-form", requireAuth, asyncHandler(async (req, res) => {
    const { chromium } = await import('playwright');
    const { loginToProcore } = await import('../playwright/auth');
    const { PROCORE_SELECTORS, getBidBoardUrl } = await import('../playwright/selectors');

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
    });
    const page = await context.newPage();

    const loggedIn = await loginToProcore(page);
    if (!loggedIn) {
      await browser.close();
      return res.status(400).json({ error: 'Failed to login to Procore' });
    }

    const config = await storage.getAutomationConfig("procore_config");
    const companyId = (config?.value as any)?.companyId || DEFAULT_PROCORE_COMPANY_ID;
    const credentials = await storage.getAutomationConfig("procore_browser_credentials");
    const sandbox = (credentials?.value as any)?.sandbox || false;

    const bidboardUrl = getBidBoardUrl(companyId, sandbox);
    await page.goto(bidboardUrl, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    const result: any = {
      success: true,
      steps: [],
      elementsFound: {},
      screenshots: {},
    };

    result.screenshots.bidboardList = `data:image/png;base64,${(await page.screenshot()).toString('base64')}`;
    result.steps.push('Captured BidBoard list');

    const createButton = await page.$(PROCORE_SELECTORS.bidboard.createNewProject);
    result.elementsFound.createNewProjectButton = !!createButton;

    if (createButton) {
      await createButton.click();
      await page.waitForTimeout(2000);

      result.screenshots.newProjectForm = `data:image/png;base64,${(await page.screenshot()).toString('base64')}`;
      result.steps.push('Clicked Create New Project, captured form');

      result.elementsFound.nameInput = !!(await page.$(PROCORE_SELECTORS.newProject.nameInput));
      result.elementsFound.stageSelect = !!(await page.$(PROCORE_SELECTORS.newProject.stageSelect));
      result.elementsFound.clientNameInput = !!(await page.$(PROCORE_SELECTORS.newProject.clientNameInput));
      result.elementsFound.createButton = !!(await page.$(PROCORE_SELECTORS.newProject.createButton));
      result.elementsFound.cancelButton = !!(await page.$(PROCORE_SELECTORS.newProject.cancelButton));

      const cancelButton = await page.$(PROCORE_SELECTORS.newProject.cancelButton);
      if (cancelButton) {
        await cancelButton.click();
        result.steps.push('Clicked Cancel to close form');
      }
    } else {
      result.steps.push('Create New Project button not found');
    }

    await browser.close();

    await storage.createAuditLog({
      action: 'playwright_test_new_project_form',
      entityType: 'playwright',
      source: 'admin',
      status: 'success',
      details: { elementsFound: result.elementsFound },
    });

    res.json(result);
  }));

  app.post("/api/testing/playwright/documents-extract", requireAuth, asyncHandler(async (req, res) => {
    const { projectId } = req.body;
    if (!projectId) {
      return res.status(400).json({ error: 'projectId is required' });
    }

    const { chromium } = await import('playwright');
    const { loginToProcore } = await import('../playwright/auth');
    const archiver = (await import('archiver')).default;
    const fs = await import('fs/promises');
    const fsSync = await import('fs');
    const path = await import('path');

    const procoreConfig = await storage.getAutomationConfig("procore_config");
    const companyId = (procoreConfig?.value as any)?.companyId;
    if (!companyId) {
      return res.status(400).json({ error: 'Procore company ID not configured' });
    }

    const browser = await chromium.launch({ headless: true });
    const tempDir = `.playwright-temp/docs-${projectId}-${Date.now()}`;
    await fs.mkdir(tempDir, { recursive: true });

    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      acceptDownloads: true,
    });
    const page = await context.newPage();

    const loggedIn = await loginToProcore(page);
    if (!loggedIn) {
      await browser.close();
      return res.status(400).json({ error: 'Failed to login to Procore' });
    }

    const documentsUrl = `https://us02.procore.com/webclients/host/companies/${companyId}/projects/${projectId}/tools/documents`;
    console.log(`[documents-extract] Navigating to: ${documentsUrl}`);
    await page.goto(documentsUrl, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    const extractedData: Record<string, any> = {
      url: documentsUrl,
      timestamp: new Date().toISOString(),
      folders: [] as { name: string; files: { name: string; downloaded: boolean }[] }[],
      totalFiles: 0,
      downloadedFiles: 0,
    };

    try {
      const folderSelectors = [
        '.tree-item span',
        '[class*="TreeNode"] span',
        '[class*="folder-tree"] li',
        'nav[aria-label] li span',
        '.folder-list li',
        '[data-qa="folder-item"]',
        'span:has-text("Commitments"), span:has-text("CompanyCam"), span:has-text("Contracts"), span:has-text("Correspondence"), span:has-text("Documents"), span:has-text("Permits"), span:has-text("RFI"), span:has-text("Schedules"), span:has-text("Submittals")'
      ];

      let folderNames: string[] = [];

      for (const selector of folderSelectors) {
        try {
          const elements = await page.$$(selector);
          if (elements.length > 0) {
            for (const el of elements) {
              const text = await el.textContent();
              if (text && text.trim() && !text.includes('\n')) {
                const name = text.trim();
                if (name.length > 0 && name.length < 100 && !folderNames.includes(name)) {
                  folderNames.push(name);
                }
              }
            }
            if (folderNames.length > 0) {
              console.log(`[documents-extract] Found ${folderNames.length} folders using selector: ${selector}`);
              break;
            }
          }
        } catch {
          continue;
        }
      }

      if (folderNames.length === 0) {
        console.log('[documents-extract] Trying to scrape folders from table...');
        const rows = await page.$$('tbody tr');
        for (const row of rows) {
          const nameCell = await row.$('td:first-child');
          if (nameCell) {
            const text = await nameCell.textContent();
            const rowClass = await row.getAttribute('class') || '';
            const hasIcon = await row.$('svg, [class*="folder"], [class*="icon"]');
            if (text && text.trim() && (hasIcon || rowClass.includes('folder'))) {
              const name = text.trim();
              if (!folderNames.includes(name)) {
                folderNames.push(name);
              }
            }
          }
        }
      }

      if (folderNames.length === 0) {
        console.log('[documents-extract] Extracting folder names from page content...');
        const pageText = await page.textContent('body');
        const knownFolders = ['Commitments', 'CompanyCam', 'Contracts-Admin', 'Correspondence',
                             'Estimating Documents', 'Permits-Inspections', 'Punch-Closeout',
                             'RFI', 'Schedules', 'Submittals', 'Weekly Construction Report'];
        for (const folder of knownFolders) {
          if (pageText && pageText.includes(folder)) {
            folderNames.push(folder);
          }
        }
      }

      console.log(`[documents-extract] Found folders: ${folderNames.join(', ')}`);

      for (const folderName of folderNames) {
        const folderData = { name: folderName, files: [] as { name: string; downloaded: boolean }[] };

        try {
          const folderElement = await page.$(`text="${folderName}"`);
          if (folderElement) {
            await folderElement.click();
            await page.waitForTimeout(2000);
            await page.waitForLoadState('networkidle');

            const fileRows = await page.$$('tbody tr');
            for (const row of fileRows) {
              const nameCell = await row.$('td:first-child');
              const text = nameCell ? await nameCell.textContent() : null;
              if (text && text.trim()) {
                const fileName = text.trim();
                const isFolder = await row.$('[class*="folder"]');
                if (!isFolder && fileName !== folderName) {
                  folderData.files.push({ name: fileName, downloaded: false });
                  extractedData.totalFiles++;
                }
              }
            }

            const selectAll = await page.$('th input[type="checkbox"]');
            if (selectAll && folderData.files.length > 0) {
              await selectAll.click();
              await page.waitForTimeout(500);

              const downloadBtn = await page.$('button:has-text("Download"), [data-qa="download"]');
              if (downloadBtn) {
                try {
                  const [download] = await Promise.all([
                    page.waitForEvent('download', { timeout: 30000 }),
                    downloadBtn.click(),
                  ]);

                  const filePath = path.join(tempDir, folderName, download.suggestedFilename());
                  await fs.mkdir(path.dirname(filePath), { recursive: true });
                  await download.saveAs(filePath);

                  extractedData.downloadedFiles++;
                  folderData.files.forEach(f => f.downloaded = true);
                  console.log(`[documents-extract] Downloaded: ${filePath}`);
                } catch (downloadErr: any) {
                  console.log(`[documents-extract] Bulk download failed: ${downloadErr.message}`);
                }
              }
            }
          }
        } catch (folderErr: any) {
          console.log(`[documents-extract] Error processing folder ${folderName}: ${folderErr.message}`);
        }

        extractedData.folders.push(folderData);
      }

    } catch (extractError: any) {
      extractedData.extractionError = extractError.message;
      console.error(`[documents-extract] Extraction error: ${extractError.message}`);
    }

    const screenshotBuffer = await page.screenshot({ fullPage: false });
    extractedData.screenshot = `data:image/png;base64,${screenshotBuffer.toString('base64')}`;

    await browser.close();

    const zipPath = `${tempDir}/documents.zip`;
    const output = fsSync.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    archive.pipe(output);

    const downloadedFolders = await fs.readdir(tempDir);
    for (const folder of downloadedFolders) {
      if (folder === 'documents.zip') continue;
      const folderPath = path.join(tempDir, folder);
      const stat = await fs.stat(folderPath);
      if (stat.isDirectory()) {
        archive.directory(folderPath, folder);
      } else {
        archive.file(folderPath, { name: folder });
      }
    }

    await archive.finalize();

    await new Promise<void>((resolve, reject) => {
      output.on('close', resolve);
      output.on('error', reject);
    });

    const zipStat = await fs.stat(zipPath);
    if (zipStat.size > 0 && extractedData.downloadedFiles > 0) {
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="project-${projectId}-documents.zip"`);
      const zipStream = fsSync.createReadStream(zipPath);
      zipStream.pipe(res);

      zipStream.on('end', async () => {
        try {
          await fs.rm(tempDir, { recursive: true, force: true });
        } catch {}
      });
    } else {
      res.json({
        success: true,
        data: extractedData,
        message: 'No files were downloaded. Folders found but download may require manual intervention.',
      });

      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {}
    }
  }));
}
