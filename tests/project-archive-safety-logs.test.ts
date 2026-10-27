import { beforeEach, describe, expect, it, vi } from "vitest";

// Weather logs, safety violations and accident logs are extracted from Procore under `weatherLogs`,
// `safetyViolations` and `accidentLogs` (procore-documents.ts ProjectDocuments). The archive read them as
// `*Data`, which never exists, so all three were silently never counted, foldered or exported (and tsc
// flagged the reads). This pins the archive to the fields the extractor actually returns.
const extractMock = vi.hoisted(() => vi.fn());
vi.mock("../server/procore-documents.ts", () => ({
  extractProjectDocuments: extractMock,
  downloadProcoreFile: vi.fn(),
  getProjectDocumentSummary: vi.fn(),
  getProjectsList: vi.fn(),
}));
vi.mock("../server/storage.ts", () => ({ storage: {} }));
vi.mock("../server/storage-config.ts", () => ({
  getStorageProvider: vi.fn(),
  getStorageConfig: vi.fn(async () => ({ archiveBaseFolderName: "Archive" })),
  getAutoArchiveConfig: vi.fn(),
}));
vi.mock("../server/index.ts", () => ({ log: vi.fn() }));

function emptyDocs(overrides: Record<string, unknown>) {
  const base: Record<string, unknown> = {
    projectName: "Cedar Springs",
    budget: {},
    dailyLogs: { attachments: [], items: [] },
    commitments: { subcontracts: [], purchaseOrders: [] },
    commitmentsData: { subcontracts: [], purchaseOrders: [] },
    ...overrides,
  };
  return new Proxy(base, { get: (target, key: string) => (key in target ? target[key] : []) });
}

beforeEach(() => {
  extractMock.mockReset();
});

describe("previewArchive counts the safety and weather logs Procore returned", () => {
  it("counts and folders weather logs, safety violations and accident logs", async () => {
    extractMock.mockResolvedValue(
      emptyDocs({
        weatherLogs: [{ id: 1 }],
        safetyViolations: [{ id: 2 }],
        accidentLogs: [{ id: 3 }],
      }),
    );
    const { previewArchive } = await import("../server/project-archive.ts");

    const preview = await previewArchive("proj-1", {});

    expect(preview.fileCounts).toMatchObject({ weatherLogs: 1, safetyViolations: 1, accidentLogs: 1 });
    expect(preview.folderStructure).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/Weather Logs"),
        expect.stringContaining("/Safety Violations"),
        expect.stringContaining("/Accident Logs"),
      ]),
    );
  });

  it("counts none of them when Procore returned none", async () => {
    extractMock.mockResolvedValue(emptyDocs({}));
    const { previewArchive } = await import("../server/project-archive.ts");
    const preview = await previewArchive("proj-1", {});
    expect(preview.fileCounts).toMatchObject({ weatherLogs: 0, safetyViolations: 0, accidentLogs: 0 });
  });
});
