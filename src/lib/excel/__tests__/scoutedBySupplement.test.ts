import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseMonthlyExcel } from "@/lib/excel/parseMonthlyExcel";

/**
 * 実店舗のExcel（VIRGO給料明細）で確認された構造を再現するテスト。
 *
 * 主シート（月別成績。「源氏名」等）にはスカウト者/情報提供者列が無く、
 * 別シート（「キャスト実績」相当）にのみ「情報提供者」または「スカウト者」
 * 列が存在する。かつそのシートの名前列は「区分／No／氏名」の3列が
 * 結合セルになっており、素直な単一列ヘッダー判定では区分列やNo列を
 * 誤って名前列としてしまう（過去に「Excel側が空欄72件」という誤判定を
 * 引き起こした実際の原因）。
 */

function makeWorkbookWithMerges(
  sheets: Record<string, { rows: unknown[][]; merges?: XLSX.Range[] }>
): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  for (const [name, { rows, merges }] of Object.entries(sheets)) {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    if (merges) ws["!merges"] = merges;
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  return XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
}

/** 主シート（月別成績相当）。スカウト者/情報提供者列は無い */
function mainSheetRows(): unknown[][] {
  return [
    ["VIRGO", 2026, 6, "月度", "給与支給表"],
    ["源氏名", "時給", "出勤日数", "総売上", "本指名", "場内", "同伴", "支給額"],
    ["あいり", 5000, 20, 1500000, 10, 5, 3, 520000],
    ["ももか", 4500, 18, 900000, 6, 8, 1, 400000],
    ["れいな", 6000, 22, 2200000, 15, 3, 5, 800000],
    ["みらい", 4800, 19, 1100000, 8, 4, 2, 430000],
  ];
}

/**
 * 「キャスト実績」相当シート。ヘッダー「キャスト名」が区分／No／氏名の
 * 3列（col0-2）にまたがる結合セル。実データは区分列(col0)が空欄がち、
 * No列(col1)は数値のみ、氏名は col2 のみに入っている。
 */
function companionSheetRows(scoutedByLabel: string): unknown[][] {
  return [
    [null, null, null, null, null, null, "月度"],
    ["キャスト名", null, null, "時給", "総売上", "出勤数", scoutedByLabel],
    [null, null, null, null, null, null, null],
    ["レギュラー", 1, "あいり", 5000, 1500000, 20, "田中"],
    [null, 2, "ももか", 4500, 900000, 18, "佐藤"],
    [null, 3, "れいな", 6000, 2200000, 22, "田中"],
    [null, 4, "みらい", 4800, 1100000, 19, ""],
  ];
}

const companionMerges: XLSX.Range[] = [{ s: { r: 1, c: 0 }, e: { r: 1, c: 2 } }];

describe("scoutedBy cross-sheet supplement", () => {
  it("「情報提供者」列を別シートから氏名一致で補完する", () => {
    const buf = makeWorkbookWithMerges({
      一覧: { rows: mainSheetRows() },
      キャスト実績: { rows: companionSheetRows("情報提供者"), merges: companionMerges },
    });
    const result = parseMonthlyExcel(buf);

    expect(result.sheetName).toBe("一覧");
    const byName = Object.fromEntries(result.rows.map((r) => [r.name, r.scoutedBy]));
    expect(byName["あいり"]).toBe("田中");
    expect(byName["ももか"]).toBe("佐藤");
    expect(byName["れいな"]).toBe("田中");
    expect(byName["みらい"]).toBe(""); // 補完元シートでも空欄 → 空欄のまま

    expect(result.scoutedByDebug?.source).toBe("supplement");
    expect(result.scoutedByDebug?.sheetName).toBe("キャスト実績");
    expect(result.scoutedByDebug?.headerLabel).toBe("情報提供者");
    expect(result.scoutedByDebug?.nameColumnNumber).toBe(3); // 結合セル内でcol2(1始まり3列目)を正しく選択
    expect(result.headerMap.scoutedBy).toContain("情報提供者");
    expect(result.headerMap.scoutedBy).toContain("キャスト実績");
  });

  it("「スカウト者」列（旧表記）でも同様に補完できる", () => {
    const buf = makeWorkbookWithMerges({
      一覧: { rows: mainSheetRows() },
      キャスト実績: { rows: companionSheetRows("スカウト者"), merges: companionMerges },
    });
    const result = parseMonthlyExcel(buf);

    const byName = Object.fromEntries(result.rows.map((r) => [r.name, r.scoutedBy]));
    expect(byName["あいり"]).toBe("田中");
    expect(byName["ももか"]).toBe("佐藤");
    expect(result.scoutedByDebug?.headerLabel).toBe("スカウト者");
  });

  it("主シート自体に情報提供者列がある場合は補完せずそのまま使う", () => {
    const rowsWithColumn: unknown[][] = [
      ["源氏名", "時給", "出勤日数", "総売上", "本指名", "場内", "同伴", "支給額", "情報提供者"],
      ["あいり", 5000, 20, 1500000, 10, 5, 3, 520000, "直接記載"],
    ];
    const buf = makeWorkbookWithMerges({
      一覧: { rows: rowsWithColumn },
    });
    const result = parseMonthlyExcel(buf);

    expect(result.rows[0].scoutedBy).toBe("直接記載");
    expect(result.scoutedByDebug?.source).toBe("primary");
    expect(result.scoutedByDebug?.sheetName).toBe("一覧");
    expect(result.headerMap.scoutedBy).toBe("情報提供者");
  });

  it("同名で異なるスカウト者値が競合する場合はその氏名を補完対象から除外する", () => {
    const companionRows: unknown[][] = [
      [null, null, null, null, null, null, "月度"],
      ["キャスト名", null, null, "時給", "総売上", "出勤数", "情報提供者"],
      [null, null, null, null, null, null, null],
      ["レギュラー", 1, "あいり", 5000, 1500000, 20, "田中"],
      [null, 2, "あいり", 5000, 1500000, 20, "佐藤"], // 同名で別の値（重複データ・矛盾）
    ];
    const buf = makeWorkbookWithMerges({
      一覧: { rows: mainSheetRows() },
      キャスト実績: { rows: companionRows, merges: companionMerges },
    });
    const result = parseMonthlyExcel(buf);

    const aiRow = result.rows.find((r) => r.name === "あいり");
    expect(aiRow?.scoutedBy).toBe(""); // 競合のため補完しない
  });

  it("どのシートにも名前+スカウト者/情報提供者列が見つからない場合はsource:noneになる", () => {
    const buf = makeWorkbookWithMerges({
      一覧: { rows: mainSheetRows() },
    });
    const result = parseMonthlyExcel(buf);

    expect(result.rows.every((r) => r.scoutedBy === "")).toBe(true);
    expect(result.scoutedByDebug?.source).toBe("none");
  });
});
