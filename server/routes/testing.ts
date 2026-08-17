import type { Express, RequestHandler } from "express";
import { asyncHandler } from "../lib/async-handler";
import { storage } from "../storage";
import { DEFAULT_PROCORE_COMPANY_ID } from "../constants";
import { DEFAULT_GOOGLE_REVIEW_LINK } from "../closeout-automation";

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
      projectNumber: 'DFW-2-12345-ab',
      projectAddress: '123 Test Street, Dallas, TX 75001',
      pmName: 'John PM',
      pmEmail: 'john.pm@trockgc.com',
      pmPhone: '555-0100',
      superName: 'Mike Super',
      superEmail: 'mike.super@trockgc.com',
      superPhone: '555-0101',
      scopeSummary: 'Interior renovation and finish-out',
      accountManagerName: 'Deal Owner',
      accountManagerEmail: 'owner@trockgc.com',
      accountManagerPhone: 'TBD',
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
      googleReviewUrl: DEFAULT_GOOGLE_REVIEW_LINK,
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

  /**
   * Notes-section prober for a Bid Board project — the validation vehicle for the CRM activity note.
   *
   * The selectors in PROCORE_SELECTORS.bidboard.newUi.notes are written from Procore's PUBLISHED docs,
   * not from observed DOM (nobody can open prod Procore from CI). This route is how a human validates
   * them against a real project before the automation ships: it reports, per candidate selector, how
   * many elements matched and whether any is visible, dumps the matched Notes section's HTML, and saves
   * a screenshot.
   *
   * Body: { projectId, projectNumber?, note?, dryRun?, openEditor? }. dryRun DEFAULTS TO TRUE — this
   * route can post a real note to a real Procore project, so posting must be opted into explicitly with
   * dryRun:false plus a note. On a dry run it also clicks the "+" control by default (openEditor, safe:
   * only the Create button commits a note) because the editor and Create selectors do not exist in the
   * DOM until it is open, so without that click half the cascade could not be validated at all.
   *
   * Unlike the older probers here it drives the SHARED session (ensureLoggedIn) inside withBrowserLock
   * rather than launching its own Chromium: the probe must observe the same page the real automation
   * will drive, and it must not run concurrently with a live RFP create that holds the browser.
   */
  app.post("/api/testing/playwright/bidboard-project-note", requireAuth, asyncHandler(async (req, res) => {
    const projectId = String(req.body?.projectId ?? "").trim();
    const projectNumber = req.body?.projectNumber ? String(req.body.projectNumber).trim() : undefined;
    const note = typeof req.body?.note === "string" ? req.body.note : undefined;
    const dryRun = req.body?.dryRun !== false;
    const openEditor = req.body?.openEditor !== false;

    if (!projectId) {
      return res.status(400).json({ error: "projectId is required" });
    }
    if (!dryRun && !note?.trim()) {
      return res.status(400).json({ error: "note is required when dryRun is false" });
    }

    const { ensureLoggedIn } = await import("../playwright/auth");
    const { withBrowserLock, takeScreenshot } = await import("../playwright/browser");
    const { navigateToProject } = await import("../playwright/bidboard");
    // Every decision this route reports is made by the SAME function production uses. Its whole value
    // is telling a human which selectors are real; a parallel rule here means validating hooks
    // production would never use, or reporting working ones as absent — and that decision then ships
    // into an automation touching live Procore projects.
    const {
      findVisibleMatch,
      findVisibleRoleMatch,
      resolveNotesSection,
      resolveEditorScopes,
      actableCandidates,
      readNoteTexts,
      hasMarkerNote,
      isForbiddenFillTarget,
      cancelEditor,
      CREATE_BUTTON_ROLE,
      ROLE_MATCH_LABEL,
    } = await import("../playwright/bidboard-notes");
    const { PROCORE_SELECTORS } = await import("../playwright/selectors");

    const NOTES = PROCORE_SELECTORS.bidboard.newUi.notes;
    const MAX_HTML_CHARS = 20000;

    const outcome = await withBrowserLock("testing-bidboard-project-note", async () => {
      const { page, success: loggedIn } = await ensureLoggedIn();
      if (!loggedIn || !page) {
        return { ok: false as const, error: "Failed to log in to Procore" };
      }

      const navigated = await navigateToProject(page, projectId);
      if (!navigated) {
        return { ok: false as const, error: `Could not navigate to Bid Board project ${projectId}` };
      }

      const overviewTab = page.locator(PROCORE_SELECTORS.bidboard.projectOverviewTab).first();
      const overviewTabVisible = await overviewTab.isVisible().catch(() => false);
      if (overviewTabVisible) {
        await overviewTab.click({ timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(2000);
      }

      // Per-candidate match report: this is the whole point of the route — it says WHICH tier of the
      // cascade is (or isn't) carrying each step, instead of a single yes/no for a CSS union. The tier
      // is reported because it decides what the automation is ALLOWED to do: it acts on precise
      // (any scope) and scopedOnly (inside a validated container only), and never on loose.
      type ProbeRow = {
        selector: string;
        tier: string;
        /** Whether the AUTOMATION would act on this selector — from actableCandidates(), not a local rule. */
        actable: boolean;
        count: number;
        visible: boolean;
        visibleIndex: number | null;
      };
      const probe = async (
        tiers: { precise: string[]; scopedOnly?: string[]; loose?: string[] } | string[],
        scope: { locator: (s: string) => any } = page,
      ) => {
        const groups: Array<[string, string[]]> = Array.isArray(tiers)
          ? [["flat", tiers]]
          : [["precise", tiers.precise], ["scopedOnly", tiers.scopedOnly ?? []], ["loose", tiers.loose ?? []]];
        // The actable set comes from the shared function so "would the automation use this?" cannot
        // drift from what the automation actually does (it used to be a local `tier !== "loose"`).
        const actableSet = new Set(Array.isArray(tiers) ? tiers : actableCandidates(tiers));
        const rows: ProbeRow[] = [];
        for (const [tier, candidateList] of groups) {
          for (const selector of candidateList) {
            const count = await scope.locator(selector).count().catch(() => -1);
            // The SAME visible-match walk the automation uses. Probing `.first()` here would report
            // visible:false for a selector whose first match is a hidden responsive/template duplicate
            // — a selector the automation happily uses. visibleIndex > 0 is itself the signal.
            const hit = count > 0 ? await findVisibleMatch(scope as any, selector) : null;
            rows.push({
              selector,
              tier,
              actable: actableSet.has(selector),
              count,
              visible: hit !== null,
              visibleIndex: hit?.index ?? null,
            });
          }
        }
        return rows;
      };

      /** The Create button's role fallback, probed exactly as production resolves it. */
      const probeCreateRole = async (scope: { locator: (s: string) => any }): Promise<ProbeRow> => {
        const hit = await findVisibleRoleMatch(scope as any, CREATE_BUTTON_ROLE);
        return {
          selector: ROLE_MATCH_LABEL,
          tier: "roleFallback",
          actable: true,
          count: hit ? hit.index + 1 : 0,
          visible: hit !== null,
          visibleIndex: hit?.index ?? null,
        };
      };

      const candidates: Record<string, ProbeRow[]> = {
        section: await probe(NOTES.section),
        addButton: await probe(NOTES.addButton),
        item: await probe(NOTES.item),
        // Probed page-wide BEFORE the editor is open, so these two are expected to be empty/irrelevant
        // here; the meaningful numbers are the *AfterAdd variants below.
        input: await probe(NOTES.input),
        createButton: await probe(NOTES.createButton),
      };

      // THE verdict — section resolution, the precise-only rule, the loose-only refusal and the
      // contamination check all come from resolveNotesSection, the same call production makes. This
      // replaced four parallel re-implementations that agreed only by coincidence.
      const sectionResolution = await resolveNotesSection(page as any, { projectLabel: projectId });
      const sectionLocator = sectionResolution.ok ? sectionResolution.locator : null;
      const matchedSection = sectionResolution.ok ? sectionResolution.selector : null;
      const looseSectionOnly = !sectionResolution.ok && sectionResolution.reason === "loose-only";
      const sectionContaminated = !sectionResolution.ok && sectionResolution.reason === "contaminated";
      const sectionHtml = sectionLocator
        ? ((await sectionLocator.evaluate((el: Element) => el.outerHTML).catch(() => "")) || "").slice(0, MAX_HTML_CHARS)
        : null;
      // readNoteTexts, not allTextContents: the idempotency guard reads the union of the item
      // selectors AND the container's own text, so anything else would report texts the guard never sees.
      const noteTexts = sectionLocator ? await readNoteTexts(sectionLocator) : [];
      // Would production SKIP this project as already-noted? That is the single most consequential
      // thing this route can tell an operator, and it was previously not reported at all.
      const markerAlreadyPresent = sectionLocator ? hasMarkerNote(noteTexts) : null;

      // When no section matched, dump every button on the page so the operator can spot the real add
      // control (its label/aria-label/class is what the selectors need to become).
      const buttons = matchedSection
        ? []
        : await page
            .locator("button")
            .evaluateAll((els) =>
              els.slice(0, 120).map((el) => ({
                text: (el.textContent || "").trim().slice(0, 60),
                ariaLabel: el.getAttribute("aria-label"),
                className: (el.getAttribute("class") || "").slice(0, 160),
                dataQa: el.getAttribute("data-qa"),
              })),
            )
            .catch(() => [] as Array<Record<string, unknown>>);

      // takeScreenshot() interpolates the name straight into a file path, so keep the caller-supplied
      // id out of it as anything but [A-Za-z0-9_-].
      const safeProjectId = projectId.replace(/[^A-Za-z0-9_-]/g, "");
      const screenshotPath = await takeScreenshot(page, `bidboard-project-note-probe-${safeProjectId}`).catch(() => null);

      // Open the editor (but never commit) so the input/Create selectors — which don't exist until the
      // "+" is clicked — can be validated too. This is the half of the cascade a plain page dump misses.
      let editorScreenshotPath: string | null = null;
      let editorOpened = false;
      // ONLY click an add control that lives inside a RESOLVED, uncontaminated Notes section.
      // candidates.addButton above is a page-wide diagnostic sweep; clicking off it would let the
      // prober hit the first unrelated "Add"/"+" on a live project — precisely when no Notes section
      // was found, which is the very situation this route exists to diagnose — and then report that
      // unrelated widget's textbox and Create button as a successful selector validation. Wrong
      // validation is worse than none, because it is acted on.
      const sectionScope = sectionLocator;
      candidates.addButtonInSection = sectionScope ? await probe(NOTES.addButton, sectionScope) : [];
      // `actable` comes from the shared tier rule, so this matches what the automation would click.
      const matchedAddButton = candidates.addButtonInSection.find((row) => row.visible && row.actable)?.selector ?? null;
      let editorScopeLabels: string[] = [];
      let inputWouldBeRefused: boolean | null = null;
      if (dryRun && openEditor && sectionScope && matchedAddButton) {
        // Click the node the WALK found, not `.first()` — same reason as above.
        const addTarget = await findVisibleMatch(sectionScope as any, matchedAddButton);
        await addTarget?.locator.click({ timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(2000);

        // resolveEditorScopes applies production's dialog rule: visible AND uncontaminated, with the
        // section retained as a second scope. Probing a dialog production would REJECT (or skipping
        // the inline section because a dialog happens to be visible) is the exact inverse of this
        // route's purpose.
        const editorScopes = await resolveEditorScopes(page as any, sectionScope as any);
        editorScopeLabels = editorScopes.map((scope) => scope.label);
        candidates.inputAfterAdd = [];
        candidates.createButtonAfterAdd = [];
        for (const { label, scope } of editorScopes) {
          const inputRows = (await probe(NOTES.input, scope as any)).map((row) => ({ ...row, scope: label }));
          const createRows = [
            ...(await probe(NOTES.createButton, scope as any)),
            await probeCreateRole(scope as any),
          ].map((row) => ({ ...row, scope: label }));
          candidates.inputAfterAdd.push(...inputRows);
          candidates.createButtonAfterAdd.push(...createRows);
        }
        editorOpened = candidates.inputAfterAdd.some((row) => row.visible && row.actable);

        // Would the fill be refused by the description guard? Report it rather than leaving the
        // operator to discover it only when a real post declines.
        const resolvedInput = candidates.inputAfterAdd.find((row) => row.visible && row.actable);
        if (resolvedInput) {
          const scopeForInput = editorScopes.find((scope) => scope.label === (resolvedInput as any).scope);
          const inputHit = scopeForInput ? await findVisibleMatch(scopeForInput.scope as any, resolvedInput.selector) : null;
          inputWouldBeRefused = inputHit ? await isForbiddenFillTarget(inputHit.locator) : null;
        }

        editorScreenshotPath = await takeScreenshot(page, `bidboard-project-note-editor-${safeProjectId}`).catch(() => null);
        // Leave the page clean for whatever runs next under the browser lock — same helper production
        // uses on every post-fill exit.
        await cancelEditor(page);
      }

      let postResult: unknown = null;
      if (!dryRun && note) {
        const { postBidBoardProjectNote } = await import("../playwright/bidboard-notes");
        postResult = await postBidBoardProjectNote(page, projectId, note, projectNumber);
      }

      return {
        ok: true as const,
        projectId,
        dryRun,
        overviewTabVisible,
        url: page.url(),
        matchedSection,
        // The shared resolver's verdict verbatim — the same string production would log.
        sectionVerdict: sectionResolution.ok
          ? { ok: true, selector: sectionResolution.selector }
          : { ok: false, reason: sectionResolution.reason, selector: sectionResolution.selector, message: sectionResolution.message },
        looseSectionOnly,
        sectionContaminated,
        markerAlreadyPresent,
        editorScopeLabels,
        inputWouldBeRefused,
        matchedAddButton,
        // Why the editor probe did nothing, so a "no input/Create rows" report is never read as "those
        // selectors are broken" when the truth is "we refused to click anything".
        editorProbeSkippedReason: !dryRun || !openEditor
          ? null
          : !sectionResolution.ok
            // Verbatim from the shared resolver, so the reason the prober declines is word-for-word
            // the reason production would decline.
            ? `${sectionResolution.message} (the automation would refuse here too)`
            : !matchedAddButton
              ? "no add control matched INSIDE the resolved Notes section"
              : null,
        editorOpened,
        candidates,
        sectionHtml,
        sectionHtmlTruncated: Boolean(sectionHtml && sectionHtml.length >= MAX_HTML_CHARS),
        noteTexts,
        buttons,
        screenshotPath,
        editorScreenshotPath,
        postResult,
      };
    });

    await storage.createAuditLog({
      action: 'playwright_test_bidboard_project_note',
      entityType: 'playwright',
      entityId: projectId,
      source: 'admin',
      status: outcome.ok ? 'success' : 'failed',
      details: { projectId, dryRun, matchedSection: outcome.ok ? outcome.matchedSection : null },
      errorMessage: outcome.ok ? undefined : outcome.error,
    });

    if (!outcome.ok) {
      return res.status(400).json({ success: false, error: outcome.error });
    }
    res.json({ success: true, ...outcome });
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
