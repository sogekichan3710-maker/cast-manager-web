import { normalizeName } from "@/lib/nameNormalize";
import type { ExcelMonthlyRow } from "./parseMonthlyExcel";

/**
 * スカウト者の一括反映（既存キャストのみ対象）の計画作成。
 *
 * 過去のExcel（給与明細）に記録されているスカウト者を、月別成績・
 * 時給等には一切触れずに既存キャストの scoutedBy へ反映するための
 * 純粋関数。通常のExcelインポート（照合・成績保存）とは完全に独立して
 * おり、このモジュールは casts.scoutedBy 以外のフィールドを一切扱わない。
 *
 * 照合は既存インポートと同じ「対象店舗内の源氏名・完全一致」のみで判定し、
 * 部分一致・類似判定は行わない（誤反映を避けるため）。
 */

export type ScoutedByPlanAction =
  | "update" // 反映対象（値が変わる）
  | "skip-no-value" // Excel側が空欄
  | "skip-same" // 既に同じ値
  | "skip-no-match" // 店舗内に完全一致するキャストがいない
  | "skip-multiple-match"; // 同名キャストが複数（自動判定しない）

export interface ScoutedByPlanRow {
  rowNumber: number;
  name: string;
  excelScoutedBy: string;
  /** action が "update" の場合のみ非null */
  castId: string | null;
  /** 一致したキャストの現在の値（未一致の場合はnull） */
  currentScoutedBy: string | null;
  action: ScoutedByPlanAction;
}

export interface ScoutedByTargetCast {
  id: string;
  stageName: string;
  scoutedBy: string;
  archived: boolean;
}

export function buildScoutedByPlan(
  rows: ExcelMonthlyRow[],
  casts: ScoutedByTargetCast[]
): ScoutedByPlanRow[] {
  const byName = new Map<string, ScoutedByTargetCast[]>();
  for (const c of casts) {
    if (c.archived) continue;
    const key = normalizeName(c.stageName);
    const list = byName.get(key) ?? [];
    list.push(c);
    byName.set(key, list);
  }

  return rows.map((row) => {
    const excelScoutedBy = row.scoutedBy.trim();
    const matches = byName.get(normalizeName(row.name)) ?? [];

    if (excelScoutedBy === "") {
      return {
        rowNumber: row.rowNumber,
        name: row.name,
        excelScoutedBy,
        castId: null,
        currentScoutedBy: matches.length === 1 ? matches[0].scoutedBy : null,
        action: "skip-no-value",
      };
    }
    if (matches.length === 0) {
      return {
        rowNumber: row.rowNumber,
        name: row.name,
        excelScoutedBy,
        castId: null,
        currentScoutedBy: null,
        action: "skip-no-match",
      };
    }
    if (matches.length > 1) {
      return {
        rowNumber: row.rowNumber,
        name: row.name,
        excelScoutedBy,
        castId: null,
        currentScoutedBy: null,
        action: "skip-multiple-match",
      };
    }
    const cast = matches[0];
    if (cast.scoutedBy === excelScoutedBy) {
      return {
        rowNumber: row.rowNumber,
        name: row.name,
        excelScoutedBy,
        castId: cast.id,
        currentScoutedBy: cast.scoutedBy,
        action: "skip-same",
      };
    }
    return {
      rowNumber: row.rowNumber,
      name: row.name,
      excelScoutedBy,
      castId: cast.id,
      currentScoutedBy: cast.scoutedBy,
      action: "update",
    };
  });
}
