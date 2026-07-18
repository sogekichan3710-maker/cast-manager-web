"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/contexts/AuthContext";
import { AppHeader } from "@/components/AppHeader";
import { useCasts } from "@/hooks/useCasts";
import { useStores } from "@/hooks/useStores";
import { RANK_CATS, buildRanking } from "@/lib/ranking";
import { subscribeMonthlyResultsByMonth } from "@/services/monthlyResultService";
import {
  ALL_STORES_FILTER,
  currentMonth,
  monthToJa,
  type MonthlyResultWithId,
} from "@/types";

/**
 * ランキングページ（既存ローカル版 renderRanking の移植）。
 * 7カテゴリ・TOP15・重複排除・key>0のみ・降順は旧版と同一。
 */
export default function RankingPage() {
  useAuth(); // AuthGate配下でのみ表示
  const { accessibleStores, loading: storesLoading } = useStores();

  const [storeFilter, setStoreFilter] = useState<string>(ALL_STORES_FILTER);
  const [month, setMonth] = useState<string>(currentMonth());
  const [catIdx, setCatIdx] = useState(0);

  const targetStoreIds = useMemo(() => {
    if (storeFilter === ALL_STORES_FILTER) return accessibleStores.map((s) => s.id);
    return accessibleStores.some((s) => s.id === storeFilter) ? [storeFilter] : [];
  }, [storeFilter, accessibleStores]);

  const { casts } = useCasts(targetStoreIds);

  const [results, setResults] = useState<MonthlyResultWithId[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const storeKey = targetStoreIds.slice().sort().join(",");
  useEffect(() => {
    if (targetStoreIds.length === 0) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const unsub = subscribeMonthlyResultsByMonth(
      targetStoreIds,
      month,
      (list) => {
        setResults(list);
        setError(null);
        setLoading(false);
      },
      (msg) => {
        setError(msg);
        setLoading(false);
      }
    );
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeKey, month]);

  const castOf = useMemo(() => {
    const m = new Map(casts.map((c) => [c.id, c]));
    return (id: string) => m.get(id) ?? null;
  }, [casts]);

  const cat = RANK_CATS[catIdx];
  const ranked = useMemo(() => {
    const validIds = new Set(casts.map((c) => c.id));
    return buildRanking(results, cat, validIds);
  }, [results, cat, casts]);

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="app-main">
        <div className="page-head">
          <div>
            <h1 className="page-title">ランキング — {monthToJa(month)}</h1>
            <p className="page-sub">各カテゴリTOP15（対象月に実績のあるキャスト）</p>
          </div>
        </div>

        <div className="filter-bar">
          <select
            className="form-input"
            value={storeFilter}
            onChange={(e) => setStoreFilter(e.target.value)}
            aria-label="店舗"
          >
            <option value={ALL_STORES_FILTER}>全店舗</option>
            {accessibleStores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <input
            className="form-input"
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            aria-label="対象月"
          />
        </div>

        {/* カテゴリ切替（旧版 rankCatTabs 相当） */}
        <div className="chart-tabs" style={{ marginBottom: 14 }}>
          {RANK_CATS.map((c, i) => (
            <button
              key={c.id}
              className={i === catIdx ? "chart-tab active" : "chart-tab"}
              onClick={() => setCatIdx(i)}
            >
              {c.label}
            </button>
          ))}
        </div>

        {error && <div className="error-box">読み込みエラー: {error}</div>}

        {loading || storesLoading ? (
          <div className="loading-block" style={{ padding: 60 }}>
            <div className="spinner" aria-hidden />
            <p>ランキングを集計しています…</p>
          </div>
        ) : ranked.length === 0 ? (
          <div className="info-box">
            {monthToJa(month)}のデータがありません。月別成績を入力するとランキングが表示されます。
          </div>
        ) : (
          <section className="detail-card" style={{ maxWidth: 520 }}>
            <h2 className="detail-heading">{cat.label} ランキング</h2>
            {ranked.map((r, i) => {
              const c = castOf(r.castId);
              const name = c?.stageName ?? "(不明)";
              const val = cat.key(r);
              const sub = cat.sub ? cat.sub(r) : null;
              const medal = i === 0 ? "rank-1" : i === 1 ? "rank-2" : i === 2 ? "rank-3" : "";
              return (
                <Link
                  key={r.castId}
                  href={c ? `/casts/${c.id}` : "#"}
                  className="rank-row-link"
                >
                  <span className={`rank-num ${medal}`}>{i + 1}</span>
                  <span className="rank-name">{name}</span>
                  <span className="rank-val">
                    {cat.fmt(val)}
                    {sub && <span className="rank-sub">{sub}</span>}
                  </span>
                </Link>
              );
            })}
          </section>
        )}
      </main>
    </div>
  );
}
