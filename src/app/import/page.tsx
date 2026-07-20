"use client";

import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { AppHeader } from "@/components/AppHeader";
import { useStores } from "@/hooks/useStores";
import { subscribeCasts } from "@/services/castService";
import { fetchMonthlyResultsByStoreMonth } from "@/services/monthlyResultService";
import { fetchRulesByStore } from "@/services/nameMatchingRuleService";
import {
  executeExcelImport,
  type ImportProgress,
  type ImportResult,
  type RowDecision,
  type StatusDecision,
} from "@/services/excelImportService";
import type { ExcelParseResult } from "@/lib/excel/parseMonthlyExcel";
import {
  AnalyzeCancelledError,
  analyzeExcelBuffer,
  analyzeExcelFile,
  matchExcelRowsChunked,
  type AnalyzeProgress,
} from "@/lib/excel/analyzeExcel";
import type { MatchResult, RowAction, MatchableCast } from "@/lib/excel/importMatching";
import {
  BULK_NEW_WARN_COUNT,
  ROW_FILTERS,
  buildInitialRowStates,
  bulkClearSelection,
  bulkExcludeRows,
  bulkLinkExactRows,
  bulkNewNoCandidateRows,
  canExecutePlan,
  listBulkNewEligible,
  recomputeExisting,
  rowMatchesFilter,
  summarizePlan,
  type PlanRowState,
  type RowFilterId,
} from "@/lib/excel/importPlan";
import {
  currentMonth,
  isAdminOrAbove,
  monthToJa,
  type CastWithId,
  type MonthlyResultWithId,
} from "@/types";

/**
 * Excelインポート（owner / 許可されたadmin）。
 *
 * 60名規模でも運用できるよう、明らかに一致している行は「自動確定済み」とし、
 * 本当に確認が必要な行（要確認）だけを人が処理する方式。
 *
 * - 解析（読込/シート解析/ヘッダー判定/データ抽出/キャスト照合）は
 *   AbortControllerでキャンセル可能。キャンセル後は初期画面へ戻り、
 *   途中結果をUI・照合・Firestoreへ一切反映しない
 * - Firestore保存中のキャンセルは別系統（cancelRef）。未処理行は保存せず、
 *   保存済み変更は必ず importBatches.changes へ記録され、
 *   status は cancelled / partial-cancelled（completedにしない）
 * - 一括操作（完全一致のみ紐付け / 候補なしのみ新規登録 / 除外 / 選択解除）と
 *   絞り込みで要確認行だけを処理できる
 */

interface RowState extends PlanRowState {
  showDiff: boolean;
}

export default function ImportPage() {
  const { firebaseUser, userDoc } = useAuth();
  const canImport = isAdminOrAbove(userDoc);
  const router = useRouter();
  const { accessibleStores } = useStores();

  const [storeId, setStoreId] = useState("");
  const [month, setMonth] = useState(currentMonth());
  const [fileName, setFileName] = useState("");
  const [parseResult, setParseResult] = useState<ExcelParseResult | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const fileBufferRef = useRef<ArrayBuffer | null>(null);

  // 解析（読込〜照合）のキャンセル系
  const [analyzing, setAnalyzing] = useState(false);
  const [matching, setMatching] = useState(false);
  const [analyzeProgress, setAnalyzeProgress] = useState<AnalyzeProgress | null>(null);
  const [analyzeCancelRequested, setAnalyzeCancelRequested] = useState(false);
  const analyzeControllerRef = useRef<AbortController | null>(null);

  const [casts, setCasts] = useState<CastWithId[]>([]);
  const [rowStates, setRowStates] = useState<RowState[]>([]);
  const [matchResult, setMatchResult] = useState<MatchResult | null>(null);
  const [existingMap, setExistingMap] = useState<Map<string, MonthlyResultWithId>>(new Map());
  const [statusChoices, setStatusChoices] = useState<Map<string, string>>(new Map());
  // 既定は「要対応のみ」: 完全一致1名の自動紐付け・完全一致なしの自動新規は表示しない
  const [filter, setFilter] = useState<RowFilterId>("attention");

  const [bulkNewOpen, setBulkNewOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Firestore保存のキャンセル系（解析キャンセルとは別系統）
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [saveCancelRequested, setSaveCancelRequested] = useState(false);
  const cancelRef = useRef(false);

  useEffect(() => {
    if (userDoc && !canImport) router.replace("/dashboard");
  }, [userDoc, canImport, router]);

  const storeIds = useMemo(() => accessibleStores.map((s) => s.id), [accessibleStores]);
  useEffect(() => {
    if (storeIds.length === 0) return;
    return subscribeCasts(storeIds, setCasts, (m) => setPageError(m));
  }, [storeIds]);

  const storeName = (id: string) => accessibleStores.find((s) => s.id === id)?.name ?? id;
  const existingCastIds = useMemo(() => new Set(existingMap.keys()), [existingMap]);
  const summary = useMemo(() => summarizePlan(rowStates), [rowStates]);
  const executable = canExecutePlan(rowStates);
  const visibleIndices = useMemo(
    () =>
      rowStates
        .map((st, i) => (rowMatchesFilter(st, filter) ? i : -1))
        .filter((i) => i >= 0),
    [rowStates, filter]
  );
  const busy = analyzing || matching || running;
  const bulkNewEligible = useMemo(() => listBulkNewEligible(rowStates), [rowStates]);

  if (!canImport) return null;

  /** キャンセル後・ファイル再選択時: ファイル選択前の初期画面へ完全に戻す */
  function resetToInitial() {
    setFileName("");
    fileBufferRef.current = null;
    setParseResult(null);
    setMatchResult(null);
    setRowStates([]);
    setStatusChoices(new Map());
    setFilter("attention");
    setResult(null);
    setProgress(null);
    setConfirmOpen(false);
    setBulkNewOpen(false);
    setAnalyzeProgress(null);
    setAnalyzeCancelRequested(false);
    setPageError(null);
  }

  function resetPreviewOnly() {
    setMatchResult(null);
    setRowStates([]);
    setStatusChoices(new Map());
    setFilter("attention");
    setResult(null);
    setConfirmOpen(false);
    setBulkNewOpen(false);
  }

  async function onFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // 同じファイルの再選択を許可
    if (!file) return;
    if (busy) return; // 二重読込防止
    resetToInitial();
    setFileName(file.name);
    const controller = new AbortController();
    analyzeControllerRef.current = controller;
    setAnalyzing(true);
    setAnalyzeCancelRequested(false);
    try {
      const { buffer, result: res } = await analyzeExcelFile(file, {
        signal: controller.signal,
        onProgress: setAnalyzeProgress,
      });
      fileBufferRef.current = buffer;
      setParseResult(res);
      setAnalyzeProgress(null);
    } catch (err) {
      if (err instanceof AnalyzeCancelledError) {
        resetToInitial(); // 途中結果を残さず初期画面へ（成功表示も出さない）
      } else {
        const msg = (err as Error).message;
        resetToInitial();
        setFileName(file.name);
        setPageError(msg);
      }
    } finally {
      setAnalyzing(false);
      analyzeControllerRef.current = null;
    }
  }

  async function onSelectSheet(sheetName: string) {
    if (!fileBufferRef.current || busy) return;
    resetPreviewOnly();
    setParseResult(null);
    const controller = new AbortController();
    analyzeControllerRef.current = controller;
    setAnalyzing(true);
    setAnalyzeCancelRequested(false);
    try {
      const res = await analyzeExcelBuffer(fileBufferRef.current, {
        signal: controller.signal,
        sheetName,
        onProgress: setAnalyzeProgress,
      });
      setParseResult(res);
      setAnalyzeProgress(null);
    } catch (err) {
      if (err instanceof AnalyzeCancelledError) {
        resetToInitial();
      } else {
        setPageError((err as Error).message);
      }
    } finally {
      setAnalyzing(false);
      analyzeControllerRef.current = null;
    }
  }

  function onCancelAnalyze() {
    setAnalyzeCancelRequested(true);
    analyzeControllerRef.current?.abort();
  }

  /** 照合確認画面を作成する（キャンセル可能） */
  async function onBuildPreview() {
    if (!parseResult || !storeId || !/^\d{4}-\d{2}$/.test(month) || busy) return;
    if (parseResult.rows.length === 0) {
      setPageError("キャスト行が0件のため照合できません。シート・ヘッダー行をご確認ください。");
      return;
    }
    setPageError(null);
    const controller = new AbortController();
    analyzeControllerRef.current = controller;
    setMatching(true);
    setAnalyzeCancelRequested(false);
    try {
      const [rules, existing] = await Promise.all([
        fetchRulesByStore(storeId),
        fetchMonthlyResultsByStoreMonth(storeId, month),
      ]);
      if (controller.signal.aborted) throw new AnalyzeCancelledError();
      const matchable: MatchableCast[] = casts.map((c) => ({
        id: c.id,
        storeId: c.storeId,
        stageName: c.stageName,
        realName: c.realName,
        kana: c.kana,
        hourlyWage: c.hourlyWage,
        status: c.status,
        archived: c.archived,
      }));
      const mr = await matchExcelRowsChunked(parseResult.rows, storeId, matchable, rules, {
        signal: controller.signal,
        onProgress: setAnalyzeProgress,
      });
      const exMap = new Map(existing.map((m) => [m.castId, m]));
      setExistingMap(exMap);
      setMatchResult(mr);
      setRowStates(
        buildInitialRowStates(mr.matches, new Set(exMap.keys())).map((s) => ({
          ...s,
          showDiff: false,
        }))
      );
      setStatusChoices(new Map());
      setAnalyzeProgress(null);
    } catch (err) {
      if (err instanceof AnalyzeCancelledError) {
        resetToInitial(); // 照合中キャンセルも初期画面へ戻す
      } else {
        setPageError((err as Error).message);
      }
    } finally {
      setMatching(false);
      analyzeControllerRef.current = null;
    }
  }

  function updateRow(idx: number, patch: Partial<RowState>) {
    setRowStates((prev) => {
      const next = [...prev];
      const merged = { ...next[idx], ...patch };
      const recomputed = recomputeExisting(merged, existingCastIds);
      next[idx] = { ...merged, existing: recomputed.existing };
      return next;
    });
  }

  function applyBulk(fn: (states: RowState[]) => { states: PlanRowState[]; applied: number }) {
    setRowStates((prev) => {
      const { states } = fn(prev);
      return states.map((s, i) => ({ ...s, showDiff: prev[i].showDiff })) as RowState[];
    });
  }

  function onJumpToUnresolved() {
    const first = rowStates.find((st) => st.action === null);
    if (!first) return;
    document
      .getElementById(`import-row-${first.match.row.rowNumber}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
    setFilter("unresolved");
  }

  async function onExecute() {
    if (!firebaseUser || running || !matchResult || !executable) return;
    setConfirmOpen(false);
    setPageError(null);
    cancelRef.current = false;
    setSaveCancelRequested(false);
    setRunning(true);
    setResult(null);
    setProgress(null);
    try {
      const decisions: RowDecision[] = rowStates.map((r) => ({
        row: r.match.row,
        action: r.action as RowAction, // executable判定済み（null無し）
        castId: r.action === "new" ? null : r.castId,
        newWage: r.action === "wage-change" ? r.match.row.hourlyWage : null,
        existing: r.existing,
        saveRule: r.saveRule,
      }));
      const statusDecisions: StatusDecision[] = [];
      statusChoices.forEach((choice, castId) => {
        if (choice === "退店" || choice === "休職" || choice === "在籍") {
          statusDecisions.push({ castId, newStatus: choice });
        }
      });
      const res = await executeExcelImport(
        firebaseUser.uid,
        { storeId, targetMonth: month, fileName, decisions, statusDecisions },
        setProgress,
        () => cancelRef.current
      );
      setResult(res);
    } catch (err) {
      setPageError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }

  const readyToPreview =
    !!parseResult && parseResult.rows.length > 0 && !!storeId && /^\d{4}-\d{2}$/.test(month);

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="app-main app-main-wide">
        <div className="page-head">
          <div>
            <h1 className="page-title">Excelインポート</h1>
            <p className="page-sub">
              給与明細Excel（.xls / .xlsx）を読み込み、照合確認のうえ保存します（PCでの操作を推奨）
            </p>
          </div>
        </div>

        {pageError && <div className="error-box">{pageError}</div>}

        <section className="section-card" style={{ marginBottom: 16 }}>
          <h2 style={{ marginBottom: 10 }}>1. 対象を選択</h2>
          <div className="filter-bar" style={{ marginBottom: 0 }}>
            <select
              className="form-input"
              value={storeId}
              onChange={(e) => {
                setStoreId(e.target.value);
                resetPreviewOnly();
              }}
              disabled={busy}
            >
              <option value="">対象店舗を選択 *</option>
              {accessibleStores.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <input
              className="form-input"
              type="month"
              value={month}
              onChange={(e) => {
                setMonth(e.target.value);
                resetPreviewOnly();
              }}
              disabled={busy}
            />
            <input
              type="file"
              accept=".xlsx,.xls,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => void onFileSelected(e)}
              disabled={busy}
            />
          </div>

          {(analyzing || matching) && analyzeProgress && (
            <div className="analyze-progress">
              <span>
                {analyzeProgress.label}
                {analyzeProgress.current != null && analyzeProgress.total != null && (
                  <>
                    {" "}
                    — {analyzeProgress.current} / {analyzeProgress.total}
                    （{Math.round((analyzeProgress.current / analyzeProgress.total) * 100)}%）
                  </>
                )}
              </span>
              <button type="button" className="btn btn-danger btn-sm" onClick={onCancelAnalyze}>
                {analyzeCancelRequested ? "キャンセル受付済み…" : "キャンセル"}
              </button>
            </div>
          )}

          {parseResult && (
            <div style={{ marginTop: 12 }}>
              {parseResult.warnings.map((w, i) => (
                <div key={i} className="error-box" style={{ marginBottom: 8 }}>⚠ {w}</div>
              ))}

              <div className="table-wrap">
                <table className="data-table">
                  <tbody>
                    <tr><td>ファイル</td><td style={{ wordBreak: "break-all" }}>{fileName}</td></tr>
                    <tr>
                      <td>選択中シート</td>
                      <td>
                        <select
                          className="form-input"
                          style={{ maxWidth: 320, display: "inline-block" }}
                          value={parseResult.sheetName}
                          onChange={(e) => void onSelectSheet(e.target.value)}
                          disabled={busy}
                        >
                          {parseResult.sheets.map((s) => (
                            <option key={s.name} value={s.name}>
                              {s.name}（有効{s.validRows}行）
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                    <tr><td>ヘッダー行</td><td>{parseResult.headerRowNumber}行目</td></tr>
                    <tr>
                      <td>データ範囲</td>
                      <td>
                        {parseResult.dataStartRow
                          ? `${parseResult.dataStartRow}〜${parseResult.dataEndRow}行目`
                          : "検出なし"}
                      </td>
                    </tr>
                    <tr><td>検出キャスト行</td><td>{parseResult.rows.length}件</td></tr>
                    <tr><td>除外行</td><td>{parseResult.excluded.length}件</td></tr>
                  </tbody>
                </table>
              </div>

              <details style={{ marginTop: 8 }}>
                <summary>シートの判定結果（{parseResult.sheets.length}シート）</summary>
                <div className="table-wrap" style={{ marginTop: 8 }}>
                  <table className="data-table">
                    <thead>
                      <tr><th>シート</th><th>判定</th><th>ヘッダー行</th><th className="num">有効行</th></tr>
                    </thead>
                    <tbody>
                      {parseResult.sheets.map((s) => (
                        <tr key={s.name}>
                          <td>{s.name}{s.adopted && <span className="badge badge-green" style={{ marginLeft: 6 }}>採用</span>}</td>
                          <td>{s.reason}</td>
                          <td>{s.headerRowNumber ? `${s.headerRowNumber}行目` : "-"}</td>
                          <td className="num">{s.validRows}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>

              {parseResult.excluded.length > 0 && (
                <details style={{ marginTop: 8 }}>
                  <summary>読み飛ばした行（理由付き・{parseResult.excluded.length}件）</summary>
                  <div className="table-wrap" style={{ marginTop: 8 }}>
                    <table className="data-table">
                      <thead>
                        <tr><th>行</th><th>名前列の値</th><th>理由</th></tr>
                      </thead>
                      <tbody>
                        {parseResult.excluded.map((ex, i) => (
                          <tr key={i}>
                            <td>{ex.rowNumber}</td>
                            <td style={{ wordBreak: "break-all" }}>{ex.value || "（空欄）"}</td>
                            <td>{ex.reason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              )}
            </div>
          )}

          <div style={{ marginTop: 12 }}>
            <button
              className="btn btn-primary"
              onClick={() => void onBuildPreview()}
              disabled={!readyToPreview || busy}
            >
              {matching ? "照合中…" : "照合確認へ進む"}
            </button>
            {!readyToPreview && !analyzing && (
              <span className="page-sub" style={{ marginLeft: 10 }}>
                対象店舗・対象月・Excelファイルをすべて選択してください
              </span>
            )}
          </div>
        </section>

        {matchResult && rowStates.length > 0 && (
          <>
            <section className="section-card" style={{ marginBottom: 16 }}>
              <h2 style={{ marginBottom: 4 }}>2. 照合確認</h2>
              <p className="page-sub" style={{ marginBottom: 10 }}>
                {storeName(storeId)} / {monthToJa(month)} — 照合は源氏名の
                <strong>完全一致のみ</strong>で判定します（部分一致・類似候補はありません。
                「れい」「れいな」「みれい」は別人として扱います）。
                完全一致1名は自動で紐付け、完全一致なしは新規登録として自動確定され、
                この画面には表示されません（絞り込みで確認・変更可）。
                表示されるのは対応が必要な行だけです。
              </p>

              {/* 集計バー + 未選択への導線（sticky） */}
              <div className="plan-summary-bar">
                <span className="badge badge-green">自動確定 {summary.autoConfirmed}</span>
                <span className="badge badge-orange">要確認 {summary.needsConfirm}</span>
                <span className={`badge ${summary.unresolved > 0 ? "badge-red" : "badge-gray"}`}>
                  未選択 {summary.unresolved}
                </span>
                <span className="badge badge-gray">新規 {summary.newCasts}</span>
                <span className="badge badge-gray">紐付け {summary.links}</span>
                <span className="badge badge-gray">時給変更 {summary.wageChanges}</span>
                <span className="badge badge-gray">除外 {summary.excluded}</span>
                {summary.unresolved > 0 && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={onJumpToUnresolved}>
                    ↓ 未選択行へ移動
                  </button>
                )}
              </div>

              {/* 絞り込み + 一括操作 */}
              <div className="bulk-bar">
                <select
                  className="form-input"
                  style={{ maxWidth: 220 }}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value as RowFilterId)}
                  disabled={running}
                  aria-label="絞り込み"
                >
                  {ROW_FILTERS.map((f) => (
                    <option key={f.id} value={f.id}>
                      絞り込み: {f.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="choice-btn"
                  disabled={running}
                  onClick={() => applyBulk(bulkLinkExactRows)}
                >
                  完全一致のみ一括紐付け
                </button>
                <button
                  type="button"
                  className="choice-btn"
                  disabled={running || bulkNewEligible.length === 0}
                  onClick={() => setBulkNewOpen(true)}
                >
                  候補なしのみ一括新規登録（{bulkNewEligible.length}件）
                </button>
                <button
                  type="button"
                  className="choice-btn"
                  disabled={running}
                  onClick={() => applyBulk((s) => bulkExcludeRows(s, new Set(visibleIndices)))}
                >
                  表示中のみ一括除外
                </button>
                <button
                  type="button"
                  className="choice-btn"
                  disabled={running}
                  onClick={() => applyBulk((s) => bulkExcludeRows(s))}
                >
                  全件を除外
                </button>
                <button
                  type="button"
                  className="choice-btn"
                  disabled={running}
                  onClick={() => applyBulk((s) => bulkClearSelection(s, new Set(visibleIndices)))}
                >
                  表示中の選択を解除
                </button>
                <button
                  type="button"
                  className="choice-btn"
                  disabled={running}
                  onClick={() => applyBulk((s) => bulkClearSelection(s))}
                >
                  選択をすべて解除
                </button>
              </div>

              {visibleIndices.length === 0 ? (
                <p className="empty-note" style={{ padding: 12 }}>
                  {filter === "attention"
                    ? "対応が必要な行はありません（すべて自動確定済みです）。そのまま最終確認へ進めます。"
                    : "この絞り込みに該当する行はありません"}
                </p>
              ) : (
                visibleIndices.map((idx) => (
                  <RowCard
                    key={rowStates[idx].match.row.rowNumber}
                    rs={rowStates[idx]}
                    existingMap={existingMap}
                    onChange={(patch) => updateRow(idx, patch)}
                    disabled={running}
                  />
                ))
              )}
            </section>

            {matchResult.missingCasts.length > 0 && (
              <section className="section-card" style={{ marginBottom: 16 }}>
                <h2 style={{ marginBottom: 4 }}>3. 退店・在籍状態の確認</h2>
                <p className="page-sub" style={{ marginBottom: 10 }}>
                  対象店舗に「在籍」ですがExcelに存在しないキャストです。退店した場合は状態を変更できます（変更しない場合はそのまま）。
                </p>
                {matchResult.missingCasts.map((c) => (
                  <div key={c.id} className="import-row-card">
                    <div className="row-head">
                      <span className="row-name">{c.stageName}</span>
                      <span className="page-sub">現在時給 ¥{c.hourlyWage.toLocaleString()}</span>
                    </div>
                    <div className="import-actions">
                      {["そのまま", "退店", "休職"].map((label) => {
                        const value = label === "そのまま" ? "" : label;
                        const selected = (statusChoices.get(c.id) ?? "") === value;
                        return (
                          <button
                            key={label}
                            type="button"
                            className={`choice-btn${selected ? " selected" : ""}`}
                            disabled={running}
                            onClick={() =>
                              setStatusChoices((prev) => {
                                const next = new Map(prev);
                                if (value) next.set(c.id, value);
                                else next.delete(c.id);
                                return next;
                              })
                            }
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </section>
            )}

            <section className="section-card" style={{ marginBottom: 16 }}>
              <h2 style={{ marginBottom: 10 }}>4. インポートを実行</h2>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <button
                  className="btn btn-primary"
                  onClick={() => setConfirmOpen(true)}
                  disabled={running || !executable}
                >
                  {running ? "保存中…" : "最終確認へ（段階6/8）"}
                </button>
                {!executable && !running && (
                  <span className="page-sub">
                    未選択の行が {summary.unresolved} 件あるため実行できません
                  </span>
                )}
                {running && (
                  <button
                    className="btn btn-danger"
                    onClick={() => {
                      cancelRef.current = true;
                      setSaveCancelRequested(true);
                    }}
                  >
                    {saveCancelRequested ? "キャンセル受付済み…" : "キャンセル（未処理行は保存しない）"}
                  </button>
                )}
              </div>
              {running && progress && (
                <p className="progress-note">
                  段階7/8 Firestore保存 — {progress.done} / {progress.total} 件
                  （{progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0}%）
                  ／ 作成 {progress.created} / 上書き {progress.updated} / スキップ {progress.skipped} /
                  エラー {progress.errors} ／ 保存済み変更 {progress.savedChanges}件
                  {saveCancelRequested && " ／ キャンセル要求受付済み — 現在の行の処理後に停止します"}
                </p>
              )}
              {result && (
                <div
                  className={result.status === "completed" && result.errors === 0 ? "info-box" : "error-box"}
                  style={{ marginTop: 12 }}
                >
                  <strong>
                    {result.status === "completed" && result.errors === 0 && "段階8/8 インポートが完了しました"}
                    {result.status === "completed" && result.errors > 0 && "インポートは完了しましたが一部エラーがあります"}
                    {result.status === "cancelled" &&
                      "インポートをキャンセルしました（保存された変更はありません）"}
                    {result.status === "partial-cancelled" &&
                      "インポートをキャンセルしました（一部保存済み — 履歴からロールバックできます）"}
                    {result.status === "failed" && "インポートに失敗しました"}
                  </strong>
                  <p style={{ marginTop: 6 }}>
                    成功（作成+上書き） {result.created + result.updated} ／ 保存済み変更 {result.savedChanges}件
                    ／ スキップ {result.skipped} ／ エラー {result.errors} ／ 未処理 {result.unprocessed}件
                  </p>
                  <p className="page-sub" style={{ marginTop: 4 }}>
                    このインポートは「インポート履歴」からBatch単位でロールバックできます。
                  </p>
                  {result.errorMessages.map((m, i) => (
                    <p key={i} style={{ marginTop: 4 }}>{m}</p>
                  ))}
                </div>
              )}
            </section>
          </>
        )}
      </main>

      {bulkNewOpen && (
        <BulkNewModal
          eligible={bulkNewEligible}
          summaryExcluded={summary.excluded}
          summaryNeedsConfirm={summary.needsConfirm}
          storeName={storeName(storeId)}
          month={month}
          onApply={() => {
            applyBulk(bulkNewNoCandidateRows);
            setBulkNewOpen(false);
          }}
          onClose={() => setBulkNewOpen(false)}
        />
      )}

      {confirmOpen && parseResult && (
        <FinalConfirmModal
          storeName={storeName(storeId)}
          month={month}
          fileName={fileName}
          sheetName={parseResult.sheetName}
          detectedRows={parseResult.rows.length}
          summary={summary}
          statusChangeCount={statusChoices.size}
          executable={executable}
          running={running}
          onExecute={() => void onExecute()}
          onClose={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}

/** 候補なし一括新規登録の確認画面 */
function BulkNewModal({
  eligible,
  summaryExcluded,
  summaryNeedsConfirm,
  storeName,
  month,
  onApply,
  onClose,
}: {
  eligible: PlanRowState[];
  summaryExcluded: number;
  summaryNeedsConfirm: number;
  storeName: string;
  month: string;
  onApply: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-card" style={{ maxWidth: 560 }}>
        <div className="modal-head">
          <h2>候補なしの一括新規登録 — 確認</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕ 閉じる</button>
        </div>
        <p className="page-sub" style={{ marginBottom: 10 }}>
          {storeName} / {monthToJa(month)} へ、既存キャストに候補が1件も無い行を
          新規キャストとして登録します（空欄・数値のみ・集計項目・候補ありの行は対象外）。
        </p>
        {eligible.length >= BULK_NEW_WARN_COUNT && (
          <div className="error-box" style={{ marginBottom: 10 }}>
            ⚠ 新規登録が{eligible.length}件と多くなっています。誤ったシートや店舗を
            読み込んでいないか、キャスト名一覧を確認してから実行してください。
          </div>
        )}
        <div className="table-wrap" style={{ maxHeight: 300, overflowY: "auto" }}>
          <table className="data-table">
            <thead>
              <tr><th>行</th><th>キャスト名</th><th className="num">Excel時給</th></tr>
            </thead>
            <tbody>
              {eligible.map((st) => (
                <tr key={st.match.row.rowNumber}>
                  <td>{st.match.row.rowNumber}</td>
                  <td>{st.match.row.name}</td>
                  <td className="num">
                    {st.match.row.hourlyWage != null
                      ? `¥${st.match.row.hourlyWage.toLocaleString()}`
                      : "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="page-sub" style={{ marginTop: 10 }}>
          新規登録予定 {eligible.length}件 ／ 除外済み {summaryExcluded}件 ／
          要確認 {summaryNeedsConfirm}件。作成されたデータは importBatches.changes に
          記録され、Batch単位でロールバックできます。
        </p>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose}>キャンセル</button>
          <button className="btn btn-primary" onClick={onApply}>
            {eligible.length}件を新規登録に設定
          </button>
        </div>
      </div>
    </div>
  );
}

/** 実行前の最終確認画面（段階6/8） */
function FinalConfirmModal({
  storeName,
  month,
  fileName,
  sheetName,
  detectedRows,
  summary,
  statusChangeCount,
  executable,
  running,
  onExecute,
  onClose,
}: {
  storeName: string;
  month: string;
  fileName: string;
  sheetName: string;
  detectedRows: number;
  summary: ReturnType<typeof summarizePlan>;
  statusChangeCount: number;
  executable: boolean;
  running: boolean;
  onExecute: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-card" style={{ maxWidth: 520 }}>
        <div className="modal-head">
          <h2>最終確認（段階6/8）</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={running}>
            ✕ 閉じる
          </button>
        </div>
        <div className="table-wrap">
          <table className="data-table">
            <tbody>
              <tr><td>対象店舗</td><td>{storeName}</td></tr>
              <tr><td>対象月</td><td>{monthToJa(month)}</td></tr>
              <tr><td>ファイル</td><td style={{ wordBreak: "break-all" }}>{fileName}</td></tr>
              <tr><td>採用シート</td><td>{sheetName}</td></tr>
              <tr><td>検出キャスト数</td><td className="num">{detectedRows}件</td></tr>
              <tr><td>自動確定</td><td className="num">{summary.autoConfirmed}件</td></tr>
              <tr><td>新規キャスト登録</td><td className="num">{summary.newCasts}件</td></tr>
              <tr><td>既存キャストへ紐付け</td><td className="num">{summary.links}件</td></tr>
              <tr><td>既存成績の上書き</td><td className="num">{summary.overwrite}件</td></tr>
              <tr><td>時給変更として処理</td><td className="num">{summary.wageChanges}件</td></tr>
              <tr><td>在籍状態の変更</td><td className="num">{statusChangeCount}件</td></tr>
              <tr><td>除外</td><td className="num">{summary.excluded}件</td></tr>
              <tr>
                <td>未選択</td>
                <td className="num">
                  {summary.unresolved > 0 ? (
                    <span className="badge badge-red">{summary.unresolved}件</span>
                  ) : (
                    "0件"
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="info-box" style={{ marginTop: 10 }}>
          すべての変更は importBatches.changes に記録され、実行後に
          「インポート履歴」からBatch単位でロールバックできます。
        </div>
        {summary.unresolved > 0 && (
          <div className="error-box" style={{ marginTop: 10 }}>
            未選択の行が残っているため実行できません。
          </div>
        )}
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose} disabled={running}>
            キャンセル
          </button>
          <button
            className="btn btn-primary"
            onClick={onExecute}
            disabled={!executable || running || summary.unresolved > 0}
          >
            実行（段階7/8 保存開始）
          </button>
        </div>
      </div>
    </div>
  );
}

const ACTION_LABELS: Record<RowAction, string> = {
  link: "既存キャストへ紐付け",
  new: "新規キャストとして登録",
  "wage-change": "時給変更として処理",
  exclude: "インポート対象から除外",
};

function RowCard({
  rs,
  existingMap,
  onChange,
  disabled,
}: {
  rs: RowState;
  existingMap: Map<string, MonthlyResultWithId>;
  onChange: (patch: Partial<RowState>) => void;
  disabled: boolean;
}) {
  const { match } = rs;
  const row = match.row;
  const existing =
    rs.castId && rs.action !== "new" && rs.action !== null
      ? existingMap.get(rs.castId)
      : undefined;
  const linkedCandidate = match.candidates.find((c) => c.cast.id === rs.castId);

  return (
    <div className="import-row-card" id={`import-row-${row.rowNumber}`}>
      <div className="row-head">
        <div>
          <span className="row-name">行{row.rowNumber}: {row.name}</span>
          {rs.action === null && (
            <span className="badge badge-red" style={{ marginLeft: 8 }}>未選択</span>
          )}
          {rs.autoConfirmed && rs.action !== null && (
            <span className="badge badge-green" style={{ marginLeft: 8 }}>自動確定済み</span>
          )}
          {match.ruleApplied && match.ruleReconfirmReasons.length === 0 && (
            <span className="badge badge-purple" style={{ marginLeft: 8 }}>ルール適用</span>
          )}
          {match.wageChange && (
            <span className="badge badge-yellow" style={{ marginLeft: 8 }}>時給変更候補</span>
          )}
          {match.sameNameConfirm && (
            <span className="badge badge-orange" style={{ marginLeft: 8 }}>完全一致が複数</span>
          )}
        </div>
        <span className="page-sub">
          売上 ¥{row.totalSales.toLocaleString()}
          {row.hourlyWage != null && ` ／ Excel時給 ¥${row.hourlyWage.toLocaleString()}`}
        </span>
      </div>

      {match.ruleReconfirmReasons.length > 0 && (
        <div className="candidate" style={{ color: "var(--acc2)" }}>
          ルールがありますが再確認が必要です: {match.ruleReconfirmReasons.join(" / ")}
        </div>
      )}
      {match.statusConfirm && (
        <div className="candidate" style={{ color: "var(--acc2)" }}>{match.statusConfirm}</div>
      )}

      {match.candidates.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          {match.candidates.map((c) => (
            <label key={c.cast.id} className="candidate" style={{ display: "block", cursor: "pointer" }}>
              <input
                type="radio"
                name={`cand-${row.rowNumber}`}
                checked={rs.castId === c.cast.id && rs.action !== "new" && rs.action !== "exclude" && rs.action !== null}
                disabled={disabled}
                onChange={() => {
                  const wageDiffers =
                    row.hourlyWage != null && row.hourlyWage > 0 && row.hourlyWage !== c.cast.hourlyWage;
                  onChange({
                    castId: c.cast.id,
                    action: wageDiffers && rs.action === "wage-change" ? "wage-change" : "link",
                  });
                }}
                style={{ marginRight: 6 }}
              />
              <strong>{c.cast.stageName}</strong>
              {c.cast.realName && `（本名: ${c.cast.realName}）`}
              ／ 現在時給 ¥{c.cast.hourlyWage.toLocaleString()}
              {row.hourlyWage != null && ` ／ Excel時給 ¥${row.hourlyWage.toLocaleString()}`}
              ／ {c.reason}
              {c.cast.status !== "在籍" && ` ／ ${c.cast.status}`}
              {c.cast.archived && " ／ アーカイブ済み"}
            </label>
          ))}
        </div>
      )}

      <div className="import-actions">
        {(Object.keys(ACTION_LABELS) as RowAction[]).map((action) => {
          const isWage = action === "wage-change";
          const wageAvailable =
            row.hourlyWage != null &&
            row.hourlyWage > 0 &&
            !!rs.castId &&
            linkedCandidate !== undefined &&
            row.hourlyWage !== linkedCandidate.cast.hourlyWage;
          if (isWage && !wageAvailable && rs.action !== "wage-change") return null;
          return (
            <button
              key={action}
              type="button"
              className={`choice-btn${rs.action === action ? " selected" : ""}`}
              disabled={disabled}
              onClick={() => onChange({ action })}
            >
              {ACTION_LABELS[action]}
              {isWage && linkedCandidate && row.hourlyWage != null &&
                `（¥${linkedCandidate.cast.hourlyWage.toLocaleString()} → ¥${row.hourlyWage.toLocaleString()}）`}
            </button>
          );
        })}
      </div>

      {existing && rs.action !== "exclude" && rs.action !== null && (
        <div style={{ marginTop: 8 }}>
          <div className="candidate">
            この月の成績が既に存在します（総売上 ¥{existing.totalSales.toLocaleString()}）。
          </div>
          <div className="import-actions">
            <button
              type="button"
              className={`choice-btn${rs.existing === "skip" ? " selected" : ""}`}
              disabled={disabled}
              onClick={() => onChange({ existing: "skip" })}
            >
              既存を維持してスキップ
            </button>
            <button
              type="button"
              className={`choice-btn${rs.existing === "overwrite" ? " selected" : ""}`}
              disabled={disabled}
              onClick={() => onChange({ existing: "overwrite" })}
            >
              既存を上書き
            </button>
            <button
              type="button"
              className="choice-btn"
              disabled={disabled}
              onClick={() => onChange({ showDiff: !rs.showDiff })}
            >
              差分を確認して判断
            </button>
          </div>
          {rs.showDiff && (
            <div className="table-wrap" style={{ marginTop: 8 }}>
              <table className="data-table">
                <thead>
                  <tr><th>項目</th><th className="num">既存</th><th className="num">Excel</th></tr>
                </thead>
                <tbody>
                  <DiffRow label="総売上" a={existing.totalSales} b={row.totalSales} yen />
                  <DiffRow label="支給額" a={existing.payment} b={row.payment} yen />
                  <DiffRow label="本指名" a={existing.honshimeiCount} b={row.honshimeiCount} />
                  <DiffRow label="本指名組数" a={existing.honshimeiGroupCount} b={row.honshimeiGroupCount} />
                  <DiffRow label="顧客数" a={existing.customerCount} b={row.customerCount} />
                  <DiffRow label="場内" a={existing.jounaiCount} b={row.jounaiCount} />
                  <DiffRow label="同伴" a={existing.douhan} b={row.douhan} />
                  <DiffRow label="出勤日数" a={existing.workDays} b={row.workDays} />
                  <DiffRow label="出勤時間" a={existing.workHours} b={row.workHours} />
                  <DiffRow label="欠勤" a={existing.absent} b={row.absent} />
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {rs.action !== "exclude" && rs.action !== null && (
        <label className="check-label" style={{ marginTop: 8, display: "inline-flex", gap: 6 }}>
          <input
            type="checkbox"
            checked={rs.saveRule}
            disabled={disabled}
            onChange={(e) => onChange({ saveRule: e.target.checked })}
          />
          この照合結果を記憶する（次回インポートで自動判定に使用）
        </label>
      )}
    </div>
  );
}

function DiffRow({ label, a, b, yen }: { label: string; a: number; b: number; yen?: boolean }) {
  const fmt = (v: number) => (yen ? `¥${v.toLocaleString()}` : String(v));
  const changed = a !== b;
  return (
    <tr>
      <td>{label}</td>
      <td className="num">{fmt(a)}</td>
      <td className="num" style={changed ? { color: "var(--acc2)", fontWeight: 700 } : undefined}>
        {fmt(b)}
      </td>
    </tr>
  );
}
