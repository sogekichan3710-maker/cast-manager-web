import { collection, doc, getDoc, getDocs, query, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getDb, getFunctionsInstance } from "@/lib/firebase";
import type { CastDoc } from "@/types";

/**
 * キャストの完全削除（owner専用・PR5レビュー対応でCloud Functions化）。
 *
 * 削除前のプレビュー（関連データ件数の集計）は読み取りのみのため
 * 引き続きクライアント側で行う。実際の削除は
 * functions/src/index.ts の deleteCastPermanently（owner専用Callable
 * Function・Admin SDK）へ完全に移した。複数コレクションにまたがる
 * 削除を途中失敗時にも安全に再実行できるようにするため、クライアント側の
 * 逐次Firestore書き込みでは行わない（詳細はdeleteCastPermanently関数の
 * コメント参照）。
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

/** 削除前に関連データ件数を集計する（読み取りのみ・クライアント側） */
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

export interface CastDeletionResult {
  /** true の場合、以前の呼び出しで既に完全削除が完了済みだった（冪等な再実行） */
  alreadyDeleted: boolean;
  deletedCounts: Record<string, number> | null;
}

/**
 * キャストと関連データを完全に削除する（owner専用・Cloud Functions経由）。
 * Firestore Rules は owner を含めクライアントSDKからの任意のcasts削除を
 * 禁止しているため、この呼び出し（Callable Function）だけが完全削除の
 * 唯一の経路になる。
 */
export async function deleteCastPermanently(castId: string): Promise<CastDeletionResult> {
  try {
    const fn = httpsCallable(getFunctionsInstance(), "deleteCastPermanently");
    const res = await fn({ castId });
    const data = res.data as {
      ok: boolean;
      alreadyDeleted?: boolean;
      deletedCounts?: Record<string, number> | null;
    };
    return {
      alreadyDeleted: Boolean(data.alreadyDeleted),
      deletedCounts: data.deletedCounts ?? null,
    };
  } catch (err) {
    const e = err as { message?: string };
    throw new Error(e?.message || "削除に失敗しました");
  }
}
