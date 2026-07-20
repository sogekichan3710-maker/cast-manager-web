"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { AppHeader } from "@/components/AppHeader";
import { useStores } from "@/hooks/useStores";
import { subscribeImportBatches } from "@/services/importBatchService";
import {
  buildRollbackPreview,
  rollbackImportBatch,
  type RollbackProgress,
  type RollbackResult,
} from "@/services/importRollbackService";
import {
  isAdminOrAbove,
  monthToJa,
  type ImportBatchWithId,
  type RollbackStatus,
  type RunStatus,
} from "@/types";

/**
 * インポート履歴（owner / 許可されたadmin）。
 * Batchを選択して内容（新規キャスト・更新・月別成績・時給履歴・ルールの件数）を
 * 確認したうえで、Batch単位のロールバックを実行できる。
 * viewerは既存の権限設計（業務データは閲覧可）に合わせRules上は読み取り可能だが、
 * インポート・ロールバックは実行できないため画面自体は非表示とする。
 */
export default function ImportHistoryPage() {
  const { firebaseUser, userDoc } = useAuth();
  const canView = isAdminOrAbove(userDoc);
  const router = useRouter();
  const { accessibleStores } = useStores();

  const [batches, setBatches] = useState<ImportBatchWithId[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [selected, setSelected] = useState<ImportBatchWithId | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<RollbackProgress | null>(null);
  const [result, setResult] = useState<RollbackResult | null>(null);
  const cancelRef = useRef(false);

  useEffect(() => {
    if (userDoc && !canView) router.replace("/dashboard");
  }, [userDoc, canView, router]);

  const storeIds = useMemo(() => accessibleStores.map((s) => s.id), [accessibleStores]);
  useEffect(() => {
    if (!canView || storeIds.length === 0) return;
    setLoading(true);
    return subscribeImportBatches(
      storeIds,
      (list) => {
        setBatches(list);
        setLoading(false);
      },
      (m) => {
        setError(m);
        setLoading(false);
      }
    );
  }, [canView, storeIds]);

  const storeName = (id: string) => accessibleStores.find((s) => s.id === id)?.name ?? id;

  if (!canView) return null;

  function openRollback(b: ImportBatchWithId) {
    setSelected(b);
    setResult(null);
    setProgress(null);
  }

  async function onRollback() {
    if (!firebaseUser || !selected || running) return;
    const preview = buildRollbackPreview(selected);
    if (!preview.available) return;
    if (
      !window.confirm(
        `このインポート（${selected.fileName} / ${monthToJa(selected.targetMonth)}）を取り消します。\n` +
          "このBatchが作成・変更したデータのみが対象です。実行しますか？"
      )
    ) {
      return;
    }
    cancelRef.current = false;
    setRunning(true);
    setResult(null);
    setProgress(null);
    try {
      const res = await rollbackImportBatch(
        firebaseUser.uid,
        selected,
        setProgress,
        () => cancelRef.current
      );
      setResult(res);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="app-main app-main-wide">
        <div className="page-head">
          <div>
            <h1 className="page-title">インポート履歴</h1>
            <p className="page-sub">
              Excelインポートの実行履歴（閲覧可能な店舗のみ）。Batchを選択して取り消しできます
            </p>
          </div>
        </div>

        {error && <div className="error-box">{error}</div>}

        {loading ? (
          <div className="loading-block" style={{ padding: 40 }}>
            <div className="spinner" aria-hidden />
            <p>読み込んでいます…</p>
          </div>
        ) : batches.length === 0 ? (
          <p className="empty-note">インポート履歴はまだありません</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>実行日時</th>
                  <th>店舗</th>
                  <th>対象月</th>
                  <th>ファイル</th>
                  <th>状態</th>
                  <th>ロールバック</th>
                  <th className="num">行数</th>
                  <th className="num">作成</th>
                  <th className="num">上書き</th>
                  <th className="num">スキップ</th>
                  <th className="num">エラー</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr key={b.id}>
                    <td>{b.createdAt ? b.createdAt.toDate().toLocaleString("ja-JP") : "-"}</td>
                    <td>{storeName(b.storeId)}</td>
                    <td>{monthToJa(b.targetMonth)}</td>
                    <td style={{ wordBreak: "break-all" }}>{b.fileName}</td>
                    <td><StatusBadge status={b.status} /></td>
                    <td><RollbackBadge status={b.rollbackStatus ?? "none"} /></td>
                    <td className="num">{b.totalRows}</td>
                    <td className="num">{b.createdCount}</td>
                    <td className="num">{b.updatedCount}</td>
                    <td className="num">{b.skippedCount}</td>
                    <td className="num">
                      {b.errorCount > 0 ? (
                        <span className="badge badge-red">{b.errorCount}</span>
                      ) : (
                        0
                      )}
                    </td>
                    <td>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => openRollback(b)}
                        disabled={running}
                      >
                        詳細 / 取り消し
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {selected && (
        <RollbackModal
          batch={selected}
          storeName={storeName}
          running={running}
          progress={progress}
          result={result}
          onCancelRun={() => { cancelRef.current = true; }}
          onExecute={() => void onRollback()}
          onClose={() => {
            if (!running) setSelected(null);
          }}
        />
      )}
    </div>
  );
}

function RollbackModal({
  batch,
  storeName,
  running,
  progress,
  result,
  onCancelRun,
  onExecute,
  onClose,
}: {
  batch: ImportBatchWithId;
  storeName: (id: string) => string;
  running: boolean;
  progress: RollbackProgress | null;
  result: RollbackResult | null;
  onCancelRun: () => void;
  onExecute: () => void;
  onClose: () => void;
}) {
  const preview = buildRollbackPreview(batch);

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
          <h2>インポートの取り消し（ロールバック）</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={running}>
            ✕ 閉じる
          </button>
        </div>

        <p className="page-sub" style={{ marginBottom: 10 }}>
          {storeName(batch.storeId)} / {monthToJa(batch.targetMonth)} / {batch.fileName}
          <br />
          実行結果: {batch.summary || "-"}
          {batch.rollbackSummary ? ` ／ 前回ロールバック: ${batch.rollbackSummary}` : ""}
        </p>

        <div className="table-wrap">
          <table className="data-table">
            <tbody>
              <tr><td>新規キャスト</td><td className="num">{preview.newCasts}件</td></tr>
              <tr><td>更新キャスト（時給・在籍状態）</td><td className="num">{preview.updatedCasts}件</td></tr>
              <tr><td>月別成績（新規+上書き）</td><td className="num">{preview.monthlyResults}件</td></tr>
              <tr><td>時給履歴</td><td className="num">{preview.wageHistory}件</td></tr>
              <tr><td>nameMatchingRules</td><td className="num">{preview.nameMatchingRules}件</td></tr>
            </tbody>
          </table>
        </div>

        {!preview.available && (
          <div className="info-box" style={{ marginTop: 10 }}>
            ロールバック不可: {preview.unavailableReason}
          </div>
        )}
        {preview.available && (
          <div className="info-box" style={{ marginTop: 10 }}>
            このBatchが作成・変更したデータのみを取り消します。
            インポート後に手動変更されたデータは上書きせず「戻せない」として理由を表示します。
          </div>
        )}

        {progress && (
          <p className="progress-note">
            処理中… {progress.done} / {progress.total}
            （取り消し {progress.reverted} / 戻せない {progress.skipped}）
          </p>
        )}

        {result && (
          <div
            className={result.status === "completed" ? "info-box" : "error-box"}
            style={{ marginTop: 10 }}
          >
            <strong>
              {result.status === "completed" && "ロールバックが完了しました"}
              {result.status === "partial" && "ロールバックは一部のみ完了しました"}
              {result.status === "failed" && "ロールバックに失敗しました"}
            </strong>
            <p style={{ marginTop: 6 }}>
              取り消し {result.reverted} / 戻せない {result.skipped.length} / エラー {result.errorMessages.length}
            </p>
            {result.skipped.map((s, i) => (
              <p key={i} className="page-sub" style={{ marginTop: 4 }}>
                {s.collection}/{s.docId}: {s.reason}
              </p>
            ))}
            {result.errorMessages.map((m, i) => (
              <p key={i} style={{ marginTop: 4 }}>{m}</p>
            ))}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onClose} disabled={running}>
            閉じる
          </button>
          {running ? (
            <button className="btn btn-danger" onClick={onCancelRun}>
              キャンセル
            </button>
          ) : (
            <button
              className="btn btn-danger"
              onClick={onExecute}
              disabled={!preview.available || result?.status === "completed"}
            >
              ロールバックを実行
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: RunStatus }) {
  const map: Record<RunStatus, { cls: string; label: string }> = {
    processing: { cls: "badge-yellow", label: "実行中" },
    completed: { cls: "badge-green", label: "完了" },
    failed: { cls: "badge-red", label: "失敗" },
    cancelled: { cls: "badge-gray", label: "中断" },
  };
  const m = map[status] ?? { cls: "badge-gray", label: status };
  return <span className={`badge ${m.cls}`}>{m.label}</span>;
}

function RollbackBadge({ status }: { status: RollbackStatus }) {
  if (status === "none") return <span className="dim">-</span>;
  const map: Record<Exclude<RollbackStatus, "none">, { cls: string; label: string }> = {
    completed: { cls: "badge-gray", label: "取消済み" },
    partial: { cls: "badge-orange", label: "一部取消" },
    failed: { cls: "badge-red", label: "取消失敗" },
  };
  const m = map[status as Exclude<RollbackStatus, "none">] ?? { cls: "badge-gray", label: status };
  return <span className={`badge ${m.cls}`}>{m.label}</span>;
}
