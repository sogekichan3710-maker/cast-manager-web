import * as XLSX from "xlsx";

/**
 * 月別成績Excelのパース。
 *
 * 旧HTML版のExcelインポート（SheetJS使用）を踏襲し、
 * 1行目付近のヘッダー行を検出して列名（日本語）でマッピングする。
 * 旧index.htmlが本リポジトリに無いため、列名は旧版で使用していた
 * 日本語ラベル（月別成績画面と同一の語彙）+ 揺れの別名で受け付け、
 * 解釈できない行は errors として報告する（黙って捨てない）。
 */

export interface ExcelMonthlyRow {
  /** Excel上の行番号（1始まり・表示用） */
  rowNumber: number;
  name: string;
  /** 時給列が存在しない場合は null（時給変更判定をスキップ） */
  hourlyWage: number | null;
  totalSales: number;
  payment: number;
  honshimeiCount: number;
  honshimeiGroupCount: number;
  customerCount: number;
  jounaiCount: number;
  douhan: number;
  workDays: number;
  workHours: number;
  absent: number;
  notes: string;
}

export interface ExcelParseResult {
  rows: ExcelMonthlyRow[];
  /** 解釈できなかった行（行番号と理由） */
  errors: Array<{ rowNumber: number; reason: string }>;
  /** 検出したヘッダーと列の対応（確認表示用） */
  headerMap: Record<string, string>;
  sheetName: string;
}

/** 列名エイリアス（正規化後の文字列で比較） */
const COLUMN_ALIASES: Record<keyof Omit<ExcelMonthlyRow, "rowNumber">, string[]> = {
  name: ["源氏名", "名前", "キャスト名", "キャスト", "name"],
  hourlyWage: ["時給", "現在時給", "hourlywage", "wage"],
  totalSales: ["総売上", "売上", "総売り上げ", "totalsales", "sales"],
  payment: ["支給額", "給料", "給与", "支給", "payment"],
  honshimeiCount: ["本指名", "本指名本数", "honshimei"],
  honshimeiGroupCount: ["本指名組数", "本指名組", "本指名(組)", "hongroup"],
  customerCount: ["顧客数", "客数", "customers"],
  jounaiCount: ["場内", "場内指名", "jounai"],
  douhan: ["同伴", "同伴数", "douhan"],
  workDays: ["出勤日数", "出勤", "workdays"],
  workHours: ["出勤時間", "勤務時間", "workhours"],
  absent: ["欠勤", "欠勤数", "absent"],
  notes: ["備考", "メモ", "notes", "note"],
};

function normHeader(v: unknown): string {
  return String(v ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "");
}

function toNum(v: unknown): number {
  if (v == null || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(String(v).replace(/[,¥￥\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/**
 * ExcelのArrayBufferをパースして行データへ変換する。
 * 最初のシートを対象とし、先頭10行からヘッダー行（名前列を含む行）を探す。
 */
export function parseMonthlyExcel(buffer: ArrayBuffer): ExcelParseResult {
  const wb = XLSX.read(buffer, { type: "array" });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error("Excelにシートがありません");
  const sheet = wb.Sheets[sheetName];
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: "",
  });

  // ヘッダー行の検出: 名前列のエイリアスを含む最初の行
  let headerRowIdx = -1;
  let colIndex: Partial<Record<keyof Omit<ExcelMonthlyRow, "rowNumber">, number>> = {};
  for (let r = 0; r < Math.min(grid.length, 10); r++) {
    const cells = (grid[r] ?? []).map(normHeader);
    const nameCol = cells.findIndex((c) => COLUMN_ALIASES.name.includes(c));
    if (nameCol < 0) continue;
    headerRowIdx = r;
    colIndex = {};
    (Object.keys(COLUMN_ALIASES) as Array<keyof typeof COLUMN_ALIASES>).forEach((field) => {
      const idx = cells.findIndex((c) => c !== "" && COLUMN_ALIASES[field].includes(c));
      if (idx >= 0) colIndex[field] = idx;
    });
    break;
  }
  if (headerRowIdx < 0 || colIndex.name === undefined) {
    throw new Error(
      "ヘッダー行が見つかりません。1行目付近に「源氏名」（または「名前」）列を含むシートを指定してください。"
    );
  }

  const headerMap: Record<string, string> = {};
  const headerCells = (grid[headerRowIdx] ?? []).map((v) => String(v ?? ""));
  (Object.entries(colIndex) as Array<[string, number]>).forEach(([field, idx]) => {
    headerMap[field] = headerCells[idx] ?? "";
  });

  const rows: ExcelMonthlyRow[] = [];
  const errors: Array<{ rowNumber: number; reason: string }> = [];
  const hasWageCol = colIndex.hourlyWage !== undefined;

  for (let r = headerRowIdx + 1; r < grid.length; r++) {
    const cells = grid[r] ?? [];
    const rowNumber = r + 1;
    const isEmptyRow = cells.every((c) => c == null || String(c).trim() === "");
    if (isEmptyRow) continue;
    const name = String(cells[colIndex.name!] ?? "").trim();
    if (!name) {
      errors.push({ rowNumber, reason: "名前が空の行のためスキップします" });
      continue;
    }
    const get = (field: keyof typeof COLUMN_ALIASES): unknown =>
      colIndex[field] !== undefined ? cells[colIndex[field]!] : "";
    rows.push({
      rowNumber,
      name,
      hourlyWage: hasWageCol ? Math.round(toNum(get("hourlyWage"))) : null,
      totalSales: Math.round(toNum(get("totalSales"))),
      payment: Math.round(toNum(get("payment"))),
      honshimeiCount: toNum(get("honshimeiCount")),
      honshimeiGroupCount: toNum(get("honshimeiGroupCount")),
      customerCount: toNum(get("customerCount")),
      jounaiCount: toNum(get("jounaiCount")),
      douhan: toNum(get("douhan")),
      workDays: toNum(get("workDays")),
      workHours: toNum(get("workHours")),
      absent: toNum(get("absent")),
      notes: String(get("notes") ?? "").trim(),
    });
  }

  return { rows, errors, headerMap, sheetName };
}
