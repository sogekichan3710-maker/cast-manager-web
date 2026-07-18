import { collection, getDocs, query, where } from "firebase/firestore";
import { getDb } from "@/lib/firebase";
import type {
  CastDoc,
  CastWithId,
  GoalDoc,
  GoalWithId,
  InterviewDoc,
  InterviewWithId,
  MonthlyResultDoc,
  MonthlyResultWithId,
  MotivationDoc,
  MotivationWithId,
  WageHistoryDoc,
  WageHistoryWithId,
} from "@/types";

/**
 * Excelエクスポート用のデータ一括取得。
 * 対象店舗（閲覧可能店舗のみ）を in 句で絞り込んで取得し、
 * 期間（YYYY-MM〜YYYY-MM）はクライアント側でフィルタする。
 */

async function fetchByStores<T extends { storeId: string }>(
  col: string,
  storeIds: string[]
): Promise<Array<T & { id: string }>> {
  const db = getDb();
  const out: Array<T & { id: string }> = [];
  for (let i = 0; i < storeIds.length; i += 30) {
    const chunk = storeIds.slice(i, i + 30);
    const snap = await getDocs(query(collection(db, col), where("storeId", "in", chunk)));
    snap.docs.forEach((d) => out.push({ id: d.id, ...(d.data() as T) }));
  }
  return out;
}

export interface ExportFetchResult {
  casts: CastWithId[];
  monthlyResults: MonthlyResultWithId[];
  interviews: InterviewWithId[];
  goals: GoalWithId[];
  motivations: MotivationWithId[];
  wageHistory: WageHistoryWithId[];
}

/** 期間フィルタ: YYYY-MM または YYYY-MM-DD の値が from〜to（YYYY-MM）に入るか */
function inRange(value: string, fromMonth: string, toMonth: string): boolean {
  if (!value) return true; // 日付未入力のデータは除外しない
  const m = value.slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(m)) return true;
  return (!fromMonth || m >= fromMonth) && (!toMonth || m <= toMonth);
}

export async function fetchExportData(
  storeIds: string[],
  fromMonth: string,
  toMonth: string,
  onProgress?: (label: string) => void
): Promise<ExportFetchResult> {
  if (storeIds.length === 0) {
    return { casts: [], monthlyResults: [], interviews: [], goals: [], motivations: [], wageHistory: [] };
  }
  onProgress?.("キャストを取得中…");
  const casts = await fetchByStores<CastDoc>("casts", storeIds);
  onProgress?.("月別成績を取得中…");
  const monthlyResults = (await fetchByStores<MonthlyResultDoc>("monthlyResults", storeIds)).filter(
    (m) => inRange(m.month, fromMonth, toMonth)
  );
  onProgress?.("面談履歴を取得中…");
  const interviews = (await fetchByStores<InterviewDoc>("interviews", storeIds)).filter((iv) =>
    inRange(iv.date, fromMonth, toMonth)
  );
  onProgress?.("目標を取得中…");
  const goals = (await fetchByStores<GoalDoc>("goals", storeIds)).filter((g) =>
    inRange(g.month, fromMonth, toMonth)
  );
  onProgress?.("モチベーションを取得中…");
  const motivations = (await fetchByStores<MotivationDoc>("motivations", storeIds)).filter((m) =>
    inRange(m.date, fromMonth, toMonth)
  );
  onProgress?.("時給履歴を取得中…");
  const wageHistory = (await fetchByStores<WageHistoryDoc>("wageHistory", storeIds)).filter((w) =>
    inRange(w.effectiveMonth, fromMonth, toMonth)
  );

  // 並び順を整える（月・日付の昇順、キャストは店舗→源氏名）
  casts.sort((a, b) => a.storeId.localeCompare(b.storeId) || a.stageName.localeCompare(b.stageName, "ja"));
  monthlyResults.sort((a, b) => a.month.localeCompare(b.month) || (b.totalSales || 0) - (a.totalSales || 0));
  interviews.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  goals.sort((a, b) => (a.month || "").localeCompare(b.month || ""));
  motivations.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  wageHistory.sort((a, b) => (a.effectiveMonth || "").localeCompare(b.effectiveMonth || ""));

  return { casts, monthlyResults, interviews, goals, motivations, wageHistory };
}
