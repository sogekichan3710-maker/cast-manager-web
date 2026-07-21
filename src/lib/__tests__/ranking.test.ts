import { describe, expect, it } from "vitest";
import { Timestamp } from "firebase/firestore";
import { RANK_CATS, buildRanking, isRankingEligible } from "@/lib/ranking";
import { monthPeriodEnd } from "@/types";
import type { CastWithId, MonthlyResultWithId } from "@/types";

const JULY_END = monthPeriodEnd("2026-07")!;

function mr(id: string, castId: string, totalSales: number): MonthlyResultWithId {
  return {
    id,
    castId,
    storeId: "store_a",
    month: "2026-07",
    totalSales,
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
    batchId: null,
    createdAt: null as never,
    createdBy: "",
    updatedAt: null as never,
    updatedBy: "",
  };
}

function activeCast(
  id: string,
  storeId = "store_a",
  rankingEligibleFrom: Timestamp | null = null
): Pick<CastWithId, "id" | "storeId" | "rankingEligibleFrom"> {
  return { id, storeId, rankingEligibleFrom };
}

describe("buildRanking（PR6: 全件表示 / PR7: 在籍キャスト全員を対象に含める）", () => {
  it("20件を超えるデータでも全件返す（従来のTOP15打ち切りを廃止）", () => {
    const casts = Array.from({ length: 25 }, (_, i) => activeCast(`cast_${i}`));
    const results = Array.from({ length: 25 }, (_, i) =>
      mr(`mr_${i}`, `cast_${i}`, 10000 + i)
    );
    const ranked = buildRanking(results, RANK_CATS[0], casts, JULY_END);
    expect(ranked.length).toBe(25);
  });

  it("降順ソート・孤立レコード（対象外キャストの実績）は除去する", () => {
    const casts = [activeCast("cast_a"), activeCast("cast_b")];
    const results = [mr("m1", "cast_a", 5000), mr("m2", "cast_b", 8000), mr("m3", "cast_c", 9000)];
    const ranked = buildRanking(results, RANK_CATS[0], casts, JULY_END);
    expect(ranked.map((r) => r.castId)).toEqual(["cast_b", "cast_a"]);
  });

  it("同一castIdはid降順で1件に重複排除する", () => {
    const casts = [activeCast("cast_a")];
    const results = [mr("m1", "cast_a", 5000), mr("m2", "cast_a", 7000)];
    const ranked = buildRanking(results, RANK_CATS[0], casts, JULY_END);
    expect(ranked.length).toBe(1);
    expect(ranked[0].id).toBe("m2");
  });

  it("実績のある在籍キャストと無い在籍キャストが両方いても全員返す（実績なしは0埋め）", () => {
    const casts = [activeCast("cast_a"), activeCast("cast_b"), activeCast("cast_c")];
    const results = [mr("m1", "cast_a", 5000)];
    const ranked = buildRanking(results, RANK_CATS[0], casts, JULY_END);
    expect(ranked.length).toBe(3);
    const noRecord = ranked.filter((r) => r.castId !== "cast_a");
    expect(noRecord.every((r) => r.totalSales === 0)).toBe(true);
  });

  it("実績なし（0）のキャストは降順ソートの結果として末尾へ並ぶ", () => {
    const casts = [activeCast("cast_a"), activeCast("cast_b"), activeCast("cast_c")];
    const results = [mr("m1", "cast_a", 5000), mr("m2", "cast_b", 9000)];
    const ranked = buildRanking(results, RANK_CATS[0], casts, JULY_END);
    expect(ranked.map((r) => r.castId)).toEqual(["cast_b", "cast_a", "cast_c"]);
    expect(ranked[2].totalSales).toBe(0);
  });

  it("在籍キャストが1人もいなければ空配列を返す", () => {
    const ranked = buildRanking([mr("m1", "cast_a", 5000)], RANK_CATS[0], [], JULY_END);
    expect(ranked).toEqual([]);
  });

  it("実績なしキャストの表示値（fmt）は「¥0」になる", () => {
    const casts = [activeCast("cast_a")];
    const ranked = buildRanking([], RANK_CATS[0], casts, JULY_END);
    expect(ranked.length).toBe(1);
    expect(RANK_CATS[0].fmt(RANK_CATS[0].key(ranked[0]))).toBe("¥0");
  });
});

describe("isRankingEligible（PR8: ランキング対象開始日）", () => {
  it("rankingEligibleFromが未設定（null）なら常に対象", () => {
    expect(isRankingEligible(null, JULY_END)).toBe(true);
  });

  it("rankingEligibleFromが対象期間の終了時刻以前なら対象", () => {
    const from = Timestamp.fromDate(new Date(2024, 11, 15)); // 2024-12-15
    expect(isRankingEligible(from, monthPeriodEnd("2024-12")!)).toBe(true);
    expect(isRankingEligible(from, monthPeriodEnd("2025-01")!)).toBe(true);
  });

  it("rankingEligibleFromが対象期間の終了時刻より後なら対象外", () => {
    const from = Timestamp.fromDate(new Date(2024, 11, 15)); // 2024-12-15
    expect(isRankingEligible(from, monthPeriodEnd("2024-11")!)).toBe(false);
  });

  it("日単位の期間終了でも同じ関数で判定できる（将来の日次ランキング向け設計）", () => {
    const from = Timestamp.fromDate(new Date(2024, 11, 15)); // 2024-12-15
    const endOfDay = (y: number, m: number, d: number) => new Date(y, m - 1, d, 23, 59, 59, 999);
    expect(isRankingEligible(from, endOfDay(2024, 12, 10))).toBe(false);
    expect(isRankingEligible(from, endOfDay(2024, 12, 15))).toBe(true);
    expect(isRankingEligible(from, endOfDay(2024, 12, 20))).toBe(true);
  });
});

describe("buildRanking × rankingEligibleFrom（PR8: 対象期間より前に登録されたキャストは非表示）", () => {
  it("対象月より後に開始したキャストはランキングから除外される（実績0埋めは影響しない）", () => {
    const decFrom = Timestamp.fromDate(new Date(2024, 11, 15)); // 2024-12-15
    const casts = [
      activeCast("cast_early"), // rankingEligibleFrom未設定=常に対象
      activeCast("cast_dec", "store_a", decFrom),
    ];
    const novEnd = monthPeriodEnd("2024-11")!;
    const rankedNov = buildRanking([], RANK_CATS[0], casts, novEnd);
    expect(rankedNov.map((r) => r.castId)).toEqual(["cast_early"]);

    const decEnd = monthPeriodEnd("2024-12")!;
    const rankedDec = buildRanking([], RANK_CATS[0], casts, decEnd);
    expect(rankedDec.map((r) => r.castId).sort()).toEqual(["cast_dec", "cast_early"]);
  });
});
