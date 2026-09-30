import type { PrismaClient } from "@prisma/client";
import type { Logger } from "pino";
import type {
  RepairAnomaly,
  RepairReport,
  SearchIndexDocument,
} from "./types.js";
import type { SearchIndexService } from "./searchIndexService.js";
import {
  type QuestHookInput,
  type SavedPoolHookInput,
  type SettlementHookInput,
  type VaultInput,
  questToSearchDocument,
  savedPoolToSearchDocument,
  settlementToSearchDocument,
  vaultToSearchDocument,
} from "./searchIndexHooks.js";

export interface SearchSourceLoader {
  loadVaults(): Promise<VaultInput[]>;
  loadSavedPools(): Promise<SavedPoolHookInput[]>;
  loadQuests(): Promise<QuestHookInput[]>;
  loadSettlements(): Promise<SettlementHookInput[]>;
}

export class PrismaSearchSourceLoader implements SearchSourceLoader {
  constructor(private readonly prisma: PrismaClient) {}

  public async loadVaults(): Promise<VaultInput[]> {
    const rows = await this.prisma.poolRegistry.findMany();
    return rows.map((r) => ({
      id: r.id,
      name: `Pool ${r.poolAddress.slice(0, 8)}`,
      poolAddress: r.poolAddress,
      admin: r.admin,
      asset: r.asset,
      active: r.active,
      updatedAt: r.updatedAt,
    }));
  }

  public async loadSavedPools(): Promise<SavedPoolHookInput[]> {
    const rows = await this.prisma.savedPool.findMany();
    return rows.map((r) => ({
      id: r.id,
      walletAddress: r.walletAddress,
      poolId: r.poolId,
      poolName: r.poolName,
      status: r.status,
      asset: r.asset,
      tvl: r.tvl,
      updatedAt: r.updatedAt,
    }));
  }

  public async loadQuests(): Promise<QuestHookInput[]> {
    const rows = await this.prisma.userQuest.findMany();
    return rows.map((r) => ({
      id: r.id,
      walletAddress: r.walletAddress,
      questId: r.questId,
      status: r.status,
      progress: r.progress,
      target: r.target,
      updatedAt: r.updatedAt,
    }));
  }

  public async loadSettlements(): Promise<SettlementHookInput[]> {
    const rows = await this.prisma.vaultSettlement.findMany();
    return rows.map((r) => ({
      id: r.id,
      vaultId: r.vaultId,
      state: r.state,
      settlementType: r.settlementType,
      recipient: r.recipient,
      amount: r.amount,
      txHash: r.txHash,
      updatedAt: r.updatedAt,
    }));
  }
}

export class SearchIndexRepairService {
  private readonly loader: SearchSourceLoader;

  constructor(
    prismaOrLoader: PrismaClient | SearchSourceLoader,
    private readonly indexService: SearchIndexService,
    private readonly logger?: Logger,
  ) {
    if ("loadVaults" in prismaOrLoader) {
      this.loader = prismaOrLoader;
    } else {
      this.loader = new PrismaSearchSourceLoader(prismaOrLoader);
    }
  }

  public async detectAnomalies(): Promise<RepairAnomaly[]> {
    const anomalies: RepairAnomaly[] = [];

    const [vaults, savedPools, quests, settlements] = await Promise.all([
      this.loader.loadVaults(),
      this.loader.loadSavedPools(),
      this.loader.loadQuests(),
      this.loader.loadSettlements(),
    ]);

    const sourceDocs: Map<string, SearchIndexDocument> = new Map();

    for (const v of vaults) {
      const doc = vaultToSearchDocument(v);
      sourceDocs.set(doc.id, doc);
    }
    for (const sp of savedPools) {
      const doc = savedPoolToSearchDocument(sp);
      sourceDocs.set(doc.id, doc);
    }
    for (const q of quests) {
      const doc = questToSearchDocument(q);
      sourceDocs.set(doc.id, doc);
    }
    for (const s of settlements) {
      const doc = settlementToSearchDocument(s);
      sourceDocs.set(doc.id, doc);
    }

    const currentIndexDocs = await this.indexService.listAllDocuments();
    const indexDocsMap = new Map(currentIndexDocs.map((d) => [d.id, d]));

    // 1. Check for missing, stale, or visibility-mismatched records
    for (const [id, expectedDoc] of sourceDocs.entries()) {
      const indexedDoc = indexDocsMap.get(id);

      if (!indexedDoc || indexedDoc.deletedAt) {
        anomalies.push({
          recordType: expectedDoc.recordType,
          recordId: expectedDoc.recordId,
          anomalyType: "missing",
          reason: `Record ${id} exists in primary source but is absent from search index`,
          sourceVersion: expectedDoc.version,
          expectedVisibility: expectedDoc.visibility,
        });
        continue;
      }

      if (indexedDoc.visibility !== expectedDoc.visibility) {
        anomalies.push({
          recordType: expectedDoc.recordType,
          recordId: expectedDoc.recordId,
          anomalyType: "visibility_mismatch",
          reason: `Visibility mismatch for ${id}: index has '${indexedDoc.visibility}', source expected '${expectedDoc.visibility}'`,
          sourceVersion: expectedDoc.version,
          indexVersion: indexedDoc.version,
          expectedVisibility: expectedDoc.visibility,
          actualVisibility: indexedDoc.visibility,
        });
        continue;
      }

      const isTitleStale = indexedDoc.title !== expectedDoc.title;
      const isStatusStale = indexedDoc.status !== expectedDoc.status;
      const isAssetStale = (indexedDoc.asset || "") !== (expectedDoc.asset || "");
      const isOwnerStale =
        (indexedDoc.ownerWallet || "").toLowerCase() !==
        (expectedDoc.ownerWallet || "").toLowerCase();
      const isVersionStale = (indexedDoc.version || 0) < (expectedDoc.version || 0);

      if (
        isTitleStale ||
        isStatusStale ||
        isAssetStale ||
        isOwnerStale ||
        isVersionStale
      ) {
        anomalies.push({
          recordType: expectedDoc.recordType,
          recordId: expectedDoc.recordId,
          anomalyType: "stale",
          reason: `Stale content in index for ${id}`,
          sourceVersion: expectedDoc.version,
          indexVersion: indexedDoc.version,
        });
      }
    }

    // 2. Check for orphaned index entries (exist in index, but no longer in source)
    for (const [id, indexedDoc] of indexDocsMap.entries()) {
      if (indexedDoc.deletedAt) continue;
      if (!sourceDocs.has(id)) {
        anomalies.push({
          recordType: indexedDoc.recordType,
          recordId: indexedDoc.recordId,
          anomalyType: "orphaned",
          reason: `Entry ${id} exists in search index but was deleted or revoked from source of truth`,
          indexVersion: indexedDoc.version,
          actualVisibility: indexedDoc.visibility,
        });
      }
    }

    return anomalies;
  }

  public async runRepair(): Promise<RepairReport> {
    const startedAt = new Date();
    const startMs = performance.now();

    const [vaults, savedPools, quests, settlements] = await Promise.all([
      this.loader.loadVaults(),
      this.loader.loadSavedPools(),
      this.loader.loadQuests(),
      this.loader.loadSettlements(),
    ]);

    const sourceDocs: Map<string, SearchIndexDocument> = new Map();
    for (const v of vaults) {
      const doc = vaultToSearchDocument(v);
      sourceDocs.set(doc.id, doc);
    }
    for (const sp of savedPools) {
      const doc = savedPoolToSearchDocument(sp);
      sourceDocs.set(doc.id, doc);
    }
    for (const q of quests) {
      const doc = questToSearchDocument(q);
      sourceDocs.set(doc.id, doc);
    }
    for (const s of settlements) {
      const doc = settlementToSearchDocument(s);
      sourceDocs.set(doc.id, doc);
    }

    const currentIndexDocs = await this.indexService.listAllDocuments();
    const anomalies = await this.detectAnomalies();

    const counts = {
      missing: 0,
      stale: 0,
      visibilityMismatch: 0,
      orphaned: 0,
    };

    const details: RepairReport["details"] = [];

    for (const anomaly of anomalies) {
      const compositeId = `${anomaly.recordType}:${anomaly.recordId.toLowerCase()}`;
      if (anomaly.anomalyType === "missing") {
        counts.missing++;
        const expected = sourceDocs.get(compositeId);
        if (expected) {
          await this.indexService.indexDocument(expected);
          details.push({
            recordType: anomaly.recordType,
            recordId: anomaly.recordId,
            anomalyType: "missing",
            actionTaken: "inserted",
          });
        }
      } else if (
        anomaly.anomalyType === "stale" ||
        anomaly.anomalyType === "visibility_mismatch"
      ) {
        if (anomaly.anomalyType === "stale") counts.stale++;
        if (anomaly.anomalyType === "visibility_mismatch") counts.visibilityMismatch++;

        const expected = sourceDocs.get(compositeId);
        if (expected) {
          await this.indexService.indexDocument(expected);
          details.push({
            recordType: anomaly.recordType,
            recordId: anomaly.recordId,
            anomalyType: anomaly.anomalyType,
            actionTaken: "updated",
          });
        }
      } else if (anomaly.anomalyType === "orphaned") {
        counts.orphaned++;
        await this.indexService.removeDocument(
          anomaly.recordType,
          anomaly.recordId,
        );
        details.push({
          recordType: anomaly.recordType,
          recordId: anomaly.recordId,
          anomalyType: "orphaned",
          actionTaken: "deleted",
        });
      }
    }

    const completedAt = new Date();
    const durationMs = Math.round((performance.now() - startMs) * 100) / 100;

    const report: RepairReport = {
      scannedSources: sourceDocs.size,
      scannedIndexEntries: currentIndexDocs.length,
      anomaliesDetected: counts,
      repairedCount: details.length,
      details,
      startedAt,
      completedAt,
      durationMs,
    };

    if (this.logger) {
      this.logger.info(
        {
          event: "search_index_repair_completed",
          scannedSources: report.scannedSources,
          scannedIndexEntries: report.scannedIndexEntries,
          repairedCount: report.repairedCount,
          anomalies: report.anomaliesDetected,
          durationMs: report.durationMs,
        },
        `Search index repair job completed: repaired ${report.repairedCount} anomalies in ${report.durationMs}ms`,
      );
    }

    return report;
  }
}
