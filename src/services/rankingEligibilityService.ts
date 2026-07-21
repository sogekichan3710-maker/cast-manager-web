import {
  collection,
  doc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
  where,
} from "firebase/firestore";
import { getDb } from "@/lib/firebase";
import { writeAuditLog } from "@/services/auditLogService";
import { monthPeriodStart, type CastDoc, type MonthlyResultDoc } from "@/types";

/**
 * 既存キャストの rankingEligibleFrom 一括バックフィル（owner専用・冪等）。
 *
 * PR8でランキングに rankingEligibleFrom（対象開始日より前の期間には表示しない）
 * を導入したが、既存キャストにはこの値が無い。初回のみ実行する一括設定処理:
 * - rankingEligibleFrom が既に設定済み（自動・手動問わず）のキャストは一切変更しない
 *   （何度実行しても安全・二重実行で上書きされない）
 * - 対象キャストの monthlyResults のうち最も古い month の月初を採用する
 * - monthlyResults が1件も無いキャストは対象外のまま（null）
 *   = ランキングでは「常に対象」として扱われる（従来の全件表示動作を維持）
 */

export interface BackfillProgress {
  total: number;
  done: number;
  updated: number;
  skipped: number;
  errors: number;
}

export interface BackfillResult {
  total: number;
  updated: number;
  skipped: number;
  errors: number;
  errorMessages: string[];
}

export async function backfillRankingEligibleFrom(
  actorUid: string,
  actorName: string,
  onProgress: (p: BackfillProgress) => void,
  shouldCancel: () => boolean
): Promise<BackfillResult> {
  const db = getDb();
  const castsSnap = await getDocs(collection(db, "casts"));
  const targets = castsSnap.docs.filter((d) => (d.data() as CastDoc).rankingEligibleFrom == null);

  const total = targets.length;
  let done = 0;
  let updated = 0;
  let skipped = 0;
  const errorMessages: string[] = [];
  const report = () => onProgress({ total, done, updated, skipped, errors: errorMessages.length });
  report();

  for (const castDoc of targets) {
    if (shouldCancel()) break;
    try {
      const mrSnap = await getDocs(
        query(collection(db, "monthlyResults"), where("castId", "==", castDoc.id))
      );
      if (mrSnap.empty) {
        skipped++;
      } else {
        const earliestMonth = mrSnap.docs
          .map((d) => (d.data() as MonthlyResultDoc).month)
          .sort()[0];
        const start = monthPeriodStart(earliestMonth);
        if (!start) {
          skipped++;
        } else {
          const ts = Timestamp.fromDate(start);
          const castRef = doc(db, "casts", castDoc.id);
          const applied = await runTransaction(db, async (tx) => {
            const snap = await tx.get(castRef);
            if (!snap.exists()) return false;
            if ((snap.data() as CastDoc).rankingEligibleFrom != null) return false; // 既に設定済みは上書きしない
            tx.update(castRef, {
              rankingEligibleFrom: ts,
              updatedAt: serverTimestamp(),
              updatedBy: actorUid,
            });
            return true;
          });
          if (applied) updated++;
          else skipped++;
        }
      }
    } catch (err) {
      errorMessages.push(`${castDoc.id}（${(castDoc.data() as CastDoc).stageName ?? ""}）: ${(err as Error).message}`);
    }
    done++;
    report();
  }

  try {
    await writeAuditLog({
      actorUid,
      actorName,
      action: "cast.update",
      collection: "casts",
      documentId: "(bulk-ranking-eligible-from-backfill)",
      storeId: null,
      before: null,
      after: { total, updated, skipped, errors: errorMessages.length },
    });
  } catch {
    // 監査ログの書き込み失敗は結果自体には影響させない
  }

  return { total, updated, skipped, errors: errorMessages.length, errorMessages };
}
