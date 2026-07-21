"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AppHeader } from "@/components/AppHeader";
import { useCasts } from "@/hooks/useCasts";
import { useStores } from "@/hooks/useStores";
import { calcAge, daysUntilBirthday, getBirthdayCasts } from "@/lib/dashboard";
import { ALL_STORES_FILTER } from "@/types";

/**
 * 誕生日（今月・来月）の全件一覧（PR6・ダッシュボードの「詳細を見る」先）。
 * 対象範囲（今月・来月）はダッシュボードのカードと同一。検索に対応する。
 */
export default function BirthdaysListPage() {
  const searchParams = useSearchParams();
  const { accessibleStores, loading: storesLoading } = useStores();
  const storeFilter = searchParams.get("store") ?? ALL_STORES_FILTER;

  const targetStoreIds = useMemo(() => {
    if (storeFilter === ALL_STORES_FILTER) return accessibleStores.map((s) => s.id);
    return accessibleStores.some((s) => s.id === storeFilter) ? [storeFilter] : [];
  }, [storeFilter, accessibleStores]);

  const { casts, loading } = useCasts(targetStoreIds);

  const now = new Date();
  const thisM = now.getMonth() + 1;
  const nextM = thisM === 12 ? 1 : thisM + 1;
  const bdThis = useMemo(() => getBirthdayCasts(casts, thisM), [casts, thisM]);
  const bdNext = useMemo(() => getBirthdayCasts(casts, nextM), [casts, nextM]);
  const all = useMemo(() => [...bdThis, ...bdNext], [bdThis, bdNext]);

  const [q, setQ] = useState("");
  const filtered = useMemo(
    () => (q.trim() ? all.filter((c) => c.stageName.includes(q.trim())) : all),
    [all, q]
  );

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="app-main">
        <div className="page-head">
          <div>
            <h1 className="page-title">🎂 誕生日一覧</h1>
            <p className="page-sub">
              今月{bdThis.length}名 / 来月{bdNext.length}名
            </p>
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
            {filtered.map((c) => {
              const days = daysUntilBirthday(c.birthday);
              const age = calcAge(c.birthday);
              const label = days === 0 ? "🎂 今日!" : days === 1 ? "明日!" : `${days}日後`;
              return (
                <div key={c.id} className="record-item">
                  <div className="record-head">
                    <Link href={`/casts/${c.id}`} className="cast-link">
                      {c.stageName}
                    </Link>
                    {age != null && <span className="dim">{age + 1}歳になります</span>}
                    <span
                      style={{
                        marginLeft: "auto",
                        fontWeight: 700,
                        fontSize: 12,
                        color:
                          days != null && days <= 3
                            ? "var(--red)"
                            : days != null && days <= 7
                              ? "var(--yellow)"
                              : "var(--text2)",
                      }}
                    >
                      {label}
                    </span>
                  </div>
                  <p className="record-text dim">
                    🎂 {c.birthday}
                    {c.manager ? `　担当: ${c.manager}` : ""}
                  </p>
                </div>
              );
            })}
          </section>
        )}
      </main>
    </div>
  );
}
