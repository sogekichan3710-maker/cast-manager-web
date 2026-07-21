import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import type { Timestamp } from "firebase/firestore";
import {
  AnalyzeCancelledError,
  analyzeExcelBuffer,
  matchExcelRowsChunked,
} from "@/lib/excel/analyzeExcel";
import { parseMonthlyExcel } from "@/lib/excel/parseMonthlyExcel";
import { matchExcelRows, type MatchableCast } from "@/lib/excel/importMatching";
import {
  ROW_FILTERS,
  buildInitialRowStates,
  bulkClearSelection,
  bulkExcludeRows,
  bulkLinkExactRows,
  bulkNewNoCandidateRows,
  canExecutePlan,
  listBulkNewEligible,
  rowMatchesFilter,
  summarizePlan,
} from "@/lib/excel/importPlan";
import { finalizeCancelledStatus } from "@/services/excelImportService";
import { buildRollbackPreview } from "@/services/importRollbackService";
import type { ExcelMonthlyRow } from "@/lib/excel/parseMonthlyExcel";
import type { ImportBatchWithId, NameMatchingRuleWithId } from "@/types";

// ---------------- fixtures ----------------

function row(name: string, rowNumber = 2, hourlyWage: number | null = 5000): ExcelMonthlyRow {
  return {
    rowNumber,
    name,
    hourlyWage,
    scoutedBy: "",
    totalSales: 1000000,
    payment: 500000,
    honshimeiCount: 5,
    honshimeiGroupCount: 0,
    customerCount: 0,
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
    ...partial,
  };
}

function testWorkbookBuffer(): ArrayBuffer {
  const rows: unknown[][] = [
    ["源氏名", "時給", "総売上", "支給額", "本指名", "場内", "同伴", "出勤日数", "出勤時間"],
    ["あいり", 5000, 1000000, 500000, 5, 2, 1, 15, 70],
    ["ももか", 4500, 800000, 400000, 3, 1, 0, 12, 55],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "給料明細");
  return XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
}

// ---------------- 解析キャンセル ----------------

describe("解析キャンセル（analyzeExcelBuffer）", () => {
  it("キャンセル済みsignalでは解析せず AnalyzeCancelledError", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      analyzeExcelBuffer(testWorkbookBuffer(), { signal: controller.signal })
    ).rejects.toBeInstanceOf(AnalyzeCancelledError);
  });

  it("シート走査の途中でabortすると結果を返さない（解析結果の非反映）", async () => {
    const controller = new AbortController();
    let sawProgress = false;
    await expect(
      analyzeExcelBuffer(testWorkbookBuffer(), {
        signal: controller.signal,
        onProgress: (p) => {
          sawProgress = true;
          if (p.stage === "scan") controller.abort(); // 走査開始と同時にキャンセル要求
        },
      })
    ).rejects.toBeInstanceOf(AnalyzeCancelledError);
    expect(sawProgress).toBe(true);
  });

  it("キャンセル後に同じバッファを再解析できる（同一ファイル再読込）", async () => {
    const buffer = testWorkbookBuffer();
    const controller = new AbortController();
    controller.abort();
    await expect(
      analyzeExcelBuffer(buffer, { signal: controller.signal })
    ).rejects.toBeInstanceOf(AnalyzeCancelledError);
    // 2回目（新しいsignal）は成功する
    const result = await analyzeExcelBuffer(buffer, { signal: new AbortController().signal });
    expect(result.rows.map((r) => r.name)).toEqual(["あいり", "ももか"]);
  });
});

describe("キャスト照合の非同期版（matchExcelRowsChunked）", () => {
  const rows = [row("あいり", 2), row("ももか", 3, 4500), row("れいな", 4)];
  const casts = [
    cast({ id: "c1", stageName: "あいり" }),
    cast({ id: "c2", stageName: "ももか", hourlyWage: 4500 }),
    cast({ id: "c9", stageName: "ゆき" }), // Excelに無い在籍キャスト
  ];

  it("チャンク分割しても同期版と同一の結果になる", async () => {
    const sync = matchExcelRows(rows, "virgo", casts, []);
    const chunked = await matchExcelRowsChunked(rows, "virgo", casts, [], { chunkSize: 1 });
    expect(chunked.matches.map((m) => m.suggestedAction)).toEqual(
      sync.matches.map((m) => m.suggestedAction)
    );
    expect(chunked.matches.map((m) => m.suggestedCastId)).toEqual(
      sync.matches.map((m) => m.suggestedCastId)
    );
    expect(chunked.missingCasts.map((c) => c.id)).toEqual(sync.missingCasts.map((c) => c.id));
  });

  it("照合中にabortすると AnalyzeCancelledError（結果は返らない）", async () => {
    const controller = new AbortController();
    await expect(
      matchExcelRowsChunked(rows, "virgo", casts, [], {
        chunkSize: 1,
        signal: controller.signal,
        onProgress: () => controller.abort(),
      })
    ).rejects.toBeInstanceOf(AnalyzeCancelledError);
  });
});

// ---------------- 保存キャンセルのステータス ----------------

describe("保存中キャンセルのステータス判定", () => {
  it("保存済み変更0件 → cancelled / 1件以上 → partial-cancelled（completedにしない）", () => {
    expect(finalizeCancelledStatus(0)).toBe("cancelled");
    expect(finalizeCancelledStatus(1)).toBe("partial-cancelled");
    expect(finalizeCancelledStatus(42)).toBe("partial-cancelled");
    expect(finalizeCancelledStatus(0)).not.toBe("completed");
    expect(finalizeCancelledStatus(5)).not.toBe("completed");
  });

  it("partial-cancelled のBatch（変更記録あり）はロールバック可能", () => {
    const batch = {
      id: "b1",
      storeId: "virgo",
      fileName: "t.xls",
      targetMonth: "2024-07",
      status: "partial-cancelled",
      totalRows: 10,
      createdCount: 3,
      updatedCount: 0,
      skippedCount: 0,
      errorCount: 0,
      summary: "",
      changes: [
        { type: "mr-created", collection: "monthlyResults", docId: "virgo_c1_2024-07", before: null, after: null },
        { type: "cast-created", collection: "casts", docId: "c-new", before: null, after: null },
      ],
      rollbackStatus: "none",
      createdAt: null as unknown as Timestamp,
      createdBy: "u1",
      completedAt: null,
    } as unknown as ImportBatchWithId;
    const preview = buildRollbackPreview(batch);
    expect(preview.available).toBe(true);
    expect(preview.monthlyResults).toBe(1);
    expect(preview.newCasts).toBe(1);
  });

  it("実行中（processing）のBatchはロールバック不可のまま", () => {
    const batch = {
      id: "b2",
      storeId: "virgo",
      status: "processing",
      changes: [{ type: "mr-created", collection: "monthlyResults", docId: "x", before: null, after: null }],
      rollbackStatus: "none",
    } as unknown as ImportBatchWithId;
    expect(buildRollbackPreview(batch).available).toBe(false);
  });
});

// ---------------- 自動確定 ----------------

describe("自動確定", () => {
  it("完全一致1名・在籍・時給同一 → 自動確定され、実行対象に含まれる", () => {
    const { matches } = matchExcelRows([row("あいり")], "virgo", [cast({})], []);
    const states = buildInitialRowStates(matches, new Set());
    expect(states[0].autoConfirmed).toBe(true);
    expect(states[0].action).toBe("link");
    expect(canExecutePlan(states)).toBe(true); // チェック操作なしで実行可能
    expect(summarizePlan(states).autoConfirmed).toBe(1);
  });

  it("一致候補が複数 → 自動確定しない", () => {
    const { matches } = matchExcelRows(
      [row("あいり")],
      "virgo",
      [cast({ id: "c1" }), cast({ id: "c2", realName: "別人" })],
      []
    );
    const states = buildInitialRowStates(matches, new Set());
    expect(states[0].autoConfirmed).toBe(false);
    expect(states[0].action).toBeNull();
  });

  it("アーカイブ済み → 自動確定しない", () => {
    const { matches } = matchExcelRows([row("あいり")], "virgo", [cast({ archived: true })], []);
    const states = buildInitialRowStates(matches, new Set());
    expect(states[0].autoConfirmed).toBe(false);
  });

  it("時給差がある → 自動確定しない（時給変更候補として要確認）", () => {
    const { matches } = matchExcelRows([row("あいり", 2, 5500)], "virgo", [cast({})], []);
    const states = buildInitialRowStates(matches, new Set());
    expect(states[0].autoConfirmed).toBe(false);
    expect(matches[0].wageChange).not.toBeNull();
  });

  it("完全一致なし → 新規として自動確定（部分一致は別人扱い）", () => {
    const { matches } = matchExcelRows([row("ももか")], "virgo", [cast({})], []);
    const states = buildInitialRowStates(matches, new Set());
    expect(matches[0].candidates).toHaveLength(0);
    expect(states[0].autoConfirmed).toBe(true);
    expect(states[0].action).toBe("new");
  });
});

// ---------------- 一括操作・絞り込み ----------------

describe("一括操作", () => {
  // 行1: 完全一致（時給同一） / 行2: 候補なし / 行3: 完全一致だが時給差 /
  // 行4: 同名複数 / 行5: 候補なし
  const rows = [
    row("あいり", 2),
    row("しんじん", 3),
    row("れいな", 4, 6000),
    row("かぶり", 5),
    row("しんじん2", 6),
  ];
  const casts = [
    cast({ id: "c1", stageName: "あいり" }),
    cast({ id: "c3", stageName: "れいな", hourlyWage: 5500 }),
    cast({ id: "c4a", stageName: "かぶり" }),
    cast({ id: "c4b", stageName: "かぶり", realName: "別人" }),
  ];
  const build = () =>
    buildInitialRowStates(matchExcelRows(rows, "virgo", casts, []).matches, new Set());

  it("完全一致のみ一括紐付け: 時給差・同名複数の行には適用されない", () => {
    // 全解除してから一括適用しても、クリーンな完全一致だけが紐付く
    const cleared = bulkClearSelection(build()).states;
    const { states, applied } = bulkLinkExactRows(cleared);
    expect(applied).toBe(1);
    expect(states[0].action).toBe("link"); // あいり
    expect(states[0].castId).toBe("c1");
    expect(states[2].action).toBeNull(); // れいな（時給差）は未選択のまま
    expect(states[3].action).toBeNull(); // かぶり（同名複数）は未選択のまま
  });

  it("候補なしのみ一括新規登録: 候補のある行は対象外", () => {
    const initial = build();
    const eligible = listBulkNewEligible(initial);
    expect(eligible.map((st) => st.match.row.name)).toEqual(["しんじん", "しんじん2"]);
    const { states, applied } = bulkNewNoCandidateRows(initial);
    expect(applied).toBe(2);
    expect(states[1].action).toBe("new");
    expect(states[4].action).toBe("new");
    expect(states[3].action).toBeNull(); // 同名複数は変更されない
  });

  it("表示中のみ一括除外 / 全件除外", () => {
    const initial = build();
    const visible = new Set([1, 4]); // 「新規候補のみ」絞り込み相当
    const partial = bulkExcludeRows(initial, visible);
    expect(partial.applied).toBe(2);
    expect(partial.states[1].action).toBe("exclude");
    expect(partial.states[4].action).toBe("exclude");
    expect(partial.states[0].action).toBe("link"); // 表示外は変更されない

    const all = bulkExcludeRows(initial);
    expect(all.states.every((st) => st.action === "exclude")).toBe(true);
    expect(canExecutePlan(all.states)).toBe(true);
  });

  it("選択をすべて解除 / 表示中のみ解除", () => {
    const initial = build();
    const cleared = bulkClearSelection(initial);
    expect(cleared.states.every((st) => st.action === null)).toBe(true);
    expect(canExecutePlan(cleared.states)).toBe(false);

    const partial = bulkClearSelection(initial, new Set([0]));
    expect(partial.states[0].action).toBeNull();
  });

  it("未選択が残る場合は実行拒否 / 自動確定＋手動解決で実行可能", () => {
    const initial = build();
    // 候補なし行は自動新規になるが、時給差・同名複数が未選択のため実行不可
    expect(canExecutePlan(initial)).toBe(false);
    const states = initial.map((st) =>
      st.action === null ? { ...st, action: "exclude" as const } : st
    );
    expect(canExecutePlan(states)).toBe(true);
    const s = summarizePlan(states);
    expect(s.unresolved).toBe(0);
    expect(s.autoConfirmed).toBe(3); // あいり（紐付け）+ しんじん・しんじん2（自動新規）
  });
});

describe("絞り込み", () => {
  const rows = [row("あいり", 2), row("しんじん", 3), row("れいな", 4, 6000), row("かぶり", 5)];
  const casts = [
    cast({ id: "c1", stageName: "あいり" }),
    cast({ id: "c3", stageName: "れいな", hourlyWage: 5500 }),
    cast({ id: "c4a", stageName: "かぶり", archived: true }),
    cast({ id: "c4b", stageName: "かぶり", realName: "別人" }),
  ];
  const states = buildInitialRowStates(
    matchExcelRows(rows, "virgo", casts, []).matches,
    new Set()
  );
  const namesFor = (filter: (typeof ROW_FILTERS)[number]["id"]) =>
    states.filter((st) => rowMatchesFilter(st, filter)).map((st) => st.match.row.name);

  it("9種の絞り込みが定義されている（既定は要対応のみ）", () => {
    expect(ROW_FILTERS.map((f) => f.id)).toEqual([
      "attention", "all", "unresolved", "autoConfirmed", "exactMatch",
      "newCandidate", "wageChange", "archivedCandidate", "multiCandidate",
    ]);
    expect(ROW_FILTERS[0].label).toBe("要対応のみ");
  });

  it("各絞り込みが該当行だけを返す", () => {
    expect(namesFor("all")).toHaveLength(4);
    // 自動確定: あいり（完全一致1名の紐付け）+ しんじん（完全一致なしの新規）
    expect(namesFor("autoConfirmed")).toEqual(["あいり", "しんじん"]);
    // 要対応（既定表示）: 自動確定行は表示されない
    expect(namesFor("attention")).toEqual(["れいな", "かぶり"]);
    expect(namesFor("unresolved")).toEqual(["れいな", "かぶり"]);
    expect(namesFor("exactMatch")).toEqual(expect.arrayContaining(["あいり", "れいな", "かぶり"]));
    expect(namesFor("newCandidate")).toEqual(["しんじん"]);
    expect(namesFor("wageChange")).toEqual(["れいな"]);
    expect(namesFor("archivedCandidate")).toEqual(["かぶり"]);
    expect(namesFor("multiCandidate")).toEqual(["かぶり"]);
  });
});

// ---------------- ルールとの整合（自動確定の再確認条件維持） ----------------

describe("ルール適用行の自動確定", () => {
  function linkRule(name: string, castId: string): NameMatchingRuleWithId {
    return {
      id: `virgo__${name}`,
      storeId: "virgo",
      sourceName: name,
      normalizedName: name,
      decision: "link",
      linkedCastId: castId,
      hourlyWage: 5000,
      active: true,
      createdAt: null as unknown as Timestamp,
      createdBy: "u1",
      updatedAt: null as unknown as Timestamp,
      updatedBy: "u1",
    };
  }

  it("有効なlinkルール → 自動確定", () => {
    const { matches } = matchExcelRows([row("あいり")], "virgo", [cast({})], [linkRule("あいり", "c1")]);
    const states = buildInitialRowStates(matches, new Set());
    expect(states[0].autoConfirmed).toBe(true);
  });

  it("linkedCastId が存在しないルール → 自動確定しない", () => {
    const { matches } = matchExcelRows([row("あいり")], "virgo", [cast({})], [linkRule("あいり", "ghost")]);
    const states = buildInitialRowStates(matches, new Set());
    expect(states[0].autoConfirmed).toBe(false);
  });
});
