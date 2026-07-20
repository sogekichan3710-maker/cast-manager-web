import * as XLSX from "xlsx";

/**
 * 給与明細Excel（.xls / .xlsx）のパース。
 *
 * 実店舗の給与明細ファイルは複数シート（「設定」等のマスター/集計シートを含む）
 * を持つため、以下を行う:
 *  1. 全シートを走査し「給料明細シート」をスコアリングで自動判定
 *     （シート名 + ヘッダー行の検出品質 + 有効データ行数）
 *  2. ヘッダー行の自動判定（名前列 + 他の既知列が2つ以上そろう行のみ採用）
 *  3. データ範囲の判定（ヘッダー直後〜集計行/連続空行まで）
 *  4. 集計行・設定行・注釈行・空行・数値のみの行を理由付きで除外
 *     （本指名・場内指名・同伴・ボトル・ドリンク・合計・平均等は
 *       キャスト名として扱わない）
 *  5. 名前は検出した名前列からのみ取得。数値列は見出しで検出した列からのみ取得
 *
 * 判定できないシート・行は黙って捨てず、除外理由と警告を返し、
 * UI側でシートの手動選択・除外行の確認ができるようにする。
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

export interface ExcludedRow {
  rowNumber: number;
  /** 除外時に名前列にあった値（表示用） */
  value: string;
  reason: string;
}

export interface SheetInfo {
  name: string;
  adopted: boolean;
  /** 採用/不採用の理由 */
  reason: string;
  /** ヘッダー行（1始まり）。検出できなかった場合は null */
  headerRowNumber: number | null;
  /** 検出できた有効データ行数 */
  validRows: number;
}

export interface ExcelParseResult {
  rows: ExcelMonthlyRow[];
  /** 理由付きの除外行 */
  excluded: ExcludedRow[];
  /** 検出したヘッダーと列の対応（確認表示用） */
  headerMap: Record<string, string>;
  /** 採用したシート */
  sheetName: string;
  /** ヘッダー行（1始まり） */
  headerRowNumber: number;
  /** データ開始行・終了行（1始まり。データ0件時は null） */
  dataStartRow: number | null;
  dataEndRow: number | null;
  /** 全シートの判定結果（手動選択UI用） */
  sheets: SheetInfo[];
  /** 0件・件数過多・シート名が怪しい等の警告 */
  warnings: string[];
}

/** 列名エイリアス（正規化後の文字列で比較） */
const COLUMN_ALIASES: Record<keyof Omit<ExcelMonthlyRow, "rowNumber">, string[]> = {
  name: ["源氏名", "名前", "キャスト名", "キャスト", "氏名", "name"],
  hourlyWage: ["時給", "現在時給", "hourlywage", "wage"],
  totalSales: ["総売上", "売上", "総売り上げ", "売上合計", "totalsales", "sales"],
  payment: ["支給額", "給料", "給与", "支給", "総支給額", "payment"],
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

/**
 * キャスト名として扱わない語（正規化後の完全一致、または合計/平均系の前後方一致）。
 * 実ファイルの「設定」シート・集計領域に現れる項目名を含む。
 */
export const EXCLUDED_NAME_WORDS: ReadonlyArray<string> = [
  "本指名",
  "本指名本数",
  "本指名組数",
  "場内指名",
  "場内",
  "同伴",
  "ボトル",
  "ドリンク",
  "合計",
  "小計",
  "総計",
  "平均",
  "売上",
  "総売上",
  "給与",
  "給料",
  "支給額",
  "支給",
  "時給",
  "欠勤",
  "出勤",
  "出勤日数",
  "出勤時間",
  "顧客数",
  "客数",
  "指名",
  "バック",
  "キャスト",
  "キャスト名",
  "名前",
  "源氏名",
  "氏名",
  "備考",
  "設定",
  "項目",
  "単価",
  "金額",
  "件数",
  "人数",
  "日付",
  "月",
];

/** シート名の判定語 */
const SHEET_NAME_BONUS = ["明細", "給料", "給与", "キャスト", "一覧", "リスト"];
const SHEET_NAME_PENALTY = ["設定", "config", "master", "マスタ", "集計", "テンプレ", "template", "sheet"];

/** データ終了とみなす連続無効行数 */
const MAX_CONSECUTIVE_INVALID = 5;
/** 「異常に多い」とみなすキャスト行数 */
const TOO_MANY_ROWS = 150;

function normText(v: unknown): string {
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

/** 数値のみ（"55" / 55 / "1,200" / "¥500" 等）か */
function isNumericOnly(raw: string): boolean {
  const s = raw.normalize("NFKC").trim().replace(/[,¥￥\s%％]/g, "");
  return s !== "" && /^[-+]?\d+(\.\d+)?$/.test(s);
}

/**
 * キャスト名として不適切な値の判定。除外理由を返す（適切なら null）。
 * 名前列のセルにのみ適用する。
 */
export function invalidCastNameReason(raw: string): string | null {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "名前が空欄";
  if (isNumericOnly(trimmed)) return "数値のみのため（キャスト名ではない）";
  const n = normText(trimmed);
  for (const word of EXCLUDED_NAME_WORDS) {
    const w = normText(word);
    if (n === w) return `集計・設定項目「${trimmed}」のため`;
  }
  // 「〇〇合計」「合計〇〇」「〇〇平均」等の集計行
  if (/(合計|小計|総計|平均)/.test(n)) return `集計行「${trimmed}」のため`;
  // 記号のみ・区切り線
  if (/^[-=＝ー─―_*．.。・:：\s]+$/.test(trimmed)) return "区切り・記号のみのため";
  return null;
}

interface HeaderDetection {
  headerRowIdx: number; // 0始まり
  colIndex: Partial<Record<keyof Omit<ExcelMonthlyRow, "rowNumber">, number>>;
  /** 名前列以外に検出できた既知列数 */
  knownCols: number;
}

/**
 * ヘッダー行を探す。
 * 「名前列エイリアスを含み、かつ他の既知列（時給・総売上・支給額等）が
 *  2つ以上そろう行」のみをヘッダーとして認める。
 * （「設定」シートの単独ラベルをヘッダーと誤認しないため）
 */
function detectHeader(grid: unknown[][], maxScan = 30): HeaderDetection | null {
  let best: HeaderDetection | null = null;
  for (let r = 0; r < Math.min(grid.length, maxScan); r++) {
    const cells = (grid[r] ?? []).map(normText);
    const nameCol = cells.findIndex((c) => COLUMN_ALIASES.name.includes(c));
    if (nameCol < 0) continue;
    const colIndex: HeaderDetection["colIndex"] = { name: nameCol };
    let knownCols = 0;
    (Object.keys(COLUMN_ALIASES) as Array<keyof typeof COLUMN_ALIASES>).forEach((field) => {
      if (field === "name") return;
      const idx = cells.findIndex((c) => c !== "" && COLUMN_ALIASES[field].includes(c));
      if (idx >= 0 && idx !== nameCol) {
        colIndex[field] = idx;
        knownCols++;
      }
    });
    if (knownCols < 2) continue; // 名前+既知2列未満はヘッダーと認めない
    if (!best || knownCols > best.knownCols) {
      best = { headerRowIdx: r, colIndex, knownCols };
    }
  }
  return best;
}

interface SheetScan {
  name: string;
  header: HeaderDetection | null;
  grid: unknown[][];
  rows: ExcelMonthlyRow[];
  excluded: ExcludedRow[];
  dataStartRow: number | null;
  dataEndRow: number | null;
  score: number;
}

/** ヘッダー検出済みシートからデータ行・除外行を抽出する */
function extractRows(grid: unknown[][], header: HeaderDetection): Pick<SheetScan, "rows" | "excluded" | "dataStartRow" | "dataEndRow"> {
  const { headerRowIdx, colIndex } = header;
  const rows: ExcelMonthlyRow[] = [];
  const excluded: ExcludedRow[] = [];
  const hasWageCol = colIndex.hourlyWage !== undefined;
  let consecutiveInvalid = 0;
  let stopped = false;

  const get = (cells: unknown[], field: keyof typeof COLUMN_ALIASES): unknown =>
    colIndex[field] !== undefined ? cells[colIndex[field]!] : "";

  for (let r = headerRowIdx + 1; r < grid.length; r++) {
    if (stopped) break;
    const cells = grid[r] ?? [];
    const rowNumber = r + 1;
    const rawName = String(cells[colIndex.name!] ?? "").trim();
    const isEmptyRow = cells.every((c) => c == null || String(c).trim() === "");

    if (isEmptyRow) {
      consecutiveInvalid++;
      if (consecutiveInvalid >= MAX_CONSECUTIVE_INVALID && rows.length > 0) {
        stopped = true; // データ領域の終わり（以降は集計・注釈領域とみなす）
      }
      continue;
    }

    const reason = invalidCastNameReason(rawName);
    if (reason) {
      // 合計・平均行が出たら以降を集計領域とみなして打ち切る（データ行検出済みの場合）
      const isSummary = rows.length > 0 && /(合計|小計|総計|平均)/.test(normText(rawName));
      excluded.push({
        rowNumber,
        value: rawName,
        reason: isSummary ? `${reason}。以降はデータ範囲外として読み込みを終了` : reason,
      });
      if (isSummary) stopped = true;
      consecutiveInvalid++;
      if (consecutiveInvalid >= MAX_CONSECUTIVE_INVALID && rows.length > 0) stopped = true;
      continue;
    }

    consecutiveInvalid = 0;
    rows.push({
      rowNumber,
      name: rawName,
      hourlyWage: hasWageCol ? Math.round(toNum(get(cells, "hourlyWage"))) : null,
      totalSales: Math.round(toNum(get(cells, "totalSales"))),
      payment: Math.round(toNum(get(cells, "payment"))),
      honshimeiCount: toNum(get(cells, "honshimeiCount")),
      honshimeiGroupCount: toNum(get(cells, "honshimeiGroupCount")),
      customerCount: toNum(get(cells, "customerCount")),
      jounaiCount: toNum(get(cells, "jounaiCount")),
      douhan: toNum(get(cells, "douhan")),
      workDays: toNum(get(cells, "workDays")),
      workHours: toNum(get(cells, "workHours")),
      absent: toNum(get(cells, "absent")),
      notes: String(get(cells, "notes") ?? "").trim(),
    });
  }

  return {
    rows,
    excluded,
    dataStartRow: rows.length > 0 ? rows[0].rowNumber : null,
    dataEndRow: rows.length > 0 ? rows[rows.length - 1].rowNumber : null,
  };
}

/** シート名によるスコア（給料明細らしさ） */
function sheetNameScore(name: string): number {
  const n = normText(name);
  let score = 0;
  for (const w of SHEET_NAME_BONUS) if (n.includes(normText(w))) score += 30;
  for (const w of SHEET_NAME_PENALTY) if (n.includes(normText(w))) score -= 60;
  return score;
}

/**
 * ExcelのArrayBufferをパースする。
 * @param opts.sheetName 指定した場合はそのシートを強制採用（手動選択UI用）
 */
export function parseMonthlyExcel(
  buffer: ArrayBuffer,
  opts?: { sheetName?: string }
): ExcelParseResult {
  const wb = XLSX.read(buffer, { type: "array" });
  if (wb.SheetNames.length === 0) throw new Error("Excelにシートがありません");

  // ---- 全シートを走査してスコアリング ----
  const scans: SheetScan[] = wb.SheetNames.map((name) => {
    const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], {
      header: 1,
      raw: true,
      defval: "",
    });
    const header = detectHeader(grid);
    if (!header) {
      return { name, header: null, grid, rows: [], excluded: [], dataStartRow: null, dataEndRow: null, score: sheetNameScore(name) - 1000 };
    }
    const extracted = extractRows(grid, header);
    // スコア: シート名 + 既知列数×10 + 有効行数（最大50）
    const score =
      sheetNameScore(name) + header.knownCols * 10 + Math.min(extracted.rows.length, 50);
    return { name, header, grid, ...extracted, score };
  });

  // ---- 採用シートの決定 ----
  let adopted: SheetScan | undefined;
  if (opts?.sheetName) {
    adopted = scans.find((s) => s.name === opts.sheetName);
    if (!adopted) throw new Error(`シート「${opts.sheetName}」が見つかりません`);
  } else {
    adopted = scans
      .filter((s) => s.header !== null && s.rows.length > 0)
      .sort((a, b) => b.score - a.score)[0];
    if (!adopted) {
      // ヘッダー+データを検出できたシートが1つも無い
      const sheetList = wb.SheetNames.join(" / ");
      throw new Error(
        `給料明細のヘッダー行（「源氏名」または「名前」+ 時給・総売上等の列）を検出できるシートがありません。` +
          `シート: ${sheetList}。正しいシートか、ヘッダー行の列名をご確認ください。`
      );
    }
  }

  if (!adopted.header) {
    throw new Error(
      `シート「${adopted.name}」ではヘッダー行（名前列 + 時給・総売上等2列以上）を検出できませんでした。別のシートを選択してください。`
    );
  }

  // ---- シート判定結果（UI表示用） ----
  const sheets: SheetInfo[] = scans.map((s) => ({
    name: s.name,
    adopted: s === adopted,
    reason:
      s === adopted
        ? "給料明細シートとして採用"
        : s.header === null
          ? "ヘッダー行を検出できないため除外（設定・集計シートの可能性）"
          : s.rows.length === 0
            ? "有効なキャスト行が無いため除外"
            : "採用シートよりスコアが低いため除外",
    headerRowNumber: s.header ? s.header.headerRowIdx + 1 : null,
    validRows: s.rows.length,
  }));

  // ---- 警告 ----
  const warnings: string[] = [];
  if (adopted.rows.length === 0) {
    warnings.push("キャスト行を1件も検出できませんでした。シート・ヘッダー行をご確認ください。");
  }
  if (adopted.rows.length > TOO_MANY_ROWS) {
    warnings.push(
      `検出行数が${adopted.rows.length}件と異常に多いため、集計領域を誤って読み込んでいる可能性があります。除外行と行範囲をご確認ください。`
    );
  }
  if (sheetNameScore(adopted.name) < 0) {
    warnings.push(
      `採用シート名「${adopted.name}」は設定・集計シートの可能性があります。正しいシートか確認し、必要ならシートを選択し直してください。`
    );
  }
  if (adopted.excluded.length > adopted.rows.length && adopted.rows.length > 0) {
    warnings.push("除外行がキャスト行より多くなっています。除外理由をご確認ください。");
  }

  const headerCells = (adopted.grid[adopted.header.headerRowIdx] ?? []).map((v) => String(v ?? ""));
  const headerMap: Record<string, string> = {};
  (Object.entries(adopted.header.colIndex) as Array<[string, number]>).forEach(([field, idx]) => {
    headerMap[field] = headerCells[idx] ?? "";
  });

  return {
    rows: adopted.rows,
    excluded: adopted.excluded,
    headerMap,
    sheetName: adopted.name,
    headerRowNumber: adopted.header.headerRowIdx + 1,
    dataStartRow: adopted.dataStartRow,
    dataEndRow: adopted.dataEndRow,
    sheets,
    warnings,
  };
}
