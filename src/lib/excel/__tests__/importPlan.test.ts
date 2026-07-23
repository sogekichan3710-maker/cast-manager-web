import { describe, expect, it } from "vitest";
import type { Timestamp } from "firebase/firestore";
import { matchExcelRows, type MatchableCast } from "@/lib/excel/importMatching";
import {
  buildInitialRowStates,
  canExecutePlan,
  summarizePlan,
} from "@/lib/excel/importPlan";
import type { ExcelMonthlyRow } from "@/lib/excel/parseMonthlyExcel";
import type { NameMatchingRuleWithId } from "@/types";

function row(name: string, rowNumber = 2, hourlyWage: number | null = 5000): ExcelMonthlyRow {
  return {
    rowNumber,
    name,
    hourlyWage,
    scoutedBy: "",
    totalSales: 1000000,
    payment: 500000,
    honshimeiCount: 5,
    honshimeiGroupCount: 3,
    customerCount: 10,
    jounaiCount: 2,
    douhan: 1,
    workDays: 15,
    workHours: 70,
    absent: 0,
    notes: "",
  };
}

function cast(partial: Partial<MatchableCast>): MatchableCast {
  return {
    id: "c1",
    storeId: "virgo",
    stageName: "あいり",
    realName: "",
    kana: "",
    hourlyWage: 5000,
    status: "在籍",
    archived: false,
    scoutedBy: "",
    ...partial,
  };
}

function linkRule(name: string, castId: string, wage: number): NameMatchingRuleWithId {
  return {
    id: `virgo__${name}`,
    storeId: "virgo",
    sourceName: name,
    normalizedName: name,
    decision: "link",
    linkedCastId: castId,
    hourlyWage: wage,
    active: true,
    createdAt: null as unknown as Timestamp,
    createdBy: "u1",
    updatedAt: null as unknown as Timestamp,
    updatedBy: "u1",
  };
}

describe("buildInitialRowStates（初期状態）", () => {
  it("完全一致なしの行は新規として自動確定される（未選択にならない）", () => {
    const { matches } = matchExcelRows([row("ももか")], "virgo", [], []);
    const states = buildInitialRowStates(matches, new Set());
    expect(matches[0].needsConfirm).toBe(false);
    expect(states[0].action).toBe("new");
    expect(states[0].autoConfirmed).toBe(true);
  });

  it("同名複数・時給変更候補・在籍状態確認も未選択で開始する", () => {
    const rows = [row("あいり", 2), row("れいな", 3, 6000), row("ももか", 4)];
    const casts = [
      cast({ id: "c1", stageName: "あいり" }),
      cast({ id: "c2", stageName: "あいり", realName: "別人" }), // 同名複数
      cast({ id: "c3", stageName: "れいな", hourlyWage: 5500 }), // 時給差 → 時給変更候補
      cast({ id: "c4", stageName: "ももか", status: "退店" }), // 在籍状態確認
    ];
    const { matches } = matchExcelRows(rows, "virgo", casts, []);
    const states = buildInitialRowStates(matches, new Set());
    expect(states.every((s) => s.action === null)).toBe(true);
    expect(canExecutePlan(states)).toBe(false);
  });

  it("自動確定できる行（完全一致・時給同一・在籍・ルール適用）は提案が初期選択される", () => {
    const { matches } = matchExcelRows([row("あいり")], "virgo", [cast({})], []);
    const states = buildInitialRowStates(matches, new Set());
    expect(states[0].action).toBe("link");
    expect(canExecutePlan(states)).toBe(true);
  });

  it("既存成績がある行の初期状態はスキップ（上書きは明示選択のみ）", () => {
    const { matches } = matchExcelRows([row("あいり")], "virgo", [cast({})], []);
    const states = buildInitialRowStates(matches, new Set(["c1"]));
    expect(states[0].existing).toBe("skip");
  });
});

describe("summarizePlan / canExecutePlan（最終確認画面）", () => {
  it("新規・紐付け・時給変更・除外・未選択を集計する", () => {
    const rows = [row("A", 2), row("B", 3), row("C", 4), row("D", 5), row("E", 6)];
    const { matches } = matchExcelRows(rows, "virgo", [], []);
    const states = buildInitialRowStates(matches, new Set());
    // 完全一致なし → 全行が新規として自動確定（そのまま実行可能）
    expect(summarizePlan(states).newCasts).toBe(5);
    expect(summarizePlan(states).unresolved).toBe(0);
    expect(canExecutePlan(states)).toBe(true);

    // 手動で変更した場合の集計
    states[0] = { ...states[0], action: "exclude" };
    states[1] = { ...states[1], action: "link", castId: "cx" };
    states[2] = { ...states[2], action: null }; // 手動で未選択へ戻す
    const s = summarizePlan(states);
    expect(s.newCasts).toBe(2);
    expect(s.excluded).toBe(1);
    expect(s.links).toBe(1);
    expect(s.unresolved).toBe(1);
    expect(canExecutePlan(states)).toBe(false); // 未選択が残れば実行不可

    states[2] = { ...states[2], action: "exclude" };
    expect(canExecutePlan(states)).toBe(true);
    expect(summarizePlan(states).unresolved).toBe(0);
  });
});

describe("2回連続インポートの冪等性", () => {
  const excelRows = [row("あいり", 4), row("ももか", 5, 4500)];

  it("1回目: 完全一致なし→自動新規 → 2回目: 完全一致で自動紐付け+既存スキップになり重複しない", () => {
    // ---- 1回目: キャストなし・ルールなし → 全行自動で新規 ----
    const first = matchExcelRows(excelRows, "virgo", [], []);
    const firstStates = buildInitialRowStates(first.matches, new Set());
    expect(firstStates.every((s) => s.action === "new")).toBe(true);
    expect(canExecutePlan(firstStates)).toBe(true); // 操作なしで実行可能
    expect(summarizePlan(firstStates).newCasts).toBe(2);

    // ---- 実行後の状態を再現 ----
    // executeExcelImport は「新規登録」を作成キャストへの link ルールとして保存する
    const createdCasts = [
      cast({ id: "new1", stageName: "あいり", hourlyWage: 5000 }),
      cast({ id: "new2", stageName: "ももか", hourlyWage: 4500 }),
    ];
    const savedRules = [
      linkRule("あいり", "new1", 5000),
      linkRule("ももか", "new2", 4500),
    ];
    // 月別成績 {storeId}_{castId}_{YYYY-MM} が作成済み → existingCastIds に反映
    const existingCastIds = new Set(["new1", "new2"]);

    // ---- 2回目: 同じExcelを再インポート ----
    const second = matchExcelRows(excelRows, "virgo", createdCasts, savedRules);
    const secondStates = buildInitialRowStates(second.matches, existingCastIds);

    // ルールで自動紐付けされ、新規登録は提案されない
    expect(second.matches.every((m) => m.ruleApplied)).toBe(true);
    expect(secondStates.every((s) => s.action === "link")).toBe(true);
    // 既存成績はスキップが初期値 → そのまま実行しても二重登録されない
    expect(secondStates.every((s) => s.existing === "skip")).toBe(true);
    const s = summarizePlan(secondStates);
    expect(s.newCasts).toBe(0);
    expect(s.overwrite).toBe(0);
    expect(s.skipExisting).toBe(2);
    expect(canExecutePlan(secondStates)).toBe(true);
  });

  it("「新規登録」ルールが残っていても、同名キャストが既に存在すれば自動で新規登録しない", () => {
    const staleNewRule: NameMatchingRuleWithId = {
      ...linkRule("あいり", "", 5000),
      decision: "new",
      linkedCastId: null,
    };
    const { matches } = matchExcelRows(
      [row("あいり", 4)],
      "virgo",
      [cast({ id: "new1", stageName: "あいり" })],
      [staleNewRule]
    );
    expect(matches[0].ruleReconfirmReasons.length).toBeGreaterThan(0);
    expect(matches[0].needsConfirm).toBe(true);
    const states = buildInitialRowStates(matches, new Set());
    expect(states[0].action).toBeNull(); // 未選択（勝手に重複登録しない）
  });
});
