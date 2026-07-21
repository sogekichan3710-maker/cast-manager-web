import { describe, expect, it } from "vitest";
import type { Timestamp } from "firebase/firestore";
import { mrRowBusinessFields } from "@/services/excelImportService";
import { lastUpdateAt, lastUpdateSource } from "@/lib/monthlyResultDiff";
import { monthlyResultId } from "@/types";
import type { ExcelMonthlyRow } from "@/lib/excel/parseMonthlyExcel";

/**
 * 「毎日・飛び飛び運用対応」（要件③）の回帰テスト。
 *
 * 会社Excelはその時点までの月累計を保持しているため、7/20分→7/21分→
 * （欠落）→7/25分のように何度・どんな順序で同じ月のExcelを取り込んでも、
 * 常に「同じ月別成績ドキュメントを重複なく上書き更新」できる必要がある。
 * これは以下の2点だけで成り立つ:
 *  (1) 月別成績のドキュメントIDが店舗・キャスト・月だけで決まる（日付を
 *      含まない）→ 何度再インポートしても新しいドキュメントは作られない
 *  (2) Excel行→保存データの変換が常にExcelの値をそのまま採用する
 *      （既存値への加算を行わない）→ 最後に取り込んだExcelの値が
 *      そのまま最終状態になる
 */

function row(overrides: Partial<ExcelMonthlyRow> = {}): ExcelMonthlyRow {
  return {
    rowNumber: 2,
    name: "あいり",
    hourlyWage: 5000,
    scoutedBy: "",
    totalSales: 1000000,
    payment: 400000,
    honshimeiCount: 20,
    honshimeiGroupCount: 10,
    customerCount: 15,
    jounaiCount: 5,
    douhan: 3,
    workDays: 15,
    workHours: 70,
    absent: 0,
    notes: "",
    ...overrides,
  };
}

const ts = (ms: number): Timestamp => ({ toMillis: () => ms }) as unknown as Timestamp;

describe("monthlyResultId（日付を含まない決定的ID・要件③の土台）", () => {
  it("同じ店舗・キャスト・月であれば、何度呼んでも同一IDになる（7/20分→7/21分→7/25分の再インポートが同一ドキュメントを指す）", () => {
    const idDay1 = monthlyResultId("virgo", "cast1", "2026-07");
    const idDay2 = monthlyResultId("virgo", "cast1", "2026-07");
    const idDay3 = monthlyResultId("virgo", "cast1", "2026-07");
    expect(idDay1).toBe(idDay2);
    expect(idDay2).toBe(idDay3);
  });

  it("店舗・キャスト・月が異なれば異なるIDになる（誤って別キャスト/店舗/月を上書きしない）", () => {
    const a = monthlyResultId("virgo", "cast1", "2026-07");
    const b = monthlyResultId("regina", "cast1", "2026-07");
    const c = monthlyResultId("virgo", "cast2", "2026-07");
    const d = monthlyResultId("virgo", "cast1", "2026-08");
    expect(new Set([a, b, c, d]).size).toBe(4);
  });
});

describe("mrRowBusinessFields（Excel行→保存値は常に上書き・加算しない）", () => {
  it("Excel行の値をそのまま採用する（既存の保存値には一切依存しない）", () => {
    const r = row({ totalSales: 1500000, payment: 520000, honshimeiCount: 12 });
    const data = mrRowBusinessFields(r);
    expect(data.totalSales).toBe(1500000);
    expect(data.payment).toBe(520000);
    expect(data.honshimeiCount).toBe(12);
  });

  it("2回目のインポート（例: 7/25分。より新しい月累計）は1回目の値を無視し、Excelの新しい値のみを反映する", () => {
    const day1 = mrRowBusinessFields(row({ totalSales: 1000000 }));
    const day2 = mrRowBusinessFields(row({ totalSales: 1800000 })); // 加算(2800000)ではなく置換
    expect(day1.totalSales).toBe(1000000);
    expect(day2.totalSales).toBe(1800000);
  });
});

describe("lastUpdateSource / lastUpdateAt（最終更新がExcelか手動編集かの判別）", () => {
  it("両方nullなら不明", () => {
    expect(lastUpdateSource({ lastImportAt: null, lastManualEditAt: null })).toBe("不明");
    expect(lastUpdateAt({ lastImportAt: null, lastManualEditAt: null })).toBeNull();
  });

  it("Excelインポートのみあれば Excel", () => {
    const at = ts(1000);
    expect(lastUpdateSource({ lastImportAt: at, lastManualEditAt: null })).toBe("Excel");
    expect(lastUpdateAt({ lastImportAt: at, lastManualEditAt: null })).toBe(at);
  });

  it("手動編集のみあれば 手動編集", () => {
    const at = ts(1000);
    expect(lastUpdateSource({ lastImportAt: null, lastManualEditAt: at })).toBe("手動編集");
  });

  it("両方あれば新しい方を採用する（Excelが後なら再度Excel）", () => {
    const importAt = ts(2000);
    const manualAt = ts(1000);
    expect(lastUpdateSource({ lastImportAt: importAt, lastManualEditAt: manualAt })).toBe("Excel");
    expect(lastUpdateAt({ lastImportAt: importAt, lastManualEditAt: manualAt })).toBe(importAt);
  });

  it("両方あれば新しい方を採用する（手動編集が後なら手動編集）", () => {
    const importAt = ts(1000);
    const manualAt = ts(2000);
    expect(lastUpdateSource({ lastImportAt: importAt, lastManualEditAt: manualAt })).toBe("手動編集");
    expect(lastUpdateAt({ lastImportAt: importAt, lastManualEditAt: manualAt })).toBe(manualAt);
  });
});
