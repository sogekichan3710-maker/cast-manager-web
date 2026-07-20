import {
  collection,
  doc,
  documentId,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
  type Unsubscribe,
  type WriteBatch,
} from "firebase/firestore";
import { getDb } from "@/lib/firebase";
import { writeAuditLog } from "@/services/auditLogService";
import type { MigrationRunWithId, MigrationRunDoc, RunStatus } from "@/types";
import type { ConversionResult } from "@/lib/migration/convertLegacyData";

/**
 * 旧ローカルデータ移行の実行サービス（owner専用・Rulesでも制限）。
 *
 * 冪等性の設計:
 * - すべての移行ドキュメントは「決定的なドキュメントID」で書き込む
 *   （旧IDを保持。monthlyResults は storeId_castId_YYYY-MM、
 *     nameMatchingRules は storeId__正規化名、castRecords分離分は 旧ID_goal / 旧ID_moti）
 * - 書き込み前に既存ドキュメントの有無をIDで照会し、既存は一切変更せず skip
 * - そのため同じJSONを何度実行しても二重登録されず、
 *   途中失敗後の再実行でも成功済み分は skip されるだけで安全に再開できる
 * - 実行記録は migrationRuns/{migrationId} に保持する
 */

export interface MigrationProgress {
  phase: string;
  total: number;
  done: number;
  created: number;
  skipped: number;
  errors: number;
}

export interface MigrationResultSummary {
  migrationId: string;
  status: RunStatus;
  created: number;
  updated: number; // 本移行は「既存はskip」方針のため常に0（表示仕様として保持）
  skipped: number;
  errors: number;
  errorMessages: string[];
  byCollection: Record<string, { created: number; skipped: number }>;
}

export interface WriteTask {
  col: string;
  id: string;
  data: Record<string, unknown>;
  meta: "full" | "createOnly"; // full: createdAt/updatedAt両方 / createOnly: createdAt系のみ(wageHistory)
}

/** Firestoreの 'in' 句上限 */
const IN_CHUNK = 30;
/** writeBatch上限500に対する安全マージン */
const BATCH_SIZE = 300;

export function buildTasks(conversion: ConversionResult, migrationId: string): WriteTask[] {
  const tasks: WriteTask[] = [];
  for (const s of conversion.stores) tasks.push({ col: "stores", id: s.id, data: { ...s.data }, meta: "full" });
  for (const c of conversion.casts) tasks.push({ col: "casts", id: c.id, data: { ...c.data }, meta: "full" });
  for (const m of conversion.monthlyResults)
    tasks.push({ col: "monthlyResults", id: m.id, data: { ...m.data, batchId: migrationId }, meta: "full" });
  for (const i of conversion.interviews) tasks.push({ col: "interviews", id: i.id, data: { ...i.data }, meta: "full" });
  for (const g of conversion.goals) tasks.push({ col: "goals", id: g.id, data: { ...g.data }, meta: "full" });
  for (const m of conversion.motivations) tasks.push({ col: "motivations", id: m.id, data: { ...m.data }, meta: "full" });
  for (const w of conversion.wageHistory) tasks.push({ col: "wageHistory", id: w.id, data: { ...w.data }, meta: "createOnly" });
  for (const r of conversion.nameMatchingRules)
    tasks.push({ col: "nameMatchingRules", id: r.id, data: { ...r.data }, meta: "full" });
  return tasks;
}

/**
 * 書き込み計画（純関数・テスト可能）。
 * 既存IDに含まれるタスクは skip、含まれないものだけを書き込み対象にする。
 * 同じ変換結果 + 1回目の書き込み済みIDで再実行すると toWrite が空になる
 * （= 同じJSONを2回移行しても二重登録されない冪等性の中核）。
 */
export function planMigrationWrites(
  tasks: WriteTask[],
  existingIds: Set<string> // `${col}/${id}`
): {
  toWrite: WriteTask[];
  skipped: number;
  byCollection: Record<string, { created: number; skipped: number }>;
} {
  const byCollection: Record<string, { created: number; skipped: number }> = {};
  const toWrite: WriteTask[] = [];
  let skipped = 0;
  for (const t of tasks) {
    const bump = (byCollection[t.col] ??= { created: 0, skipped: 0 });
    if (existingIds.has(`${t.col}/${t.id}`)) {
      bump.skipped++;
      skipped++;
    } else {
      bump.created++;
      toWrite.push(t);
    }
  }
  return { toWrite, skipped, byCollection };
}

/** 各コレクションの既存ドキュメントIDを 'in' クエリで照会する */
async function fetchExistingIds(tasksByCol: Map<string, WriteTask[]>): Promise<Set<string>> {
  const db = getDb();
  const existing = new Set<string>(); // `${col}/${id}`
  for (const [col, tasks] of tasksByCol) {
    const ids = tasks.map((t) => t.id);
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const chunk = ids.slice(i, i + IN_CHUNK);
      const snap = await getDocs(
        query(collection(db, col), where(documentId(), "in", chunk))
      );
      snap.docs.forEach((d) => existing.add(`${col}/${d.id}`));
    }
  }
  return existing;
}

/**
 * 移行を実行する。
 * - onProgress: バッチごとに進捗を通知
 * - shouldCancel: 各バッチ書き込み前に確認し、trueなら安全に中断
 *   （中断時点までの書き込みは決定的IDのため、再実行してもskipされるだけ）
 */
export async function executeMigration(
  actorUid: string,
  actorName: string,
  fileName: string,
  conversion: ConversionResult,
  onProgress: (p: MigrationProgress) => void,
  shouldCancel: () => boolean
): Promise<MigrationResultSummary> {
  const db = getDb();
  const runRef = doc(collection(db, "migrationRuns"));
  const migrationId = runRef.id;

  const runBase: Omit<MigrationRunDoc, "startedAt" | "completedAt"> = {
    fileName,
    sourceFormat: conversion.sourceFormat,
    status: "processing",
    summary: "",
    createdBy: actorUid,
    errorSummary: "",
  };
  const initBatch = writeBatch(db);
  initBatch.set(runRef, { ...runBase, startedAt: serverTimestamp(), completedAt: null });
  await initBatch.commit();

  const tasks = buildTasks(conversion, migrationId);
  const tasksByCol = new Map<string, WriteTask[]>();
  for (const t of tasks) {
    const arr = tasksByCol.get(t.col) ?? [];
    arr.push(t);
    tasksByCol.set(t.col, arr);
  }

  const byCollection: Record<string, { created: number; skipped: number }> = {};
  const errorMessages: string[] = [];
  let created = 0;
  let skipped = 0;
  let done = 0;
  let status: RunStatus = "completed";

  const report = (phase: string) =>
    onProgress({ phase, total: tasks.length, done, created, skipped, errors: errorMessages.length });

  try {
    report("既存データを確認しています…");
    const existing = await fetchExistingIds(tasksByCol);

    // 書き込み対象（既存はskip）
    const plan = planMigrationWrites(tasks, existing);
    const toWrite = plan.toWrite;
    for (const [col, v] of Object.entries(plan.byCollection)) {
      byCollection[col] = { created: 0, skipped: v.skipped };
    }
    skipped = plan.skipped;
    done = plan.skipped;
    report("書き込みを開始します…");

    for (let i = 0; i < toWrite.length; i += BATCH_SIZE) {
      if (shouldCancel()) {
        status = "cancelled";
        break;
      }
      const chunk = toWrite.slice(i, i + BATCH_SIZE);
      const batch: WriteBatch = writeBatch(db);
      for (const t of chunk) {
        const meta =
          t.meta === "createOnly"
            ? { createdAt: serverTimestamp(), createdBy: actorUid }
            : {
                createdAt: serverTimestamp(),
                createdBy: actorUid,
                updatedAt: serverTimestamp(),
                updatedBy: actorUid,
              };
        batch.set(doc(db, t.col, t.id), { ...t.data, ...meta });
      }
      await batch.commit();
      for (const t of chunk) {
        (byCollection[t.col] ??= { created: 0, skipped: 0 }).created++;
      }
      created += chunk.length;
      done += chunk.length;
      report("書き込み中…");
    }
  } catch (err) {
    status = "failed";
    errorMessages.push((err as Error).message);
  }

  const summaryText = `作成 ${created} / 更新 0 / スキップ ${skipped} / エラー ${errorMessages.length}`;
  try {
    await updateDoc(runRef, {
      status,
      summary: summaryText,
      errorSummary: errorMessages.join("\n").slice(0, 2000),
      completedAt: serverTimestamp(),
    });
  } catch (err) {
    // 実行記録の更新失敗は移行結果自体には影響しない（画面に表示のみ）
    errorMessages.push(`実行記録の更新に失敗: ${(err as Error).message}`);
  }

  try {
    await writeAuditLog({
      actorUid,
      actorName,
      action: "migration.execute",
      collection: "migrationRuns",
      documentId: migrationId,
      storeId: null,
      before: null,
      after: { fileName, status, created, skipped, errors: errorMessages.length },
    });
  } catch {
    // 監査ログの書き込み失敗は移行結果自体には影響させない
  }

  report(status === "completed" ? "完了" : status === "cancelled" ? "中断しました" : "エラーで停止しました");
  return {
    migrationId,
    status,
    created,
    updated: 0,
    skipped,
    errors: errorMessages.length,
    errorMessages,
    byCollection,
  };
}

/** 移行実行履歴を購読する（owner専用画面用） */
export function subscribeMigrationRuns(
  onChange: (runs: MigrationRunWithId[]) => void,
  onError: (m: string) => void
): Unsubscribe {
  return onSnapshot(
    query(collection(getDb(), "migrationRuns"), orderBy("startedAt", "desc")),
    (snap) => {
      onChange(snap.docs.map((d) => ({ id: d.id, ...(d.data() as MigrationRunDoc) })));
    },
    (e) => onError(e.message)
  );
}
