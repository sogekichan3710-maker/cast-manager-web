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
import { parseMonthlyExcel, type ExcelParseResult } from "@/lib/excel/parseMonthlyExcel";
import {
  matchExcelRows,
  type MatchResult,
  type RowAction,
  type MatchableCast,
} from "@/lib/excel/importMatching";
import {
  buildInitialRowStates,
  canExecutePlan,
  recomputeExisting,
  summarizePlan,
  type PlanRowState,
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
 * 店舗・月・ファイル選択 → シート/範囲確認 → 照合確認（時給変更 / 同名 /
 * 在籍状態の3種確認）→ 最終確認画面 → 実行 → 結果表示。
 *
 * 安全対策:
 * - 要確認行の初期状態は「未選択」。すべて解決するまで実行不可
 * - 自動で新規キャスト登録しない（ルールで確定済みの場合のみ自動提案）
 * - 実行前に最終確認画面（新規/更新/時給変更/除外/要確認の件数）を必ず表示
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

  const [casts, setCasts] = useState<CastWithId[]>([]);
  const [rowStates, setRowStates] = useState<RowState[]>([]);
  const [matchResult, setMatchResult] = useState<MatchResult | null>(null);
  const [existingMap, setExistingMap] = useState<Map<string, MonthlyResultWithId>>(new Map());
  const [statusChoices, setStatusChoices] = useState<Map<string, string>>(new Map());
  const [preparing, setPreparing] = useState(false);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const cancelRef = useRef(false);

  useEffect(() => {
    if (userDoc && !canImport) router.replace("/dashboard");
  }, [userDoc, canImport, router]);

  // 照合用に閲覧可能全店舗のキャストを購読（他店舗同名の検出に使用）
  const storeIds = useMemo(() => accessibleStores.map((s) => s.id), [accessibleStores]);
  useEffect(() => {
    if (storeIds.length === 0) return;
    return subscribeCasts(storeIds, setCasts, (m) => setPageError(m));
  }, [storeIds]);

  const storeName = (id: string) => accessibleStores.find((s) => s.id === id)?.name ?? id;
  const existingCastIds = useMemo(() => new Set(existingMap.keys()), [existingMap]);
  const summary = useMemo(() => summarizePlan(rowStates), [rowStates]);
  const executable = canExecutePlan(rowStates);

  if (!canImport) return null;

  function resetPreview() {
    setMatchResult(null);
    setRowStates([]);
    setResult(null);
    setConfirmOpen(false);
  }

  function parseBuffer(buffer: ArrayBuffer, sheetName?: string) {
    setPageError(null);
    setParseResult(null);
    resetPreview();
    try {
      setParseResult(parseMonthlyExcel(buffer, sheetName ? { sheetName } : undefined));
    } catch (err) {
      setPageError((err as Error).message);
    }
  }

  function onFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      fileBufferRef.current = reader.result as ArrayBuffer;
      parseBuffer(fileBufferRef.current);
    };
    reader.onerror = () => setPageError("ファイルの読み込みに失敗しました");
    reader.readAsArrayBuffer(file);
  }

  function onSelectSheet(sheetName: string) {
    if (!fileBufferRef.current) return;
    parseBuffer(fileBufferRef.current, sheetName);
  }

  /** 照合確認画面を作成する */
  async function onBuildPreview() {
    if (!parseResult || !storeId || !/^\d{4}-\d{2}$/.test(month) || preparing) return;
    if (parseResult.rows.length === 0) {
      setPageError("キャスト行が0件のため照合できません。シート・ヘッダー行をご確認ください。");
      return;
    }
    setPreparing(true);
    setPageError(null);
    try {
      const [rules, existing] = await Promise.all([
        fetchRulesByStore(storeId),
        fetchMonthlyResultsByStoreMonth(storeId, month),
      ]);
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
      const mr = matchExcelRows(parseResult.rows, storeId, matchable, rules);
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
    } catch (err) {
      setPageError((err as Error).message);
    } finally {
      setPreparing(false);
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

  async function onExecute() {
    if (!firebaseUser || running || !matchResult || !executable) return;
    setConfirmOpen(false);
    setPageError(null);
    cancelRef.current = false;
    setRunning(true);
    setResult(null);
    setProgress(null);
    try {
      const decisions: RowDecision[] = rowStates.map((r) => ({
        row: r.match.row,
        action: r.action as RowAction, // executable 判定済み（null無し）
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
                resetPreview();
              }}
              disabled={running}
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
                resetPreview();
              }}
              disabled={running}
            />
            <input
              type="file"
              accept=".xlsx,.xls,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={onFileSelected}
              disabled={running}
            />
          </div>

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
                          onChange={(e) => onSelectSheet(e.target.value)}
                          disabled={running}
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
              disabled={!readyToPreview || preparing || running}
            >
              {preparing ? "照合中…" : "照合確認へ進む"}
            </button>
            {!readyToPreview && (
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
              <p className="page-sub" style={{ marginBottom: 12 }}>
                {storeName(storeId)} / {monthToJa(month)} ―
                未選択（要確認） {summary.unresolved}件 ／
                時給変更候補 {rowStates.filter((r) => r.match.wageChange).length}件 ／
                同名候補 {rowStates.filter((r) => r.match.sameNameConfirm).length}件 ／
                在籍状態確認 {rowStates.filter((r) => r.match.statusConfirm).length}件
              </p>
              {summary.unresolved > 0 && (
                <div className="info-box" style={{ marginBottom: 12 }}>
                  「未選択」の行がすべて解決されるまでインポートは実行できません。
                  各行で紐付け・新規登録・時給変更・除外のいずれかを選択してください。
                </div>
              )}

              {rowStates.map((rs, idx) => (
                <RowCard
                  key={rs.match.row.rowNumber}
                  rs={rs}
                  existingMap={existingMap}
                  storeName={storeName}
                  targetStoreId={storeId}
                  onChange={(patch) => updateRow(idx, patch)}
                  disabled={running}
                />
              ))}
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
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button
                  className="btn btn-primary"
                  onClick={() => setConfirmOpen(true)}
                  disabled={running || !executable}
                >
                  {running ? "インポート中…" : "最終確認へ"}
                </button>
                {!executable && !running && (
                  <span className="page-sub" style={{ alignSelf: "center" }}>
                    未選択の行が {summary.unresolved} 件あるため実行できません
                  </span>
                )}
                {running && (
                  <button className="btn btn-ghost" onClick={() => { cancelRef.current = true; }}>
                    キャンセル（現在の行の処理後に停止）
                  </button>
                )}
              </div>
              {progress && (
                <p className="progress-note">
                  処理中… {progress.done} / {progress.total} 行
                  （作成 {progress.created} / 上書き {progress.updated} / スキップ {progress.skipped} / エラー {progress.errors}）
                </p>
              )}
              {result && (
                <div
                  className={result.status === "completed" && result.errors === 0 ? "info-box" : "error-box"}
                  style={{ marginTop: 12 }}
                >
                  <strong>
                    {result.status === "completed" && result.errors === 0 && "インポートが完了しました"}
                    {result.status === "completed" && result.errors > 0 && "インポートは完了しましたが一部エラーがあります"}
                    {result.status === "cancelled" && "インポートを中断しました"}
                    {result.status === "failed" && "インポートに失敗しました"}
                  </strong>
                  <p style={{ marginTop: 6 }}>
                    作成 {result.created} / 上書き {result.updated} / スキップ {result.skipped} / エラー {result.errors}
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

      {confirmOpen && (
        <div className="modal-overlay" role="dialog" aria-modal="true">
          <div className="modal-card" style={{ maxWidth: 480 }}>
            <div className="modal-head">
              <h2>インポート実行前の最終確認</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setConfirmOpen(false)}>
                ✕ 閉じる
              </button>
            </div>
            <p className="page-sub" style={{ marginBottom: 10 }}>
              {storeName(storeId)} / {monthToJa(month)} / {fileName}
            </p>
            <div className="table-wrap">
              <table className="data-table">
                <tbody>
                  <tr><td>新規キャスト登録</td><td className="num">{summary.newCasts}件</td></tr>
                  <tr><td>既存キャストへ紐付け</td><td className="num">{summary.links}件</td></tr>
                  <tr><td>時給変更として処理</td><td className="num">{summary.wageChanges}件</td></tr>
                  <tr><td>既存成績の上書き</td><td className="num">{summary.overwrite}件</td></tr>
                  <tr><td>既存ありスキップ</td><td className="num">{summary.skipExisting}件</td></tr>
                  <tr><td>インポート対象から除外</td><td className="num">{summary.excluded}件</td></tr>
                  <tr><td>未選択（要確認）</td><td className="num">{summary.unresolved}件</td></tr>
                  <tr><td>在籍状態の変更</td><td className="num">{statusChoices.size}件</td></tr>
                </tbody>
              </table>
            </div>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setConfirmOpen(false)}>
                キャンセル
              </button>
              <button
                className="btn btn-primary"
                onClick={() => void onExecute()}
                disabled={!executable || running}
              >
                実行
              </button>
            </div>
          </div>
        </div>
      )}
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
  storeName,
  targetStoreId,
  onChange,
  disabled,
}: {
  rs: PlanRowState & { showDiff: boolean };
  existingMap: Map<string, MonthlyResultWithId>;
  storeName: (id: string) => string;
  targetStoreId: string;
  onChange: (patch: Partial<PlanRowState & { showDiff: boolean }>) => void;
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
    <div className="import-row-card">
      <div className="row-head">
        <div>
          <span className="row-name">行{row.rowNumber}: {row.name}</span>
          {rs.action === null && (
            <span className="badge badge-red" style={{ marginLeft: 8 }}>未選択</span>
          )}
          {match.ruleApplied && match.ruleReconfirmReasons.length === 0 && (
            <span className="badge badge-purple" style={{ marginLeft: 8 }}>ルール適用</span>
          )}
          {match.wageChange && (
            <span className="badge badge-yellow" style={{ marginLeft: 8 }}>時給変更候補</span>
          )}
          {match.sameNameConfirm && (
            <span className="badge badge-orange" style={{ marginLeft: 8 }}>同名・類似候補</span>
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
                disabled={disabled || c.cast.storeId !== targetStoreId}
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
              ／ {storeName(c.cast.storeId)}
              ／ 現在時給 ¥{c.cast.hourlyWage.toLocaleString()}
              {row.hourlyWage != null && ` ／ Excel時給 ¥${row.hourlyWage.toLocaleString()}`}
              ／ {c.reason}
              ／ {c.matchType === "exact" ? "完全一致" : "類似候補"}
              {c.cast.status !== "在籍" && ` ／ ${c.cast.status}`}
              {c.cast.archived && " ／ アーカイブ済み"}
              {c.cast.storeId !== targetStoreId && "（他店舗のため紐付け不可・参考表示）"}
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
