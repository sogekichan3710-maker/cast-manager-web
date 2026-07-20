import { describe, expect, it } from "vitest";
import { normalizeMonth } from "@/types/domain";
import { parseLegacyData } from "@/lib/migration/parseLegacyData";
import {
  convertLegacyData,
  mapMotiLevel,
} from "@/lib/migration/convertLegacyData";
import { validateLegacyData } from "@/lib/migration/validateLegacyData";
import { buildTasks, planMigrationWrites } from "@/services/migrationService";
import type { LegacyData } from "@/lib/migration/legacyTypes";

const STORES = [{ id: "virgo", name: "VIRGO", code: "virgo", color: "#9c27b0", order: 0, active: true }];

function baseLegacy(partial: Partial<LegacyData>): LegacyData {
  return {
    sourceFormat: "cm2_v4",
    casts: [],
    monthlyResults: [],
    interviews: [],
    castRecords: [],
    goals: [],
    motivationLogs: [],
    wageHistory: [],
    importBatches: [],
    stores: STORES,
    nameMatchingRules: [],
    ...partial,
  };
}

const CAST = {
  id: "cast1",
  storeId: "virgo",
  stageName: "あいり",
  realName: "山田愛",
  kana: "あいり",
  hourlyWage: 5000,
  status: "在籍",
};

// ---------------- 月変換（既存 normalizeMonth の互換確認） ----------------
describe("month変換", () => {
  it("「2026年7月」→ 2026-07", () => {
    expect(normalizeMonth("2026年7月")).toBe("2026-07");
  });
  it("「2026年12月」→ 2026-12", () => {
    expect(normalizeMonth("2026年12月")).toBe("2026-12");
  });
  it("2026-7 / 2026/09 / 2026-07 を受け付ける", () => {
    expect(normalizeMonth("2026-7")).toBe("2026-07");
    expect(normalizeMonth("2026/09")).toBe("2026-09");
    expect(normalizeMonth("2026-07")).toBe("2026-07");
  });
  it("変換できない形式は null", () => {
    expect(normalizeMonth("7月")).toBeNull();
    expect(normalizeMonth("")).toBeNull();
    expect(normalizeMonth("invalid")).toBeNull();
  });
});

// ---------------- 旧JSONのパース ----------------
describe("parseLegacyData（旧JSONのパース）", () => {
  it("exportFullJSON形式（トップレベルにコレクション）を読める", () => {
    const json = JSON.stringify({ format: "cm2_v4", casts: [CAST], stores: STORES });
    const parsed = parseLegacyData(json);
    expect(parsed.sourceFormat).toBe("cm2_v4");
    expect(parsed.casts).toHaveLength(1);
    expect(parsed.casts[0].id).toBe("cast1");
  });

  it("localStorageダンプ形式（cm2_v4キーにJSON文字列）を読める", () => {
    const inner = JSON.stringify({ casts: [CAST], stores: STORES });
    const parsed = parseLegacyData(JSON.stringify({ cm2_v4: inner }));
    expect(parsed.sourceFormat).toBe("cm2_v4");
    expect(parsed.casts).toHaveLength(1);
  });

  it("id をキーにしたオブジェクト形式のコレクションを配列へ正規化する", () => {
    const json = JSON.stringify({
      casts: { cast1: { storeId: "virgo", stageName: "あいり" } },
      stores: STORES,
    });
    const parsed = parseLegacyData(json);
    expect(parsed.casts).toHaveLength(1);
    expect(parsed.casts[0].id).toBe("cast1");
  });

  it("data配下にネストされた形式を読める", () => {
    const json = JSON.stringify({ version: "cm2_v4", data: { casts: [CAST], stores: STORES } });
    const parsed = parseLegacyData(json);
    expect(parsed.casts).toHaveLength(1);
  });

  it("壊れたJSONはエラー", () => {
    expect(() => parseLegacyData("{not json")).toThrow();
  });

  it("コレクションが1つも無いJSONはエラー", () => {
    expect(() => parseLegacyData(JSON.stringify({ foo: 1 }))).toThrow();
  });
});

// ---------------- 変換 ----------------
describe("convertLegacyData（旧→新変換）", () => {
  it("キャスト: 旧IDを保持し、フィールドをマッピングする", () => {
    const conv = convertLegacyData(
      baseLegacy({
        casts: [{ ...CAST, wage: undefined, memo: null, targetSales: "1,000,000" }],
      }),
      []
    );
    expect(conv.casts).toHaveLength(1);
    expect(conv.casts[0].id).toBe("cast1");
    expect(conv.casts[0].data.stageName).toBe("あいり");
    expect(conv.casts[0].data.hourlyWage).toBe(5000);
    expect(conv.casts[0].data.memo).toBe(""); // null → ""
    expect(conv.casts[0].data.targetSales).toBe(1000000); // "1,000,000" → 数値
  });

  it("storeIdが存在しないキャストは除外し unknownStore に報告（別店舗へ統合しない）", () => {
    const conv = convertLegacyData(
      baseLegacy({ casts: [{ ...CAST, id: "c2", storeId: "unknown-store" }] }),
      []
    );
    expect(conv.casts).toHaveLength(0);
    expect(conv.unknownStore).toHaveLength(1);
  });

  it("storeId='__all__' の店舗はFirestoreへ保存しない", () => {
    const conv = convertLegacyData(
      baseLegacy({ stores: [...STORES, { id: "__all__", name: "全店舗" }] }),
      []
    );
    expect(conv.stores.map((s) => s.id)).toEqual(["virgo"]);
    expect(conv.invalid.some((i) => i.collection === "stores")).toBe(true);
  });

  it("monthlyResults: IDを storeId_castId_YYYY-MM へ統一し、旧month「2026年7月」を変換する", () => {
    const conv = convertLegacyData(
      baseLegacy({
        casts: [CAST],
        monthlyResults: [
          { id: "mr1", castId: "cast1", month: "2026年7月", totalSales: 1234567, payment: 500000 },
        ],
      }),
      []
    );
    expect(conv.monthlyResults).toHaveLength(1);
    expect(conv.monthlyResults[0].id).toBe("virgo_cast1_2026-07");
    expect(conv.monthlyResults[0].data.month).toBe("2026-07");
    expect(conv.monthlyResults[0].data.totalSales).toBe(1234567);
    expect(conv.idMap.some((m) => m.legacyId === "mr1" && m.newId === "virgo_cast1_2026-07")).toBe(true);
  });

  it("monthlyResults: 同一キーの重複は後勝ちで1件になり duplicates に報告", () => {
    const conv = convertLegacyData(
      baseLegacy({
        casts: [CAST],
        monthlyResults: [
          { id: "mr1", castId: "cast1", month: "2026年7月", totalSales: 100 },
          { id: "mr2", castId: "cast1", month: "2026-07", totalSales: 200 },
        ],
      }),
      []
    );
    expect(conv.monthlyResults).toHaveLength(1);
    expect(conv.monthlyResults[0].data.totalSales).toBe(200);
    expect(conv.duplicates).toHaveLength(1);
  });

  it("monthlyResults: 参照先キャスト不在は orphans、変換不能な月は badMonth", () => {
    const conv = convertLegacyData(
      baseLegacy({
        casts: [CAST],
        monthlyResults: [
          { id: "mr1", castId: "ghost", month: "2026-07" },
          { id: "mr2", castId: "cast1", month: "不明" },
        ],
      }),
      []
    );
    expect(conv.monthlyResults).toHaveLength(0);
    expect(conv.orphans).toHaveLength(1);
    expect(conv.badMonth).toHaveLength(1);
  });

  it("castRecords（統合記録）は interviews / goals / motivations へ分離される", () => {
    const conv = convertLegacyData(
      baseLegacy({
        casts: [CAST],
        castRecords: [
          {
            id: "rec1",
            castId: "cast1",
            date: "2026-07-01",
            interviewer: "店長",
            content: "定期面談",
            goalMonth: "2026年7月",
            salesTarget: 1000000,
            goalStatus: "進行中",
            motiLevel: "2:低い",
            motiState: "疲れ気味",
          },
        ],
      }),
      []
    );
    expect(conv.interviews).toHaveLength(1);
    expect(conv.interviews[0].id).toBe("rec1");
    expect(conv.interviews[0].data.content).toBe("定期面談");
    expect(conv.goals).toHaveLength(1);
    expect(conv.goals[0].id).toBe("rec1_goal");
    expect(conv.goals[0].data.month).toBe("2026-07");
    expect(conv.goals[0].data.salesTarget).toBe(1000000);
    expect(conv.motivations).toHaveLength(1);
    expect(conv.motivations[0].id).toBe("rec1_moti");
    expect(conv.motivations[0].data.level).toBe("2:低い");
    expect(conv.motivations[0].data.state).toBe("疲れ気味");
  });

  it("旧goalsのフィールド名（sales/honshimei等）を新形式へマッピングする", () => {
    const conv = convertLegacyData(
      baseLegacy({
        casts: [CAST],
        goals: [
          {
            id: "g1",
            castId: "cast1",
            month: "2026年8月",
            sales: 800000,
            honshimei: 10,
            douhan: 3,
            workDays: 18,
            status: "未達成",
          },
        ],
      }),
      []
    );
    expect(conv.goals).toHaveLength(1);
    const g = conv.goals[0].data;
    expect(g.month).toBe("2026-08");
    expect(g.salesTarget).toBe(800000);
    expect(g.honshimeiTarget).toBe(10);
    expect(g.douhanTarget).toBe(3);
    expect(g.workDaysTarget).toBe(18);
    expect(g.status).toBe("未達成");
  });

  it("motivationLogsのレベル値（数値・ラベル）を新5段階へマッピングする", () => {
    expect(mapMotiLevel(5)).toBe("5:非常に高い");
    expect(mapMotiLevel("3")).toBe("3:普通");
    expect(mapMotiLevel("2:低い")).toBe("2:低い");
    expect(mapMotiLevel("低い")).toBe("2:低い");
    expect(mapMotiLevel("非常に低い")).toBe("1:非常に低い");
    expect(mapMotiLevel("")).toBeNull();
    expect(mapMotiLevel("謎の値")).toBeNull();

    const conv = convertLegacyData(
      baseLegacy({
        casts: [CAST],
        motivationLogs: [
          { id: "m1", castId: "cast1", date: "2026-07-01", level: 4, state: "好調" },
          { id: "m2", castId: "cast1", date: "2026-07-02", level: "謎" },
        ],
      }),
      []
    );
    expect(conv.motivations).toHaveLength(1);
    expect(conv.motivations[0].data.level).toBe("4:高い");
    expect(conv.invalid.some((i) => i.collection === "motivationLogs")).toBe(true);
  });

  it("wageHistory: oldWage/newWage を現在の型へ合わせ、適用月を変換する", () => {
    const conv = convertLegacyData(
      baseLegacy({
        casts: [CAST],
        wageHistory: [
          { id: "w1", castId: "cast1", oldWage: 4500, newWage: 5000, effectiveMonth: "2026年6月", reason: "昇給" },
        ],
      }),
      []
    );
    expect(conv.wageHistory).toHaveLength(1);
    const w = conv.wageHistory[0].data;
    expect(w.oldHourlyWage).toBe(4500);
    expect(w.newHourlyWage).toBe(5000);
    expect(w.effectiveMonth).toBe("2026-06");
    expect(w.source).toBe("migration");
  });

  it("nameMatchingRules: IDを storeId__正規化名 に統一し decision をマッピングする", () => {
    const conv = convertLegacyData(
      baseLegacy({
        casts: [CAST],
        nameMatchingRules: [
          { id: "r1", storeId: "virgo", name: "アイリ", decision: "existing", castId: "cast1", wage: 5000 },
        ],
      }),
      []
    );
    expect(conv.nameMatchingRules).toHaveLength(1);
    const r = conv.nameMatchingRules[0];
    expect(r.id).toBe("virgo__アイリ".normalize("NFKC").toLowerCase().replace(/\s+/g, ""));
    expect(r.data.decision).toBe("link");
    expect(r.data.linkedCastId).toBe("cast1");
    expect(r.data.normalizedName).toBe("アイリ".normalize("NFKC").toLowerCase());
  });

  it("同一店舗の同名キャストは duplicates に報告される（自動統合しない）", () => {
    const conv = convertLegacyData(
      baseLegacy({
        casts: [CAST, { ...CAST, id: "cast2", realName: "別人" }],
      }),
      []
    );
    expect(conv.casts).toHaveLength(2); // 両方移行される（統合しない）
    expect(conv.duplicates.some((d) => d.collection === "casts")).toBe(true);
  });
});

// ---------------- プレビュー集計 ----------------
describe("validateLegacyData（プレビュー）", () => {
  it("件数と詳細が変換結果と一致する", () => {
    const preview = validateLegacyData(
      baseLegacy({
        casts: [CAST],
        monthlyResults: [{ id: "mr1", castId: "cast1", month: "2026年7月", totalSales: 100 }],
        importBatches: [{ id: "b1" }],
      }),
      []
    );
    expect(preview.counts.casts).toBe(1);
    expect(preview.counts.monthlyResults).toBe(1);
    expect(preview.counts.stores).toBe(1);
    expect(preview.rawCounts.importBatches).toBe(1);
    expect(preview.conversion.monthlyResults[0].id).toBe("virgo_cast1_2026-07");
  });
});

// ---------------- 冪等性（同じJSONを2回移行） ----------------
describe("冪等性（planMigrationWrites）", () => {
  function makeConversion() {
    return convertLegacyData(
      baseLegacy({
        casts: [CAST],
        monthlyResults: [{ id: "mr1", castId: "cast1", month: "2026年7月", totalSales: 100 }],
        wageHistory: [{ id: "w1", castId: "cast1", oldWage: 4500, newWage: 5000, effectiveMonth: "2026-06" }],
      }),
      []
    );
  }

  it("同じ入力からは常に同じ決定的IDが生成される", () => {
    const a = buildTasks(makeConversion(), "mig-x");
    const b = buildTasks(makeConversion(), "mig-x");
    expect(a.map((t) => `${t.col}/${t.id}`)).toEqual(b.map((t) => `${t.col}/${t.id}`));
  });

  it("1回目: 全件作成 → 2回目: 全件skipで書き込みゼロ（二重登録されない）", () => {
    const tasks = buildTasks(makeConversion(), "mig-x");

    // 1回目: 既存なし → 全件書き込み
    const first = planMigrationWrites(tasks, new Set());
    expect(first.toWrite).toHaveLength(tasks.length);
    expect(first.skipped).toBe(0);

    // 1回目の書き込み結果を「既存」として2回目を実行
    const written = new Set(first.toWrite.map((t) => `${t.col}/${t.id}`));
    const second = planMigrationWrites(buildTasks(makeConversion(), "mig-y"), written);
    expect(second.toWrite).toHaveLength(0);
    expect(second.skipped).toBe(tasks.length);
  });

  it("途中失敗の再実行: 書き込み済み分だけskipされ、残りだけ書き込まれる", () => {
    const tasks = buildTasks(makeConversion(), "mig-x");
    const half = new Set(tasks.slice(0, 2).map((t) => `${t.col}/${t.id}`));
    const plan = planMigrationWrites(tasks, half);
    expect(plan.skipped).toBe(2);
    expect(plan.toWrite).toHaveLength(tasks.length - 2);
  });

  it("monthlyResultsの重複防止: 同一店舗・キャスト・月は既存skipになる", () => {
    const tasks = buildTasks(makeConversion(), "mig-x").filter((t) => t.col === "monthlyResults");
    expect(tasks).toHaveLength(1);
    const plan = planMigrationWrites(tasks, new Set(["monthlyResults/virgo_cast1_2026-07"]));
    expect(plan.toWrite).toHaveLength(0);
    expect(plan.byCollection.monthlyResults.skipped).toBe(1);
  });
});

// ---------------- バックアップJSONの再読込 ----------------
describe("バックアップJSON再読込", () => {
  it("cmweb-backup_v1 形式を移行ウィザードで読み込める", () => {
    const backup = {
      formatVersion: "cmweb-backup_v1",
      exportedAt: "2026-07-18T00:00:00.000Z",
      exportedBy: "uid-owner",
      counts: { casts: 1 },
      collections: {
        stores: [{ id: "virgo", name: "VIRGO", code: "virgo", color: "#9c27b0", order: 0, active: true, createdAt: "2026-01-01T00:00:00.000Z" }],
        casts: [{ ...CAST, createdAt: "2026-01-01T00:00:00.000Z" }],
        monthlyResults: [
          { id: "virgo_cast1_2026-07", castId: "cast1", storeId: "virgo", month: "2026-07", totalSales: 100, payment: 50 },
        ],
      },
    };
    const parsed = parseLegacyData(JSON.stringify(backup));
    expect(parsed.sourceFormat).toBe("cmweb-backup_v1");
    const conv = convertLegacyData(parsed, []);
    expect(conv.casts).toHaveLength(1);
    expect(conv.monthlyResults).toHaveLength(1);
    // IDが既に新形式なら維持される
    expect(conv.monthlyResults[0].id).toBe("virgo_cast1_2026-07");
    expect(conv.idMap.filter((m) => m.collection === "monthlyResults")).toHaveLength(0);
  });
});
