/**
 * Reconciliation API Routes — Data Health dashboard & resolution
 */

import { Router } from "express";
import { db } from "../db";
import { eq, and, desc, sql, count, like, or, isNull } from "drizzle-orm";
import {
  reconciliationProjects,
  reconciliationConflicts,
  reconciliationAuditLog,
  reconciliationScanRuns,
  legacyNumberMappings,
} from "@shared/reconciliation-schema";
import { runReconciliationScan, getLastScanStatus } from "../services/reconciliation/engine";
import { writebackResolution } from "../services/reconciliation/writeback";
import { storage } from "../storage";

const router = Router();

function getUserId(req: any): string {
  return req.session?.userId ?? "system";
}

// Dashboard
router.get("/dashboard", async (_req, res) => {
  try {
    const [totals] = await db
      .select({
        total: count(),
        exact: sql<number>`count(*) filter (where bucket = 'exact_match')`,
        fuzzy: sql<number>`count(*) filter (where bucket = 'fuzzy_match')`,
        orphanPc: sql<number>`count(*) filter (where bucket = 'orphan_procore')`,
        orphanHs: sql<number>`count(*) filter (where bucket = 'orphan_hubspot')`,
        conflicts: sql<number>`count(*) filter (where bucket = 'conflict')`,
        resolved: sql<number>`count(*) filter (where bucket = 'resolved')`,
        ignored: sql<number>`count(*) filter (where bucket = 'ignored')`,
      })
      .from(reconciliationProjects);

    const [severity] = await db
      .select({
        critical: sql<number>`count(*) filter (where severity = 'critical')`,
        warning: sql<number>`count(*) filter (where severity = 'warning')`,
        info: sql<number>`count(*) filter (where severity = 'info')`,
      })
      .from(reconciliationConflicts)
      .where(eq(reconciliationConflicts.isResolved, false));

    const trend = await db
      .select()
      .from(reconciliationScanRuns)
      .orderBy(desc(reconciliationScanRuns.startedAt))
      .limit(30);

    const lastScan = trend[0] ?? null;

    res.json({
      totals: {
        total: totals?.total ?? 0,
        linked: (totals?.exact ?? 0) + (totals?.fuzzy ?? 0) + (totals?.resolved ?? 0),
        procoreMatched: (totals?.exact ?? 0) + (totals?.fuzzy ?? 0) + (totals?.resolved ?? 0) + (totals?.conflicts ?? 0) + (totals?.orphanPc ?? 0),
        hubspotMatched: (totals?.exact ?? 0) + (totals?.fuzzy ?? 0) + (totals?.resolved ?? 0) + (totals?.conflicts ?? 0) + (totals?.orphanHs ?? 0),
        conflicts: totals?.conflicts ?? 0,
        resolved: totals?.resolved ?? 0,
        ignored: totals?.ignored ?? 0,
      },
      byBucket: {
        exact_match: totals?.exact ?? 0,
        fuzzy_match: totals?.fuzzy ?? 0,
        orphan_procore: totals?.orphanPc ?? 0,
        orphan_hubspot: totals?.orphanHs ?? 0,
        conflict: totals?.conflicts ?? 0,
        resolved: totals?.resolved ?? 0,
        ignored: totals?.ignored ?? 0,
      },
      bySeverity: {
        critical: severity?.critical ?? 0,
        warning: severity?.warning ?? 0,
        info: severity?.info ?? 0,
      },
      trend: trend.map((r) => ({
        id: r.id,
        date: r.startedAt,
        conflicts: r.conflicts,
        resolved: r.resolved,
        totalProjects: r.totalProjects,
      })),
      lastScan: lastScan
        ? {
            id: lastScan.id,
            startedAt: lastScan.startedAt,
            completedAt: lastScan.completedAt,
            triggeredBy: lastScan.triggeredBy,
          }
        : null,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/dashboard/trend", async (_req, res) => {
  try {
    const rows = await db
      .select()
      .from(reconciliationScanRuns)
      .orderBy(desc(reconciliationScanRuns.startedAt))
      .limit(30);
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Projects queue
router.get("/projects", async (req, res) => {
  try {
    const bucket = req.query.bucket as string | undefined;
    const severity = req.query.severity as string | undefined;
    const search = req.query.search as string | undefined;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const offset = (page - 1) * limit;

    const conditions = [];
    if (bucket) conditions.push(eq(reconciliationProjects.bucket, bucket as any));
    if (search?.trim()) {
      const s = `%${search.trim()}%`;
      conditions.push(
        or(
          like(reconciliationProjects.canonicalName, s),
          like(reconciliationProjects.canonicalProjectNumber, s),
          sql`${reconciliationProjects.procoreData}::text ilike ${s}`,
          sql`${reconciliationProjects.hubspotData}::text ilike ${s}`
        )!
      );
    }

    const where = conditions.length ? and(...conditions) : undefined;

    const [data, totalRes] = await Promise.all([
      db
        .select()
        .from(reconciliationProjects)
        .where(where)
        .orderBy(desc(reconciliationProjects.updatedAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: count() })
        .from(reconciliationProjects)
        .where(where),
    ]);

    const total = totalRes[0]?.count ?? 0;

    const withConflicts = await Promise.all(
      data.map(async (p) => {
        const conflicts = severity
          ? await db
              .select()
              .from(reconciliationConflicts)
              .where(
                and(
                  eq(reconciliationConflicts.reconciliationProjectId, p.id),
                  eq(reconciliationConflicts.isResolved, false),
                  eq(reconciliationConflicts.severity, severity as any)
                )
              )
          : await db
              .select()
              .from(reconciliationConflicts)
              .where(
                and(
                  eq(reconciliationConflicts.reconciliationProjectId, p.id),
                  eq(reconciliationConflicts.isResolved, false)
                )
              );
        return { ...p, conflicts };
      })
    );

    res.json({
      data: withConflicts,
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/projects/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [project] = await db
      .select()
      .from(reconciliationProjects)
      .where(eq(reconciliationProjects.id, id))
      .limit(1);

    if (!project) {
      return res.status(404).json({ error: "Project not found" });
    }

    const conflicts = await db
      .select()
      .from(reconciliationConflicts)
      .where(eq(reconciliationConflicts.reconciliationProjectId, id))
      .orderBy(desc(reconciliationConflicts.severity));

    const auditLog = await db
      .select()
      .from(reconciliationAuditLog)
      .where(eq(reconciliationAuditLog.reconciliationProjectId, id))
      .orderBy(desc(reconciliationAuditLog.performedAt))
      .limit(50);

    res.json({ ...project, conflicts, auditLog });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Resolution
router.post("/projects/:id/resolve-field", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { fieldName, resolvedValue, source, writeback, notes } = req.body;
    if (!fieldName || resolvedValue == null || !source) {
      return res.status(400).json({ error: "fieldName, resolvedValue, source required" });
    }
    if (!["procore", "hubspot", "manual"].includes(source)) {
      return res.status(400).json({ error: "source must be procore, hubspot, or manual" });
    }

    const result = await writebackResolution(
      id,
      fieldName,
      String(resolvedValue),
      source,
      getUserId(req),
      { writeback: writeback !== false }
    );

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }
    res.json({ success: true, writebackFailed: result.writebackFailed });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/projects/:id/resolve-all", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { source, writeback } = req.body;
    if (!source || !["procore", "hubspot"].includes(source)) {
      return res.status(400).json({ error: "source must be procore or hubspot" });
    }

    const conflicts = await db
      .select()
      .from(reconciliationConflicts)
      .where(
        and(
          eq(reconciliationConflicts.reconciliationProjectId, id),
          eq(reconciliationConflicts.isResolved, false)
        )
      );

    const project = await db
      .select()
      .from(reconciliationProjects)
      .where(eq(reconciliationProjects.id, id))
      .limit(1)
      .then((r) => r[0]);

    if (!project) return res.status(404).json({ error: "Project not found" });

    const pc = project.procoreData as any;
    const hs = project.hubspotData as any;

    const fieldToValue: Record<string, { procore: string; hubspot: string }> = {
      project_number: { procore: pc?.projectNumber ?? "", hubspot: hs?.projectNumber ?? "" },
      name: { procore: pc?.name ?? "", hubspot: hs?.dealName ?? "" },
      location: { procore: pc?.address ?? "", hubspot: hs?.address ?? "" },
      amount: { procore: String(pc?.estimatedValue ?? ""), hubspot: String(hs?.amount ?? "") },
      stage: { procore: pc?.stage ?? "", hubspot: hs?.dealStage ?? "" },
    };

    for (const c of conflicts) {
      const vals = fieldToValue[c.fieldName];
      if (vals) {
        const val = source === "procore" ? vals.procore : vals.hubspot;
        await writebackResolution(
          id,
          c.fieldName,
          val,
          source,
          getUserId(req),
          { writeback: writeback !== false }
        );
      }
    }

    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/projects/:id/ignore", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { reason } = req.body;
    await db
      .update(reconciliationProjects)
      .set({
        bucket: "ignored",
        adminNotes: reason ?? null,
        updatedAt: new Date(),
      })
      .where(eq(reconciliationProjects.id, id));

    await db.insert(reconciliationAuditLog).values({
      reconciliationProjectId: id,
      action: "mark_ignored",
      performedBy: getUserId(req),
      notes: reason ?? null,
    });

    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/projects/:id/link", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { targetSystem, targetId } = req.body;
    if (!targetSystem || !targetId || !["procore", "hubspot"].includes(targetSystem)) {
      return res.status(400).json({ error: "targetSystem (procore|hubspot) and targetId required" });
    }

    const [project] = await db
      .select()
      .from(reconciliationProjects)
      .where(eq(reconciliationProjects.id, id))
      .limit(1);

    if (!project) return res.status(404).json({ error: "Project not found" });

    const updates: Record<string, any> = { updatedAt: new Date() };
    if (targetSystem === "procore") {
      updates.procoreProjectId = targetId;
    } else {
      updates.hubspotDealId = targetId;
    }

    await db
      .update(reconciliationProjects)
      .set(updates)
      .where(eq(reconciliationProjects.id, id));

    await db.insert(reconciliationAuditLog).values({
      reconciliationProjectId: id,
      action: "link_existing",
      performedBy: getUserId(req),
      newValue: JSON.stringify({ targetSystem, targetId }),
    });

    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/projects/:id/unignore", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [p] = await db
      .select()
      .from(reconciliationProjects)
      .where(eq(reconciliationProjects.id, id))
      .limit(1);
    if (!p) return res.status(404).json({ error: "Project not found" });

    const conflicts = await db
      .select()
      .from(reconciliationConflicts)
      .where(eq(reconciliationConflicts.reconciliationProjectId, id));
    const bucket = conflicts.some((c) => !c.isResolved)
      ? "conflict"
      : p.procoreProjectId && p.hubspotDealId
        ? "exact_match"
        : p.procoreProjectId
          ? "orphan_procore"
          : "orphan_hubspot";

    await db
      .update(reconciliationProjects)
      .set({ bucket, adminNotes: null, updatedAt: new Date() })
      .where(eq(reconciliationProjects.id, id));

    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Legacy mappings
router.get("/legacy-mappings", async (req, res) => {
  try {
    const unmappedOnly = req.query.unmappedOnly === "true";
    const rows = unmappedOnly
      ? await db
          .select()
          .from(legacyNumberMappings)
          .where(isNull(legacyNumberMappings.canonicalNumber))
      : await db.select().from(legacyNumberMappings);
    res.json(rows);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/legacy-mappings", async (req, res) => {
  try {
    const { legacyNumber, canonicalNumber, era } = req.body;
    if (!legacyNumber) {
      return res.status(400).json({ error: "legacyNumber required" });
    }
    const [row] = await db
      .insert(legacyNumberMappings)
      .values({
        legacyNumber: String(legacyNumber).trim(),
        canonicalNumber: canonicalNumber ? String(canonicalNumber).trim() : null,
        era: (era || "legacy") as "legacy" | "zapier" | "synchub",
      })
      .onConflictDoUpdate({
        target: legacyNumberMappings.legacyNumber,
        set: {
          canonicalNumber: canonicalNumber ? String(canonicalNumber).trim() : null,
        },
      })
      .returning();
    res.json(row);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Bulk
router.post("/bulk/resolve", async (req, res) => {
  try {
    const { projectIds, source, writeback } = req.body;
    if (!Array.isArray(projectIds) || !source) {
      return res.status(400).json({ error: "projectIds array and source required" });
    }
    const userId = getUserId(req);
    for (const id of projectIds) {
      try {
        const conflicts = await db
          .select()
          .from(reconciliationConflicts)
          .where(
            and(
              eq(reconciliationConflicts.reconciliationProjectId, id),
              eq(reconciliationConflicts.isResolved, false)
            )
          );
        const [project] = await db
          .select()
          .from(reconciliationProjects)
          .where(eq(reconciliationProjects.id, id))
          .limit(1);
        if (!project) continue;
        const pc = project.procoreData as any;
        const hs = project.hubspotData as any;
        const fieldToValue: Record<string, { procore: string; hubspot: string }> = {
          project_number: { procore: pc?.projectNumber ?? "", hubspot: hs?.projectNumber ?? "" },
          name: { procore: pc?.name ?? "", hubspot: hs?.dealName ?? "" },
          location: { procore: pc?.address ?? "", hubspot: hs?.address ?? "" },
          amount: { procore: String(pc?.estimatedValue ?? ""), hubspot: String(hs?.amount ?? "") },
          stage: { procore: pc?.stage ?? "", hubspot: hs?.dealStage ?? "" },
        };
        for (const c of conflicts) {
          const vals = fieldToValue[c.fieldName];
          if (vals) {
            const val = source === "procore" ? vals.procore : vals.hubspot;
            await writebackResolution(id, c.fieldName, val, source as "procore" | "hubspot", userId, {
              writeback: writeback !== false,
            });
          }
        }
      } catch {
        // continue on error
      }
    }
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/bulk/ignore", async (req, res) => {
  try {
    const { projectIds, reason } = req.body;
    if (!Array.isArray(projectIds)) {
      return res.status(400).json({ error: "projectIds array required" });
    }
    for (const id of projectIds) {
      await db
        .update(reconciliationProjects)
        .set({ bucket: "ignored", adminNotes: reason ?? null, updatedAt: new Date() })
        .where(eq(reconciliationProjects.id, id));
    }
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// Engine
router.post("/scan", async (req, res) => {
  try {
    const { triggeredBy } = req.body;
    const result = await runReconciliationScan(triggeredBy ?? "manual");
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.get("/scan/status", async (_req, res) => {
  try {
    const status = await getLastScanStatus();
    res.json(status);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /seed — Bootstrap from existing sync mappings
router.post("/seed", async (_req, res) => {
  try {
    const { parseProjectNumber } = await import("../services/reconciliation/matcher");
    const mappings = await storage.getSyncMappings();
    let legacyCount = 0;

    for (const m of mappings) {
      const projectNumber = m.procoreProjectNumber || null;
      if (!projectNumber) continue;

      const parsed = parseProjectNumber(projectNumber.toUpperCase());

      if (!parsed) {
        try {
          await db
            .insert(legacyNumberMappings)
            .values({
              legacyNumber: projectNumber,
              canonicalNumber: null,
              era: "legacy",
              projectName: m.procoreProjectName || m.hubspotDealName || null,
              procoreProjectId: m.procoreProjectId || null,
              hubspotDealId: m.hubspotDealId || null,
            })
            .onConflictDoNothing({ target: legacyNumberMappings.legacyNumber });
          legacyCount++;
        } catch {
          // Skip duplicates
        }
      }
    }

    const scanResult = await runReconciliationScan("seed-from-ui");

    res.json({
      success: true,
      syncMappingsProcessed: mappings.length,
      legacyNumbersDetected: legacyCount,
      scan: scanResult,
    });
  } catch (e: any) {
    console.error("[reconciliation] Seed failed:", e);
    res.status(500).json({ message: e.message });
  }
});

// Audit log
router.get("/audit-log", async (req, res) => {
  try {
    const projectId = req.query.projectId as string | undefined;
    const action = req.query.action as string | undefined;
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 50));
    const offset = (page - 1) * limit;

    const conditions = [];
    if (projectId) conditions.push(eq(reconciliationAuditLog.reconciliationProjectId, parseInt(projectId)));
    if (action) conditions.push(eq(reconciliationAuditLog.action, action as any));
    const where = conditions.length ? and(...conditions) : undefined;

    const [data, totalRes] = await Promise.all([
      db
        .select()
        .from(reconciliationAuditLog)
        .where(where)
        .orderBy(desc(reconciliationAuditLog.performedAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: count() })
        .from(reconciliationAuditLog)
        .where(where),
    ]);

    res.json({
      data,
      total: totalRes[0]?.count ?? 0,
      page,
      limit,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/audit-log/:id/rollback", async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const [entry] = await db
      .select()
      .from(reconciliationAuditLog)
      .where(eq(reconciliationAuditLog.id, id))
      .limit(1);

    if (!entry) return res.status(404).json({ error: "Audit entry not found" });
    if (!entry.fieldName) return res.status(400).json({ error: "Cannot rollback project-level action" });

    await db
      .update(reconciliationConflicts)
      .set({
        isResolved: false,
        resolvedValue: null,
        resolvedSource: null,
        resolvedBy: null,
        resolvedAt: null,
      })
      .where(
        and(
          eq(reconciliationConflicts.reconciliationProjectId, entry.reconciliationProjectId),
          eq(reconciliationConflicts.fieldName, entry.fieldName)
        )
      );

    await db
      .update(reconciliationProjects)
      .set({
        bucket: "conflict",
        isResolved: false,
        resolvedBy: null,
        resolvedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(reconciliationProjects.id, entry.reconciliationProjectId));

    await db.insert(reconciliationAuditLog).values({
      reconciliationProjectId: entry.reconciliationProjectId,
      action: "manual_override",
      fieldName: entry.fieldName,
      previousValue: entry.newValue,
      newValue: entry.previousValue,
      source: "rollback",
      performedBy: getUserId(req),
      notes: "Rollback of audit entry " + id,
    });

    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
