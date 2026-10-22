import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// H1 (credential paths): the Procore Settings save and the Drive storage PUT must REFUSE, at the route, a save that would leave no usable client
// secret, naming the env var; and must never persist a submitted secret. Dependencies are stubbed; the real route handlers run.
const configs = vi.hoisted(() => new Map<string, any>());
const saved = vi.hoisted(() => [] as any[]);
const storageConfig = vi.hoisted(() => ({
  current: { activeProvider: "google-drive", googleDrive: undefined as any },
  save: vi.fn(async (partial: any) => ({ ...storageConfig.current, ...partial })),
}));

vi.mock("../server/storage.ts", () => ({
  storage: {
    getAutomationConfig: vi.fn(async (key: string) => configs.get(key) ?? null),
    upsertAutomationConfig: vi.fn(async (row: any) => { saved.push(row); configs.set(row.key, { value: row.value }); }),
    createAuditLog: vi.fn(async () => undefined),
  },
}));
vi.mock("../server/procore.ts", () => ({
  runFullProcoreSync: vi.fn(), syncProcoreBidBoard: vi.fn(), syncProcoreRoleAssignments: vi.fn(), updateProcoreProject: vi.fn(), updateProcoreBid: vi.fn(),
  fetchProcoreBidDetail: vi.fn(), proxyProcoreAttachment: vi.fn(), fetchProcoreProjectStages: vi.fn(), fetchProcoreProjectDetail: vi.fn(),
}));
vi.mock("../server/hubspot.ts", () => ({ updateHubSpotDealStage: vi.fn() }));
vi.mock("../server/procore-hubspot-sync.ts", () => ({
  syncProcoreToHubspot: vi.fn(), getSyncOverview: vi.fn(), unlinkMapping: vi.fn(), createManualMapping: vi.fn(), getUnmatchedProjects: vi.fn(),
  mapProcoreStageToHubspot: vi.fn(), resolveHubspotStageId: vi.fn(),
}));
vi.mock("../server/deal-project-number.ts", () => ({ assignProjectNumber: vi.fn(), getProjectNumberRegistry: vi.fn() }));
vi.mock("../server/email-notifications.ts", () => ({ sendStageChangeEmail: vi.fn() }));
vi.mock("../server/lib/async-handler.ts", () => ({ asyncHandler: (fn: any) => (req: any, res: any, next: any) => Promise.resolve(fn(req, res, next)).catch(next) }));
vi.mock("../server/storage-config.ts", () => ({
  getStorageConfig: vi.fn(async () => storageConfig.current),
  saveStorageConfig: storageConfig.save,
  testStorageConnection: vi.fn(), getStorageProvider: vi.fn(),
}));
vi.mock("../server/project-archive.ts", () => ({
  getArchivableProjects: vi.fn(), previewArchive: vi.fn(), getProjectDocumentSummary: vi.fn(), startProjectArchive: vi.fn(),
  getArchiveProgress: vi.fn(), getAllArchiveProgress: vi.fn(), handleProjectStageChange: vi.fn(),
}));

const NAMES = ["PROCORE_CLIENT_SECRET", "GOOGLE_DRIVE_CLIENT_SECRET", "CLIENT_SECRETS_ENV_ONLY"] as const;
const prior: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const n of NAMES) { prior[n] = process.env[n]; delete process.env[n]; }
  configs.clear(); saved.length = 0; storageConfig.save.mockClear(); storageConfig.current = { activeProvider: "google-drive", googleDrive: undefined };
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => { for (const n of NAMES) { if (prior[n] === undefined) delete process.env[n]; else process.env[n] = prior[n]; } vi.restoreAllMocks(); });

async function withApp(mount: (app: express.Express) => Promise<void> | void, fn: (base: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  await mount(app);
  const server = app.listen(0);
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no server");
  try { await fn(`http://127.0.0.1:${addr.port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))); }
}
const send = (base: string, method: string, path: string, body: any) =>
  fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("POST /api/integrations/procore/save", () => {
  const mount = async (app: express.Express) => {
    const { registerProcoreRoutes } = await import("../server/routes/procore.ts");
    registerProcoreRoutes(app, (_q: any, _s: any, n: any) => n());
  };
  it("no env var and no stored secret → 400 naming PROCORE_CLIENT_SECRET, a typed secret is not stored", async () => {
    await withApp(mount, async (base) => {
      const r = await send(base, "POST", "/api/integrations/procore/save", { clientId: "cid", clientSecret: "typed-secret", companyId: "1" });
      expect(r.status).toBe(400);
      expect((await r.json()).message).toContain("PROCORE_CLIENT_SECRET");
      expect(saved).toHaveLength(0);
    });
  });
  it("CLIENT_SECRETS_ENV_ONLY with only a legacy stored secret → 400 (the OAuth path would ignore that copy)", async () => {
    configs.set("procore_config", { value: { clientId: "cid", clientSecret: "legacy" } });
    process.env.CLIENT_SECRETS_ENV_ONLY = "true";
    await withApp(mount, async (base) => {
      const r = await send(base, "POST", "/api/integrations/procore/save", { clientId: "cid", companyId: "1" });
      expect(r.status).toBe(400);
      expect((await r.json()).message).toContain("PROCORE_CLIENT_SECRET");
    });
  });
  it("with the env var set the save succeeds and the stored row has NO clientSecret, whatever was typed; with only a legacy copy it is carried over", async () => {
    process.env.PROCORE_CLIENT_SECRET = "from-env";
    await withApp(mount, async (base) => {
      const r = await send(base, "POST", "/api/integrations/procore/save", { clientId: "cid", clientSecret: "typed-secret", companyId: "1" });
      expect(r.status).toBe(200);
      expect(saved.at(-1).value).not.toHaveProperty("clientSecret");
      expect(JSON.stringify(saved)).not.toContain("typed-secret");
    });
    delete process.env.PROCORE_CLIENT_SECRET;
    configs.set("procore_config", { value: { clientId: "cid", clientSecret: "legacy" } });
    await withApp(mount, async (base) => {
      expect((await send(base, "POST", "/api/integrations/procore/save", { clientId: "cid2", clientSecret: "typed-secret", companyId: "1" })).status).toBe(200);
      expect(saved.at(-1).value.clientSecret).toBe("legacy"); // never the typed one
    });
  });
});

describe("PUT /api/settings/storage (Google Drive)", () => {
  const mount = async (app: express.Express) => {
    const archive = await import("../server/archive-routes.ts");
    const mod: any = archive;
    const router = (await import("express")).Router();
    mod.registerArchiveRoutes(router, (_q: any, _s: any, n: any) => n());
    app.use(mod.default ?? mod.router ?? router);
  };
  const drive = { clientId: "drive-client-id", clientSecret: "typed-secret", refreshToken: "rt-1234" };
  it("no env var and no stored secret → 400 naming GOOGLE_DRIVE_CLIENT_SECRET, and nothing is saved", async () => {
    await withApp(mount, async (base) => {
      const r = await send(base, "PUT", "/api/settings/storage", { googleDrive: drive });
      expect(r.status).toBe(400);
      expect((await r.json()).message).toContain("GOOGLE_DRIVE_CLIENT_SECRET");
      expect(storageConfig.save).not.toHaveBeenCalled();
    });
  });
  it("CLIENT_SECRETS_ENV_ONLY with only a legacy stored secret → 400", async () => {
    storageConfig.current = { activeProvider: "google-drive", googleDrive: { clientId: "x", clientSecret: "legacy", refreshToken: "y" } };
    process.env.CLIENT_SECRETS_ENV_ONLY = "true";
    await withApp(mount, async (base) => {
      const r = await send(base, "PUT", "/api/settings/storage", { googleDrive: drive });
      expect(r.status).toBe(400);
      expect((await r.json()).message).toContain("GOOGLE_DRIVE_CLIENT_SECRET");
    });
  });
  it("with the env var set (or a legacy copy and no env-only) the save goes through; a save without googleDrive is untouched by the check", async () => {
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = "from-env";
    await withApp(mount, async (base) => {
      expect((await send(base, "PUT", "/api/settings/storage", { googleDrive: drive })).status).toBe(200);
      expect(storageConfig.save).toHaveBeenCalledTimes(1);
    });
    delete process.env.GOOGLE_DRIVE_CLIENT_SECRET;
    await withApp(mount, async (base) => {
      expect((await send(base, "PUT", "/api/settings/storage", { archiveBaseFolderName: "Archive" })).status).toBe(200); // no googleDrive in the body
    });
  });
});
