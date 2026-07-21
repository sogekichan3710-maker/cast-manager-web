"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";
import { useCasts } from "@/hooks/useCasts";
import { useDashboardData } from "@/hooks/useDashboardData";
import { useStores } from "@/hooks/useStores";
import { calcGoalStatus, type GoalStatusEntry } from "@/lib/dashboard";
import { ALL_STORES_FILTER, currentMonth, monthToJa } from "@/types";

type FilterMode = "all" | "unachieved" | "achieved";

/**
 * 目標達成状況の全件一覧（PR6・ダッシュボードの「詳細を見る」先）。
 * ダッシュボードのカードは未達成8件・達成4件までだが、ここでは全件を表示する。
 */
export default function GoalStatusListPage() {
  const searchParams = useSearchParams();
  const { accessibleStores, loading: storesLoading } = useStores();
  const storeFilter = searchParams.get("store") ?? ALL_STORES_FILTER;
  const month = searchParams.get("month") ?? currentMonth();

  const targetStoreIds = useMemo(() => {
    if (storeFilter === ALL_STORES_FILTER) return accessibleStores.map((s) => s.id);
    return accessibleStores.some((s) => s.id === storeFilter) ? [storeFilter] : [];
  }, [storeFilter, accessibleStores]);

  const { casts } = useCasts(targetStoreIds);
  const { results, goals, loading } = useDashboardData(targetStoreIds);

  const [q, setQ] = useState("");
  const [mode, setMode] = useState<FilterMode>("all");

  const list = useMemo(
    () => calcGoalStatus({ month, casts, goals, allResults: results }),
    [month, casts, goals, results]
  );
  const filtered = useMemo(() => {
    let l = list;
    if (mode === "unachieved") l = l.filter((x) => x.someUnachieved);
    if (mode === "achieved") l = l.filter((x) => x.allAchieved);
    if (q.trim()) l = l.filter((x) => x.cast.stageName.includes(q.trim()));
    return l;
  }, [list, mode, q]);

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="app-main">
        <div className="page-head">
          <div>
            <h1 className="page-title">🎯 目標達成状況一覧 — {monthToJa(month)}</h1>
            <p className="page-sub">
              {filtered.length}名（達成 {list.filter((x) => x.allAchieved).length} / 未達成{" "}
              {list.filter((x) => x.someUnachieved).length}）
            </p>
          </div>
          <Link href="/dashboard" className="btn btn-ghost btn-sm">
            ← ダッシュボードへ戻る
          </Link>
        </div>

        <div className="filter-bar">
          <select
            className="form-input"
            value={mode}
            onChange={(e) => setMode(e.target.value as FilterMode)}
            aria-label="達成状況"
          >
            <option value="all">すべて</option>
            <option value="unachieved">未達成あり</option>
            <option value="achieved">全達成</option>
          </select>
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
          <p className="empty-note">{monthToJa(month)}の目標が設定されていません</p>
        ) : (
          <section className="detail-card">
            {filtered.map((x) => (
              <GoalRow key={x.goal.id} entry={x} />
            ))}
          </section>
        )}
      </main>
    </div>
  );
}

function GoalRow({ entry }: { entry: GoalStatusEntry }) {
  return (
    <div className="record-item">
      <div className="record-head">
        <Link href={`/casts/${entry.cast.id}`} className="cast-link">
          {entry.cast.stageName}
        </Link>
        <span className={`badge ${entry.allAchieved ? "badge-green" : "badge-yellow"}`}>
          {entry.allAchieved ? "全達成" : "未達成あり"}
        </span>
      </div>
      <p className="record-text dim">
        {entry.items
          .map(
            (i) =>
              `${i.label} ${i.actual != null ? i.fmt(i.actual) : "-"}/${i.fmt(i.goal)}(${
                i.pct != null ? i.pct + "%" : "-"
              })${i.achieved ? "✓" : ""}`
          )
          .join(" / ")}
      </p>
    </div>
  );
}
