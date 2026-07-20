import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  invalidCastNameReason,
  parseMonthlyExcel,
} from "@/lib/excel/parseMonthlyExcel";

/**
 * 実店舗の給与明細ファイル「VIRGO 2024年7月 キャスト給料明細.xls」で報告された
 * 不具合（「設定」シートを読み込み、数字・同伴・本指名・場内指名・ボトル・
 * ドリンク等がキャスト候補に出る）を再現するテストブック。
 *
 * 注: 実ファイルは本環境に添付されていないため、報告された症状
 * （シート「設定」・76行検出・上記の誤検出項目）を忠実に再現した
 * 合成ブックで検証している。実ファイル入手後に同テストで再確認すること。
 */

/** 報告された「設定」シート相当（バック率・単価などの設定/集計領域） */
function settingsSheetRows(): unknown[][] {
  const rows: unknown[][] = [
    ["設定", "", ""],
    ["項目", "単価", "バック"],
    ["同伴", 3000, 1000],
    ["本指名", 2000, 500],
    ["場内指名", 1000, 300],
    ["ボトル", 5000, 1500],
    ["ドリンク", 1000, 500],
    ["", "", ""],
    ["名前", "", ""], // 名前ラベル単独（旧実装はこれをヘッダーと誤認していた）
  ];
  // 数字だけの行（55, 61, 62, ... 報告された誤検出値）
  for (const n of [55, 61, 62, 63, 64, 65, 66, 68, 69, 70]) {
    rows.push([n, n * 100, ""]);
  }
  // 76行相当まで埋める
  while (rows.length < 76) rows.push(["", "", ""]);
  return rows;
}

/** 正しい給料明細シート相当 */
function payrollSheetRows(): unknown[][] {
  return [
    ["VIRGO 2024年7月 キャスト給料明細", "", "", "", "", "", "", "", "", ""],
    ["", "", "", "", "", "", "", "", "", ""],
    ["源氏名", "時給", "出勤日数", "出勤時間", "総売上", "本指名", "場内", "同伴", "支給額", "備考"],
    ["あいり", 5000, 20, 100, 1500000, 10, 5, 3, 520000, ""],
    ["ももか", 4500, 18, 85, 900000, 6, 8, 1, 400000, "新人"],
    ["55", 0, 0, 0, 0, 0, 0, 0, 0, ""], // データ範囲内の数字だけ行
    ["ドリンク", 0, 0, 0, 12000, 0, 0, 0, 0, ""], // データ範囲内の集計項目行
    ["れいな", 6000, 22, 110, 2200000, 15, 3, 5, 800000, ""],
    ["", "", "", "", "", "", "", "", "", ""],
    ["合計", "", 60, 295, 4600000, 31, 16, 9, 1720000, ""],
    ["平均", "", 20, 98.3, 1533333, 10.3, 5.3, 3, 573333, ""],
  ];
}

function makeWorkbook(sheets: Record<string, unknown[][]>): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
}

/** 「設定」シートが先頭にある実ファイル相当のブック */
function realFileLikeBuffer(): ArrayBuffer {
  return makeWorkbook({
    設定: settingsSheetRows(),
    給料明細: payrollSheetRows(),
  });
}

describe("parseMonthlyExcel: シート自動判定", () => {
  it("「設定」シートが先頭でも給料明細シートを採用する", () => {
    const result = parseMonthlyExcel(realFileLikeBuffer());
    expect(result.sheetName).toBe("給料明細");
    const settings = result.sheets.find((s) => s.name === "設定");
    expect(settings?.adopted).toBe(false);
    expect(settings?.reason).toContain("ヘッダー行を検出できない");
  });

  it("採用シートのヘッダー行・データ範囲を正しく検出する", () => {
    const result = parseMonthlyExcel(realFileLikeBuffer());
    expect(result.headerRowNumber).toBe(3);
    expect(result.dataStartRow).toBe(4);
    expect(result.dataEndRow).toBe(8); // 最後のキャスト行（れいな）
    expect(result.headerMap.name).toBe("源氏名");
    expect(result.headerMap.hourlyWage).toBe("時給");
    expect(result.headerMap.totalSales).toBe("総売上");
    expect(result.headerMap.payment).toBe("支給額");
  });

  it("シートを手動指定できる（設定シートを指定するとヘッダー無しエラー）", () => {
    expect(() => parseMonthlyExcel(realFileLikeBuffer(), { sheetName: "設定" })).toThrow(
      /ヘッダー行/
    );
  });

  it("どのシートでもヘッダーを検出できない場合はシート一覧付きでエラー", () => {
    const buf = makeWorkbook({ 設定: settingsSheetRows() });
    expect(() => parseMonthlyExcel(buf)).toThrow(/設定/);
  });
});

describe("parseMonthlyExcel: キャスト行の抽出と除外", () => {
  it("キャスト名だけを検出し、集計・設定項目・数字だけの行は候補に出ない", () => {
    const result = parseMonthlyExcel(realFileLikeBuffer());
    const names = result.rows.map((r) => r.name);
    expect(names).toEqual(["あいり", "ももか", "れいな"]);
    // 報告された誤検出項目が一切含まれないこと
    for (const bad of ["55", "61", "同伴", "本指名", "場内指名", "ボトル", "ドリンク", "合計", "平均", ""]) {
      expect(names).not.toContain(bad);
    }
  });

  it("除外行が理由付きで報告される", () => {
    const result = parseMonthlyExcel(realFileLikeBuffer());
    const byValue = (v: string) => result.excluded.find((e) => e.value === v);
    expect(byValue("55")?.reason).toContain("数値のみ");
    expect(byValue("ドリンク")?.reason).toContain("集計・設定項目");
    expect(byValue("合計")?.reason).toContain("集計");
  });

  it("合計行以降（平均行など）はデータ範囲外として読み込まない", () => {
    const result = parseMonthlyExcel(realFileLikeBuffer());
    // 合計行で読み込み終了 → 平均行は除外一覧にも現れない
    expect(result.excluded.some((e) => e.value === "平均")).toBe(false);
    expect(result.excluded.find((e) => e.value === "合計")?.reason).toContain("読み込みを終了");
  });

  it("数値・売上・支給額は検出した見出しの列から取得する", () => {
    const result = parseMonthlyExcel(realFileLikeBuffer());
    const airi = result.rows.find((r) => r.name === "あいり")!;
    expect(airi.hourlyWage).toBe(5000);
    expect(airi.workDays).toBe(20);
    expect(airi.workHours).toBe(100);
    expect(airi.totalSales).toBe(1500000);
    expect(airi.honshimeiCount).toBe(10);
    expect(airi.jounaiCount).toBe(5);
    expect(airi.douhan).toBe(3);
    expect(airi.payment).toBe(520000);
  });

  it("キャスト行0件のシートしか無い場合は採用せずエラーになる", () => {
    const buf = makeWorkbook({
      空シート: [["源氏名", "時給", "総売上"], ["合計", 0, 0]],
    });
    expect(() => parseMonthlyExcel(buf)).toThrow();
  });

  it("採用シート名が「設定」等の場合は警告を出す", () => {
    const buf = makeWorkbook({ 設定: payrollSheetRows() });
    const result = parseMonthlyExcel(buf);
    expect(result.sheetName).toBe("設定");
    expect(result.warnings.some((w) => w.includes("設定"))).toBe(true);
  });
});

describe("invalidCastNameReason（キャスト名の妥当性）", () => {
  it("報告された誤検出値をすべて拒否する", () => {
    for (const bad of [
      "55", "61", "62", "63", "64", "65", "66", "68", "69", "70",
      "同伴", "本指名", "場内指名", "ボトル", "ドリンク",
      "合計", "平均", "売上", "給与", "支給額", "",
      "1,200", "¥500", "売上合計", "-----",
    ]) {
      expect(invalidCastNameReason(bad), `「${bad}」は拒否されるべき`).not.toBeNull();
    }
  });

  it("通常のキャスト名は許可する", () => {
    for (const ok of ["あいり", "ももか", "レイナ", "Airi", "あい り2", "みく☆"]) {
      expect(invalidCastNameReason(ok), `「${ok}」は許可されるべき`).toBeNull();
    }
  });
});
