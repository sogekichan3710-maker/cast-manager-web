import * as XLSX from "xlsx";

/**
 * 給与明細Excel（.xls / .xlsx）のパース。
 *
 * 実店舗の給与明細ファイルは複数シート（「設定」等のマスター/集計シートを含む）
 * を持つため、以下を行う:
 *  1. 全シートを走査し「給料明細シート」をスコアリングで自動判定
 *     （シート名 + ヘッダー行の検出品質 + 有効データ行数）。行データ本体
 *     （名前・時給・本指名・場内・同伴・支給額等）はこの採用シートから読む
 *  2. ヘッダー行の自動判定（名前列 + 他の既知列が2つ以上そろう行のみ採用）
 *  3. データ範囲の判定（ヘッダー直後〜集計行/連続空行まで）
 *  4. 集計行・設定行・注釈行・空行・数値のみの行を理由付きで除外
 *     （本指名・場内指名・同伴・ボトル・ドリンク・合計・平均等は
 *       キャスト名として扱わない）
 *  5. 名前は検出した名前列からのみ取得。数値列は見出しで検出した列からのみ取得
 *  6. totalSales（総売上）だけは特別扱い: ワークブックに「キャスト実績」という
 *     名前のシートがあれば、その「合計」列を氏名一致で取得しtotalSalesを
 *     上書きする（findTotalSalesOverride参照）。無ければ採用シート自身の
 *     「合計」等の別名検出結果のまま（他の項目には一切影響しない）
 *
 * 判定できないシート・行は黙って捨てず、除外理由と警告を返し、
 * UI側でシートの手動選択・除外行の確認ができるようにする。
 */

/**
 * セル参照情報（照合確認画面でのトレース表示用）。
 * formula が非nullの場合、totalSales はそのセルの数式ではなく
 * ファイル保存時点のキャッシュ値（cell.v）である点に注意
 * （xlsxはブラウザ上で数式を再計算しない）。
 */
export interface ExcelCellRef {
  /** 例: "F12"（1始まりのExcel表記） */
  address: string;
  /** セルが数式の場合はその式（例: "=C12*D12"）。数式でなければ null */
  formula: string | null;
}

export interface ExcelMonthlyRow {
  /** Excel上の行番号（1始まり・表示用） */
  rowNumber: number;
  name: string;
  /** 時給列が存在しない場合は null（時給変更判定をスキップ） */
  hourlyWage: number | null;
  /** スカウト者（PR6で追加）。列が存在しない場合は空文字 */
  scoutedBy: string;
  /**
   * 指名売上（「指名」「指名売上」列。金額）。本指名の**本数**（honshimeiCount）とは
   * 別概念。列が存在しない場合は0
   */
  shimeiSales?: number;
  /**
   * 指名売上セルの参照情報（照合確認画面でのトレース表示用）。
   * 列が無い場合は null。手動構築のテストデータでは undefined でもよい
   */
  shimeiSalesCell?: ExcelCellRef | null;
  /**
   * 総売上。他の項目（名前・時給・本指名・場内・同伴・支給額等）と同じ採用
   * シートの「合計」等の別名検出結果が基本値だが、ワークブックに「キャスト実績」
   * という名前のシートがあれば、その「合計」列を氏名一致で取得し上書きする
   * （findTotalSalesOverride参照。他の値から計算することはない）
   */
  totalSales: number;
  /**
   * 総売上セルの参照情報（照合確認画面でのトレース表示用）。
   * 列が無い場合は null。手動構築のテストデータでは undefined でもよい
   */
  totalSalesCell?: ExcelCellRef | null;
  /**
   * totalSalesの実際の取得元シート名（照合確認画面でのトレース表示用）。
   * 「キャスト実績」シートで上書きされた場合はそのシート名、されなかった場合は
   * 採用シート名と同じになる
   */
  totalSalesSheetName?: string;
  payment: number;
  honshimeiCount: number;
  honshimeiGroupCount: number;
  customerCount: number;
  /**
   * 「場内」列の値。旧フォーマットでは場内指名の**本数**、
   * 「指名」列がある新フォーマットでは場内売上の**金額**として使われる
   * （店舗ごとのファイル構成の違い。列名だけでは区別できないため、値の意味は
   * 「指名」列の有無で判断する＝shimeiSalesが検出された行のみ金額として合算する）
   */
  jounaiCount: number;
  /**
   * 場内セルの参照情報（照合確認画面でのトレース表示用）。列が無い場合は null
   */
  jounaiCountCell?: ExcelCellRef | null;
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
  /**
   * スカウト者（情報提供者）列の検出状況の詳細（調査・デバッグ表示用）。
   * 主シートに列が無い場合は他シートからの自動補完を試みるため、
   * どのシート・どの列から取得したかを追跡できるようにする。
   */
  scoutedByDebug: ScoutedByDebugInfo | null;
  /**
   * totalSales（売上）の取得元の詳細（調査・デバッグ表示用）。「キャスト実績」
   * という名前のシートがあれば、その「合計」列を氏名一致で採用する
   * （行データ本体の採用シートとは独立。無い場合は採用シート自身の値のまま）
   */
  totalSalesOverrideDebug: TotalSalesOverrideDebugInfo;
  /**
   * ワークブック内の全シートの「キャスト実績」判定・ヘッダー/氏名列/合計列の
   * 検出状況（調査・デバッグ表示用。totalSalesOverrideDebugがnoneの場合に
   * 「どの段階で候補から外れたか」を全シート分確認できる）
   */
  totalSalesSheetDiagnostics: TotalSalesSheetDiagnostic[];
  /**
   * キャストごとの総売上トレース（調査・デバッグ表示用）。「キャスト実績」
   * シートで取得した値・行データ採用シートで取得した値・最終的に採用した
   * 値/シート/列/セル・採用理由を1名ずつ突き合わせる
   */
  totalSalesTrace: TotalSalesTraceRow[];
}

export interface ScoutedByDebugSample {
  rowNumber: number;
  name: string;
  raw: string;
  trimmed: string;
}

export interface ScoutedByDebugInfo {
  /** "primary": 採用シート自体に列があった / "supplement": 他シートから補完 / "none": 検出できず */
  source: "primary" | "supplement" | "none";
  sheetName: string;
  headerLabel: string;
  /** 1始まり */
  columnNumber: number | null;
  /** 1始まり */
  headerRowNumber: number | null;
  /** 1始まり（名前列。結合セルにより補正された場合はその補正後の列） */
  nameColumnNumber: number | null;
  sample: ScoutedByDebugSample[];
  reason: string;
}

/**
 * 列名エイリアス（正規化後の文字列で比較・**配列の並び順が優先順位**）。
 * 実店舗の給与明細（VIRGO 2024年7月）の「一覧」シートの列名
 * （源氏名 / 時給 / 出勤数 / 労働時間 / 同伴組 / 本指名 / 場内 / 売上 /
 *   総支給額）を含む。同義列が複数あるシートでは先頭の別名を優先する。
 */
const COLUMN_ALIASES: Record<
  keyof Omit<
    ExcelMonthlyRow,
    "rowNumber" | "totalSalesCell" | "totalSalesSheetName" | "shimeiSalesCell" | "jounaiCountCell"
  >,
  string[]
> = {
  name: ["源氏名", "キャスト名", "名前", "キャスト", "氏名", "name"],
  hourlyWage: ["時給", "現在時給", "hourlywage", "wage"],
  scoutedBy: [
    "スカウト者",
    "情報提供者",
    "スカウト",
    "スカウト担当",
    "スカウト者名",
    "スカウト担当者",
    "スカウトマン",
    "紹介者",
    "情報提供者名",
    "scoutedby",
    "scout",
  ],
  // 指名売上（金額・参考値）。本指名の本数（honshimeiCount＝「本指名」列）とは
  // 別の列。「本指名」に前方一致してしまわないよう、findColumnは正規化後の
  // 完全一致で判定するため「指名」だけの列とは衝突しない。totalSalesの計算には
  // 一切使わない（下記totalSales参照）
  shimeiSales: ["指名売上", "指名"],
  // 総売上（totalSales）。行データ自体は他の項目（本指名・場内・同伴・支給額等）
  // と同じ採用シートから読むが、totalSalesの値だけは「キャスト実績」という
  // 名前のシートがあれば、その「合計」列を氏名一致で取得して上書きする
  // （findTotalSalesOverride参照）。「キャスト実績」シートが無い場合や、
  // 該当キャストが見つからない場合は、このエイリアス（採用シート自身の
  // 「合計」列。無ければ以下へフォールバック）で求めた値をそのまま使う
  totalSales: ["合計", "総売上", "売上", "売上合計", "総売り上げ", "totalsales", "sales"],
  // 実ファイルは「総支給額」（=日当+バック合計）。差引給与（日払い控除後）や
  // 最終支給額（税・消費税調整後）とは別列のため、優先順位で明示する
  payment: ["支給額", "総支給額", "支給合計", "給料", "給与", "支給", "payment"],
  honshimeiCount: ["本指名", "本指名本数", "本指名数", "honshimei"],
  honshimeiGroupCount: ["本指名組数", "本指名組", "本指名(組)", "hongroup"],
  customerCount: ["顧客数", "客数", "customers"],
  jounaiCount: ["場内", "場内指名", "jounai"],
  douhan: ["同伴", "同伴組", "同伴数", "douhan"],
  workDays: ["出勤日数", "出勤数", "出勤", "workdays"],
  workHours: ["出勤時間", "労働時間", "勤務時間", "労時間", "workhours"],
  absent: ["欠勤", "欠勤数", "absent"],
  notes: ["備考", "メモ", "notes", "note"],
};

/**
 * ヘッダー判定で「既知列」として数えるフィールド。
 * 備考はマスターシート（「設定」等）にも現れる弱いシグナルのため数えない。
 */
const HEADER_SIGNAL_FIELDS: ReadonlyArray<keyof typeof COLUMN_ALIASES> = [
  "hourlyWage",
  "shimeiSales",
  "totalSales",
  "payment",
  "honshimeiCount",
  "honshimeiGroupCount",
  "customerCount",
  "jounaiCount",
  "douhan",
  "workDays",
  "workHours",
  "absent",
];

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
/**
 * シートの絶対上限（行・列）。実運用スケール（キャスト数百名規模、
 * 日次データでも年単位で数千行程度）を大幅に超える値であり、
 * これに達するのは「実際に大量のデータがある」場合のみを想定した
 * 最終手段の安全装置（サーキットブレーカー）。通常はこの値ではなく
 * actualUsedRange() による実データ範囲の検出で安全性を確保する
 * （下記コメント参照）。
 */
const ABSOLUTE_MAX_ROWS = 20000;
const ABSOLUTE_MAX_COLS = 500;

/** 数式エラー値（#REF!等）の判定パターン */
const FORMULA_ERROR_PATTERN = /^#(REF|VALUE|DIV\/0|NAME|N\/A|NULL|NUM|ERROR)!?\??$/i;

function isFormulaErrorValue(v: unknown): boolean {
  return typeof v === "string" && FORMULA_ERROR_PATTERN.test(v.trim());
}

/** 数式エラーメッセージ表示用の日本語ラベル */
const FIELD_JA_LABELS: Record<keyof typeof COLUMN_ALIASES, string> = {
  name: "名前",
  hourlyWage: "時給",
  scoutedBy: "スカウト者",
  shimeiSales: "指名",
  totalSales: "売上",
  payment: "支給額",
  honshimeiCount: "本指名",
  honshimeiGroupCount: "本指名組数",
  customerCount: "顧客数",
  jounaiCount: "場内",
  douhan: "同伴",
  workDays: "出勤日数",
  workHours: "労働時間",
  absent: "欠勤",
  notes: "備考",
};

/** 数式エラー検出の対象とする数値系フィールド（名前・スカウト者・備考は対象外） */
const NUMERIC_FIELDS: ReadonlyArray<keyof typeof COLUMN_ALIASES> = [
  "hourlyWage",
  "shimeiSales",
  "totalSales",
  "payment",
  "honshimeiCount",
  "honshimeiGroupCount",
  "customerCount",
  "jounaiCount",
  "douhan",
  "workDays",
  "workHours",
  "absent",
];

/**
 * シートの宣言範囲（!ref）を信用せず、実際に値が入っているセルアドレスから
 * 真の使用範囲を求める。
 *
 * 実店舗のExcelファイルで、個別キャストシートの1枚だけ !ref が
 * 「A1:EU1048572」（Excelの行上限）になっている症状を確認した
 * （書式設定等の副作用と見られ、実データはA1:EU94相当のみ）。
 * !ref を信用してその範囲を読み込むと、実データが数十行しか無くても
 * 数百万セル分の配列生成を試みてブラウザが応答不能になる。
 *
 * SheetJSのワークシートオブジェクトは疎（値のあるセルのみキーを持つ）
 * ため、Object.keys() は実際に埋まっているセル数に比例した計算量で済み、
 * 宣言範囲がどれだけ巨大でも影響を受けない。
 */
function actualUsedRange(ws: XLSX.WorkSheet): XLSX.Range | null {
  let maxRow = -1;
  let maxCol = -1;
  let minRow = Infinity;
  let minCol = Infinity;
  for (const key of Object.keys(ws)) {
    if (key.startsWith("!")) continue; // !ref/!merges等のメタキーは対象外
    const addr = XLSX.utils.decode_cell(key);
    if (addr.r > maxRow) maxRow = addr.r;
    if (addr.c > maxCol) maxCol = addr.c;
    if (addr.r < minRow) minRow = addr.r;
    if (addr.c < minCol) minCol = addr.c;
  }
  if (maxRow < 0) return null; // セルが1つも無い
  return { s: { r: minRow, c: minCol }, e: { r: maxRow, c: maxCol } };
}

/**
 * シートを安全な範囲でグリッド化する。
 *
 * 宣言範囲（!ref）は使わず、実際に値があるセルから求めた使用範囲
 * （actualUsedRange）を優先する。これにより、!ref が書式設定等で
 * 不当に膨れ上がっていても実データの取りこぼしなく安全に読み込める
 * （宣言範囲だけを信用してクランプする方式とは異なり、行数・列数の
 * 上限による実データの切り捨てが起こらない）。
 *
 * ABSOLUTE_MAX_ROWS/COLS は、実際に値のあるセルがそれ自体で
 * その規模に達している場合（通常の業務データでは起こらない規模）に限り
 * 発動する最終手段の安全装置。この場合のみ本当にデータを切り捨てるため
 * truncated を立てて警告表示に使う。
 */
function safeGridFromSheet(
  ws: XLSX.WorkSheet
): { grid: unknown[][]; truncated: boolean; origin: { r: number; c: number } } {
  if (!ws["!ref"]) return { grid: [], truncated: false, origin: { r: 0, c: 0 } };
  const used = actualUsedRange(ws);
  if (!used) return { grid: [], truncated: false, origin: { r: 0, c: 0 } };

  const truncated = used.e.r + 1 > ABSOLUTE_MAX_ROWS || used.e.c + 1 > ABSOLUTE_MAX_COLS;
  const range: XLSX.Range = truncated
    ? { s: used.s, e: { r: Math.min(used.e.r, ABSOLUTE_MAX_ROWS - 1), c: Math.min(used.e.c, ABSOLUTE_MAX_COLS - 1) } }
    : used;

  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    raw: true,
    defval: "",
    range,
  });
  return { grid, truncated, origin: range.s };
}

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

/**
 * 小数2桁へ丸める（Excelの浮動小数点誤差対策。
 * 実ファイルの労働時間は 32.99999999999999 のような値になる）
 */
function to2(v: number): number {
  return Math.round(v * 100) / 100;
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
 * フィールドの列を探す。エイリアスの並び順を優先し、
 * 「支給額」と「総支給額」が両方ある場合は先頭のエイリアスを採用する。
 */
function findColumn(
  cells: string[],
  field: keyof typeof COLUMN_ALIASES,
  used: Set<number>
): number {
  for (const alias of COLUMN_ALIASES[field]) {
    const a = normText(alias);
    const idx = cells.findIndex((c, i) => c !== "" && c === a && !used.has(i));
    if (idx >= 0) return idx;
  }
  return -1;
}

/**
 * ヘッダー行を探す。
 * 「名前列エイリアスを含み、かつ数値系の既知列（時給・総売上・支給額・
 *  出勤数等）が2つ以上そろう行」のみをヘッダーとして認める。
 * （「設定」シートの「キャスト名+時給+備考」程度の行をヘッダーと誤認しないため）
 */
function detectHeader(grid: unknown[][], maxScan = 30): HeaderDetection | null {
  let best: HeaderDetection | null = null;
  for (let r = 0; r < Math.min(grid.length, maxScan); r++) {
    const cells = (grid[r] ?? []).map(normText);
    const nameCol = findColumn(cells, "name", new Set());
    if (nameCol < 0) continue;
    const used = new Set<number>([nameCol]);
    const colIndex: HeaderDetection["colIndex"] = { name: nameCol };
    let knownCols = 0;
    (Object.keys(COLUMN_ALIASES) as Array<keyof typeof COLUMN_ALIASES>).forEach((field) => {
      if (field === "name") return;
      const idx = findColumn(cells, field, used);
      if (idx >= 0) {
        colIndex[field] = idx;
        used.add(idx);
        if (HEADER_SIGNAL_FIELDS.includes(field)) knownCols++;
      }
    });
    if (knownCols < 2) continue; // 名前+数値系既知2列未満はヘッダーと認めない
    if (!best || knownCols > best.knownCols) {
      best = { headerRowIdx: r, colIndex, knownCols };
    }
  }
  return best;
}

export interface SheetScan {
  name: string;
  header: HeaderDetection | null;
  grid: unknown[][];
  rows: ExcelMonthlyRow[];
  excluded: ExcludedRow[];
  dataStartRow: number | null;
  dataEndRow: number | null;
  score: number;
  /** シート範囲が異常に大きく、読み込み範囲をクランプした場合 true */
  truncated: boolean;
}

/** セルの実アドレス・数式を求めるための文脈（総売上セルのトレース表示用） */
interface CellRefContext {
  ws: XLSX.WorkSheet;
  /** グリッドの(0,0)に対応するシート上の実座標（safeGridFromSheetのorigin） */
  origin: { r: number; c: number };
}

function cellRefAt(
  ctx: CellRefContext | null | undefined,
  gridRow: number,
  colIdx: number | undefined
): ExcelCellRef | null {
  if (!ctx || colIdx === undefined) return null;
  const address = XLSX.utils.encode_cell({
    r: ctx.origin.r + gridRow,
    c: ctx.origin.c + colIdx,
  });
  const cellObj = ctx.ws[address] as { f?: string } | undefined;
  return { address, formula: cellObj?.f ?? null };
}

/**
 * デバッグログ出力の可否（本番・プレビューではConsoleを汚さないよう抑止する）。
 * 既存の追跡ログ（excelImportService.ts の [excelImport:monthlyResults]）と同じ基準
 */
const DEBUG_LOG_ENABLED =
  typeof process !== "undefined" && process.env.NODE_ENV !== "production";

/** ヘッダー検出済みシートからデータ行・除外行を抽出する */
function extractRows(
  grid: unknown[][],
  header: HeaderDetection,
  cellRefContext?: CellRefContext | null
): Pick<SheetScan, "rows" | "excluded" | "dataStartRow" | "dataEndRow"> {
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

    // 数式エラー値（#REF!等）の検出。他シート参照の数式が壊れている場合、
    // 黙って0扱いにすると誤ったデータをそのまま保存してしまうため、
    // どの項目が取得不能だったかを明示したうえで行ごと除外する
    const errorFields = NUMERIC_FIELDS.filter(
      (field) => colIndex[field] !== undefined && isFormulaErrorValue(get(cells, field))
    );
    if (errorFields.length > 0) {
      const labels = errorFields.map((f) => FIELD_JA_LABELS[f]).join("・");
      excluded.push({
        rowNumber,
        value: rawName,
        reason: `数式エラーのため「${labels}」を取得できません。Excelを開いて再計算・保存し直すか、個別キャストシート等から値をご確認ください`,
      });
      continue;
    }

    consecutiveInvalid = 0;

    // totalSalesは「キャスト実績」シートの「合計」列（COLUMN_ALIASES.totalSales＝
    // ["合計"]のみ）の値をそのまま使う。指名（shimeiSales）・場内（jounaiCount）は
    // 内訳の参考値として保持するだけで、totalSalesの計算には一切使わない
    // （再計算・上書きをしない）
    const hasShimeiCol = colIndex.shimeiSales !== undefined;
    const shimeiSalesRaw = toNum(get(cells, "shimeiSales"));
    const jounaiRaw = toNum(get(cells, "jounaiCount"));
    const totalSalesValue = Math.round(toNum(get(cells, "totalSales")));

    rows.push({
      rowNumber,
      name: rawName,
      hourlyWage: hasWageCol ? Math.round(toNum(get(cells, "hourlyWage"))) : null,
      scoutedBy: String(get(cells, "scoutedBy") ?? "").trim(),
      shimeiSales: hasShimeiCol ? Math.round(shimeiSalesRaw) : 0,
      shimeiSalesCell: cellRefAt(cellRefContext, r, colIndex.shimeiSales),
      totalSales: totalSalesValue,
      totalSalesCell: cellRefAt(cellRefContext, r, colIndex.totalSales),
      payment: Math.round(toNum(get(cells, "payment"))),
      honshimeiCount: to2(toNum(get(cells, "honshimeiCount"))),
      honshimeiGroupCount: to2(toNum(get(cells, "honshimeiGroupCount"))),
      customerCount: to2(toNum(get(cells, "customerCount"))),
      jounaiCount: to2(jounaiRaw),
      jounaiCountCell: cellRefAt(cellRefContext, r, colIndex.jounaiCount),
      douhan: to2(toNum(get(cells, "douhan"))),
      workDays: to2(toNum(get(cells, "workDays"))),
      workHours: to2(toNum(get(cells, "workHours"))),
      absent: to2(toNum(get(cells, "absent"))),
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

/**
 * 名前列のヘッダーセルが複数列にまたがる結合セルの場合、実際に
 * 1行ごとの氏名が入っている列を結合範囲内から選び直す。
 *
 * 実店舗のExcel（「キャスト実績」シート等）では「キャスト名」ヘッダーが
 * 区分／No／氏名の3列にまたがる結合セルになっており、素直にヘッダー文字列の
 * 位置（先頭列）を名前列とみなすと、区分列（複数行にわたる縦結合で
 * 大半の行が空欄）やNo列（数値のみ）を誤って名前列としてしまう。
 * 結合範囲内の各列を実データ（ヘッダー直後の行）でスコアリングし、
 * 「非空・非数値のセルが最も多い列」を実際の名前列として採用する。
 */
function resolveMergedNameColumn(
  grid: unknown[][],
  merges: ReadonlyArray<{ s: { r: number; c: number }; e: { r: number; c: number } }>,
  headerRowIdx: number,
  initialCol: number
): number {
  const spanMerge = merges.find(
    (m) =>
      m.s.c <= initialCol &&
      initialCol <= m.e.c &&
      m.s.r <= headerRowIdx &&
      headerRowIdx <= m.e.r &&
      m.e.c > m.s.c
  );
  if (!spanMerge) return initialCol;

  const scanEnd = Math.min(grid.length, headerRowIdx + 1 + 60);
  const candidates: { c: number; nonEmpty: number; numericOnly: number }[] = [];
  for (let c = spanMerge.s.c; c <= spanMerge.e.c; c++) {
    let nonEmpty = 0;
    let numericOnly = 0;
    for (let r = headerRowIdx + 1; r < scanEnd; r++) {
      const s = String(grid[r]?.[c] ?? "").trim();
      if (s === "") continue;
      nonEmpty++;
      if (isNumericOnly(s)) numericOnly++;
    }
    candidates.push({ c, nonEmpty, numericOnly });
  }
  const viable = candidates.filter((cand) => cand.nonEmpty > 0 && cand.numericOnly < cand.nonEmpty);
  if (viable.length === 0) return initialCol;
  viable.sort((a, b) => b.nonEmpty - a.nonEmpty);
  return viable[0].c;
}

interface ScoutedBySupplementCandidate {
  sheetName: string;
  headerLabel: string;
  headerRowNumber: number;
  columnNumber: number;
  nameColumnNumber: number;
  map: Map<string, string>;
  sample: ScoutedByDebugSample[];
  ambiguousNames: string[];
}

/**
 * 採用シート自体にスカウト者（情報提供者）列が無い場合に、他シートから
 * 「名前列＋スカウト者列」の組を検出し、氏名一致で値を補完するための
 * 候補を探す。通常のヘッダー判定（detectHeader）・データ抽出（extractRows）
 * をそのまま再利用し、名前列のみ resolveMergedNameColumn で補正する。
 *
 * 複数シートが候補になった場合は、補完できた件数が最も多いシートを採用する。
 * 同一氏名に複数の異なるスカウト者値が見つかった場合は、誤反映を避けるため
 * その氏名は補完対象から除外する（ambiguousNames に記録）。
 */
function findScoutedBySupplement(
  wb: XLSX.WorkBook,
  scans: SheetScan[],
  excludeSheetName: string
): ScoutedBySupplementCandidate | null {
  let best: ScoutedBySupplementCandidate | null = null;

  for (const scan of scans) {
    if (scan.name === excludeSheetName) continue;
    const header = scan.header;
    if (!header || header.colIndex.scoutedBy === undefined || header.colIndex.name === undefined) continue;

    const ws = wb.Sheets[scan.name];
    const merges = (ws["!merges"] ?? []) as ReadonlyArray<{
      s: { r: number; c: number };
      e: { r: number; c: number };
    }>;
    const resolvedNameCol = resolveMergedNameColumn(scan.grid, merges, header.headerRowIdx, header.colIndex.name);
    const effectiveHeader: HeaderDetection =
      resolvedNameCol === header.colIndex.name
        ? header
        : { ...header, colIndex: { ...header.colIndex, name: resolvedNameCol } };
    const extracted = extractRows(scan.grid, effectiveHeader);

    const map = new Map<string, string>();
    const conflicting = new Set<string>();
    const sample: ScoutedByDebugSample[] = [];
    for (const row of extracted.rows) {
      const value = row.scoutedBy.trim();
      if (sample.length < 5) {
        sample.push({ rowNumber: row.rowNumber, name: row.name, raw: value, trimmed: value });
      }
      if (!value) continue;
      const key = normText(row.name);
      if (map.has(key) && map.get(key) !== value) {
        conflicting.add(key);
        continue;
      }
      map.set(key, value);
    }
    for (const key of conflicting) map.delete(key);
    if (map.size === 0) continue;

    const headerCells = (scan.grid[header.headerRowIdx] ?? []).map((v) => String(v ?? ""));
    const candidate: ScoutedBySupplementCandidate = {
      sheetName: scan.name,
      headerLabel: headerCells[header.colIndex.scoutedBy] ?? "",
      headerRowNumber: header.headerRowIdx + 1,
      columnNumber: header.colIndex.scoutedBy + 1,
      nameColumnNumber: resolvedNameCol + 1,
      map,
      sample,
      ambiguousNames: [...conflicting],
    };
    if (!best || candidate.map.size > best.map.size) best = candidate;
  }
  return best;
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
 * 売上（totalSales）専用の参照元シート名。行データ本体（名前・時給・本指名・
 * 場内・同伴・支給額等）は従来通り採用シート（スコアリングで決定）から読むが、
 * totalSalesの値だけは、この名前のシートがあればその「合計」列を氏名一致で
 * 取得し、採用シート自身の値を上書きする（findTotalSalesOverride参照）。
 * 「一覧」等の他のシートに紛らわしい「合計」列があっても、totalSales以外の
 * 項目には一切影響しない
 */
const TOTAL_SALES_SHEET_NAME = "キャスト実績";

/** シート名が TOTAL_SALES_SHEET_NAME を含むか（正規化後の部分一致） */
function isTotalSalesSheetName(name: string): boolean {
  return normText(name).includes(normText(TOTAL_SALES_SHEET_NAME));
}

export interface TotalSalesOverrideDebugSample {
  rowNumber: number;
  name: string;
  totalSales: number;
}

export interface TotalSalesOverrideDebugInfo {
  /** "override": 「キャスト実績」シートの「合計」列を採用 / "none": シートが無い等で採用シート自身の値のまま */
  source: "override" | "none";
  sheetName: string | null;
  headerRowNumber: number | null;
  columnNumber: number | null;
  nameColumnNumber: number | null;
  sample: TotalSalesOverrideDebugSample[];
  reason: string;
}

interface TotalSalesOverrideCandidate {
  sheetName: string;
  headerRowNumber: number;
  columnNumber: number;
  nameColumnNumber: number;
  map: Map<string, { totalSales: number; totalSalesCell: ExcelCellRef | null }>;
}

/**
 * 「キャスト実績」という名前のシートがあれば、その「合計」列を氏名一致の
 * 上書きデータとして使う。無ければ null（totalSalesは採用シート自身の
 * 「合計」等の別名検出結果のまま＝従来通り）。
 * 複数該当する場合は先に見つかったシートを使う
 */
function findTotalSalesOverride(scans: SheetScan[]): TotalSalesOverrideCandidate | null {
  const scan = scans.find((s) => isTotalSalesSheetName(s.name) && s.header !== null);
  if (!scan || !scan.header) return null;
  const nameIdx = scan.header.colIndex.name;
  const totalIdx = scan.header.colIndex.totalSales;
  if (nameIdx === undefined || totalIdx === undefined) return null;

  const map = new Map<string, { totalSales: number; totalSalesCell: ExcelCellRef | null }>();
  for (const row of scan.rows) {
    map.set(normText(row.name), { totalSales: row.totalSales, totalSalesCell: row.totalSalesCell ?? null });
  }
  return {
    sheetName: scan.name,
    headerRowNumber: scan.header.headerRowIdx + 1,
    columnNumber: totalIdx + 1,
    nameColumnNumber: nameIdx + 1,
    map,
  };
}

/**
 * ワークブック内の全シートについて、「キャスト実績」判定・ヘッダー検出・
 * 氏名列/合計列の検出状況を一覧化する（調査・デバッグ表示用）。
 * findTotalSalesOverrideがnullを返した場合に「どの段階で候補から外れたか」
 * （シート名が一致しない／ヘッダー未検出／氏名列未検出／合計列未検出）を
 * 全シート分そのまま確認できるようにする。推測を避け、コードが実際に
 * 判定した結果をそのまま表示するためのもの
 */
export interface TotalSalesSheetDiagnostic {
  name: string;
  /** normText適用後の文字列（全角半角・空白等の正規化後） */
  normalizedName: string;
  /** isTotalSalesSheetName（「キャスト実績」を含むか）の判定結果 */
  matchesCastPerformanceSheetName: boolean;
  headerDetected: boolean;
  headerRowNumber: number | null;
  nameColumnDetected: boolean;
  nameColumnLabel: string | null;
  totalSalesColumnDetected: boolean;
  totalSalesColumnLabel: string | null;
  validRowCount: number;
}

function buildTotalSalesSheetDiagnostics(scans: SheetScan[]): TotalSalesSheetDiagnostic[] {
  return scans.map((s) => {
    const idx = s.header?.colIndex;
    const headerCells = s.header ? (s.grid[s.header.headerRowIdx] ?? []).map((v) => String(v ?? "")) : [];
    const nameIdx = idx?.name;
    const totalIdx = idx?.totalSales;
    return {
      name: s.name,
      normalizedName: normText(s.name),
      matchesCastPerformanceSheetName: isTotalSalesSheetName(s.name),
      headerDetected: s.header !== null,
      headerRowNumber: s.header ? s.header.headerRowIdx + 1 : null,
      nameColumnDetected: nameIdx !== undefined,
      nameColumnLabel: nameIdx !== undefined ? (headerCells[nameIdx] ?? null) : null,
      totalSalesColumnDetected: totalIdx !== undefined,
      totalSalesColumnLabel: totalIdx !== undefined ? (headerCells[totalIdx] ?? null) : null,
      validRowCount: s.rows.length,
    };
  });
}

/**
 * findTotalSalesOverrideがnullを返した理由を、上のシート診断情報から
 * 具体的に説明する（「シートが無い」「ヘッダー未検出」「氏名列未検出」
 * 「合計列未検出」のどれかを特定する。推測ではなく判定結果に基づく）
 */
function describeCastPerformanceUnavailableReason(diagnostics: TotalSalesSheetDiagnostic[]): string {
  const matching = diagnostics.filter((d) => d.matchesCastPerformanceSheetName);
  if (matching.length === 0) {
    return `「${TOTAL_SALES_SHEET_NAME}」という名前のシートが見つかりません`;
  }
  const withHeader = matching.filter((d) => d.headerDetected);
  if (withHeader.length === 0) {
    return `「${matching.map((d) => d.name).join("」「")}」という名前のシートはありますが、ヘッダー行を検出できません`;
  }
  const withName = withHeader.filter((d) => d.nameColumnDetected);
  if (withName.length === 0) {
    return `「${withHeader.map((d) => d.name).join("」「")}」シートのヘッダーは検出できましたが、氏名列を検出できません`;
  }
  const withTotal = withName.filter((d) => d.totalSalesColumnDetected);
  if (withTotal.length === 0) {
    return `「${withName.map((d) => d.name).join("」「")}」シートの氏名列は検出できましたが、「合計」等の総売上列を検出できません`;
  }
  return "原因不明（シート・列は検出できているはずですが上書きされていません。開発者へご連絡ください）";
}

export interface TotalSalesTraceRow {
  rowNumber: number;
  castName: string;
  /** 「キャスト実績」（相当）シートから取得できた値。取得できなかった場合はnull */
  castPerformanceValue: number | null;
  castPerformanceSheet: string | null;
  /** 行データ本体の採用シート（実運用では「一覧」等）で取得した値（上書き前の値） */
  listValue: number;
  listSheet: string;
  /** 最終的にtotalSalesへ採用された値・シート・列・セル */
  selectedValue: number;
  selectedSheet: string;
  selectedColumn: string;
  selectedCell: string | null;
  reason: string;
  /** 「キャスト実績」以外（行データ採用シート＝一覧相当）の値が使われたか */
  fallbackOccurred: boolean;
}

/**
 * Excelを読み込んだ段階の、キャストごとの総売上トレース情報を組み立てる。
 * 「キャスト実績シートで取得した値」「一覧（行データ採用シート）で取得した値」
 * 「最終的に採用した値・シート・列・セル」「採用理由」を1行ごとに突き合わせる
 * （照合確認画面のデバッグ表示・console.log出力に使う）
 */
function buildTotalSalesTrace(
  listRows: ExcelMonthlyRow[],
  finalRows: ExcelMonthlyRow[],
  adoptedSheetName: string,
  adoptedTotalSalesColumnLabel: string | null,
  override: TotalSalesOverrideCandidate | null,
  diagnostics: TotalSalesSheetDiagnostic[]
): TotalSalesTraceRow[] {
  const unavailableReason = override ? null : describeCastPerformanceUnavailableReason(diagnostics);
  return finalRows.map((finalRow, i) => {
    const listRow = listRows[i];
    const castPerformanceMatch = override?.map.get(normText(finalRow.name)) ?? null;
    const fallbackOccurred = !castPerformanceMatch;
    let reason: string;
    if (override && castPerformanceMatch) {
      reason = `「${override.sheetName}」シートの「合計」列（氏名一致）を採用`;
    } else if (override && !castPerformanceMatch) {
      reason = `「${override.sheetName}」シートに氏名「${finalRow.name}」が見つからないため、行データ採用シート「${adoptedSheetName}」の値を使用`;
    } else {
      reason = `${unavailableReason}のため、行データ採用シート「${adoptedSheetName}」の値を使用`;
    }
    return {
      rowNumber: finalRow.rowNumber,
      castName: finalRow.name,
      castPerformanceValue: castPerformanceMatch?.totalSales ?? null,
      castPerformanceSheet: override?.sheetName ?? null,
      listValue: listRow.totalSales,
      listSheet: adoptedSheetName,
      selectedValue: finalRow.totalSales,
      selectedSheet: finalRow.totalSalesSheetName ?? adoptedSheetName,
      selectedColumn: fallbackOccurred ? (adoptedTotalSalesColumnLabel ?? "―") : "合計",
      selectedCell: finalRow.totalSalesCell?.address ?? null,
      reason,
      fallbackOccurred,
    };
  });
}

/** Excelバイナリをワークブックとして読み込む（シート解析段階） */
export function readWorkbook(buffer: ArrayBuffer): XLSX.WorkBook {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: "array" });
  } catch {
    throw new Error(
      "ファイル形式を読み取れませんでした。.xlsx / .xls 形式で保存されたExcelファイルかご確認のうえ、" +
        "壊れている場合はExcelで開いて別名保存してから再度お試しください。"
    );
  }
  if (wb.SheetNames.length === 0) throw new Error("Excelにシートがありません");
  return wb;
}

/** 1シートを走査する（ヘッダー判定+データ抽出段階。非同期版から1枚ずつ呼ぶ） */
export function scanSheet(wb: XLSX.WorkBook, name: string): SheetScan {
  const ws = wb.Sheets[name];
  const { grid, truncated, origin } = safeGridFromSheet(ws);
  const header = detectHeader(grid);
  if (!header) {
    return {
      name,
      header: null,
      grid,
      rows: [],
      excluded: [],
      dataStartRow: null,
      dataEndRow: null,
      score: sheetNameScore(name) - 1000,
      truncated,
    };
  }
  const extracted = extractRows(grid, header, { ws, origin });
  // スコア: シート名 + 既知列数×10 + 有効行数（最大50）
  const score =
    sheetNameScore(name) + header.knownCols * 10 + Math.min(extracted.rows.length, 50);
  return { name, header, grid, ...extracted, score, truncated };
}

/** 走査済み全シートから採用シートを決定し、結果を組み立てる */
export function assembleParseResult(
  scans: SheetScan[],
  sheetNames: string[],
  wb: XLSX.WorkBook,
  opts?: { sheetName?: string }
): ExcelParseResult {
  // ---- 採用シートの決定 ----
  // 行データ本体（名前・時給・本指名・場内・同伴・支給額等）はここのスコアリングで
  // 決定する採用シートから読む（従来通り）。totalSalesの値だけは、この後
  // findTotalSalesOverviewで「キャスト実績」シートの「合計」列があれば上書きする
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
      const sheetList = sheetNames.join(" / ");
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
      (s === adopted
        ? "給料明細シートとして採用"
        : s.header === null
          ? "ヘッダー行を検出できないため除外（設定・集計シートの可能性）"
          : s.rows.length === 0
            ? "有効なキャスト行が無いため除外"
            : "採用シートよりスコアが低いため除外") +
      (s.truncated
        ? `（データ量が上限（${ABSOLUTE_MAX_ROWS}行×${ABSOLUTE_MAX_COLS}列）を超えるため一部のみ読み込み）`
        : ""),
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
  if (adopted.truncated) {
    warnings.push(
      `採用シート「${adopted.name}」の実データ量が上限（${ABSOLUTE_MAX_ROWS}行×${ABSOLUTE_MAX_COLS}列）を超えているため、一部のみ読み込みました。データが途中で切れている可能性があるため、シートを分割するか管理者にご確認ください。`
    );
  }
  const errorSkippedCount = adopted.excluded.filter((e) => e.reason.includes("数式エラー")).length;
  if (errorSkippedCount > 0) {
    warnings.push(
      `${errorSkippedCount}件の行が数式エラー（#REF!等）のため読み込めませんでした。除外行の詳細をご確認ください。`
    );
  }
  const headerCells = (adopted.grid[adopted.header.headerRowIdx] ?? []).map((v) => String(v ?? ""));
  const headerMap: Record<string, string> = {};
  (Object.entries(adopted.header.colIndex) as Array<[string, number]>).forEach(([field, idx]) => {
    headerMap[field] = headerCells[idx] ?? "";
  });

  // ---- スカウト者（情報提供者）列の解決 ----
  // 採用シート自体に列が無い場合、他シートから「名前＋スカウト者」列の
  // 組を検出し、氏名一致で補完する（実店舗のExcelでは月別成績とスカウト者
  // 情報が別シートに分かれていることがあるため）。
  let rows = adopted.rows;
  let scoutedByDebug: ScoutedByDebugInfo;
  if (adopted.header.colIndex.scoutedBy !== undefined) {
    const idx = adopted.header.colIndex.scoutedBy;
    scoutedByDebug = {
      source: "primary",
      sheetName: adopted.name,
      headerLabel: headerCells[idx] ?? "",
      columnNumber: idx + 1,
      headerRowNumber: adopted.header.headerRowIdx + 1,
      nameColumnNumber: (adopted.header.colIndex.name ?? -1) + 1,
      sample: adopted.rows.slice(0, 5).map((r) => {
        const rawCell = adopted.grid[r.rowNumber - 1]?.[idx];
        const raw = String(rawCell ?? "");
        return { rowNumber: r.rowNumber, name: r.name, raw, trimmed: r.scoutedBy };
      }),
      reason: `採用シート「${adopted.name}」の${idx + 1}列目（見出し「${headerCells[idx] ?? ""}」）から取得`,
    };
  } else {
    const supplement = findScoutedBySupplement(wb, scans, adopted.name);
    if (supplement) {
      rows = adopted.rows.map((row) => {
        if (row.scoutedBy) return row;
        const value = supplement.map.get(normText(row.name));
        return value ? { ...row, scoutedBy: value } : row;
      });
      headerMap.scoutedBy = `${supplement.headerLabel}（「${supplement.sheetName}」シートから自動補完）`;
      scoutedByDebug = {
        source: "supplement",
        sheetName: supplement.sheetName,
        headerLabel: supplement.headerLabel,
        columnNumber: supplement.columnNumber,
        headerRowNumber: supplement.headerRowNumber,
        nameColumnNumber: supplement.nameColumnNumber,
        sample: supplement.sample,
        reason:
          `採用シート「${adopted.name}」にはスカウト者列が無いため、` +
          `「${supplement.sheetName}」シートの${supplement.columnNumber}列目` +
          `（見出し「${supplement.headerLabel}」）を氏名一致で補完` +
          (supplement.ambiguousNames.length > 0
            ? `（同名で値が競合した${supplement.ambiguousNames.length}名は補完対象外）`
            : ""),
      };
    } else {
      scoutedByDebug = {
        source: "none",
        sheetName: adopted.name,
        headerLabel: "",
        columnNumber: null,
        headerRowNumber: null,
        nameColumnNumber: (adopted.header.colIndex.name ?? -1) + 1,
        sample: [],
        reason: `採用シート「${adopted.name}」および他のどのシートにも、名前列とスカウト者/情報提供者列の組み合わせを検出できませんでした。`,
      };
    }
  }

  // ---- totalSalesの上書き（「キャスト実績」シートの「合計」列を氏名一致で採用） ----
  // 行データ本体（名前・時給・本指名・場内・同伴・支給額等）は採用シートのまま
  // 変更しない。totalSalesだけを、存在すれば「キャスト実績」シートの「合計」列の
  // 実値に置き換える（見つからない場合は採用シート自身の値のまま＝従来通り）
  const rowsBeforeTotalSalesOverride = rows; // トレース用（行データ採用シート＝「一覧」相当の元の値）
  const totalSalesOverride = findTotalSalesOverride(scans);
  let totalSalesOverrideDebug: TotalSalesOverrideDebugInfo;
  if (totalSalesOverride) {
    rows = rows.map((row) => {
      const match = totalSalesOverride.map.get(normText(row.name));
      if (!match) return { ...row, totalSalesSheetName: adopted.name };
      return {
        ...row,
        totalSales: match.totalSales,
        totalSalesCell: match.totalSalesCell,
        totalSalesSheetName: totalSalesOverride.sheetName,
      };
    });
    totalSalesOverrideDebug = {
      source: "override",
      sheetName: totalSalesOverride.sheetName,
      headerRowNumber: totalSalesOverride.headerRowNumber,
      columnNumber: totalSalesOverride.columnNumber,
      nameColumnNumber: totalSalesOverride.nameColumnNumber,
      sample: rows.slice(0, 5).map((r) => ({ rowNumber: r.rowNumber, name: r.name, totalSales: r.totalSales })),
      reason:
        `「${totalSalesOverride.sheetName}」シートの${totalSalesOverride.columnNumber}列目（「合計」列）を` +
        `氏名一致でtotalSalesに採用（行データ本体は採用シート「${adopted.name}」のまま）`,
    };
  } else {
    rows = rows.map((row) => ({ ...row, totalSalesSheetName: adopted.name }));
    totalSalesOverrideDebug = {
      source: "none",
      sheetName: null,
      headerRowNumber: null,
      columnNumber: null,
      nameColumnNumber: null,
      sample: [],
      reason: `「${TOTAL_SALES_SHEET_NAME}」という名前のシートが見つからないため、採用シート「${adopted.name}」自身のtotalSales列（${headerMap.totalSales ?? "検出なし"}）をそのまま使用`,
    };
  }

  // 【デバッグログ・段階1: Excel読み込み】シート名・セル位置・取得値を行ごとに
  // 出力する。totalSalesSheetNameが採用シート（rowDataSheetName）と異なる場合、
  // その行のtotalSalesは「キャスト実績」シートの「合計」列由来（上書き適用）。
  // 本番・プレビューではConsoleを汚さないよう抑止する
  if (DEBUG_LOG_ENABLED) {
    for (const r of rows) {
      // eslint-disable-next-line no-console
      console.info("[parseMonthlyExcel:row]", {
        rowDataSheetName: adopted.name,
        totalSalesSheetName: r.totalSalesSheetName,
        totalSalesOverridden: r.totalSalesSheetName !== adopted.name,
        rowNumber: r.rowNumber,
        name: r.name,
        shimeiSales: headerMap.shimeiSales ? r.shimeiSales : null,
        shimeiSalesCell: r.shimeiSalesCell?.address ?? null,
        jounaiCount: headerMap.jounaiCount ? r.jounaiCount : null,
        jounaiCountCell: r.jounaiCountCell?.address ?? null,
        totalSalesCell: r.totalSalesCell?.address ?? null,
        totalSales: r.totalSales,
      });
    }
  }

  // ---- 総売上トレース（調査用・一時的なデバッグ表示）----
  // 「キャスト実績シートの総売上が一覧シートの値で上書きされているように見える」
  // という報告の原因調査用。キャストごとに「キャスト実績シートの取得値」
  // 「行データ採用シート（一覧相当）の取得値」「最終的に採用した値・シート・列・
  // セル」「採用理由」を突き合わせる。DEBUG_LOG_ENABLED（本番では抑止）とは
  // 独立して、常にconsole.logへ出力する（本番環境での調査に使うため）
  const totalSalesSheetDiagnostics = buildTotalSalesSheetDiagnostics(scans);
  const totalSalesTrace = buildTotalSalesTrace(
    rowsBeforeTotalSalesOverride,
    rows,
    adopted.name,
    headerMap.totalSales ?? null,
    totalSalesOverride,
    totalSalesSheetDiagnostics
  );
  for (const t of totalSalesTrace) {
    // eslint-disable-next-line no-console
    console.log({
      castName: t.castName,
      castPerformanceValue: t.castPerformanceValue,
      listValue: t.listValue,
      selectedValue: t.selectedValue,
      selectedSheet: t.selectedSheet,
      selectedColumn: t.selectedColumn,
      selectedCell: t.selectedCell,
      reason: t.reason,
    });
  }

  return {
    rows,
    excluded: adopted.excluded,
    headerMap,
    sheetName: adopted.name,
    totalSalesSheetDiagnostics,
    totalSalesTrace,
    totalSalesOverrideDebug,
    headerRowNumber: adopted.header.headerRowIdx + 1,
    dataStartRow: adopted.dataStartRow,
    dataEndRow: adopted.dataEndRow,
    sheets,
    warnings,
    scoutedByDebug,
  };
}

/**
 * ExcelのArrayBufferをパースする（同期版）。
 * @param opts.sheetName 指定した場合はそのシートを強制採用（手動選択UI用）
 *
 * キャンセル対応が必要な画面からは analyzeExcel.ts の
 * analyzeExcelBuffer（シートごとに中断確認する非同期版）を使用する。
 */
export function parseMonthlyExcel(
  buffer: ArrayBuffer,
  opts?: { sheetName?: string }
): ExcelParseResult {
  const wb = readWorkbook(buffer);
  const scans = wb.SheetNames.map((name) => scanSheet(wb, name));
  return assembleParseResult(scans, wb.SheetNames, wb, opts);
}
