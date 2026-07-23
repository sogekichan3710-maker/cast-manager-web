import { describe, expect, it } from "vitest";
import type { Timestamp } from "firebase/firestore";
import {
  matchExcelRows,
  buildRuleFromDecision,
  WAGE_GAP_RECONFIRM,
  type MatchableCast,
} from "@/lib/excel/importMatching";
import type { ExcelMonthlyRow } from "@/lib/excel/parseMonthlyExcel";
import type { NameMatchingRuleWithId } from "@/types";

function row(name: string, hourlyWage: number | null = null): ExcelMonthlyRow {
  return {
    rowNumber: 2,
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

function rule(partial: Partial<NameMatchingRuleWithId>): NameMatchingRuleWithId {
  return {
    id: "virgo__あいり",
    storeId: "virgo",
    sourceName: "あいり",
    normalizedName: "あいり",
    decision: "link",
    linkedCastId: "c1",
    hourlyWage: 5000,
    active: true,
    createdAt: null as unknown as Timestamp,
    createdBy: "u1",
    updatedAt: null as unknown as Timestamp,
    updatedBy: "u1",
    ...partial,
  };
}

describe("matchExcelRows: 基本照合", () => {
  it("完全一致1件・時給同一・在籍 → link提案・確認不要", () => {
    const { matches } = matchExcelRows([row("あいり", 5000)], "virgo", [cast({})], []);
    expect(matches[0].suggestedAction).toBe("link");
    expect(matches[0].suggestedCastId).toBe("c1");
    expect(matches[0].needsConfirm).toBe(false);
    expect(matches[0].candidates).toHaveLength(1);
  });

  it("全角半角・空白の揺れ（NFKC正規化）でも一致する", () => {
    const { matches } = matchExcelRows(
      [row("アイリ")],
      "virgo",
      [cast({ stageName: "ｱｲﾘ" })],
      []
    );
    expect(matches[0].suggestedCastId).toBe("c1");
  });

  it("候補なし → 新規登録を提案", () => {
    const { matches } = matchExcelRows([row("ももか")], "virgo", [cast({})], []);
    expect(matches[0].suggestedAction).toBe("new");
    expect(matches[0].candidates).toHaveLength(0);
  });

  it("候補のscoutedByは照合判定に影響せず、表示用にそのまま保持される（PR10）", () => {
    const { matches } = matchExcelRows(
      [row("あいり", 5000)],
      "virgo",
      [cast({ scoutedBy: "田中" })],
      []
    );
    expect(matches[0].suggestedAction).toBe("link");
    expect(matches[0].candidates[0].cast.scoutedBy).toBe("田中");
  });
});

describe("確認フロー1: 時給変更候補", () => {
  it("Excel時給が現在時給と異なる → wage-change候補・要確認", () => {
    const { matches } = matchExcelRows([row("あいり", 5500)], "virgo", [cast({})], []);
    const m = matches[0];
    expect(m.suggestedAction).toBe("wage-change");
    expect(m.wageChange).toEqual({ castId: "c1", oldWage: 5000, newWage: 5500 });
    expect(m.needsConfirm).toBe(true);
  });

  it("時給列が無い（null）場合は時給変更候補にしない", () => {
    const { matches } = matchExcelRows([row("あいり", null)], "virgo", [cast({})], []);
    expect(matches[0].suggestedAction).toBe("link");
    expect(matches[0].wageChange).toBeNull();
  });
});

describe("確認フロー2: 同名キャスト候補", () => {
  it("同名（完全一致）が複数 → 自動統合せず要確認", () => {
    const { matches } = matchExcelRows(
      [row("あいり", 5000)],
      "virgo",
      [cast({ id: "c1" }), cast({ id: "c2", realName: "別人" })],
      []
    );
    const m = matches[0];
    expect(m.sameNameConfirm).toBe(true);
    expect(m.needsConfirm).toBe(true);
    expect(m.suggestedCastId).toBeNull();
    expect(m.candidates).toHaveLength(2);
  });

  it("部分一致・本名一致・ふりがな一致・他店舗同名は候補にしない（別人として新規扱い）", () => {
    // 「れい」「れいな」「みれい」は別人。類似判定は内部でも行わない
    const { matches } = matchExcelRows(
      [row("れい")],
      "virgo",
      [
        cast({ id: "c1", stageName: "れいな" }), // 部分一致 → 別人
        cast({ id: "c2", stageName: "みれい" }), // 部分一致 → 別人
        cast({ id: "c3", stageName: "ももか", realName: "れい" }), // 本名一致 → 候補にしない
        cast({ id: "c4", stageName: "あい", kana: "れい" }), // ふりがな一致 → 候補にしない
        cast({ id: "c5", stageName: "れい", storeId: "regina" }), // 他店舗同名 → 候補にしない
      ],
      []
    );
    const m = matches[0];
    expect(m.candidates).toHaveLength(0);
    expect(m.suggestedAction).toBe("new");
    expect(m.needsConfirm).toBe(false); // 完全一致なし → 新規として自動確定
    expect(m.sameNameConfirm).toBe(false);
  });
});

describe("確認フロー3: 退店・在籍状態の確認", () => {
  it("退店キャストがExcelに出現 → statusConfirm・要確認", () => {
    const { matches } = matchExcelRows(
      [row("あいり", 5000)],
      "virgo",
      [cast({ status: "退店" })],
      []
    );
    expect(matches[0].statusConfirm).toContain("退店");
    expect(matches[0].needsConfirm).toBe(true);
  });

  it("在籍だがExcelに存在しないキャスト → missingCasts（退店確認候補）", () => {
    const { missingCasts } = matchExcelRows(
      [row("あいり", 5000)],
      "virgo",
      [cast({ id: "c1" }), cast({ id: "c9", stageName: "ももか" })],
      []
    );
    expect(missingCasts.map((c) => c.id)).toEqual(["c9"]);
  });

  it("退店・アーカイブ済みキャストは missingCasts に含めない", () => {
    const { missingCasts } = matchExcelRows(
      [],
      "virgo",
      [
        cast({ id: "c1", status: "退店" }),
        cast({ id: "c2", stageName: "ももか", archived: true }),
      ],
      []
    );
    expect(missingCasts).toHaveLength(0);
  });
});

describe("nameMatchingRules の適用", () => {
  it("有効なlinkルール → 自動確定（確認不要）", () => {
    const { matches } = matchExcelRows([row("あいり", 5000)], "virgo", [cast({})], [rule({})]);
    const m = matches[0];
    expect(m.ruleApplied).toBe(true);
    expect(m.ruleReconfirmReasons).toHaveLength(0);
    expect(m.suggestedAction).toBe("link");
    expect(m.needsConfirm).toBe(false);
  });

  it("excludeルール → 除外を自動提案", () => {
    const { matches } = matchExcelRows(
      [row("あいり", 5000)],
      "virgo",
      [cast({})],
      [rule({ decision: "exclude", linkedCastId: null })]
    );
    expect(matches[0].suggestedAction).toBe("exclude");
    expect(matches[0].needsConfirm).toBe(false);
  });

  it("ルールのリンク先キャストが存在しない → 自動確定せず再確認", () => {
    const { matches } = matchExcelRows(
      [row("あいり", 5000)],
      "virgo",
      [cast({})],
      [rule({ linkedCastId: "ghost" })]
    );
    const m = matches[0];
    expect(m.ruleReconfirmReasons.length).toBeGreaterThan(0);
    expect(m.needsConfirm).toBe(true);
  });

  it("ルールのリンク先が他店舗 → 再確認", () => {
    const { matches } = matchExcelRows(
      [row("あいり", 5000)],
      "virgo",
      [cast({ id: "c9", storeId: "regina" }), cast({ id: "c1" })],
      [rule({ linkedCastId: "c9" })]
    );
    expect(matches[0].ruleReconfirmReasons.some((r) => r.includes("店舗"))).toBe(true);
    expect(matches[0].needsConfirm).toBe(true);
  });

  it("ルールのリンク先がアーカイブ済み → 再確認", () => {
    const { matches } = matchExcelRows(
      [row("あいり", 5000)],
      "virgo",
      [cast({ archived: true })],
      [rule({})]
    );
    expect(matches[0].ruleReconfirmReasons.some((r) => r.includes("アーカイブ"))).toBe(true);
  });

  it(`大幅な時給差（${WAGE_GAP_RECONFIRM}円以上）→ 再確認`, () => {
    const { matches } = matchExcelRows(
      [row("あいり", 5000 + WAGE_GAP_RECONFIRM)],
      "virgo",
      [cast({})],
      [rule({})]
    );
    expect(matches[0].ruleReconfirmReasons.some((r) => r.includes("時給差"))).toBe(true);
    expect(matches[0].needsConfirm).toBe(true);
  });

  it("同名候補が複数存在してもルールが対象キャストを一意に特定していれば自動採用する（再確認しない）", () => {
    const { matches } = matchExcelRows(
      [row("あいり", 5000)],
      "virgo",
      [cast({ id: "c1" }), cast({ id: "c2" })],
      [rule({ linkedCastId: "c1" })]
    );
    const m = matches[0];
    expect(m.ruleReconfirmReasons).toEqual([]);
    expect(m.needsConfirm).toBe(false);
    expect(m.suggestedAction).toBe("link");
    expect(m.suggestedCastId).toBe("c1");
  });

  it("ルール適用時は時給が異なっても再確認せず自動採用する（時給自体は変更しない）", () => {
    const { matches } = matchExcelRows(
      [row("あいり", 5200)], // 差200円 < 再確認閾値
      "virgo",
      [cast({})],
      [rule({})]
    );
    const m = matches[0];
    expect(m.suggestedAction).toBe("link");
    expect(m.wageChange).toBeNull();
    expect(m.needsConfirm).toBe(false);
  });

  it("ルールのリンク先キャストが退店・休職の場合は再確認する", () => {
    const { matches } = matchExcelRows(
      [row("あいり", 5000)],
      "virgo",
      [cast({ status: "退店" })],
      [rule({})]
    );
    const m = matches[0];
    expect(m.suggestedAction).toBe("link");
    expect(m.statusConfirm).toContain("退店");
    expect(m.needsConfirm).toBe(true);
  });

  it("非activeルール・他店舗のルールは適用されない", () => {
    const { matches } = matchExcelRows(
      [row("あいり", 5000)],
      "virgo",
      [cast({})],
      [rule({ active: false }), rule({ id: "regina__あいり", storeId: "regina" })]
    );
    expect(matches[0].ruleApplied).toBe(false);
  });
});

describe("buildRuleFromDecision（確定内容の保存形）", () => {
  it("wage-change は link として保存し、対象キャストとExcel時給を保持する", () => {
    const r = buildRuleFromDecision("virgo", row("あいり", 5500), "wage-change", "c1");
    expect(r.decision).toBe("link");
    expect(r.linkedCastId).toBe("c1");
    expect(r.hourlyWage).toBe(5500);
    expect(r.normalizedName).toBe("あいり");
  });

  it("new / exclude は linkedCastId を持たない", () => {
    expect(buildRuleFromDecision("virgo", row("ももか"), "new", null).decision).toBe("new");
    expect(buildRuleFromDecision("virgo", row("ももか"), "exclude", "c1").linkedCastId).toBeNull();
  });
});
