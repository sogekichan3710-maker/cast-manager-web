import {
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Unsubscribe,
} from "firebase/firestore";
import { getDb } from "@/lib/firebase";
import {
  ALL_STORES_FILTER,
  type BatchChange,
  type ImportBatchDoc,
  type ImportBatchWithId,
  type RunStatus,
} from "@/types";

const COL = "importBatches";

/** インポート開始時に履歴ドキュメントを作成する */
export async function createImportBatch(
  actorUid: string,
  params: { storeId: string; fileName: string; targetMonth: string; totalRows: number }
): Promise<string> {
  const db = getDb();
  const ref = doc(collection(db, COL));
  await setDoc(ref, {
    storeId: params.storeId,
    fileName: params.fileName,
    targetMonth: params.targetMonth,
    status: "processing" satisfies RunStatus,
    totalRows: params.totalRows,
    createdCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    summary: "",
    changes: [],
    rollbackStatus: "none",
    rollbackAt: null,
    rollbackBy: null,
    rollbackSummary: "",
    createdAt: serverTimestamp(),
    createdBy: actorUid,
    completedAt: null,
  });
  return ref.id;
}

/**
 * インポート完了・失敗・中断時に結果と変更記録を書き込む。
 * changes は中断・失敗時も必ず保存する（部分実行分もロールバック可能にするため）。
 */
export async function completeImportBatch(
  batchId: string,
  result: {
    status: RunStatus;
    createdCount: number;
    updatedCount: number;
    skippedCount: number;
    errorCount: number;
    summary: string;
  },
  changes: BatchChange[]
): Promise<void> {
  await updateDoc(doc(getDb(), COL, batchId), {
    ...result,
    changes,
    completedAt: serverTimestamp(),
  });
}

/** 閲覧可能店舗のインポート履歴を購読する（新しい順） */
export function subscribeImportBatches(
  storeIds: string[],
  onChange: (batches: ImportBatchWithId[]) => void,
  onError: (m: string) => void
): Unsubscribe {
  if (storeIds.length === 0 || storeIds.includes(ALL_STORES_FILTER)) {
    onChange([]);
    return () => {};
  }
  const chunks: string[][] = [];
  for (let i = 0; i < storeIds.length; i += 30) chunks.push(storeIds.slice(i, i + 30));
  const results = new Map<number, ImportBatchWithId[]>();
  const unsubs = chunks.map((chunk, idx) =>
    onSnapshot(
      query(collection(getDb(), COL), where("storeId", "in", chunk), orderBy("createdAt", "desc")),
      (snap) => {
        results.set(idx, snap.docs.map((d) => ({ id: d.id, ...(d.data() as ImportBatchDoc) })));
        if (results.size === chunks.length) {
          const all = Array.from(results.values()).flat();
          all.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
          onChange(all);
        }
      },
      (e) => onError(e.message)
    )
  );
  return () => unsubs.forEach((u) => u());
}
