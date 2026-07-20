import {
  collection,
  doc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { getDb } from "@/lib/firebase";
import { writeAuditLog } from "@/services/auditLogService";
import type { BatchChange, ImportBatchWithId, RollbackStatus } from "@/types";

/**
 * Excelインポートの Batch 単位ロールバック。
 *
 * importBatches.changes（インポート実行時に記録した変更一覧）をもとに、
 * 以下を取り消す:
 *  - 新規キャスト（casts / importBatchId付き）→ 削除
 *    （このBatch以外のデータが参照している場合は安全のため削除せず理由を表示）
 *  - 新規月別成績（mr-created）→ 削除（batchIdが一致する場合のみ）
 *  - 上書きした月別成績（mr-updated）→ インポート前の値へ復元
 *  - 追加した時給履歴（wage-added / source: excel-import）→ 削除 +
 *    casts.hourlyWage をインポート前へ復元
 *  - 追加/更新した nameMatchingRules → 削除 / インポート前の値へ復元
 *  - キャストの在籍状態変更 → インポート前へ復元
 *
 * 安全設計:
 *  - インポート後に手動変更されたデータは上書きせず「戻せない」として理由を残す
 *    （現在値がインポートが書き込んだ値と一致する場合のみ復元・削除する）
 *  - Firestore上の既存データ（このインポートが作成・変更していないもの）には
 *    一切触れない
 *  - 結果は importBatches に rollbackStatus / rollbackAt / rollbackBy /
 *    rollbackSummary として保存する
 */

export interface RollbackPreview {
  /** 新規キャスト件数 */
  newCasts: number;
  /** 更新キャスト件数（時給変更・在籍状態変更） */
  updatedCasts: number;
  /** 月別成績件数（新規+上書き） */
  monthlyResults: number;
  /** 時給履歴件数 */
  wageHistory: number;
  /** nameMatchingRules件数（新規+更新） */
  nameMatchingRules: number;
  /** ロールバック可能か */
  available: boolean;
  unavailableReason: string | null;
}

/** ロールバック実行前の確認表示用サマリー */
export function buildRollbackPreview(batch: ImportBatchWithId): RollbackPreview {
  const changes = batch.changes ?? [];
  const count = (types: BatchChange["type"][]) =>
    changes.filter((c) => types.includes(c.type)).length;
  // 同一キャストへの複数更新（時給+在籍）は1キャストとして数える
  const updatedCastIds = new Set(
    changes.filter((c) => c.type === "cast-updated").map((c) => c.docId)
  );

  let available = true;
  let unavailableReason: string | null = null;
  if (batch.status === "processing") {
    available = false;
    unavailableReason = "インポートが実行中のためロールバックできません";
  } else if ((batch.rollbackStatus ?? "none") === "completed") {
    available = false;
    unavailableReason = "このBatchはすでにロールバック済みです";
  } else if (changes.length === 0) {
    available = false;
    unavailableReason =
      "このBatchには変更記録（changes）がありません（ロールバック機能追加前のインポート、または変更が1件もなかったインポートです）";
  }

  return {
    newCasts: count(["cast-created"]),
    updatedCasts: updatedCastIds.size,
    monthlyResults: count(["mr-created", "mr-updated"]),
    wageHistory: count(["wage-added"]),
    nameMatchingRules: count(["rule-created", "rule-updated"]),
    available,
    unavailableReason,
  };
}

export interface RollbackProgress {
  done: number;
  total: number;
  reverted: number;
  skipped: number;
}

export interface RollbackResult {
  status: RollbackStatus;
  reverted: number;
  /** 戻せなかった変更（理由付き） */
  skipped: Array<{ docId: string; collection: string; reason: string }>;
  errorMessages: string[];
}

/** 現在値が after と一致するか（インポート後の手動変更検知） */
function matchesAfter(
  current: Record<string, unknown>,
  after: Record<string, unknown> | null
): boolean {
  if (!after) return true;
  for (const [k, v] of Object.entries(after)) {
    const cur = current[k];
    if ((cur ?? null) !== (v ?? null)) return false;
  }
  return true;
}

/** 復元用の更新データ（before + メタ） */
function restoreData(
  before: Record<string, unknown>,
  actorUid: string
): Record<string, unknown> {
  return { ...before, updatedAt: serverTimestamp(), updatedBy: actorUid };
}

export async function rollbackImportBatch(
  actorUid: string,
  actorName: string,
  batch: ImportBatchWithId,
  onProgress: (p: RollbackProgress) => void,
  shouldCancel: () => boolean
): Promise<RollbackResult> {
  const db = getDb();
  const preview = buildRollbackPreview(batch);
  if (!preview.available) {
    throw new Error(preview.unavailableReason ?? "ロールバックできません");
  }

  const changes = batch.changes ?? [];
  // 実行順: ルール → 時給履歴 → 月別成績 → キャスト更新 → 新規キャスト削除
  // （新規キャストは参照データを先に消してから削除判定する）
  const order: Record<BatchChange["type"], number> = {
    "rule-created": 0,
    "rule-updated": 0,
    "wage-added": 1,
    "mr-created": 2,
    "mr-updated": 2,
    "cast-updated": 3,
    "cast-created": 4,
  };
  const sorted = [...changes].sort((a, b) => order[a.type] - order[b.type]);

  let reverted = 0;
  const skipped: RollbackResult["skipped"] = [];
  const errorMessages: string[] = [];
  let cancelled = false;
  let done = 0;
  const report = () =>
    onProgress({ done, total: sorted.length, reverted, skipped: skipped.length });

  // このロールバックで削除する月別成績・時給履歴のID（新規キャスト参照判定用）
  const deletingMrIds = new Set(
    sorted.filter((c) => c.type === "mr-created").map((c) => c.docId)
  );
  const deletingWhIds = new Set(
    sorted.filter((c) => c.type === "wage-added").map((c) => c.docId)
  );

  for (const c of sorted) {
    if (shouldCancel()) {
      cancelled = true;
      break;
    }
    try {
      switch (c.type) {
        case "rule-created": {
          // インポートが作成したルールを削除（内容が変わっていても、
          // このBatch起源のルールであることはdocIdで確定しているため削除する）
          await runTransaction(db, async (tx) => {
            const ref = doc(db, "nameMatchingRules", c.docId);
            const snap = await tx.get(ref);
            if (!snap.exists()) return; // すでに無い → 実質ロールバック済み
            tx.delete(ref);
          });
          reverted++;
          break;
        }
        case "rule-updated": {
          const ok = await runTransaction(db, async (tx) => {
            const ref = doc(db, "nameMatchingRules", c.docId);
            const snap = await tx.get(ref);
            if (!snap.exists()) return "missing";
            const cur = snap.data() as Record<string, unknown>;
            if (!matchesAfter(cur, c.after)) return "changed";
            tx.update(ref, restoreData(c.before ?? {}, actorUid));
            return "ok";
          });
          if (ok === "ok" || ok === "missing") reverted++;
          else skipped.push({ docId: c.docId, collection: c.collection, reason: "インポート後に手動変更されているため復元しません" });
          break;
        }
        case "wage-added": {
          await runTransaction(db, async (tx) => {
            const ref = doc(db, "wageHistory", c.docId);
            const snap = await tx.get(ref);
            if (!snap.exists()) return;
            tx.delete(ref);
          });
          reverted++;
          break;
        }
        case "mr-created": {
          const ok = await runTransaction(db, async (tx) => {
            const ref = doc(db, "monthlyResults", c.docId);
            const snap = await tx.get(ref);
            if (!snap.exists()) return "missing";
            const cur = snap.data() as { batchId?: string | null };
            if (cur.batchId !== batch.id) return "changed";
            tx.delete(ref);
            return "ok";
          });
          if (ok === "ok" || ok === "missing") reverted++;
          else {
            deletingMrIds.delete(c.docId);
            skipped.push({ docId: c.docId, collection: c.collection, reason: "インポート後に別の操作で更新されているため削除しません（batchId不一致）" });
          }
          break;
        }
        case "mr-updated": {
          const ok = await runTransaction(db, async (tx) => {
            const ref = doc(db, "monthlyResults", c.docId);
            const snap = await tx.get(ref);
            if (!snap.exists()) return "missing";
            const cur = snap.data() as { batchId?: string | null };
            if (cur.batchId !== batch.id) return "changed";
            tx.update(ref, restoreData(c.before ?? {}, actorUid));
            return "ok";
          });
          if (ok === "ok") reverted++;
          else if (ok === "missing") skipped.push({ docId: c.docId, collection: c.collection, reason: "対象の月別成績が存在しないため復元できません（削除済み）" });
          else skipped.push({ docId: c.docId, collection: c.collection, reason: "インポート後に別の操作で更新されているため復元しません（batchId不一致）" });
          break;
        }
        case "cast-updated": {
          const ok = await runTransaction(db, async (tx) => {
            const ref = doc(db, "casts", c.docId);
            const snap = await tx.get(ref);
            if (!snap.exists()) return "missing";
            const cur = snap.data() as Record<string, unknown>;
            if (!matchesAfter(cur, c.after)) return "changed";
            tx.update(ref, restoreData(c.before ?? {}, actorUid));
            return "ok";
          });
          if (ok === "ok") reverted++;
          else if (ok === "missing") skipped.push({ docId: c.docId, collection: c.collection, reason: "対象キャストが存在しないため復元できません" });
          else skipped.push({ docId: c.docId, collection: c.collection, reason: "インポート後に手動変更されているため復元しません（インポート前の値へ戻すと手動変更が失われます）" });
          break;
        }
        case "cast-created": {
          // 他のデータ（このロールバックで削除しないもの）が参照していれば削除しない
          const refs = await findRemainingReferences(c.docId, deletingMrIds, deletingWhIds);
          if (refs.length > 0) {
            skipped.push({
              docId: c.docId,
              collection: c.collection,
              reason: `このキャストを参照するデータが残っているため削除しません（${refs.join(" / ")}）。不要な場合はアーカイブをご利用ください`,
            });
            break;
          }
          const ok = await runTransaction(db, async (tx) => {
            const ref = doc(db, "casts", c.docId);
            const snap = await tx.get(ref);
            if (!snap.exists()) return "missing";
            const cur = snap.data() as { importBatchId?: string | null };
            if (cur.importBatchId !== batch.id) return "changed";
            tx.delete(ref);
            return "ok";
          });
          if (ok === "ok" || ok === "missing") reverted++;
          else skipped.push({ docId: c.docId, collection: c.collection, reason: "このBatchで作成されたキャストではないため削除しません（importBatchId不一致）" });
          break;
        }
      }
    } catch (err) {
      errorMessages.push(`${c.collection}/${c.docId}: ${(err as Error).message}`);
      skipped.push({ docId: c.docId, collection: c.collection, reason: `エラー: ${(err as Error).message}` });
    }
    done++;
    report();
  }

  let status: RollbackStatus;
  if (errorMessages.length > 0 && reverted === 0) status = "failed";
  else if (cancelled || skipped.length > 0) status = "partial";
  else status = "completed";

  const rollbackSummary =
    `取り消し ${reverted} / 戻せない ${skipped.length} / エラー ${errorMessages.length}` +
    (cancelled ? "（キャンセルにより中断）" : "");

  try {
    await updateDoc(doc(db, "importBatches", batch.id), {
      rollbackStatus: status,
      rollbackAt: serverTimestamp(),
      rollbackBy: actorUid,
      rollbackSummary,
    });
  } catch (err) {
    errorMessages.push(`ロールバック結果の記録に失敗: ${(err as Error).message}`);
  }

  try {
    await writeAuditLog({
      actorUid,
      actorName,
      action: "import.rollback",
      collection: "importBatches",
      documentId: batch.id,
      storeId: batch.storeId,
      before: { changesCount: changes.length },
      after: { rollbackStatus: status, reverted, skippedCount: skipped.length },
    });
  } catch {
    // 監査ログの書き込み失敗はロールバック結果自体には影響させない
  }

  report();
  return { status, reverted, skipped, errorMessages };
}

/**
 * 新規キャストを参照する残存データを探す。
 * このロールバックで削除する月別成績・時給履歴は除外して数える。
 */
async function findRemainingReferences(
  castId: string,
  deletingMrIds: Set<string>,
  deletingWhIds: Set<string>
): Promise<string[]> {
  const db = getDb();
  const refs: string[] = [];
  const check: Array<[string, string, Set<string> | null]> = [
    ["monthlyResults", "月別成績", deletingMrIds],
    ["wageHistory", "時給履歴", deletingWhIds],
    ["interviews", "面談", null],
    ["goals", "目標", null],
    ["motivations", "モチベーション", null],
  ];
  for (const [col, label, excludeIds] of check) {
    const snap = await getDocs(
      query(collection(db, col), where("castId", "==", castId))
    );
    const remaining = snap.docs.filter((d) => !excludeIds || !excludeIds.has(d.id));
    if (remaining.length > 0) refs.push(`${label}${remaining.length}件`);
  }
  return refs;
}
