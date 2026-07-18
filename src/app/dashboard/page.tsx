"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/contexts/AuthContext";
import { AppHeader } from "@/components/AppHeader";
import { useCasts } from "@/hooks/useCasts";
import { useDashboardData } from "@/hooks/useDashboardData";
import { useStores } from "@/hooks/useStores";
import {
  avgWageTrend12,
  calcAge,
  calcDashboardKpi,
  calcFollowHigh,
  calcGoalStatus,
  calcOverdueInterviews,
  calcUpcomingInterviews,
  daysUntilBirthday,
  getBirthdayCasts,
  type GoalStatusEntry,
} from "@/lib/dashboard";
import {
  ALL_STORES_FILTER,
  currentMonth,
  fmtDiff,
  isAdminOrAbove,
  monthToJa,
} from "@/types";

export default function DashboardPage() {
  const { userDoc } = useAuth();
  const canEdit = isAdminOrAbove(userDoc);
  const { accessibleStores, loading: storesLoading } = useStores();

  const [storeFilter, setStoreFilter] = useState<string>(ALL_STORES_FILTER);
  const [month, setMonth] = useState<string>(currentMonth());

  const targetStoreIds = useMemo(() => {
    if (storeFilter === ALL_STORES_FILTER) return accessibleStores.map((s) => s.id);
    return accessibleStores.some((s) => s.id === storeFilter) ? [storeFilter] : [];
  }, [storeFilter, accessibleStores]);

  const { casts } = useCasts(targetStoreIds);
  const { results, interviews, goals, motivations, loading, error, refresh } =
    useDashboardData(targetStoreIds);

  // ── 集計（lib/dashboard.ts の純関数群 = 旧版計算式） ──
  const kpi = useMemo(
    () => calcDashboardKpi({ month, casts, allResults: results }),
    [month, casts, results]
  );
  const wageTrend = useMemo(
    () => avgWageTrend12({ month, casts, allResults: results }),
    [month, casts, results]
  );
  const overdue = useMemo(
    () => calcOverdueInterviews({ casts, interviews, motivations }),
    [casts, interviews, motivations]
  );
  const followHigh = useMemo(
    () => calcFollowHigh({ casts, interviews }),
    [casts, interviews]
  );
  const upcoming = useMemo(
    () => calcUpcomingInterviews({ casts, interviews }),
    [casts, interviews]
  );
  const goalStatus = useMemo(
    () => calcGoalStatus({ month, casts, goals, allResults: results }),
    [month, casts, goals, results]
  );
  const goalUnachieved = goalStatus.filter((x) => x.someUnachieved);
  const goalAchieved = goalStatus.filter((x) => x.allAchieved);

  const now = new Date();
  const thisM = now.getMonth() + 1;
  const nextM = thisM === 12 ? 1 : thisM + 1;
  const bdThis = useMemo(() => getBirthdayCasts(casts, thisM), [casts, thisM]);
  const bdNext = useMemo(() => getBirthdayCasts(casts, nextM), [casts, nextM]);

  const hasData = results.some((r) => r.month === month);

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="app-main app-main-wide">
        <div className="page-head">
          <div>
            <h1 className="page-title">ダッシュボード — {monthToJa(month)}</h1>
            <p className="page-sub">
              {storeFilter === ALL_STORES_FILTER
                ? `全店舗（閲覧可能な${accessibleStores.length}店舗）`
                : accessibleStores.find((s) => s.id === storeFilter)?.name}
            </p>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={refresh} disabled={loading}>
            ↻ 更新
          </button>
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

        {error && <div className="error-box">読み込みエラー: {error}</div>}

        {loading || storesLoading ? (
          <div className="loading-block" style={{ padding: 60 }}>
            <div className="spinner" aria-hidden />
            <p>集計しています…</p>
          </div>
        ) : (
          <>
            {!hasData && (
              <div className="info-box" style={{ marginBottom: 14 }}>
                {monthToJa(month)}の成績データがまだありません。
                月別成績ページから入力すると集計が表示されます。
              </div>
            )}

            {/* ── 店舗状況（旧版dashStats + 合計/平均カード） ── */}
            <div className="stats-grid stats-grid-dash">
              <Kpi label="在籍人数" value={`${kpi.activeCount}名`} sub={`全${kpi.allCount}名中`} accent />
              <Kpi
                label="今月売上"
                value={`¥${kpi.tSales.toLocaleString()}`}
                sub={
                  kpi.salesDiffPct != null
                    ? `前月比 ${kpi.salesDiffPct >= 0 ? "+" : ""}${kpi.salesDiffPct}%`
                    : "前月データなし"
                }
                green
              />
              <Kpi
                label="平均時給（月）"
                value={kpi.avgWageMonth != null ? `¥${kpi.avgWageMonth.toLocaleString()}` : "–"}
                sub={`出勤${kpi.wageMonthCount}名の平均`}
                accent
              />
              <Kpi
                label="平均時給（年）"
                value={kpi.avgWageYear != null ? `¥${kpi.avgWageYear.toLocaleString()}` : "–"}
                sub={`${month.slice(0, 4)}年 ${kpi.wageYearCount}名の平均`}
              />
              <Kpi
                label="平均実質時給"
                value={kpi.aggRealWage != null ? `¥${kpi.aggRealWage.toLocaleString()}` : "–"}
                sub="支給額÷出勤時間"
              />
              <Kpi label="総支給額" value={`¥${kpi.tPay.toLocaleString()}`} />
              <Kpi label="本指名本数" value={`${kpi.tHonshimei}本`} sub={`${kpi.tHonGroup}組`} />
              <Kpi label="顧客数" value={`${kpi.tCustomer}名`} />
              <Kpi label="場内指名" value={`${kpi.tJounai}本`} />
              <Kpi label="同伴" value={`${kpi.tDouhan}件`} />
              <Kpi
                label="出勤"
                value={`${kpi.tWork}日`}
                sub={`${kpi.tWorkHours.toFixed(1)}h / 出勤${kpi.workingCnt}名`}
              />
              <Kpi
                label="給与差額 合計"
                value={fmtDiff(kpi.tPayDiff)}
                sub={kpi.avgPayDiff != null ? `平均 ${fmtDiff(kpi.avgPayDiff)}` : undefined}
              />
              <Kpi
                label="時給差額 合計"
                value={fmtDiff(kpi.tWageDiff)}
                sub={kpi.avgWageDiff != null ? `平均 ${fmtDiff(kpi.avgWageDiff)}` : undefined}
              />
              <Kpi
                label="年間累計売上"
                value={`¥${kpi.yearSalesTotal.toLocaleString()}`}
                sub={`本指名 ${kpi.yearHonshimei}本`}
              />
            </div>

            {/* ── 平均時給推移（直近12ヶ月・古→新） ── */}
            <section className="detail-card" style={{ marginTop: 14 }}>
              <h2 className="detail-heading">💴 平均時給推移（月別）</h2>
              <WageTrendChart data={wageTrend} />
              <p style={{ fontSize: 10, color: "var(--text3)", marginTop: 6 }}>
                各月に実績データがあるキャストの時給を平均。退店済みキャストは実績のある月のみ集計。
              </p>
            </section>

            <div className="dash-columns">
              {/* ── 面談アラート ── */}
              <section className="detail-card">
                <h2 className="detail-heading">⚠️ 面談アラート（30日以上 or 未面談）</h2>
                {overdue.length === 0 ? (
                  <p className="empty-note" style={{ color: "var(--green)" }}>
                    全員面談済み ✓（1ヶ月以内）
                  </p>
                ) : (
                  overdue.slice(0, 6).map((x) => (
                    <div key={x.cast.id} className="record-item">
                      <div className="record-head">
                        <Link href={`/casts/${x.cast.id}`} className="cast-link">
                          {x.cast.stageName}
                        </Link>
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
                            className={`badge ${
                              x.motiLevel.includes("低い") ? "badge-red" : "badge-gray"
                            }`}
                          >
                            {x.motiLevel}
                          </span>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </section>

              {/* ── フォロー高 ── */}
              <section className="detail-card">
                <h2 className="detail-heading">🚨 フォロー必要度「高」</h2>
                {followHigh.length === 0 ? (
                  <p className="empty-note">該当なし</p>
                ) : (
                  followHigh.map((x) => (
                    <div key={x.cast.id} className="record-item">
                      <div className="record-head">
                        <Link href={`/casts/${x.cast.id}`} className="cast-link">
                          {x.cast.stageName}
                        </Link>
                        <span className="dim">最終面談 {x.interview.date}</span>
                      </div>
                    </div>
                  ))
                )}
              </section>

              {/* ── 次回面談予定 ── */}
              <section className="detail-card">
                <h2 className="detail-heading">📅 次回面談予定（7日以内）</h2>
                {upcoming.length === 0 ? (
                  <p className="empty-note">7日以内の予定はありません</p>
                ) : (
                  upcoming.map((x) => (
                    <div key={x.interview.id} className="record-item">
                      <div className="record-head">
                        <strong>{x.interview.nextDate}</strong>
                        <Link href={`/casts/${x.cast.id}`} className="cast-link">
                          {x.cast.stageName}
                        </Link>
                        {x.interview.nextTask && (
                          <span className="dim">{x.interview.nextTask}</span>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </section>

              {/* ── 目標達成状況 ── */}
              <section className="detail-card">
                <h2 className="detail-heading">
                  🎯 目標達成状況（達成 {goalAchieved.length} / 未達成 {goalUnachieved.length}）
                </h2>
                {goalStatus.length === 0 ? (
                  <p className="empty-note">{monthToJa(month)}の目標が設定されていません</p>
                ) : goalUnachieved.length === 0 ? (
                  <>
                    <p className="empty-note" style={{ color: "var(--green)" }}>
                      全達成🎉
                    </p>
                    {goalAchieved.slice(0, 4).map((x) => (
                      <GoalRow key={x.goal.id} entry={x} />
                    ))}
                  </>
                ) : (
                  <>
                    {goalUnachieved.slice(0, 8).map((x) => (
                      <GoalRow key={x.goal.id} entry={x} />
                    ))}
                    {goalAchieved.slice(0, 4).map((x) => (
                      <GoalRow key={x.goal.id} entry={x} />
                    ))}
                  </>
                )}
              </section>

              {/* ── 誕生日 ── */}
              <section className="detail-card">
                <h2 className="detail-heading">
                  🎂 誕生日（今月{bdThis.length} / 来月{bdNext.length}）
                </h2>
                {bdThis.length === 0 && bdNext.length === 0 ? (
                  <p className="empty-note">今月・来月の誕生日はありません</p>
                ) : (
                  [...bdThis, ...bdNext].map((c) => {
                    const days = daysUntilBirthday(c.birthday);
                    const age = calcAge(c.birthday);
                    const label =
                      days === 0 ? "🎂 今日!" : days === 1 ? "明日!" : `${days}日後`;
                    return (
                      <div key={c.id} className="record-item">
                        <div className="record-head">
                          <Link href={`/casts/${c.id}`} className="cast-link">
                            {c.stageName}
                          </Link>
                          {age != null && (
                            <span className="dim">{age + 1}歳になります</span>
                          )}
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
                  })
                )}
              </section>
            </div>

            {canEdit && (
              <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
                <Link href="/monthly" className="btn btn-primary btn-sm">
                  月別成績を入力
                </Link>
                <Link href="/ranking" className="btn btn-ghost btn-sm">
                  ランキングを見る
                </Link>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
  green,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  green?: boolean;
  accent?: boolean;
}) {
  return (
    <div
      className="stat-card"
      style={accent ? { border: "1px solid var(--acc)" } : undefined}
    >
      <div className="stat-label" style={accent ? { color: "var(--acc2)" } : undefined}>
        {label}
      </div>
      <div
        className="stat-value"
        style={{ color: green ? "var(--green)" : accent ? "var(--acc2)" : undefined }}
      >
        {value}
      </div>
      {sub && <div className="stat-sub">{sub}</div>}
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

/** 平均時給12ヶ月推移の簡易SVG（TrendChartと同座標系・データなし月はスキップ） */
function WageTrendChart({
  data,
}: {
  data: Array<{ l: string; v: number | null; cnt: number }>;
}) {
  const valid = data.filter((d) => d.v != null);
  if (valid.length < 2) {
    return (
      <p className="empty-note" style={{ textAlign: "center", padding: 16 }}>
        データが不足しています（2ヶ月以上の実績が必要）
      </p>
    );
  }
  const W = 580;
  const H = 200;
  const P = { t: 20, r: 16, b: 36, l: 66 };
  const cW = W - P.l - P.r;
  const cH = H - P.t - P.b;
  const vals = valid.map((d) => d.v as number);
  let vMin = Math.min(...vals);
  let vMax = Math.max(...vals);
  if (vMin === vMax) vMax = vMin + 1;
  const pad = (vMax - vMin) * 0.08;
  vMin -= pad;
  vMax += pad;
  const x = (i: number) =>
    P.l + (data.length === 1 ? cW / 2 : (i / (data.length - 1)) * cW);
  const y = (v: number) => P.t + cH - ((v - vMin) / (vMax - vMin)) * cH;
  const pts = data
    .map((d, i) => (d.v != null ? { px: x(i), py: y(d.v), l: d.l, v: d.v } : null))
    .filter((p): p is NonNullable<typeof p> => p !== null);
  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.px},${p.py}`).join(" ");
  const grids = [0, 1, 2, 3, 4].map((g) => ({
    gy: y(vMin + ((vMax - vMin) * g) / 4),
    gv: vMin + ((vMax - vMin) * g) / 4,
  }));
  return (
    <div className="chart-scroll">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "auto", display: "block" }}
        role="img"
        aria-label="平均時給推移"
      >
        {grids.map((g, i) => (
          <g key={i}>
            <line
              x1={P.l}
              y1={g.gy}
              x2={W - P.r}
              y2={g.gy}
              stroke="var(--border)"
              strokeWidth={1}
            />
            <text x={P.l - 6} y={g.gy + 3} textAnchor="end" fontSize={9} fill="var(--text3)">
              ¥{Math.round(g.gv).toLocaleString()}
            </text>
          </g>
        ))}
        <path d={path} fill="none" stroke="var(--acc2)" strokeWidth={2.5} />
        {pts.map((p, i) => (
          <g key={i}>
            <circle cx={p.px} cy={p.py} r={3.5} fill="var(--acc2)" />
            <text x={p.px} y={p.py - 8} textAnchor="middle" fontSize={8.5} fill="var(--text2)">
              ¥{Math.round(p.v).toLocaleString()}
            </text>
          </g>
        ))}
        {data.map((d, i) => (
          <text
            key={i}
            x={x(i)}
            y={H - P.b + 16}
            textAnchor="middle"
            fontSize={9}
            fill="var(--text3)"
          >
            {d.l}
          </text>
        ))}
      </svg>
    </div>
  );
}
