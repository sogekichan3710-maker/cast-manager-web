"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";
import { useCasts } from "@/hooks/useCasts";
import { useDashboardData } from "@/hooks/useDashboardData";
import { useStores } from "@/hooks/useStores";
import { calcFollowHigh } from "@/lib/dashboard";
import { ALL_STORES_FILTER } from "@/types";

/**
 * フォロー必要度「高」の全件一覧（PR6・ダッシュボードの「詳細を見る」先）。
 * 検索・スクロールに対応する。
 */
export default function FollowHighListPage() {
  const searchParams = useSearchParams();
  const { accessibleStores, loading: storesLoading } = useStores();
  const storeFilter = searchParams.get("store") ?? ALL_STORES_FILTER;

  const targetStoreIds = useMemo(() => {
    if (storeFilter === ALL_STORES_FILTER) return accessibleStores.map((s) => s.id);
    return accessibleStores.some((s) => s.id === storeFilter) ? [storeFilter] : [];
  }, [storeFilter, accessibleStores]);

  const { casts } = useCasts(targetStoreIds);
  const { interviews, loading } = useDashboardData(targetStoreIds);

  const [q, setQ] = useState("");
  const list = useMemo(() => calcFollowHigh({ casts, interviews }), [casts, interviews]);
  const filtered = useMemo(
    () => (q.trim() ? list.filter((x) => x.cast.stageName.includes(q.trim())) : list),
    [list, q]
  );

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="app-main">
        <div className="page-head">
          <div>
            <h1 className="page-title">🚨 フォロー必要度「高」一覧</h1>
            <p className="page-sub">{filtered.length}名</p>
          </div>
          <Link href="/dashboard" className="btn btn-ghost btn-sm">
            ← ダッシュボードへ戻る
          </Link>
        </div>

        <div className="filter-bar">
          <input
            className="form-input"
            type="text"
            placeholder="源氏名で検索"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="検索"
          />
        </div>

        {loading || storesLoading ? (
          <div className="loading-block" style={{ padding: 60 }}>
            <div className="spinner" aria-hidden />
            <p>読み込んでいます…</p>
          </div>
        ) : filtered.length === 0 ? (
          <p className="empty-note">該当なし</p>
        ) : (
          <section className="detail-card">
            {filtered.map((x) => (
              <div key={x.cast.id} className="record-item">
                <div className="record-head">
                  <Link href={`/casts/${x.cast.id}`} className="cast-link">
                    {x.cast.stageName}
                  </Link>
                  <span className="dim">最終面談 {x.interview.date}</span>
                </div>
                {x.interview.content && (
                  <p className="record-text dim">{x.interview.content}</p>
                )}
              </div>
            ))}
          </section>
        )}
      </main>
    </div>
  );
}
