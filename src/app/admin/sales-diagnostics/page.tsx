"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { AppHeader } from "@/components/AppHeader";
import { useStores } from "@/hooks/useStores";
import { fetchCastSalesDiagnostics, type CastSalesDiagnosticResult } from "@/services/salesDiagnosticsService";
import { currentMonth, isOwner } from "@/types";

/**
 * 売上ランキング不一致の事実確認ツール（owner専用・読み取り専用）。
 *
 * 「せいかの売上ランキングが指名+場内の合計と一致しない」という報告に対し、
 * 推測ではなく実際のFirestore保存値で
 *  - 対象店舗内に同じ源氏名のキャストが複数（アーカイブ済み含む）存在しないか
 *  - それぞれのキャストのmonthlyResults（対象月）に何が保存されているか
 *  - 次回インポートがどのcastIdへ書き込まれるか（保存済み照合ルール）
 * を1画面で突き合わせるための調査専用ページ。書き込みは一切行わない。
 */
export default function SalesDiagnosticsPage() {
  const { userDoc } = useAuth();
  const owner = isOwner(userDoc);
  const router = useRouter();
  const { accessibleStores } = useStores();

  const [storeId, setStoreId] = useState("");
  const [castName, setCastName] = useState("");
  const [month, setMonth] = useState(currentMonth());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CastSalesDiagnosticResult | null>(null);

  useEffect(() => {
    if (userDoc && !owner) router.replace("/dashboard");
  }, [userDoc, owner, router]);

  useEffect(() => {
    if (!storeId && accessibleStores.length > 0) setStoreId(accessibleStores[0].id);
  }, [accessibleStores, storeId]);

  if (!owner) return null;

  async function runDiagnostics() {
    if (!storeId || !castName.trim() || !/^\d{4}-\d{2}$/.test(month)) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const r = await fetchCastSalesDiagnostics(storeId, castName.trim(), month);
      setResult(r);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="app-main">
        <div className="page-head">
          <div>
            <h1 className="page-title">売上ランキング事実確認ツール</h1>
            <p className="page-sub">
              読み取り専用。指定した源氏名に一致する全キャスト（アーカイブ済み含む）とFirestoreの実際の保存値、
              次回インポートの紐付け先ルールを突き合わせます。書き込みは一切行いません。
            </p>
          </div>
        </div>

        <div className="filter-bar">
          <select
            className="form-input"
            value={storeId}
            onChange={(e) => setStoreId(e.target.value)}
            aria-label="店舗"
          >
            {accessibleStores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <input
            className="form-input"
            type="text"
            placeholder="キャスト名（例: せいか）"
            value={castName}
            onChange={(e) => setCastName(e.target.value)}
          />
          <input
            className="form-input"
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            aria-label="対象月"
          />
          <button
            className="btn btn-primary"
            onClick={runDiagnostics}
            disabled={loading || !storeId || !castName.trim()}
          >
            {loading ? "確認中…" : "確認する"}
          </button>
        </div>

        {error && <div className="error-box">{error}</div>}

        {result && (
          <>
            <section className="detail-card" style={{ marginBottom: 16 }}>
              <h2 className="detail-heading">
                ① 対象店舗内で「{result.queryName}」に一致するキャスト（正規化名: {result.normalizedName}）
              </h2>
              {result.matchedCasts.length === 0 ? (
                <p className="page-sub">一致するキャストが見つかりませんでした。</p>
              ) : (
                <>
                  {result.matchedCasts.length > 1 && (
                    <div className="error-box">
                      ⚠ 同じ源氏名のキャストが{result.matchedCasts.length}件見つかりました。ランキングは
                      castId単位で別々に集計されるため、意図しないキャストの重複登録がないかご確認ください。
                    </div>
                  )}
                  <div className="table-scroll">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>castId</th>
                          <th>在籍状態</th>
                          <th>monthlyResultsドキュメントID</th>
                          <th>totalSales（保存値）</th>
                          <th>shimeiSales（指名）</th>
                          <th>jounaiCount（場内）</th>
                          <th>lastImportAt</th>
                          <th>lastImportBatchId</th>
                          <th>updatedAt</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.matchedCasts.map((row) => (
                          <tr key={row.cast.id}>
                            <td>
                              <code>{row.cast.id}</code>
                              {row.cast.archived && (
                                <span className="badge badge-gray" style={{ marginLeft: 6 }}>
                                  アーカイブ済み
                                </span>
                              )}
                            </td>
                            <td>{row.cast.status}</td>
                            <td>
                              <code>{row.monthlyResultId}</code>
                            </td>
                            <td className="num">
                              {row.monthlyResult ? `¥${row.monthlyResult.totalSales.toLocaleString()}` : "（ドキュメント無し）"}
                            </td>
                            <td className="num">
                              {row.monthlyResult?.shimeiSales != null
                                ? `¥${row.monthlyResult.shimeiSales.toLocaleString()}`
                                : "―"}
                            </td>
                            <td className="num">
                              {row.monthlyResult ? row.monthlyResult.jounaiCount.toLocaleString() : "―"}
                            </td>
                            <td>
                              {row.monthlyResult?.lastImportAt
                                ? row.monthlyResult.lastImportAt.toDate().toLocaleString("ja-JP")
                                : "―"}
                            </td>
                            <td>
                              <code>{row.monthlyResult?.lastImportBatchId ?? "―"}</code>
                            </td>
                            <td>
                              {row.monthlyResult?.updatedAt
                                ? row.monthlyResult.updatedAt.toDate().toLocaleString("ja-JP")
                                : "―"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </section>

            <section className="detail-card">
              <h2 className="detail-heading">
                ② 保存済み照合ルール（次回Excelインポート時にこのcastIdへ書き込まれます）
              </h2>
              {!result.rule ? (
                <p className="page-sub">
                  保存済みルールはありません。インポート時は「対象店舗内で源氏名が完全一致するキャスト」への
                  自動紐付け、または複数一致時は手動選択になります。
                </p>
              ) : (
                <div className="page-sub">
                  判定: <strong>{result.rule.decision}</strong>
                  {" ／ "}
                  紐付け先castId: <code>{result.rule.linkedCastId ?? "（無し）"}</code>
                  {" ／ "}
                  最終更新: {result.rule.updatedAt?.toDate().toLocaleString("ja-JP") ?? "―"}
                  {result.rule.linkedCastId &&
                    !result.matchedCasts.some((r) => r.cast.id === result.rule!.linkedCastId) && (
                      <div className="error-box" style={{ marginTop: 6, marginBottom: 0 }}>
                        ⚠ ルールの紐付け先castId（{result.rule.linkedCastId}）が、上の①の一覧に含まれていません。
                        キャストが削除されたか、源氏名が変更された可能性があります。次回インポートはこのcastIdへの
                        書き込みを試み、リンク先が無効であれば再確認が必要な行として扱われます。
                      </div>
                    )}
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
