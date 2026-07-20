"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { AppHeader } from "@/components/AppHeader";
import { useStores } from "@/hooks/useStores";
import { subscribeAuditLogs } from "@/services/auditLogService";
import { AUDIT_ACTIONS, isOwner, type AuditLogWithId } from "@/types";

/**
 * 監査ログ閲覧（owner専用・PR5）。
 * キャスト登録/編集/アーカイブ/復元/完全削除、月別成績登録/編集/削除、
 * 面談・目標・モチベーション・時給変更、Excelインポート実行/ロールバック、
 * 旧データ移行、JSONバックアップ、ユーザー承認/権限変更/無効化/有効化/
 * accessibleStoreIds変更について「誰が・いつ・何を・どの店舗で・変更前・
 * 変更後」を確認できる。Rules側もownerのみ閲覧可に制限している。
 */
export default function AuditLogPage() {
  const { userDoc } = useAuth();
  const owner = isOwner(userDoc);
  const router = useRouter();
  const { stores } = useStores();

  const [logs, setLogs] = useState<AuditLogWithId[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionFilter, setActionFilter] = useState<string>("");
  const [storeFilter, setStoreFilter] = useState<string>("");
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (userDoc && !owner) router.replace("/dashboard");
  }, [userDoc, owner, router]);

  useEffect(() => {
    if (!owner) return;
    setLoading(true);
    return subscribeAuditLogs(
      (list) => {
        setLogs(list);
        setLoading(false);
      },
      (m) => {
        setError(m);
        setLoading(false);
      }
    );
  }, [owner]);

  const storeName = (id: string | null) => {
    if (!id) return "-";
    return stores.find((s) => s.id === id)?.name ?? id;
  };

  const filtered = useMemo(
    () =>
      logs.filter(
        (l) =>
          (!actionFilter || l.action === actionFilter) &&
          (!storeFilter || l.storeId === storeFilter)
      ),
    [logs, actionFilter, storeFilter]
  );

  if (!owner) return null;

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="app-main app-main-wide">
        <div className="page-head">
          <div>
            <h1 className="page-title">監査ログ</h1>
            <p className="page-sub">
              誰が・いつ・何を・どの店舗で・変更前・変更後を確認できます（オーナー専用・最新500件）
            </p>
          </div>
        </div>

        {error && <div className="error-box">読み込みエラー: {error}</div>}

        <div className="filter-bar">
          <select
            className="form-input"
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
          >
            <option value="">すべての操作</option>
            {AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
          <select
            className="form-input"
            value={storeFilter}
            onChange={(e) => setStoreFilter(e.target.value)}
          >
            <option value="">すべての店舗</option>
            {stores.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>

        {loading ? (
          <div className="loading-block" style={{ padding: 40 }}>
            <div className="spinner" aria-hidden />
            <p>読み込んでいます…</p>
          </div>
        ) : filtered.length === 0 ? (
          <p className="empty-note">該当する監査ログはありません</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>日時</th>
                  <th>ユーザー</th>
                  <th>操作</th>
                  <th>コレクション</th>
                  <th>対象ID</th>
                  <th>店舗</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((log) => (
                  <Fragment key={log.id}>
                    <tr
                      className="row-clickable"
                      onClick={() => setExpanded(expanded === log.id ? null : log.id)}
                    >
                      <td>{log.createdAt ? log.createdAt.toDate().toLocaleString("ja-JP") : "-"}</td>
                      <td>{log.userName || log.userId}</td>
                      <td>{log.action}</td>
                      <td>{log.collection}</td>
                      <td style={{ wordBreak: "break-all" }}>{log.documentId}</td>
                      <td>{storeName(log.storeId)}</td>
                      <td>{expanded === log.id ? "▲" : "▼"}</td>
                    </tr>
                    {expanded === log.id && (
                      <tr>
                        <td colSpan={7}>
                          <div className="detail-grid">
                            <div>
                              <div className="detail-label">変更前</div>
                              <pre className="detail-multiline" style={{ padding: 10 }}>
                                {log.before ? JSON.stringify(log.before, null, 2) : "（なし）"}
                              </pre>
                            </div>
                            <div>
                              <div className="detail-label">変更後</div>
                              <pre className="detail-multiline" style={{ padding: 10 }}>
                                {log.after ? JSON.stringify(log.after, null, 2) : "（なし）"}
                              </pre>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
