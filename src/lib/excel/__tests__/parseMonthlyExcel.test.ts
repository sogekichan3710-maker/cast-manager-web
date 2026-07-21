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

/**
 * 実ファイル「VIRGO 2024年7月 キャスト給料明細.xls」の実構造
 * （76シート: 設定 / 一覧 / 支給表 / キャスト実績 / 個人別シート / 61〜70の
 *   予備シート。給与明細本体は「一覧」でヘッダーは2行目、データの後に
 *   61〜70の数値名プレースホルダー行と合計行が続く）を匿名化して再現。
 * 実ファイルそのものは個人情報（源氏名・給与額）を含むためコミットしない。
 * 実ファイルでの検証結果: 一覧シート採用・60名検出・全フィールド一致（PR #1参照）。
 */
function realStructureWorkbook(): ArrayBuffer {
  // 「一覧」— 実ファイルと同じ列構成（源氏名/時給/出勤数/労働時間/同伴組/
  // 本指名/場内/売上/総支給額。差引給与・最終支給額など類似列も含む）
  const ichiran: unknown[][] = [
    ["", "VIRGO", 7, "月度", "", "", "", "", "給与支給表"],
    ["", "源氏名", "時給", "歩合対象", "歩合比率", "登録有", "出勤数", "労働時間", "日当",
      "同伴組", "同バック", "その他", "本指名", "本指バック", "場内", "場内バック", "延長",
      "ドリンク", "ボトル", "バック合計", "歩合差額", "総支給額", "日払い", "名刺代", "罰金",
      "差引給与", "売上", "場内売"],
    [1, "テストあ", 7000, 1, 0.6, 0, 14, 32.99999999999999, 231000, 6, 10000, 0, 34, 34000,
      2, 1000, 0, 95040, 127920, 267960, 404880, 498959.99999999994, 2400, 0, 0, 496560, 1506400, 0],
    [2, "テストい", 12000, 1, 0.6, 0, 8, 31.5, 378000, 1, 5000, 0, 6.5, 6500,
      11.5, 5750, 0, 11900, 1800, 30950, 0, 408950, 14300, 0, 0, 394650, 169000, 78000],
    [3, "テストう", 8000, 1, 0.6, 0, 25, 107.5, 860000, 5, 17500, 0, 28, 28000,
      12.5, 6250, 0, 63050, 86625, 201425, 0, 1061425, 2400, 0, 0, 1059025, 1159400, 19000],
    // 未使用の予備行（実ファイルの61〜70行と同じく名前セルが数値）
    [4, 61, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [5, 62, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    // 合計行（名前セルなし・数値のみ）
    ["", "", "", "", "", "", 47, 172, 1469000, 12, 32500, 0, 68.5, 68500, 26, 13000, 0,
      170, 216, 500, 404880, 1969334, 19100, 0, 0, 1950235, 2834800, 97000],
  ];
  // 「設定」— キャスト名+時給+支給合計のマスター表 + バック詳細（同伴/ボトル等）
  const settei: unknown[][] = [
    [2024, "", "キャスト名", "時給", "歩合対象", "歩合比率", "登録有", "備考", "", "支給合計"],
    [7, 1, "テストあ", 7000, 1, 0.6, "", "", "", 903840],
    [45474, 2, "テストい", 12000, 1, 0.6, "", "", "", 396845],
    ["", 61, 61, "", 1, "", "", "", "", ""],
    ["", 62, 62, "", 1, "", "", "", "", ""],
    ["", "", "", "", "", "", "", "", "", ""],
    ["", "", "バック詳細", "金額", "消費税", "消費税", "", "", "", ""],
    ["", "", "同伴", "", 10, 0.09, "", "", "", ""],
    ["", "", "本指名", 1000, "", "登録有", "", "", "", ""],
    ["", "", "場内指名", 500, "", 0.09, "", "", "", ""],
    ["", "", "ボトル", "", "", "", "", "", "", ""],
    ["", "", "ドリンク", "", "", "", "", "", "", ""],
  ];
  // 「支給表」— 入力手順のコメント行だけのシート
  const shikyu: unknown[][] = [
    [45493, "VIRGO", "", "", "", "", "のセルに数字を入力し"],
    ["", "", "", "", "", "①　支払年月日を入れる"],
    ["支払年月日", "日数", "", "", "", "③　源氏名をいれる"],
    [45523, 31, "", "", "", ""],
  ];
  // 個人別シート（キャスト名+時給の行 + 日別明細）
  const personal: unknown[][] = [
    ["", "", "", "", "", "", "", "キャスト名", "", "", "時給", "歩合対象", "歩合比率", "登録有"],
    [7, "", "", "", "", "", "", "テストあ", "", "", 7000, 1, 0.6, 0],
    ["日", "曜日", "時給", "IN", "OUT", "労時間", "日当", "同伴組", "同バック", "その他", "本指名", "本指バック", "場内", "場内バック"],
    [45474, "", 7000, "", "", "", 0, "", "", "", "", 0, "", 0],
    [45475, "", "", 1.04, 1.06, 0.5, 3500, 1, "", "", 1, 1000, "", 0],
  ];
  return makeWorkbook({
    設定: settei,
    一覧: ichiran,
    "支給表 ": shikyu,
    テストあ: personal,
    "61": personal,
    "62": personal,
  });
}

describe("parseMonthlyExcel: 実ファイル構造（VIRGO給料明細）の再現", () => {
  it("「一覧」シートを採用し、設定・支給表・個人別・予備シートは採用しない", () => {
    const result = parseMonthlyExcel(realStructureWorkbook());
    expect(result.sheetName).toBe("一覧");
    expect(result.headerRowNumber).toBe(2);
    expect(result.dataStartRow).toBe(3);
    expect(result.dataEndRow).toBe(5);
    expect(result.sheets.find((s) => s.name === "支給表 ")?.reason).toContain("ヘッダー行を検出できない");
    for (const s of result.sheets) {
      if (s.name !== "一覧") expect(s.adopted).toBe(false);
    }
  });

  it("実ファイルの列名（出勤数/労働時間/同伴組/売上/総支給額）を正しくマッピングする", () => {
    const result = parseMonthlyExcel(realStructureWorkbook());
    expect(result.headerMap).toMatchObject({
      name: "源氏名",
      hourlyWage: "時給",
      workDays: "出勤数",
      workHours: "労働時間",
      douhan: "同伴組",
      honshimeiCount: "本指名",
      jounaiCount: "場内",
      totalSales: "売上",
      payment: "総支給額",
    });
    const a = result.rows.find((r) => r.name === "テストあ")!;
    expect(a.hourlyWage).toBe(7000);
    expect(a.workDays).toBe(14);
    expect(a.workHours).toBe(33); // 32.99999999999999 → 丸め
    expect(a.douhan).toBe(6);
    expect(a.honshimeiCount).toBe(34);
    expect(a.jounaiCount).toBe(2);
    expect(a.totalSales).toBe(1506400);
    // 支給額は「総支給額」列（差引給与496560・日当231000ではない）
    expect(a.payment).toBe(498960);
    // 小数の本指名・場内も保持される
    const b = result.rows.find((r) => r.name === "テストい")!;
    expect(b.honshimeiCount).toBe(6.5);
    expect(b.jounaiCount).toBe(11.5);
  });

  it("数値名の予備行と合計行は取り込まず、キャスト3名だけを検出する", () => {
    const result = parseMonthlyExcel(realStructureWorkbook());
    expect(result.rows.map((r) => r.name)).toEqual(["テストあ", "テストい", "テストう"]);
    expect(result.excluded.filter((e) => e.reason.includes("数値のみ")).length).toBe(2);
    expect(result.excluded.some((e) => e.reason.includes("空欄"))).toBe(true); // 合計行
    expect(result.warnings).toEqual([]);
  });
});

describe("parseMonthlyExcel: スカウト者列（PR6）", () => {
  it("「スカウト者」列を検出し、各行のscoutedByへ取り込む", () => {
    const buf = makeWorkbook({
      給料明細: [
        ["源氏名", "時給", "出勤日数", "総売上", "支給額", "スカウト者"],
        ["あいり", 5000, 20, 1500000, 520000, "田中"],
        ["ももか", 4500, 18, 900000, 400000, ""],
      ],
    });
    const result = parseMonthlyExcel(buf);
    expect(result.headerMap.scoutedBy).toBe("スカウト者");
    const a = result.rows.find((r) => r.name === "あいり")!;
    expect(a.scoutedBy).toBe("田中");
    const m = result.rows.find((r) => r.name === "ももか")!;
    expect(m.scoutedBy).toBe("");
  });

  it("スカウト者列が存在しないファイルでは空文字になる（従来ファイルへの後方互換）", () => {
    const result = parseMonthlyExcel(realStructureWorkbook());
    expect(result.rows.every((r) => r.scoutedBy === "")).toBe(true);
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
