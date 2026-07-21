"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";
import { useCasts } from "@/hooks/useCasts";
import { useDashboardData } from "@/hooks/useDashboardData";
import { useStores } from "@/hooks/useStores";
import { calcOverdueInterviews } from "@/lib/dashboard";
import { ALL_STORES_FILTER } from "@/types";

/**
 * 面談アラート（30日以上経過 or 未面談）の全件一覧
 * （ダッシュボードの「詳細を見る」先）。検索・スクロールに対応する。
 * 判定ロジック（calcOverdueInterviews）は変更しない。表示のみ追加。
 */
export default function OverdueInterviewsListPage() {
  const searchParams = useSearchParams();
  const { accessibleStores, loading: storesLoading } = useStores();
  const storeFilter = searchParams.get("store") ?? ALL_STORES_FILTER;

  const targetStoreIds = useMemo(() => {
    if (storeFilter === ALL_STORES_FILTER) return accessibleStores.map((s) => s.id);
    return accessibleStores.some((s) => s.id === storeFilter) ? [storeFilter] : [];
  }, [storeFilter, accessibleStores]);

  const { casts } = useCasts(targetStoreIds);
  const { interviews, motivations, loading } = useDashboardData(targetStoreIds);

  const storeName = (id: string) => accessibleStores.find((s) => s.id === id)?.name ?? id;

  const [q, setQ] = useState("");
  const list = useMemo(
    () => calcOverdueInterviews({ casts, interviews, motivations }),
    [casts, interviews, motivations]
  );
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
            <h1 className="page-title">⚠️ 面談アラート一覧（30日以上 or 未面談）</h1>
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
          <p className="empty-note" style={{ color: "var(--green)" }}>
            全員面談済み ✓（1ヶ月以内）
          </p>
        ) : (
          <section className="detail-card">
            {filtered.map((x) => (
              <div key={x.cast.id} className="record-item">
                <div className="record-head">
                  <Link href={`/casts/${x.cast.id}`} className="cast-link">
                    {x.cast.stageName}
                  </Link>
                  <span className="dim">{storeName(x.cast.storeId)}</span>
                  {x.noRecord ? (
                    <span className="badge badge-red">未面談</span>
                  ) : (
                    <span className="dim">
                      {x.elapsed}日前（{x.lastDate}）
                    </span>
                  )}
                  {x.followNeed && (
                    <span
                      className={`badge ${
                        x.followNeed === "高"
                          ? "badge-red"
                          : x.followNeed === "中"
                            ? "badge-yellow"
                            : "badge-gray"
                      }`}
                    >
                      F:{x.followNeed}
                    </span>
                  )}
                  {x.motiLevel && (
                    <span
                      className={`badge ${x.motiLevel.includes("低い") ? "badge-red" : "badge-gray"}`}
                    >
                      {x.motiLevel}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </section>
        )}
      </main>
    </div>
  );
}
