import { describe, expect, it } from "vitest";
import { RANK_CATS, buildRanking } from "@/lib/ranking";
import type { MonthlyResultWithId } from "@/types";

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

describe("buildRanking（PR6: 全件表示）", () => {
  it("20件を超えるデータでも全件返す（従来のTOP15打ち切りを廃止）", () => {
    const validIds = new Set(Array.from({ length: 25 }, (_, i) => `cast_${i}`));
    const results = Array.from({ length: 25 }, (_, i) =>
      mr(`mr_${i}`, `cast_${i}`, 10000 + i)
    );
    const ranked = buildRanking(results, RANK_CATS[0], validIds);
    expect(ranked.length).toBe(25);
  });

  it("降順ソート・key<=0は除外・孤立レコードは除去（従来仕様の維持）", () => {
    const validIds = new Set(["cast_a", "cast_b"]);
    const results = [mr("m1", "cast_a", 5000), mr("m2", "cast_b", 8000), mr("m3", "cast_c", 9000)];
    const ranked = buildRanking(results, RANK_CATS[0], validIds);
    expect(ranked.map((r) => r.castId)).toEqual(["cast_b", "cast_a"]);
  });

  it("同一castIdはid降順で1件に重複排除する", () => {
    const validIds = new Set(["cast_a"]);
    const results = [mr("m1", "cast_a", 5000), mr("m2", "cast_a", 7000)];
    const ranked = buildRanking(results, RANK_CATS[0], validIds);
    expect(ranked.length).toBe(1);
    expect(ranked[0].id).toBe("m2");
  });
});
