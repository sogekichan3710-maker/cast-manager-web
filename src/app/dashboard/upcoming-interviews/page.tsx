"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";
import { DeleteInterviewButton } from "@/components/DeleteInterviewButton";
import { useCasts } from "@/hooks/useCasts";
import { useDashboardData } from "@/hooks/useDashboardData";
import { useStores } from "@/hooks/useStores";
import { calcUpcomingInterviews } from "@/lib/dashboard";
import { ALL_STORES_FILTER } from "@/types";

/**
 * 次回面談予定（7日以内）の全件一覧（PR6・ダッシュボードの「詳細を見る」先）。
 * ダッシュボードのカードは上位5件のみだが、ここでは対象期間内の全件を表示する。
 */
export default function UpcomingInterviewsListPage() {
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
  const [actionError, setActionError] = useState<string | null>(null);
  const list = useMemo(
    () => calcUpcomingInterviews({ casts, interviews, limit: Infinity }),
    [casts, interviews]
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
            <h1 className="page-title">📅 次回面談予定（7日以内）一覧</h1>
            <p className="page-sub">{filtered.length}件</p>
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

        {actionError && <div className="error-box">{actionError}</div>}

        {loading || storesLoading ? (
          <div className="loading-block" style={{ padding: 60 }}>
            <div className="spinner" aria-hidden />
            <p>読み込んでいます…</p>
          </div>
        ) : filtered.length === 0 ? (
          <p className="empty-note">7日以内の予定はありません</p>
        ) : (
          <section className="detail-card">
            {filtered.map((x) => (
              <div key={x.interview.id} className="record-item">
                <div className="record-head">
                  <strong>{x.interview.nextDate}</strong>
                  <Link href={`/casts/${x.cast.id}`} className="cast-link">
                    {x.cast.stageName}
                  </Link>
                  {x.interview.nextTask && <span className="dim">{x.interview.nextTask}</span>}
                  <div style={{ marginLeft: "auto" }}>
                    <DeleteInterviewButton interviewId={x.interview.id} onError={setActionError} />
                  </div>
                </div>
              </div>
            ))}
          </section>
        )}
      </main>
    </div>
  );
}
