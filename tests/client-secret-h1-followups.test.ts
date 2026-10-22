import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// H1 follow-ups (Codex + CodeRabbit on #119): whitespace-only legacy secrets are unusable; saveStorageConfig scrubs a legacy Drive secret on a partial
// save and never persists a typed one (real saveStorageConfig); the Drive PUT guard looks at the RESULTING active provider.
const configs = vi.hoisted(() => new Map<string, any>());
const saved = vi.hoisted(() => [] as any[]);
vi.mock("../server/storage.ts", () => ({
  storage: {
    getAutomationConfig: vi.fn(async (key: string) => configs.get(key) ?? null),
    upsertAutomationConfig: vi.fn(async (row: any) => { saved.push(row); configs.set(row.key, { value: row.value }); }),
  },
}));
vi.mock("../server/storage-provider.ts", () => ({ GoogleDriveProvider: class {}, SharePointProvider: class {}, LocalStorageProvider: class {} }));

const NAMES = ["GOOGLE_DRIVE_CLIENT_SECRET", "CLIENT_SECRETS_ENV_ONLY"] as const;
const prior: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const n of NAMES) { prior[n] = process.env[n]; delete process.env[n]; }
  configs.clear(); saved.length = 0; vi.resetModules();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { for (const n of NAMES) { if (prior[n] === undefined) delete process.env[n]; else process.env[n] = prior[n]; } vi.restoreAllMocks(); });

describe("whitespace-only legacy secrets are unusable", () => {
  it("hasUsableClientSecret / resolveClientSecret / legacySecretToKeep treat '   ' as unset", async () => {
    const m = await import("../server/lib/client-secret.ts");
    expect(m.hasUsableClientSecret("GOOGLE_DRIVE_CLIENT_SECRET", "   \n")).toBe(false);
    expect(m.resolveClientSecret({ label: "x", envName: "GOOGLE_DRIVE_CLIENT_SECRET", dbValue: "  " })).toBe("");
    expect(m.legacySecretToKeep("GOOGLE_DRIVE_CLIENT_SECRET", "  ")).toBeUndefined();
  });
});

describe("saveStorageConfig (real)", () => {
  const stored = { activeProvider: "google-drive", archiveBaseFolderName: "A", googleDrive: { clientId: "cid-1234", clientSecret: "legacy", refreshToken: "rt-1234" } };
  it("a partial save without googleDrive scrubs the legacy Drive secret once the env var is set", async () => {
    configs.set("storage_provider_config", { value: stored });
    process.env.GOOGLE_DRIVE_CLIENT_SECRET = "from-env";
    const { saveStorageConfig } = await import("../server/storage-config.ts");
    await saveStorageConfig({ archiveBaseFolderName: "B" });
    expect(JSON.stringify(saved.at(-1).value)).not.toContain("legacy");
    expect(saved.at(-1).value.googleDrive.clientId).toBe("cid-1234");
  });
  it("with no env var the legacy copy is kept on a partial save, and a typed secret is never persisted", async () => {
    configs.set("storage_provider_config", { value: stored });
    const { saveStorageConfig } = await import("../server/storage-config.ts");
    await saveStorageConfig({ archiveBaseFolderName: "B" });
    expect(saved.at(-1).value.googleDrive.clientSecret).toBe("legacy");
    await saveStorageConfig({ googleDrive: { clientId: "cid-9999", clientSecret: "typed-secret", refreshToken: "rt-9999" } });
    expect(saved.at(-1).value.googleDrive.clientSecret).toBe("legacy");
    expect(JSON.stringify(saved.at(-1))).not.toContain("typed-secret");
  });
});

describe("PUT /api/settings/storage guard follows the resulting active provider", () => {
  const drive = { clientId: "drive-client-id", clientSecret: "typed", refreshToken: "rt-1234" };
  async function put(body: any, current: any) {
    vi.resetModules(); // each call re-imports the route so it binds THIS call's mocked stored config, not the first one's
    vi.doMock("../server/storage-config.ts", () => ({
      getStorageConfig: vi.fn(async () => current),
      saveStorageConfig: vi.fn(async (p: any) => ({ ...current, ...p })),
      testStorageConnection: vi.fn(), getStorageProvider: vi.fn(),
    }));
    vi.doMock("../server/project-archive.ts", () => ({
      getArchivableProjects: vi.fn(), previewArchive: vi.fn(), getProjectDocumentSummary: vi.fn(), startProjectArchive: vi.fn(),
      getArchiveProgress: vi.fn(), getAllArchiveProgress: vi.fn(), handleProjectStageChange: vi.fn(),
    }));
    const mod: any = await import("../server/archive-routes.ts");
    const router = express.Router();
    mod.registerArchiveRoutes(router, (_q: any, _s: any, n: any) => n());
    const app = express(); app.use(express.json()); app.use(mod.default ?? mod.router ?? router);
    const server = app.listen(0);
    try {
      const addr = server.address() as any;
      return (await fetch(`http://127.0.0.1:${addr.port}/api/settings/storage`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status;
    } finally { await new Promise<void>((r) => server.close(() => r())); }
  }
  const broken = { activeProvider: "google-drive", googleDrive: { clientId: "x", clientSecret: "", refreshToken: "y" } };
  it("switching away from an unusable Drive config (whole form incl. googleDrive) is allowed", async () => {
    expect(await put({ activeProvider: "local", googleDrive: drive }, broken)).toBe(200);
    expect(await put({ activeProvider: "sharepoint", googleDrive: drive }, broken)).toBe(200);
  });
  it("selecting google-drive as the active provider, with or without a googleDrive object, is refused without a usable secret", async () => {
    expect(await put({ activeProvider: "google-drive" }, { activeProvider: "local", googleDrive: broken.googleDrive })).toBe(400);
    expect(await put({ activeProvider: "google-drive", googleDrive: drive }, broken)).toBe(400);
    expect(await put({ googleDrive: drive }, broken)).toBe(400);
  });
});
