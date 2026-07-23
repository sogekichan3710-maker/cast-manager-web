import { doc, runTransaction, serverTimestamp, type Firestore } from "firebase/firestore";
import { getDb } from "@/lib/firebase";
import { writeAuditLog } from "@/services/auditLogService";
import type { ScoutedByPlanRow } from "@/lib/excel/scoutedByBulkPlan";

/**
 * キャストのscoutedByを、値が実際に変わる場合のみ更新する。
 * Excelインポート（1行ずつ）とスカウト者一括反映（複数キャストまとめて）の
 * 両方から使う共通のトランザクション処理。
 * 最新のFirestore値を読み直したうえで判定するため、画面表示時点の
 * 古いスナップショットで誤って上書きすることはない。
 */
export async function applyScoutedByIfChanged(
  db: Firestore,
  castId: string,
  scoutedBy: string,
  actorUid: string
): Promise<{ before: string; after: string } | null> {
  const castRef = doc(db, "casts", castId);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(castRef);
    if (!snap.exists()) throw new Error("キャストが見つかりません");
    const current = (snap.data() as { scoutedBy?: string }).scoutedBy ?? "";
    if (current === scoutedBy) return null;
    tx.update(castRef, {
      scoutedBy,
      updatedAt: serverTimestamp(),
      updatedBy: actorUid,
    });
    return { before: current, after: scoutedBy };
  });
}

export interface BulkScoutedByResult {
  updated: number;
  skipped: number;
  errors: number;
  errorMessages: string[];
  /** スキップされた対象の内訳（実行時点で既に同じ値になっていた等） */
  skippedDetails: { name: string; reason: string }[];
}

/**
 * スカウト者の一括反映を実行する（owner/admin専用・Rulesでも制限）。
 * buildScoutedByPlan() の action:"update" の行のみを対象とし、
 * casts.scoutedBy 以外のフィールド（月別成績・時給等）には一切触れない。
 * 実行時点で他の変更と競合していた場合（既にExcel側と同じ値になっていた等）は
 * 自動的にスキップする（applyScoutedByIfChangedが最新値を読み直すため）。
 */
export async function applyScoutedByBulkPlan(
  actorUid: string,
  actorName: string,
  storeId: string,
  plan: ScoutedByPlanRow[],
  onProgress?: (done: number, total: number) => void
): Promise<BulkScoutedByResult> {
  const db = getDb();
  const targets = plan.filter((p) => p.action === "update" && p.castId);
  let updated = 0;
  let skipped = 0;
  const errorMessages: string[] = [];
  const skippedDetails: { name: string; reason: string }[] = [];

  for (let i = 0; i < targets.length; i++) {
    const p = targets[i];
    try {
      const result = await applyScoutedByIfChanged(db, p.castId!, p.excelScoutedBy, actorUid);
      if (result) {
        updated++;
        await writeAuditLog({
          actorUid,
          actorName,
          action: "cast.update",
          collection: "casts",
          documentId: p.castId!,
          storeId,
          before: { scoutedBy: result.before },
          after: { scoutedBy: result.after },
        });
      } else {
        skipped++;
        skippedDetails.push({
          name: p.name,
          reason: "実行時点で既に同じ値だったためスキップしました（他の操作と競合した可能性があります）",
        });
      }
    } catch (err) {
      errorMessages.push(`「${p.name}」: ${(err as Error).message}`);
    }
    onProgress?.(i + 1, targets.length);
  }

  return { updated, skipped, errors: errorMessages.length, errorMessages, skippedDetails };
}
