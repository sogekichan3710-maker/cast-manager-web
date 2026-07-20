import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  where,
  writeBatch,
} from "firebase/firestore";
import { getDb } from "@/lib/firebase";
import { writeAuditLog } from "@/services/auditLogService";
import type { CastDoc } from "@/types";

/**
 * キャストの完全削除（owner専用・PR5）。
 *
 * casts のRulesは「importBatchId付き（Excelインポートで作成されたキャスト）」
 * のみ削除を許可しており、手動作成のキャストは削除できない仕組みを
 * PR4から維持している。完全削除はこの制約の外側で、Cloud Functions
 * 相当の管理者操作として扱う必要があるため、本サービスは owner のみが
 * 到達できる画面から呼び出すこと（UI側でも owner 以外は非表示にする）。
 *
 * 関連データ（月別成績・面談・目標・モチベーション・時給履歴・
 * nameMatchingRules・importBatches参照）を先にすべて削除し、
 * 孤立データを残さない。大量データは書き込み上限(500件/バッチ)を
 * 考慮して分割する。
 */

const RELATED_COLLECTIONS = [
  "monthlyResults",
  "interviews",
  "goals",
  "motivations",
  "wageHistory",
] as const;

export interface CastDeletionPreview {
  castId: string;
  stageName: string;
  storeId: string;
  monthlyResults: number;
  interviews: number;
  goals: number;
  motivations: number;
  wageHistory: number;
  nameMatchingRules: number;
  importBatchRefs: number;
}

/** 削除前に関連データ件数を集計する */
export async function previewCastDeletion(castId: string): Promise<CastDeletionPreview> {
  const db = getDb();
  const castSnap = await getDoc(doc(db, "casts", castId));
  if (!castSnap.exists()) throw new Error("キャストが見つかりません");
  const cast = castSnap.data() as CastDoc;

  const snaps: Record<string, Awaited<ReturnType<typeof getDocs>>> = {};
  for (const col of RELATED_COLLECTIONS) {
    snaps[col] = await getDocs(query(collection(db, col), where("castId", "==", castId)));
  }
  // nameMatchingRules はこのキャストへリンクしているものを対象にする
  const ruleSnap = await getDocs(
    query(collection(db, "nameMatchingRules"), where("linkedCastId", "==", castId))
  );
  // importBatch参照件数は、既に取得済みの monthlyResults スナップショットから
  // クライアント側で数える（batchId != null の複合クエリは不要な追加読み取り・
  // 追加インデックスを必要とするため避ける。参考表示用の件数のみ）
  const importBatchRefs = snaps.monthlyResults.docs.filter(
    (d) => (d.data() as { batchId?: string | null }).batchId != null
  ).length;

  return {
    castId,
    stageName: cast.stageName,
    storeId: cast.storeId,
    monthlyResults: snaps.monthlyResults?.size ?? 0,
    interviews: snaps.interviews?.size ?? 0,
    goals: snaps.goals?.size ?? 0,
    motivations: snaps.motivations?.size ?? 0,
    wageHistory: snaps.wageHistory?.size ?? 0,
    nameMatchingRules: ruleSnap.size,
    importBatchRefs,
  };
}

const BATCH_SIZE = 400;

async function deleteAllByCastId(db: ReturnType<typeof getDb>, col: string, castId: string): Promise<number> {
  const snap = await getDocs(query(collection(db, col), where("castId", "==", castId)));
  const refs = snap.docs.map((d) => d.ref);
  for (let i = 0; i < refs.length; i += BATCH_SIZE) {
    const batch = writeBatch(db);
    for (const ref of refs.slice(i, i + BATCH_SIZE)) batch.delete(ref);
    await batch.commit();
  }
  return refs.length;
}

/**
 * キャストと関連データを完全に削除する（owner専用）。
 * 孤立データを残さないため、関連コレクションを先に全削除してから
 * casts本体を削除する。
 */
export async function deleteCastPermanently(
  actorUid: string,
  actorName: string,
  castId: string
): Promise<CastDeletionPreview> {
  const db = getDb();
  const preview = await previewCastDeletion(castId);
  const castSnap = await getDoc(doc(db, "casts", castId));
  if (!castSnap.exists()) throw new Error("キャストが見つかりません");
  const castData = castSnap.data() as CastDoc;

  for (const col of RELATED_COLLECTIONS) {
    await deleteAllByCastId(db, col, castId);
  }

  // このキャストへリンクしているnameMatchingRulesは無効化（削除ではなく
  // active:false。ルールの履歴自体は監査のため残す）
  const ruleSnap = await getDocs(
    query(collection(db, "nameMatchingRules"), where("linkedCastId", "==", castId))
  );
  for (let i = 0; i < ruleSnap.docs.length; i += BATCH_SIZE) {
    const batch = writeBatch(db);
    for (const d of ruleSnap.docs.slice(i, i + BATCH_SIZE)) {
      batch.update(d.ref, {
        active: false,
        linkedCastId: null,
        updatedAt: serverTimestamp(),
        updatedBy: actorUid,
      });
    }
    await batch.commit();
  }

  await deleteDoc(doc(db, "casts", castId));

  await writeAuditLog({
    actorUid,
    actorName,
    action: "cast.deletePermanent",
    collection: "casts",
    documentId: castId,
    storeId: castData.storeId,
    before: {
      stageName: castData.stageName,
      storeId: castData.storeId,
      deletedRelatedCounts: preview,
    },
    after: null,
  });

  return preview;
}
