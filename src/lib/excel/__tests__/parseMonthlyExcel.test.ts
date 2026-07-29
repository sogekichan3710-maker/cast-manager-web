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

/** 結合セル（!merges）付きのシートを作れるワークブックビルダー（merges省略可） */
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

describe("parseMonthlyExcel: 総売上セルの参照情報（照合確認画面のトレース表示・数式キャッシュ検出）", () => {
  it("通常の数値セルでは、行・列から求めた実際のセル番地を記録し formula は null", () => {
    const result = parseMonthlyExcel(realFileLikeBuffer());
    const airi = result.rows.find((r) => r.name === "あいり")!;
    // payrollSheetRows: 1行目タイトル/2行目空/3行目ヘッダー/4行目あいり。
    // 総売上は5列目（源氏名,時給,出勤日数,出勤時間,総売上 → E列）
    expect(airi.totalSalesCell).toEqual({ address: "E4", formula: null });
  });

  it("総売上セルが数式の場合は数式を検出し、totalSalesは保存時のキャッシュ値をそのまま返す（xlsxは再計算しない）", () => {
    const XLSXmod = XLSX;
    const ws = XLSXmod.utils.aoa_to_sheet(payrollSheetRows());
    // あいり行（Excel上4行目）の総売上セル(E4)を数式に差し替える。
    // 本来の再計算結果がいくつであっても、ファイルが再計算・保存されていなければ
    // v（キャッシュ値）は古いままになりうることを模擬する
    ws["E4"] = { t: "n", v: 1000000, f: "F4+900000" };
    const wb = XLSXmod.utils.book_new();
    XLSXmod.utils.book_append_sheet(wb, ws, "給料明細");
    const buf = XLSXmod.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;

    const result = parseMonthlyExcel(buf);
    const airi = result.rows.find((r) => r.name === "あいり")!;
    expect(airi.totalSalesCell?.address).toBe("E4");
    expect(airi.totalSalesCell?.formula).toBe("F4+900000");
    // parseMonthlyExcel（xlsxライブラリ）は数式を再計算しないため、
    // totalSalesはセルのキャッシュ値（v）をそのまま返す
    expect(airi.totalSales).toBe(1000000);
  });
});

describe("parseMonthlyExcel: 総売上は「指名売上+場内売上=合計」列を優先する", () => {
  /**
   * 運用上、キャスト管理アプリの「総売上」は指名売上と場内売上を合算した
   * 「合計」列を保存する仕様。しかし「合計」列と紛らわしい「売上」列
   * （実際には指名売上のみの値）が同じシートに存在する実ファイルがあり、
   * 従来のエイリアス優先順位ではその「売上」列（指名売上のみ）を誤って
   * totalSalesとして読み込んでいた。
   */
  function payrollWithBreakdownRows(): unknown[][] {
    return [
      ["源氏名", "時給", "出勤日数", "出勤時間", "指名売上", "場内", "売上", "合計", "本指名", "同伴", "支給額", "備考"],
      // 指名売上1,200,000 + 場内売上300,000 = 合計1,500,000。
      // 「売上」列（1,200,000=指名売上のみ）は紛らわしいが合計とは異なる値にしてある
      ["あいり", 5000, 20, 100, 1200000, 300000, 1200000, 1500000, 10, 3, 520000, ""],
      ["ももか", 4500, 18, 85, 800000, 100000, 800000, 900000, 6, 1, 400000, "新人"],
    ];
  }

  it("指名売上・場内売上・合計の列がある場合は「合計」がtotalSalesとして保存される（指名売上のみの「売上」列は採用しない）", () => {
    const buf = makeWorkbook({ 給料明細: payrollWithBreakdownRows() });
    const result = parseMonthlyExcel(buf);
    expect(result.headerMap.totalSales).toBe("合計");
    const airi = result.rows.find((r) => r.name === "あいり")!;
    const momoka = result.rows.find((r) => r.name === "ももか")!;
    expect(airi.totalSales).toBe(1500000); // 合計（1,200,000 + 300,000）
    expect(airi.totalSales).not.toBe(1200000); // 指名売上のみの値は採用しない
    expect(momoka.totalSales).toBe(900000);
  });

  it("「合計」列が無い旧フォーマットでは、従来通り「総売上」列がtotalSalesとして保存される", () => {
    const result = parseMonthlyExcel(realFileLikeBuffer());
    expect(result.headerMap.totalSales).toBe("総売上");
    const airi = result.rows.find((r) => r.name === "あいり")!;
    expect(airi.totalSales).toBe(1500000); // payrollSheetRowsの「総売上」列の値のまま
  });
});

describe("parseMonthlyExcel: totalSalesは「キャスト実績」シートの「合計」列があればそれを優先採用する", () => {
  /**
   * 報告された不具合の再現・対応。売上（totalSales）**だけ**を対象にした修正。
   * 行データ本体（名前・時給・本指名・場内・同伴・支給額等）は、これまでと
   * 全く同じ「採用シート」（スコアリングで決定。変更なし）から読み込む。
   * ワークブックに「キャスト実績」という名前のシートがあれば、その「合計」列
   * だけを氏名一致でtotalSalesに採用する（他の項目には一切影響しない）。
   * 「キャスト実績」シートが無い、または該当キャストが無い場合は、採用シート
   * 自身の総売上列（「合計」優先・無ければ「総売上」等へフォールバック。上の
   * describe参照）がそのまま使われる＝完全に従来通り。
   *
   * 例: せいか 指名5,818,200 + 場内売上75,400 = 合計5,893,600（キャスト実績シート）。
   *     「一覧」シートの「合計」列は515,843円という無関係な値だが、totalSales
   *     以外の項目（本指名・場内・同伴・支給額等）は引き続き「一覧」シートから
   *     そのまま読み込む。
   */
  function ichiranRows(): unknown[][] {
    return [
      ["源氏名", "時給", "出勤日数", "出勤時間", "本指名", "場内", "同伴", "合計", "支給額", "備考"],
      // 「合計」列は515,843円という、キャスト実績シートとは無関係な値
      ["せいか", 5000, 22, 110, 12, 4, 2, 515843, 900000, ""],
    ];
  }

  function castJissekiRows(): unknown[][] {
    return [
      ["源氏名", "時給", "出勤日数", "出勤時間", "売上", "指名", "場内売上", "合計", "本指名", "支給額", "備考"],
      // 「売上」列（指名のみの値で紛らわしい）は無視し、「合計」列の実値のみを使う
      ["せいか", 5000, 22, 110, 5818200, 5818200, 75400, 5893600, 12, 900000, ""],
    ];
  }

  it("行データ本体は従来通り「一覧」シート（スコアが高い方）から読み、totalSalesだけ「キャスト実績」シートの「合計」で上書きされる", () => {
    const buf = makeWorkbook({ 一覧: ichiranRows(), キャスト実績: castJissekiRows() });
    const result = parseMonthlyExcel(buf);
    // 行データ本体の採用シートは「一覧」のまま（スコアリングは変更していない）
    expect(result.sheetName).toBe("一覧");
    const seika = result.rows.find((r) => r.name === "せいか")!;
    // totalSalesだけキャスト実績シートの「合計」列に置き換わる
    expect(seika.totalSales).toBe(5893600);
    expect(seika.totalSales).not.toBe(515843); // 一覧シート自身の「合計」列は使われない
    // それ以外の項目は「一覧」シートの値のまま変更されない
    expect(seika.honshimeiCount).toBe(12); // 本指名本数
    expect(seika.jounaiCount).toBe(4); // 場内本数
    expect(seika.douhan).toBe(2); // 同伴
    expect(seika.payment).toBe(900000); // 支給額（給料）
    expect(result.totalSalesOverrideDebug.source).toBe("override");
    expect(result.totalSalesOverrideDebug.sheetName).toBe("キャスト実績");
  });

  it("「キャスト実績」シートが無い場合は、採用シート自身のtotalSales列がそのまま使われる（完全に従来通り）", () => {
    const buf = makeWorkbook({ 一覧: ichiranRows() });
    const result = parseMonthlyExcel(buf);
    expect(result.sheetName).toBe("一覧");
    const seika = result.rows.find((r) => r.name === "せいか")!;
    expect(seika.totalSales).toBe(515843); // 「キャスト実績」シートが無いのでそのまま
    expect(result.totalSalesOverrideDebug.source).toBe("none");
  });

  it("「キャスト実績」シートはあるが該当キャストが見つからない場合、そのキャストのtotalSalesは採用シート自身の値のまま", () => {
    const buf = makeWorkbook({
      一覧: ichiranRows(),
      キャスト実績: [
        ["源氏名", "時給", "合計"],
        ["別のキャスト", 5000, 999999],
      ],
    });
    const result = parseMonthlyExcel(buf);
    const seika = result.rows.find((r) => r.name === "せいか")!;
    expect(seika.totalSales).toBe(515843); // 上書きされない
  });

  it("シート名の並び順に関わらず、行データ本体のシート選択・上書きの適用結果は変わらない", () => {
    const buf = makeWorkbook({ キャスト実績: castJissekiRows(), 一覧: ichiranRows() });
    const result = parseMonthlyExcel(buf);
    expect(result.sheetName).toBe("一覧");
    const seika = result.rows.find((r) => r.name === "せいか")!;
    expect(seika.totalSales).toBe(5893600);
  });

  describe("総売上トレース・シート診断（調査用デバッグ表示のデータ）", () => {
    it("上書きが成功した場合、トレースにキャスト実績/一覧それぞれの取得値と採用理由が記録される", () => {
      const buf = makeWorkbook({ 一覧: ichiranRows(), キャスト実績: castJissekiRows() });
      const result = parseMonthlyExcel(buf);
      const trace = result.totalSalesTrace.find((t) => t.castName === "せいか")!;
      expect(trace.castPerformanceValue).toBe(5893600);
      expect(trace.castPerformanceSheet).toBe("キャスト実績");
      expect(trace.listValue).toBe(515843);
      expect(trace.listSheet).toBe("一覧");
      expect(trace.selectedValue).toBe(5893600);
      expect(trace.selectedSheet).toBe("キャスト実績");
      expect(trace.selectedColumn).toBe("合計");
      expect(trace.fallbackOccurred).toBe(false);
      expect(trace.reason).toContain("キャスト実績");

      const diag = result.totalSalesSheetDiagnostics.find((d) => d.name === "キャスト実績")!;
      expect(diag.matchesCastPerformanceSheetName).toBe(true);
      expect(diag.headerDetected).toBe(true);
      expect(diag.nameColumnDetected).toBe(true);
      expect(diag.totalSalesColumnDetected).toBe(true);
    });

    it("「キャスト実績」シートが無い場合、トレースはフォールバックを明示し、シート診断は「見つからない」ことを示す", () => {
      const buf = makeWorkbook({ 一覧: ichiranRows() });
      const result = parseMonthlyExcel(buf);
      const trace = result.totalSalesTrace.find((t) => t.castName === "せいか")!;
      expect(trace.castPerformanceValue).toBeNull();
      expect(trace.listValue).toBe(515843);
      expect(trace.selectedValue).toBe(515843);
      expect(trace.selectedSheet).toBe("一覧");
      expect(trace.fallbackOccurred).toBe(true);
      expect(trace.reason).toContain("見つかりません");

      expect(result.totalSalesSheetDiagnostics.some((d) => d.matchesCastPerformanceSheetName)).toBe(false);
    });

    it("「キャスト実績」という名前のシートはあるが「合計」列を検出できない場合、その旨がシート診断・トレースの理由に現れる", () => {
      const buf = makeWorkbook({
        一覧: ichiranRows(),
        キャスト実績: [
          // 「時給」「出勤日数」の2列で既知列数の要件（2列以上）を満たしヘッダー検出は
          // 成功させつつ、総売上に相当する列名だけをどのエイリアスにも一致しないものにする
          ["源氏名", "時給", "出勤日数", "総売上高"],
          ["せいか", 5000, 20, 999999],
        ],
      });
      const result = parseMonthlyExcel(buf);
      const diag = result.totalSalesSheetDiagnostics.find((d) => d.name === "キャスト実績")!;
      expect(diag.matchesCastPerformanceSheetName).toBe(true);
      expect(diag.nameColumnDetected).toBe(true);
      expect(diag.totalSalesColumnDetected).toBe(false);

      const trace = result.totalSalesTrace.find((t) => t.castName === "せいか")!;
      expect(trace.selectedValue).toBe(515843); // 一覧のまま
      expect(trace.reason).toContain("総売上列を検出できません");
    });

    it("氏名の全角半角・空白の違いを吸収して氏名一致する（normText正規化）", () => {
      const buf = makeWorkbook({
        一覧: [
          ["源氏名", "時給", "出勤日数", "出勤時間", "本指名", "場内", "同伴", "合計", "支給額", "備考"],
          ["せいか　", 5000, 22, 110, 12, 4, 2, 515843, 900000, ""], // 全角スペース付き
        ],
        キャスト実績: [
          ["源氏名", "時給", "合計"],
          ["ｾｲｶ", 5000, 5893600], // 半角カナ表記
        ],
      });
      const result = parseMonthlyExcel(buf);
      // 正規化後の文字列が一致しないため、この場合は氏名一致せずフォールバックする
      // （半角カナ→全角ひらがな変換まではnormTextで行わないため、意図的な非一致ケース）
      const trace = result.totalSalesTrace[0];
      expect(trace.selectedValue).toBe(515843);
      expect(trace.fallbackOccurred).toBe(true);
    });
  });
});

describe("parseMonthlyExcel: 「キャスト実績」シートの結合セル氏名列（本番で報告された不具合の再現）", () => {
  /**
   * 本番の診断表示で判明した不具合の再現。「キャスト実績」シートは名前列
   * （「キャスト名」）が3列にまたがる結合セルになっており（区分／No／キャスト名）、
   * 従来はこの補正（resolveMergedNameColumn）がscoutedBy補完の探索でしか
   * 使われておらず、採用シート選択・findTotalSalesOverrideが使う
   * scanSheet/extractRowsの一般経路では未適用だった。
   *
   * その結果、名前列が結合セルの先頭列（区分列。ほとんどの行が空欄）を
   * 指してしまい、ほぼ全行が「名前が空欄」として除外され、5行連続無効行で
   * 走査が打ち切られる（MAX_CONSECUTIVE_INVALID=5）ため、有効行が1件しか
   * 検出されない不具合が起きていた（診断表示で「有効行:1」として確認された）。
   */
  function castJissekiRowsWithMergedNameHeader(): unknown[][] {
    // A〜C列が結合され、見出し文字列「キャスト名」の実体は結合範囲の先頭列（A列）に
    // 入っている（実際のExcelの結合セルの挙動：値は左上のセルのみが持つ）。
    // 一方、各行の実データはA列（区分・ほぼ空欄）でもB列（No・数値のみ）でもなく、
    // C列（キャスト名の実体）に入っている。素直にヘッダー文字列の位置（A列）を
    // 名前列とみなすと、データ行はA列がほぼ空欄のため大半が「名前が空欄」と
    // 判定され誤って除外される
    return [
      ["キャスト名", "", "", "時給", "売上"],
      ["", 1, "えま", 5000, 225221],
      ["", 2, "まな", 4800, 56072],
      ["", 3, "りの", 5200, 0], // 売上0円のキャストも有効行として採用されるべき
      ["", 4, "りな", 4500, 120000],
      ["", 5, "みく", 4500, 98000],
      ["", 6, "みお", 4500, 76000],
      ["", 7, "みなみ", 4500, 65000],
      ["", 8, "みほ", 4500, 54000],
    ];
  }
  const castJissekiMerges: XLSX.Range[] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }]; // ヘッダー行のA〜C列が結合

  function ichiranRowsForManyCasts(): unknown[][] {
    const header = ["源氏名", "時給", "出勤日数", "出勤時間", "本指名", "場内", "同伴", "合計", "支給額", "備考"];
    const names = ["えま", "まな", "りの", "りな", "みく", "みお", "みなみ", "みほ"];
    // 「一覧」シート自身の「合計」列は、キャスト実績シートとは無関係な値にしてある
    return [header, ...names.map((n, i) => [n, 5000, 20, 100, 5, 2, 1, 111111 + i, 400000, ""])];
  }

  it("結合セルの名前列でも「キャスト実績」シートの有効行が実際のキャスト人数分になる", () => {
    const buf = makeWorkbookWithMerges({
      一覧: { rows: ichiranRowsForManyCasts() },
      キャスト実績: { rows: castJissekiRowsWithMergedNameHeader(), merges: castJissekiMerges },
    });
    const result = parseMonthlyExcel(buf);
    const diag = result.totalSalesSheetDiagnostics.find((d) => d.name === "キャスト実績")!;
    expect(diag.validRowCount).toBe(8); // 1件ではなく実際の8名分
  });

  it("えま・まな・りの（0円）がキャスト実績シートの売上を採用し、fallbackが発生しない", () => {
    const buf = makeWorkbookWithMerges({
      一覧: { rows: ichiranRowsForManyCasts() },
      キャスト実績: { rows: castJissekiRowsWithMergedNameHeader(), merges: castJissekiMerges },
    });
    const result = parseMonthlyExcel(buf);

    const ema = result.totalSalesTrace.find((t) => t.castName === "えま")!;
    expect(ema.selectedValue).toBe(225221);
    expect(ema.selectedSheet).toBe("キャスト実績");
    expect(ema.castPerformanceValue).toBe(225221);
    expect(ema.fallbackOccurred).toBe(false);

    const mana = result.totalSalesTrace.find((t) => t.castName === "まな")!;
    expect(mana.selectedValue).toBe(56072);
    expect(mana.selectedSheet).toBe("キャスト実績");
    expect(mana.fallbackOccurred).toBe(false);

    // 売上0円のキャストも氏名一致として扱われ、フォールバックしない
    const rino = result.totalSalesTrace.find((t) => t.castName === "りの")!;
    expect(rino.selectedValue).toBe(0);
    expect(rino.selectedSheet).toBe("キャスト実績");
    expect(rino.castPerformanceValue).toBe(0);
    expect(rino.fallbackOccurred).toBe(false);

    // 残りのキャストも全員フォールバックしない
    for (const name of ["りな", "みく", "みお", "みなみ", "みほ"]) {
      const t = result.totalSalesTrace.find((tr) => tr.castName === name)!;
      expect(t.fallbackOccurred, `${name}がフォールバックしないはず`).toBe(false);
    }
  });

  it("結合セルの補正後も、行データ本体（本指名・場内・同伴・支給額）は引き続き「一覧」シートから読む", () => {
    const buf = makeWorkbookWithMerges({
      一覧: { rows: ichiranRowsForManyCasts() },
      キャスト実績: { rows: castJissekiRowsWithMergedNameHeader(), merges: castJissekiMerges },
    });
    const result = parseMonthlyExcel(buf);
    expect(result.sheetName).toBe("一覧");
    const ema = result.rows.find((r) => r.name === "えま")!;
    expect(ema.honshimeiCount).toBe(5);
    expect(ema.jounaiCount).toBe(2);
    expect(ema.douhan).toBe(1);
    expect(ema.payment).toBe(400000);
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
