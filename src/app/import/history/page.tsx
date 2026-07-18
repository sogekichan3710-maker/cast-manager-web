"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { AppHeader } from "@/components/AppHeader";
import { useStores } from "@/hooks/useStores";
import { subscribeImportBatches } from "@/services/importBatchService";
import {
  isAdminOrAbove,
  monthToJa,
  type ImportBatchWithId,
  type RunStatus,
} from "@/types";

/**
 * インポート履歴（owner / 許可されたadmin）。
 * viewerは既存の権限設計（業務データは閲覧可）に合わせRules上は読み取り可能だが、
 * インポートは実行できないため画面自体は非表示とする。
 */
export default function ImportHistoryPage() {
  const { userDoc } = useAuth();
  const canView = isAdminOrAbove(userDoc);
  const router = useRouter();
  const { accessibleStores } = useStores();

  const [batches, setBatches] = useState<ImportBatchWithId[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="app-main app-main-wide">
        <div className="page-head">
          <div>
            <h1 className="page-title">インポート履歴</h1>
            <p className="page-sub">Excelインポートの実行履歴（閲覧可能な店舗のみ）</p>
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
                  <th className="num">行数</th>
                  <th className="num">作成</th>
                  <th className="num">上書き</th>
                  <th className="num">スキップ</th>
                  <th className="num">エラー</th>
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
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
