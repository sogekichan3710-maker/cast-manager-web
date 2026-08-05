"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";
import { useCasts } from "@/hooks/useCasts";
import { useDashboardData } from "@/hooks/useDashboardData";
import { useStores } from "@/hooks/useStores";
import {
  calcCompletedInterviews,
  interviewTypeLabel,
  nextMonthOf,
  prevMonthOf,
  type CompletedInterviewEntry,
} from "@/lib/dashboard";
import { ALL_STORES_FILTER, currentMonth, monthToJa } from "@/types";

/**
 * 月別の面談済み一覧（ダッシュボード「今月の面談済み」カードの「全員見る」先）。
 * 対象月は画面内の月送り（＜ ＞）で切り替えられる。初期表示は常に現在の年月。
 * 判定ロジック（calcCompletedInterviews）は変更しない。表示のみ追加。
 */
export default function CompletedInterviewsListPage() {
  const searchParams = useSearchParams();
  const { accessibleStores, loading: storesLoading } = useStores();
  const storeFilter = searchParams.get("store") ?? ALL_STORES_FILTER;

  const targetStoreIds = useMemo(() => {
    if (storeFilter === ALL_STORES_FILTER) return accessibleStores.map((s) => s.id);
    return accessibleStores.some((s) => s.id === storeFilter) ? [storeFilter] : [];
  }, [storeFilter, accessibleStores]);

  const { casts } = useCasts(targetStoreIds);
  const { interviews, loading } = useDashboardData(targetStoreIds);

  const [month, setMonth] = useState(() => currentMonth());

  const storeName = (id: string) => accessibleStores.find((s) => s.id === id)?.name ?? id;

  const list = useMemo(
    () => calcCompletedInterviews({ month, casts, interviews }),
    [month, casts, interviews]
  );

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="app-main">
        <div className="page-head">
          <div>
            <h1 className="page-title">✅ 面談済み一覧</h1>
            <p className="page-sub">{list.length}件</p>
          </div>
          <Link href="/dashboard" className="btn btn-ghost btn-sm">
            ← ダッシュボードへ戻る
          </Link>
        </div>

        <div className="filter-bar" style={{ justifyContent: "center", gap: 16 }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setMonth((m) => prevMonthOf(m) ?? m)}
            aria-label="前月"
          >
            ＜
          </button>
          <strong style={{ fontSize: 15, minWidth: 110, textAlign: "center" }}>
            {monthToJa(month)}
          </strong>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setMonth((m) => nextMonthOf(m) ?? m)}
            aria-label="次月"
          >
            ＞
          </button>
        </div>

        {loading || storesLoading ? (
          <div className="loading-block" style={{ padding: 60 }}>
            <div className="spinner" aria-hidden />
            <p>読み込んでいます…</p>
          </div>
        ) : list.length === 0 ? (
          <p className="empty-note">{monthToJa(month)}の面談済みはありません</p>
        ) : (
          <section className="detail-card">
            {list.map((x) => (
              <div key={x.interview.id} className="record-item">
                <div className="record-head">
                  <strong>{x.dateKey}</strong>
                  <Link href={`/casts/${x.cast.id}`} className="cast-link">
                    {x.cast.stageName}
                  </Link>
                  <span className="dim">{storeName(x.cast.storeId)}</span>
                  <span className="dim">担当: {x.interview.interviewer || "-"}</span>
                  <span className="badge badge-gray">
                    {interviewTypeLabel(x.interview.type)}
                  </span>
                  <div style={{ marginLeft: "auto" }}>
                    <Link href={`/casts/${x.cast.id}`} className="btn btn-ghost btn-sm">
                      詳細
                    </Link>
                  </div>
                </div>
                {contentExcerpt(x) && (
                  <p className="record-text dim">{contentExcerpt(x)}</p>
                )}
              </div>
            ))}
          </section>
        )}
      </main>
    </div>
  );
}

/** 面談内容またはメモ（悩み・決定事項）の冒頭を表示する（60文字まで） */
function contentExcerpt(x: CompletedInterviewEntry): string {
  const text = (x.interview.content || x.interview.worries || x.interview.decisions || "").trim();
  if (!text) return "";
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}
