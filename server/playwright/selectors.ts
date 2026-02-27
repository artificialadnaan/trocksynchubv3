// Centralized selectors for Procore UI elements
// These may need to be updated if Procore changes their UI

export const PROCORE_SELECTORS = {
  // Login page
  login: {
    emailInput: 'input[name="email"], input[type="email"], #user_email',
    passwordInput: 'input[name="password"], input[type="password"], #user_password',
    submitButton: 'button[type="submit"], input[type="submit"], [data-testid="login-button"]',
    errorMessage: '.alert-danger, .error-message, [data-testid="login-error"]',
    mfaInput: 'input[name="otp"], input[name="code"], [data-testid="mfa-input"]',
  },
  
  // Main navigation
  nav: {
    projectSelector: '[data-testid="project-selector"], .project-selector',
    toolsMenu: '[data-testid="tools-menu"], .tools-menu',
    userMenu: '[data-testid="user-menu"], .user-avatar',
  },
  
  // BidBoard specific
  bidboard: {
    container: '[data-testid="bidboard"], .bidboard-container, #bidboard, [class*="bidboard"], [class*="estimating"]',
    projectList: '[data-testid="bidboard-projects"], .bidboard-project-list, table.projects, table[class*="project"]',
    projectRow: '[data-testid="bidboard-project-row"], .bidboard-project-row, tr.project-row, tbody tr',
    projectName: '[data-testid="project-name"], .project-name, td.name, td:first-child a',
    projectStage: '[data-testid="project-stage"], .project-stage, td.stage',
    projectNumber: '[data-testid="project-number"], .project-number, td.number',
    // Export menu - the three-dot menu in the top right
    moreOptionsMenu: '[data-testid="more-options"], button[aria-label*="more"], button[aria-label*="menu"], [class*="kebab"], [class*="more-menu"], button:has-text("⋮")',
    exportMenuOption: '[data-testid="export-option"], [role="menuitem"]:has-text("Export"), button:has-text("Export Project List"), a:has-text("Export Project List To Excel")',
    exportButton: '[data-testid="export-csv"], .export-button, button:has-text("Export")',
    filterDropdown: '[data-testid="filter-dropdown"], .filter-dropdown',
    searchInput: '[data-testid="search-input"], input[placeholder*="Search"]',
    // Stage tabs at the top (Estimate in Progress, Service - Estimating, etc.)
    stageTabs: '[class*="stage-tab"], [class*="status-tab"], [role="tablist"] button, [class*="tab-item"]',
    stageDropdown: '[data-testid="stage-dropdown"], .stage-dropdown, select.stage',
    createNewProject: 'button:has-text("Create New Project"), [data-testid="create-project"]',
    sendToPortfolioButton: '[data-testid="send-to-portfolio"], button:has-text("Send to Portfolio")',
    projectOverviewTab: '[data-testid="overview-tab"], a:has-text("Overview")',
    estimateTab: '[data-testid="estimate-tab"], a:has-text("Estimate")',
    documentsTab: '[data-testid="documents-tab"], a:has-text("Documents")',
  },
  
  // Project Overview fields
  overview: {
    clientNameInput: '[data-testid="client-name"], input[name="client_name"], #client_name',
    clientEmailInput: '[data-testid="client-email"], input[name="client_email"], #client_email',
    clientPhoneInput: '[data-testid="client-phone"], input[name="client_phone"], #client_phone',
    clientAddressInput: '[data-testid="client-address"], input[name="client_address"], #client_address',
    contactNameInput: '[data-testid="contact-name"], input[name="contact_name"], #contact_name',
    saveButton: '[data-testid="save-overview"], button:has-text("Save")',
    editButton: '[data-testid="edit-overview"], button:has-text("Edit")',
  },
  
  // Estimate section
  estimate: {
    exportButton: '[data-testid="export-estimate"], button:has-text("Export")',
    exportPdfOption: '[data-testid="export-pdf"], [data-value="pdf"]',
    exportCsvOption: '[data-testid="export-csv"], [data-value="csv"]',
    totalAmount: '[data-testid="estimate-total"], .estimate-total',
    lineItems: '[data-testid="estimate-line-items"], .line-items-table',
    inclusionsSection: '[data-testid="inclusions"], .inclusions',
    exclusionsSection: '[data-testid="exclusions"], .exclusions',
    scopeOfWork: '[data-testid="scope-of-work"], .scope-of-work',
  },
  
  // Documents section
  documents: {
    uploadButton: '[data-testid="upload-document"], button:has-text("Upload")',
    fileInput: 'input[type="file"]',
    documentList: '[data-testid="document-list"], .document-list',
    documentRow: '[data-testid="document-row"], .document-row',
    downloadButton: '[data-testid="download-document"], .download-button',
  },
  
  // Portfolio section
  portfolio: {
    container: '[data-testid="portfolio"], .portfolio-container',
    projectList: '[data-testid="portfolio-projects"], .portfolio-project-list',
    projectRow: '[data-testid="portfolio-project-row"], .portfolio-project-row',
    budgetTab: '[data-testid="budget-tab"], a:has-text("Budget")',
    primeContractTab: '[data-testid="prime-contract-tab"], a:has-text("Prime Contract")',
    documentsTab: '[data-testid="portfolio-documents-tab"], a:has-text("Documents")',
  },
  
  // Budget tool
  budget: {
    importButton: '[data-testid="import-budget"], button:has-text("Import")',
    fileInput: 'input[type="file"]',
    confirmImport: '[data-testid="confirm-import"], button:has-text("Confirm")',
    lineItems: '[data-testid="budget-line-items"], .budget-line-items',
  },
  
  // Prime Contract
  primeContract: {
    createButton: '[data-testid="create-prime-contract"], button:has-text("Create")',
    clientNameInput: '[data-testid="contract-client-name"], input[name="client_name"]',
    contractAmountInput: '[data-testid="contract-amount"], input[name="contract_amount"]',
    scopeInput: '[data-testid="contract-scope"], textarea[name="scope"]',
    inclusionsInput: '[data-testid="contract-inclusions"], textarea[name="inclusions"]',
    exclusionsInput: '[data-testid="contract-exclusions"], textarea[name="exclusions"]',
    saveButton: '[data-testid="save-prime-contract"], button:has-text("Save")',
  },
  
  // Project Directory
  directory: {
    tab: '[data-testid="directory-tab"], a:has-text("Directory"), nav a[href*="/directory"]',
    addButton: '[data-testid="add-person"], button:has-text("Add"), button:has-text("Add Person"), button:has-text("Add User")',
    searchInput: '[data-testid="directory-search"], input[placeholder*="Search"], input[placeholder*="search"]',
    personRow: '[data-testid="person-row"], .directory-row, tr.person-row',
    companyTab: '[data-testid="companies-tab"], a:has-text("Companies")',
    usersTab: '[data-testid="users-tab"], a:has-text("Users"), a:has-text("People")',
    nameInput: '[data-testid="person-name"], input[name="name"], input[name="full_name"]',
    firstNameInput: '[data-testid="first-name"], input[name="first_name"]',
    lastNameInput: '[data-testid="last-name"], input[name="last_name"]',
    emailInput: '[data-testid="person-email"], input[name="email"], input[type="email"]',
    phoneInput: '[data-testid="person-phone"], input[name="phone"], input[type="tel"]',
    companyInput: '[data-testid="person-company"], input[name="company"], [data-testid="company-select"]',
    roleDropdown: '[data-testid="role-dropdown"], select[name="role"], [data-testid="role-select"]',
    saveButton: '[data-testid="save-person"], button:has-text("Save"), button[type="submit"]',
    inviteCheckbox: '[data-testid="invite-checkbox"], input[name="send_invite"], label:has-text("Send invite")',
  },
  
  // Common UI elements
  common: {
    loadingSpinner: '[data-testid="loading"], .loading-spinner, .spinner',
    modal: '[data-testid="modal"], .modal, [role="dialog"]',
    modalCloseButton: '[data-testid="modal-close"], .modal-close, button:has-text("Close")',
    confirmButton: '[data-testid="confirm"], button:has-text("Confirm"), button:has-text("Yes")',
    cancelButton: '[data-testid="cancel"], button:has-text("Cancel"), button:has-text("No")',
    toast: '[data-testid="toast"], .toast, .notification',
    pagination: '[data-testid="pagination"], .pagination',
    nextPageButton: '[data-testid="next-page"], .next-page, button:has-text("Next")',
  },
};

export const PROCORE_URLS = {
  login: "https://login.procore.com/",
  loginSandbox: "https://login-sandbox.procore.com/",
  app: "https://app.procore.com/",
  appSandbox: "https://sandbox.procore.com/",
  
  // URL patterns
  patterns: {
    bidboard: /\/bidding\/?$/,
    bidboardProject: /\/bidding\/\d+/,
    portfolio: /\/projects?\/?$/,
    portfolioProject: /\/projects?\/\d+/,
    budget: /\/budget\/?$/,
    primeContract: /\/prime_contract\/?$/,
    documents: /\/documents?\/?$/,
  },
};

export function getBidBoardUrl(companyId: string, sandbox: boolean = false): string {
  const baseUrl = sandbox ? PROCORE_URLS.appSandbox : PROCORE_URLS.app;
  return `${baseUrl}${companyId}/company/bidding`;
}

export function getProjectUrl(companyId: string, projectId: string, sandbox: boolean = false): string {
  const baseUrl = sandbox ? PROCORE_URLS.appSandbox : PROCORE_URLS.app;
  return `${baseUrl}${companyId}/company/bidding/${projectId}`;
}

export function getPortfolioProjectUrl(projectId: string, sandbox: boolean = false): string {
  const baseUrl = sandbox ? PROCORE_URLS.appSandbox : PROCORE_URLS.app;
  return `${baseUrl}projects/${projectId}`;
}
