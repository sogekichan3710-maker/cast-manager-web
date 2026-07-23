import { doc, runTransaction, serverTimestamp, type Firestore } from "firebase/firestore";

/**
 * キャストのscoutedByを、値が実際に変わる場合のみ更新する。
 * Excelインポート（executeExcelImport）の1行ごとの処理から呼ばれる。
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
