import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseMonthlyExcel, readWorkbook, scanSheet } from "@/lib/excel/parseMonthlyExcel";

/**
 * REGINA店舗の実給料明細ファイル「2026年6月 キャスト給料明細.xlsx」の調査で
 * 判明した2点を再現するテスト。
 *
 * 1. 「一覧」シートの実際の列構成（源氏名B列/時給C列/出勤数G列/労働時間H列/
 *    同伴組J列/本指名M列/場内O列/総支給額V列/総売上AA列）は既存の見出し名
 *    ベースの汎用ロジックで正しく解析できる（VIRGO専用のロジックではない）
 * 2. 個別キャストシートの1枚（実ファイルでは「にこ」）のシート範囲（!ref）が
 *    Excelの書式設定等の副作用で約104万行に膨れ上がっており、これが
 *    「インポートできません」の実際の原因だった。全シートを無条件に
 *    総当たりでスキャンする現行実装は、この1シートの解析だけで
 *    ブラウザが応答不能になるほど遅くなる（実測: 数分以上・メモリ数GB）。
 *
 * 実ファイルは個人情報（源氏名・給与額）を含むためコミットしない。
 * 実ファイルでの検証結果: 修正後は全97シートを414msで解析完了（PR参照）。
 */

function makeWorkbook(sheets: Record<string, unknown[][]>): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
}

/**
 * REGINA実ファイルの「一覧」シートの実列構成を再現（列位置は実ファイル調査で確認済み）。
 * A列は空、B列=源氏名、C列=時給、D〜F列は歩合関連、G列=出勤数、H列=労働時間、
 * I列=日当、J列=同伴組、K〜U列はバック関連、V列=総支給額、W〜Z列は日払い等、
 * AA列=総売上（実ファイルでは「合計」相当の列）。
 */
function reginaIchiranRows(): unknown[][] {
  const header = new Array(27).fill("");
  header[1] = "源氏名";
  header[2] = "時給";
  header[6] = "出勤数";
  header[7] = "労働時間";
  header[9] = "同伴組";
  header[12] = "本指名";
  header[14] = "場内";
  header[21] = "総支給額";
  header[26] = "総売上";

  function row(name: string, wage: number, days: number, hours: number, douhan: number, honmei: number, jounai: number, payment: number, sales: number): unknown[] {
    const r = new Array(27).fill("");
    r[1] = name;
    r[2] = wage;
    r[6] = days;
    r[7] = hours;
    r[9] = douhan;
    r[12] = honmei;
    r[14] = jounai;
    r[21] = payment;
    r[26] = sales;
    return r;
  }

  return [
    ["", "REGINA", 6, "月度", "", "", "", "", "給与支給表"],
    header,
    row("せいら", 15000, 15, 56.75, 1, 1, 6, 851500, 449000),
    row("ももか", 15000, 17, 63.25, 2, 14.5, 6.5, 974000, 910300),
  ];
}

describe("parseMonthlyExcel: REGINA「一覧」シートの実列構成", () => {
  it("VIRGO専用ロジックではなく見出し名ベースの汎用ロジックで正しく解析できる", () => {
    const buf = makeWorkbook({ 一覧: reginaIchiranRows() });
    const result = parseMonthlyExcel(buf);
    expect(result.sheetName).toBe("一覧");
    expect(result.headerMap).toMatchObject({
      name: "源氏名",
      hourlyWage: "時給",
      workDays: "出勤数",
      workHours: "労働時間",
      douhan: "同伴組",
      honshimeiCount: "本指名",
      jounaiCount: "場内",
      payment: "総支給額",
      totalSales: "総売上",
    });
    const seira = result.rows.find((r) => r.name === "せいら")!;
    expect(seira.hourlyWage).toBe(15000);
    expect(seira.workDays).toBe(15);
    expect(seira.workHours).toBe(56.75);
    expect(seira.douhan).toBe(1);
    expect(seira.honshimeiCount).toBe(1);
    expect(seira.jounaiCount).toBe(6);
    expect(seira.payment).toBe(851500);
    expect(seira.totalSales).toBe(449000);
  });
});

describe("parseMonthlyExcel: 異常に大きいシート範囲への対応（実ファイルで発見した根本原因）", () => {
  /** 実データは数行だけだが、!ref を強制的に巨大化させて実ファイルの症状を再現する */
  function makeBloatedRangeWorkbook(bloatedRows: number): ArrayBuffer {
    const wb = XLSX.utils.book_new();
    const normalSheet = XLSX.utils.aoa_to_sheet(reginaIchiranRows());
    XLSX.utils.book_append_sheet(wb, normalSheet, "一覧");

    const bloatedRows2: unknown[][] = [
      ["", "", "", "", "", "", "", "キャスト名", ""],
      [6, "", "", "", "", "", "", "にこ", ""],
      ["日", "曜日", "時給", "IN", "OUT", "労時間", "日当", "同伴組", ""],
      [46174, "", 15000, "", "", "", 0, "", ""],
    ];
    const bloated = XLSX.utils.aoa_to_sheet(bloatedRows2);
    // 実ファイルで確認された症状の再現: シート範囲(!ref)だけが異常に大きい
    // （実データはA1:I4相当だが、書式設定等の副作用でrefが巨大化する）
    bloated["!ref"] = XLSX.utils.encode_range({
      s: { r: 0, c: 0 },
      e: { r: bloatedRows - 1, c: 130 },
    });
    XLSX.utils.book_append_sheet(wb, bloated, "にこ");

    return XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  }

  it("シート範囲が上限を超える場合はクランプして読み込み、truncatedを立てる", () => {
    const buf = makeBloatedRangeWorkbook(3000); // MAX_SCAN_ROWS(2000)を超える宣言範囲
    const wb = readWorkbook(buf);
    const scan = scanSheet(wb, "にこ");
    expect(scan.truncated).toBe(true);
    expect(scan.grid.length).toBeLessThanOrEqual(2000);
  });

  it("正常範囲のシートはtruncatedにならない", () => {
    const buf = makeBloatedRangeWorkbook(3000);
    const wb = readWorkbook(buf);
    const scan = scanSheet(wb, "一覧");
    expect(scan.truncated).toBe(false);
  });

  it("巨大範囲シートが存在しても解析全体がタイムアウトせず完了し、正しいシートを採用する", () => {
    const buf = makeBloatedRangeWorkbook(3000);
    const result = parseMonthlyExcel(buf);
    expect(result.sheetName).toBe("一覧");
    expect(result.rows.map((r) => r.name)).toEqual(["せいら", "ももか"]);
  });

  it("採用シート自体が巨大範囲の場合は警告とシート情報に理由が表示される", () => {
    // 「一覧」を巨大範囲にして、採用シート自体がtruncatedになるケース
    const wb = XLSX.utils.book_new();
    const ichiran = XLSX.utils.aoa_to_sheet(reginaIchiranRows());
    ichiran["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 2999, c: 26 } });
    XLSX.utils.book_append_sheet(wb, ichiran, "一覧");
    const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;

    const result = parseMonthlyExcel(buf);
    expect(result.warnings.some((w) => w.includes("先頭") && w.includes("行までで読み込み"))).toBe(true);
    const sheetInfo = result.sheets.find((s) => s.name === "一覧");
    expect(sheetInfo?.reason).toContain("読み込み");
  });
});

describe("parseMonthlyExcel: 数式エラー値（#REF!等）への対応", () => {
  it("数式エラー値を含む行は理由付きで除外し、黙って0扱いにしない", () => {
    const rows: unknown[][] = [
      ["源氏名", "時給", "出勤日数", "総売上", "支給額"],
      ["あいり", 5000, 20, 1500000, 520000],
      ["こわれ", 5000, 20, "#REF!", 520000], // 他シート参照が壊れているケース
    ];
    const buf = makeWorkbook({ 給料明細: rows });
    const result = parseMonthlyExcel(buf);
    expect(result.rows.map((r) => r.name)).toEqual(["あいり"]);
    const excludedRow = result.excluded.find((e) => e.value === "こわれ");
    expect(excludedRow?.reason).toContain("数式エラー");
    expect(excludedRow?.reason).toContain("売上");
    expect(result.warnings.some((w) => w.includes("数式エラー"))).toBe(true);
  });
});

describe("readWorkbook: 壊れたファイル・非Excelファイルのエラー表示", () => {
  it("Excelとして読み取れない壊れたバイナリには具体的なエラーメッセージを出す", () => {
    // ZIPのマジックバイトはあるが中身が壊れている（.xlsxはZIP形式のため
    // ファイルが壊れている・拡張子だけExcelを装っているケースを再現）
    const corrupted = new Uint8Array([
      0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff,
    ]).buffer;
    expect(() => readWorkbook(corrupted)).toThrow(/ファイル形式/);
  });

  it("Excel形式と解釈できないテキストは、後段の見出し検出エラーとして具体的に報告される", () => {
    // SheetJSはプレーンテキストもCSV相当として寛容に読み込むため、この場合は
    // readWorkbook自体は例外を投げないが、後段でヘッダー未検出として明確に報告される
    const notExcel = new TextEncoder().encode("これはExcelファイルではありません").buffer;
    expect(() => parseMonthlyExcel(notExcel as ArrayBuffer)).toThrow(/ヘッダー行/);
  });
});
