import { describe, expect, it } from "vitest";
import { buildScoutedByPlan, type ScoutedByTargetCast } from "@/lib/excel/scoutedByBulkPlan";
import type { ExcelMonthlyRow } from "@/lib/excel/parseMonthlyExcel";

function row(partial: Partial<ExcelMonthlyRow>): ExcelMonthlyRow {
  return {
    rowNumber: 1,
    name: "あいり",
    hourlyWage: null,
    scoutedBy: "",
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
    ...partial,
  };
}

function cast(partial: Partial<ScoutedByTargetCast>): ScoutedByTargetCast {
  return {
    id: "c1",
    stageName: "あいり",
    scoutedBy: "",
    archived: false,
    ...partial,
  };
}

describe("buildScoutedByPlan", () => {
  it("Excel側に値があり、既存の値と異なる場合はupdateになる", () => {
    const plan = buildScoutedByPlan(
      [row({ name: "あいり", scoutedBy: "田中" })],
      [cast({ id: "c1", stageName: "あいり", scoutedBy: "" })]
    );
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ action: "update", castId: "c1", excelScoutedBy: "田中" });
  });

  it("Excel側が空欄の場合はskip-no-value（既存値は変更しない）", () => {
    const plan = buildScoutedByPlan(
      [row({ name: "あいり", scoutedBy: "" })],
      [cast({ id: "c1", stageName: "あいり", scoutedBy: "既存担当" })]
    );
    expect(plan[0].action).toBe("skip-no-value");
    expect(plan[0].castId).toBeNull();
  });

  it("既に同じ値の場合はskip-same", () => {
    const plan = buildScoutedByPlan(
      [row({ name: "あいり", scoutedBy: "田中" })],
      [cast({ id: "c1", stageName: "あいり", scoutedBy: "田中" })]
    );
    expect(plan[0].action).toBe("skip-same");
  });

  it("店舗内に一致するキャストがいない場合はskip-no-match", () => {
    const plan = buildScoutedByPlan(
      [row({ name: "存在しない名前", scoutedBy: "田中" })],
      [cast({ id: "c1", stageName: "あいり", scoutedBy: "" })]
    );
    expect(plan[0].action).toBe("skip-no-match");
    expect(plan[0].castId).toBeNull();
  });

  it("同名キャストが複数存在する場合は自動判定せずskip-multiple-match", () => {
    const plan = buildScoutedByPlan(
      [row({ name: "あいり", scoutedBy: "田中" })],
      [
        cast({ id: "c1", stageName: "あいり", scoutedBy: "" }),
        cast({ id: "c2", stageName: "あいり", scoutedBy: "" }),
      ]
    );
    expect(plan[0].action).toBe("skip-multiple-match");
    expect(plan[0].castId).toBeNull();
  });

  it("アーカイブ済みキャストは照合対象にしない", () => {
    const plan = buildScoutedByPlan(
      [row({ name: "あいり", scoutedBy: "田中" })],
      [cast({ id: "c1", stageName: "あいり", scoutedBy: "", archived: true })]
    );
    expect(plan[0].action).toBe("skip-no-match");
  });

  it("全角半角・空白の揺れ（NFKC正規化）でも一致する", () => {
    const plan = buildScoutedByPlan(
      [row({ name: "アイリ", scoutedBy: "田中" })],
      [cast({ id: "c1", stageName: "ｱｲﾘ", scoutedBy: "" })]
    );
    expect(plan[0].action).toBe("update");
    expect(plan[0].castId).toBe("c1");
  });

  it("新規キャスト作成やmonthlyResultsには一切関与しない（castId未一致行の情報のみ返す）", () => {
    const plan = buildScoutedByPlan(
      [row({ name: "新規キャスト", scoutedBy: "田中" })],
      []
    );
    expect(plan[0].action).toBe("skip-no-match");
    // 戻り値にmonthlyResultsやhourlyWage等の業務フィールドへの言及が無いことを型で保証
    expect(Object.keys(plan[0]).sort()).toEqual(
      ["action", "castId", "currentScoutedBy", "excelScoutedBy", "name", "rowNumber"].sort()
    );
  });
});
