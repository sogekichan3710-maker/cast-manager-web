import {
  collection,
  doc,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  where,
  type Timestamp,
  type Unsubscribe,
} from "firebase/firestore";
import { getDb } from "@/lib/firebase";
import {
  ALL_STORES_FILTER,
  monthlyResultId,
  type MonthlyResultDoc,
  type MonthlyResultWithId,
} from "@/types";

const COL = "monthlyResults";

export class MrConflictError extends Error {
  constructor() {
    super(
      "他のユーザーがこの成績を更新しました。最新の内容を確認してから、もう一度編集してください。"
    );
    this.name = "MrConflictError";
  }
}

/** 指定店舗×指定月の成績を購読（月別成績ページ用） */
export function subscribeMonthlyResultsByMonth(
  storeIds: string[],
  month: string,
  onChange: (results: MonthlyResultWithId[]) => void,
  onError: (message: string) => void
): Unsubscribe {
  if (storeIds.length === 0 || storeIds.includes(ALL_STORES_FILTER) || !month) {
    onChange([]);
    return () => {};
  }
  const chunks: string[][] = [];
  for (let i = 0; i < storeIds.length; i += 30) chunks.push(storeIds.slice(i, i + 30));

  const results = new Map<number, MonthlyResultWithId[]>();
  const unsubs = chunks.map((chunk, idx) =>
    onSnapshot(
      query(
        collection(getDb(), COL),
        where("storeId", "in", chunk),
        where("month", "==", month)
      ),
      (snap) => {
        results.set(
          idx,
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as MonthlyResultDoc) }))
        );
        if (results.size === chunks.length) {
          const all = Array.from(results.values()).flat();
          // 既存ローカル版と同じく総売上の降順
          all.sort((a, b) => (b.totalSales || 0) - (a.totalSales || 0));
          onChange(all);
        }
      },
      (err) => onError(err.message)
    )
  );
  return () => unsubs.forEach((u) => u());
}

/** 指定キャストの全成績を購読（詳細ページ・グラフ用。月の昇順=古い月→新しい月） */
export function subscribeMonthlyResultsByCast(
  castId: string,
  onChange: (results: MonthlyResultWithId[]) => void,
  onError: (message: string) => void
): Unsubscribe {
  return onSnapshot(
    query(collection(getDb(), COL), where("castId", "==", castId)),
    (snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, ...(d.data() as MonthlyResultDoc) }));
      list.sort((a, b) => a.month.localeCompare(b.month)); // YYYY-MM は文字列比較で時系列順
      onChange(list);
    },
    (err) => onError(err.message)
  );
}

/** 月別成績フォームの入力値（既存ローカル版 saveMr と同一フィールド） */
export interface MonthlyResultInput {
  castId: string;
  storeId: string;
  month: string; // YYYY-MM
  totalSales: number;
  payment: number;
  honshimeiCount: number;
  honshimeiGroupCount: number;
  customerCount: number;
  jounaiCount: number;
  douhan: number;
  workDays: number;
  workHours: number;
  absent: number;
  notes: string;
}

export function emptyMonthlyResultInput(
  castId: string,
  storeId: string,
  month: string
): MonthlyResultInput {
  return {
    castId,
    storeId,
    month,
    totalSales: 0,
    payment: 0,
    honshimeiCount: 0,
    honshimeiGroupCount: 0,
    customerCount: 0,
    jounaiCount: 0,
    douhan: 0,
    workDays: 0,
    workHours: 0,
    absent: 0,
    notes: "",
  };
}

export function validateMonthlyResultInput(input: MonthlyResultInput): string | null {
  if (!input.castId) return "キャストを選択してください";
  if (!input.storeId || input.storeId === ALL_STORES_FILTER) {
    return "店舗が不正です";
  }
  if (!/^\d{4}-\d{2}$/.test(input.month)) return "対象月を選択してください";
  const nums: Array<[string, number]> = [
    ["総売上", input.totalSales],
    ["支給額", input.payment],
    ["本指名本数", input.honshimeiCount],
    ["本指名組数", input.honshimeiGroupCount],
    ["顧客数", input.customerCount],
    ["場内指名", input.jounaiCount],
    ["同伴", input.douhan],
    ["出勤日数", input.workDays],
    ["出勤時間", input.workHours],
    ["欠勤", input.absent],
  ];
  for (const [label, v] of nums) {
    if (!Number.isFinite(v) || v < 0) return `${label}は0以上の数値で入力してください`;
  }
  return null;
}

/**
 * 月別成績を保存する。
 * ドキュメントIDは `${storeId}_${castId}_${month}` の一意キーで、
 * 同一店舗・同一キャスト・同一月の重複を構造的に防ぐ（既存ローカル版の
 * 「既存データがあります。上書きしますか？」に相当する確認は呼び出し側で行う）。
 *
 * expectedUpdatedAt:
 *   - 新規作成: null を渡す。既存があれば ExistsError を投げるので、
 *     呼び出し側が上書き確認後に overwrite: true で再実行する。
 *   - 編集: 編集開始時点の updatedAt。他ユーザー更新を検知したら MrConflictError。
 */
export class MrExistsError extends Error {
  constructor(public existingMonth: string) {
    super("この月の成績は既に存在します");
    this.name = "MrExistsError";
  }
}

export async function saveMonthlyResult(
  actorUid: string,
  input: MonthlyResultInput,
  opts: { overwrite: boolean; expectedUpdatedAt: Timestamp | null }
): Promise<void> {
  const err = validateMonthlyResultInput(input);
  if (err) throw new Error(err);
  const db = getDb();
  const id = monthlyResultId(input.storeId, input.castId, input.month);
  const ref = doc(db, COL, id);

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const data = {
      castId: input.castId,
      storeId: input.storeId,
      month: input.month,
      totalSales: Math.round(input.totalSales),
      payment: Math.round(input.payment),
      honshimeiCount: input.honshimeiCount,
      honshimeiGroupCount: input.honshimeiGroupCount,
      customerCount: input.customerCount,
      jounaiCount: input.jounaiCount,
      douhan: input.douhan,
      workDays: input.workDays,
      workHours: input.workHours,
      absent: input.absent,
      notes: input.notes.trim(),
      batchId: null,
      updatedAt: serverTimestamp(),
      updatedBy: actorUid,
    };

    if (!snap.exists()) {
      tx.set(ref, { ...data, createdAt: serverTimestamp(), createdBy: actorUid });
      return;
    }

    const current = snap.data() as MonthlyResultDoc;
    if (opts.expectedUpdatedAt) {
      // 編集モード: 競合検知
      if (current.updatedAt && !current.updatedAt.isEqual(opts.expectedUpdatedAt)) {
        throw new MrConflictError();
      }
    } else if (!opts.overwrite) {
      // 新規モードで既存あり → 上書き確認が必要
      throw new MrExistsError(current.month);
    }
    tx.update(ref, data);
  });
}

/** 月別成績を削除する（admin以上・Rulesでも制限） */
export async function deleteMonthlyResult(resultId: string): Promise<void> {
  const db = getDb();
  await runTransaction(db, async (tx) => {
    const ref = doc(db, COL, resultId);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("成績データが見つかりません");
    tx.delete(ref);
  });
}

/** 閲覧可能店舗の全成績を購読（ダッシュボード・ランキング用） */
export function subscribeMonthlyResultsByStores(
  storeIds: string[],
  onChange: (results: MonthlyResultWithId[]) => void,
  onError: (message: string) => void
): Unsubscribe {
  if (storeIds.length === 0 || storeIds.includes(ALL_STORES_FILTER)) {
    onChange([]);
    return () => {};
  }
  const chunks: string[][] = [];
  for (let i = 0; i < storeIds.length; i += 30) chunks.push(storeIds.slice(i, i + 30));
  const results = new Map<number, MonthlyResultWithId[]>();
  const unsubs = chunks.map((chunk, idx) =>
    onSnapshot(
      query(collection(getDb(), COL), where("storeId", "in", chunk)),
      (snap) => {
        results.set(
          idx,
          snap.docs.map((d) => ({ id: d.id, ...(d.data() as MonthlyResultDoc) }))
        );
        if (results.size === chunks.length) {
          onChange(Array.from(results.values()).flat());
        }
      },
      (err) => onError(err.message)
    )
  );
  return () => unsubs.forEach((u) => u());
}
