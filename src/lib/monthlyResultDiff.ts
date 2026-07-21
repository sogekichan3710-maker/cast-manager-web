import type { Timestamp } from "firebase/firestore";
import type { ExcelMonthlyRow } from "@/lib/excel/parseMonthlyExcel";
import type { MonthlyResultWithId } from "@/types";

/**
 * 月別成績の再インポート時差分（PR5・毎日/飛び飛び運用対応）。
 *
 * Excelは「その時点までの月累計」を保持しているため、インポートは常に
 * 値を上書きする（加算しない）。月末締め後の修正（売上・支給額・保証等）も
 * 最終Excelを再インポートするだけでFirestore側が最終状態になるよう、
 * ここでは「変更された項目だけ」を抽出して確認できるようにする。
 */

export interface MonthlyResultDiffItem {
  key: string;
  label: string;
  before: number | string;
  after: number | string;
  yen: boolean;
}

const FIELDS: Array<{
  key: keyof MonthlyResultWithId & keyof ExcelMonthlyRowNumeric;
  label: string;
  yen: boolean;
}> = [
  { key: "totalSales", label: "売上", yen: true },
  { key: "payment", label: "支給額", yen: true },
  { key: "honshimeiCount", label: "本指名", yen: false },
  { key: "honshimeiGroupCount", label: "本指名組数", yen: false },
  { key: "customerCount", label: "顧客数", yen: false },
  { key: "jounaiCount", label: "場内", yen: false },
  { key: "douhan", label: "同伴", yen: false },
  { key: "workDays", label: "出勤日数", yen: false },
  { key: "workHours", label: "出勤時間", yen: false },
  { key: "absent", label: "欠勤", yen: false },
];

// ExcelMonthlyRow と MonthlyResultWithId 両方に存在する数値フィールドのみを対象にする
type ExcelMonthlyRowNumeric = Pick<
  ExcelMonthlyRow,
  | "totalSales"
  | "payment"
  | "honshimeiCount"
  | "honshimeiGroupCount"
  | "customerCount"
  | "jounaiCount"
  | "douhan"
  | "workDays"
  | "workHours"
  | "absent"
>;

/**
 * 既存データとExcel行を比較し、**値が変わった項目だけ**を返す。
 * 時給は行データではなくキャスト側の値のため、ここでは対象外
 * （時給変更は別フロー＝時給変更候補で扱う）。
 */
export function diffMonthlyResultFields(
  existing: MonthlyResultWithId,
  row: ExcelMonthlyRow
): MonthlyResultDiffItem[] {
  const items: MonthlyResultDiffItem[] = [];
  for (const f of FIELDS) {
    const before = existing[f.key] as number;
    const after = row[f.key] as number;
    if (before !== after) {
      items.push({ key: f.key, label: f.label, before, after, yen: f.yen });
    }
  }
  return items;
}

/** 表示用フォーマット（¥1,000,000 / 20 等） */
export function fmtDiffValue(v: number | string, yen: boolean): string {
  if (typeof v !== "number") return String(v);
  return yen ? `¥${v.toLocaleString()}` : v.toLocaleString();
}

/**
 * 月別成績が最後にどちらの経路で更新されたか（毎日/飛び飛びのExcel運用の
 * 可視化用）。lastImportAt / lastManualEditAt のうち新しい方を採用する。
 * どちらも無い場合（PR5より前の旧データ）は "不明"。
 */
export type LastUpdateSource = "Excel" | "手動編集" | "不明";

export function lastUpdateSource(
  r: Pick<MonthlyResultWithId, "lastImportAt" | "lastManualEditAt">
): LastUpdateSource {
  if (r.lastImportAt && r.lastManualEditAt) {
    return r.lastImportAt.toMillis() >= r.lastManualEditAt.toMillis() ? "Excel" : "手動編集";
  }
  if (r.lastImportAt) return "Excel";
  if (r.lastManualEditAt) return "手動編集";
  return "不明";
}

/** 最後の更新時刻（lastImportAt / lastManualEditAt のうち新しい方）。無ければ null */
export function lastUpdateAt(
  r: Pick<MonthlyResultWithId, "lastImportAt" | "lastManualEditAt">
): Timestamp | null {
  const a = r.lastImportAt ?? null;
  const b = r.lastManualEditAt ?? null;
  if (a && b) return a.toMillis() >= b.toMillis() ? a : b;
  return a ?? b ?? null;
}
