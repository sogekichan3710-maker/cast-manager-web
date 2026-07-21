import { describe, expect, it } from "vitest";
import type { Timestamp } from "firebase/firestore";
import { diffMonthlyResultFields, fmtDiffValue } from "@/lib/monthlyResultDiff";
import type { ExcelMonthlyRow } from "@/lib/excel/parseMonthlyExcel";
import type { MonthlyResultWithId } from "@/types";

function existing(overrides: Partial<MonthlyResultWithId> = {}): MonthlyResultWithId {
  return {
    id: "virgo_c1_2026-07",
    castId: "c1",
    storeId: "virgo",
    month: "2026-07",
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
    batchId: null,
    createdAt: null as unknown as Timestamp,
    createdBy: "u1",
    updatedAt: null as unknown as Timestamp,
    updatedBy: "u1",
    ...overrides,
  };
}

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

describe("diffMonthlyResultFields（毎日・飛び飛び運用: 変更項目のみ抽出）", () => {
  it("完全に一致する場合は空配列", () => {
    expect(diffMonthlyResultFields(existing(), row())).toEqual([]);
  });

  it("売上・本指名・支給額のみ変更 → その3項目だけを返す", () => {
    const diffs = diffMonthlyResultFields(
      existing(),
      row({ totalSales: 1100000, honshimeiCount: 22, payment: 420000 })
    );
    expect(diffs.map((d) => d.label).sort()).toEqual(["売上", "支給額", "本指名"].sort());
    const sales = diffs.find((d) => d.label === "売上")!;
    expect(sales.before).toBe(1000000);
    expect(sales.after).toBe(1100000);
  });

  it("飛び飛び日付でも累計が増えていれば通常の差分として検出される（欠損扱いしない）", () => {
    // 7/10時点の累計 → 7/18時点の累計（間の7/13は無くても正常）
    const day10 = existing({ totalSales: 500000, workDays: 5 });
    const day18 = row({ totalSales: 1300000, workDays: 12 });
    const diffs = diffMonthlyResultFields(day10, day18);
    expect(diffs.find((d) => d.label === "売上")?.after).toBe(1300000);
    expect(diffs.find((d) => d.label === "出勤日数")?.after).toBe(12);
  });

  it("月末締め後の再インポート（保証等の反映で支給額のみ変わる想定）でも差分検出できる", () => {
    const diffs = diffMonthlyResultFields(existing(), row({ payment: 450000 }));
    expect(diffs).toHaveLength(1);
    expect(diffs[0].label).toBe("支給額");
    expect(diffs[0].after).toBe(450000);
  });

  it("時給列は対象外（月別成績のフィールドではないため）", () => {
    const diffs = diffMonthlyResultFields(existing(), row({ hourlyWage: 9999 }));
    expect(diffs).toEqual([]);
  });
});

describe("fmtDiffValue", () => {
  it("円表示は¥区切り", () => {
    expect(fmtDiffValue(1234567, true)).toBe("¥1,234,567");
  });
  it("非円表示は区切りのみ", () => {
    expect(fmtDiffValue(22, false)).toBe("22");
  });
});
