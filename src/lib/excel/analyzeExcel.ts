import {
  assembleParseResult,
  readWorkbook,
  scanSheet,
  type ExcelParseResult,
  type ExcelMonthlyRow,
  type SheetScan,
} from "./parseMonthlyExcel";
import {
  matchExcelRows,
  type MatchableCast,
  type MatchResult,
  type RowMatch,
} from "./importMatching";
import type { NameMatchingRuleWithId } from "@/types";

/**
 * キャンセル可能なExcel解析パイプライン。
 *
 * 処理段階:
 *   1. ファイル読込（FileReader — abortで即中断）
 *   2. シート解析（ワークブック展開）
 *   3-4. ヘッダー判定・データ抽出（シートごとに中断確認）
 *   5. キャスト照合（行チャンクごとに中断確認）
 *
 * ブラウザの同期処理（XLSX.read等）は物理的に即停止できないため、
 * 各段階の境界で AbortSignal を確認し、キャンセル後は
 * AnalyzeCancelledError を投げて結果をUIへ一切反映させない。
 */

export class AnalyzeCancelledError extends Error {
  constructor() {
    super("解析をキャンセルしました");
    this.name = "AnalyzeCancelledError";
  }
}

export type AnalyzeStageId = "read" | "workbook" | "scan" | "match";

/** 処理段階の表示ラベル（全8段階: 6=最終確認 7=Firestore保存 8=完了/キャンセル） */
export const ANALYZE_STAGE_LABELS: Record<AnalyzeStageId, string> = {
  read: "段階1/8 ファイル読込",
  workbook: "段階2/8 シート解析",
  scan: "段階3〜4/8 ヘッダー判定・データ抽出",
  match: "段階5/8 キャスト照合",
};

export interface AnalyzeProgress {
  stage: AnalyzeStageId;
  label: string;
  /** 実件数に基づく進捗（不明な段階は null — 見かけの%は出さない） */
  current: number | null;
  total: number | null;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AnalyzeCancelledError();
}

/** イベントループへ制御を返す（キャンセルボタンのクリックを受け付けるため） */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** FileReaderでファイルを読み込む。signalのabortで即中断する */
export function readFileWithAbort(file: File, signal?: AbortSignal): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AnalyzeCancelledError());
      return;
    }
    const reader = new FileReader();
    const onAbort = () => {
      reader.abort();
      reject(new AnalyzeCancelledError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    reader.onload = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve(reader.result as ArrayBuffer);
    };
    reader.onerror = () => {
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("ファイルの読み込みに失敗しました"));
    };
    reader.onabort = () => {
      signal?.removeEventListener("abort", onAbort);
      reject(new AnalyzeCancelledError());
    };
    reader.readAsArrayBuffer(file);
  });
}

/**
 * ArrayBufferを段階的に解析する（シートごとに中断確認）。
 */
export async function analyzeExcelBuffer(
  buffer: ArrayBuffer,
  opts: {
    signal?: AbortSignal;
    sheetName?: string;
    onProgress?: (p: AnalyzeProgress) => void;
  } = {}
): Promise<ExcelParseResult> {
  const { signal, onProgress } = opts;

  throwIfAborted(signal);
  onProgress?.({ stage: "workbook", label: ANALYZE_STAGE_LABELS.workbook, current: null, total: null });
  await yieldToUi();
  throwIfAborted(signal);
  const wb = readWorkbook(buffer);

  const names = wb.SheetNames;
  const scans: SheetScan[] = [];
  for (let i = 0; i < names.length; i++) {
    throwIfAborted(signal);
    onProgress?.({
      stage: "scan",
      label: ANALYZE_STAGE_LABELS.scan,
      current: i + 1,
      total: names.length,
    });
    scans.push(scanSheet(wb, names[i]));
    // 8シートごとにUIへ制御を返す（キャンセル受付）
    if (i % 8 === 7) await yieldToUi();
  }

  throwIfAborted(signal);
  return assembleParseResult(scans, names, { sheetName: opts.sheetName });
}

/** ファイル選択から解析までの一括実行（読込段階を含む） */
export async function analyzeExcelFile(
  file: File,
  opts: {
    signal?: AbortSignal;
    sheetName?: string;
    onProgress?: (p: AnalyzeProgress) => void;
  } = {}
): Promise<{ buffer: ArrayBuffer; result: ExcelParseResult }> {
  opts.onProgress?.({ stage: "read", label: ANALYZE_STAGE_LABELS.read, current: null, total: null });
  const buffer = await readFileWithAbort(file, opts.signal);
  const result = await analyzeExcelBuffer(buffer, opts);
  return { buffer, result };
}

/**
 * キャスト照合の非同期版。行チャンクごとに中断確認しつつ、
 * 結果は同期版 matchExcelRows と完全に同一になる。
 */
export async function matchExcelRowsChunked(
  rows: ExcelMonthlyRow[],
  targetStoreId: string,
  casts: MatchableCast[],
  rules: NameMatchingRuleWithId[],
  opts: {
    signal?: AbortSignal;
    onProgress?: (p: AnalyzeProgress) => void;
    chunkSize?: number;
  } = {}
): Promise<MatchResult> {
  const { signal, onProgress } = opts;
  const chunkSize = opts.chunkSize ?? 50;
  const matches: RowMatch[] = [];

  for (let i = 0; i < rows.length; i += chunkSize) {
    throwIfAborted(signal);
    onProgress?.({
      stage: "match",
      label: ANALYZE_STAGE_LABELS.match,
      current: Math.min(i + chunkSize, rows.length),
      total: rows.length,
    });
    const part = matchExcelRows(rows.slice(i, i + chunkSize), targetStoreId, casts, rules);
    matches.push(...part.matches);
    await yieldToUi();
  }
  throwIfAborted(signal);

  // missingCasts は全行の照合結果から算出（チャンク分割しても同期版と同一の定義）
  const matched = new Set<string>();
  for (const m of matches) {
    if (m.suggestedCastId) matched.add(m.suggestedCastId);
    for (const c of m.candidates) {
      if (c.matchType === "exact") matched.add(c.cast.id);
    }
  }
  const missingCasts = casts.filter(
    (c) =>
      c.storeId === targetStoreId &&
      !c.archived &&
      c.status === "在籍" &&
      !matched.has(c.id)
  );

  return { matches, missingCasts };
}
