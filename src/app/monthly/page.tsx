"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { AppHeader } from "@/components/AppHeader";
import { MonthlyResultFormModal } from "@/components/MonthlyResultFormModal";
import { useCasts } from "@/hooks/useCasts";
import { useStores } from "@/hooks/useStores";
import {
  deleteMonthlyResult,
  subscribeMonthlyResultsByMonth,
} from "@/services/monthlyResultService";
import {
  ALL_STORES_FILTER,
  currentMonth,
  fmtDiff,
  isAdminOrAbove,
  monthToJa,
  payDiff,
  realHourlyWage,
  wageDiff,
  type CastWithId,
  type MonthlyResultWithId,
} from "@/types";

/**
 * 月別成績ページ（既存ローカル版 renderMonthly の移植）。
 * 既存仕様を維持:
 * - 列順: キャスト / 総売上 / 支給額 / 実質時給 / 給与差額 / 時給差額 /
 *         本指名 / 場内 / 同伴 / 出勤日数 / 出勤時間 / 操作
 * - 並び順: 総売上の降順
 * - 総売上が目標達成なら緑・太字
 * - 出勤時間: workHours>0 は "60.0h"、なければ workDays×4.5 を "h*" 表示
 * - 実質時給 = 支給額 ÷ 労働時間
 * 既存不具合の修正: キャスト名をクリック/タップで詳細ページへ遷移
 * （編集・削除ボタンは行遷移を発火させない）
 */
export default function MonthlyPage() {
  const router = useRouter();
  const { firebaseUser, userDoc } = useAuth();
  const canEdit = isAdminOrAbove(userDoc);
  const { accessibleStores, loading: storesLoading } = useStores();

  const [storeFilter, setStoreFilter] = useState<string>(ALL_STORES_FILTER);
  const [month, setMonth] = useState<string>(currentMonth());
  const [castFilter, setCastFilter] = useState("");

  const targetStoreIds = useMemo(() => {
    if (storeFilter === ALL_STORES_FILTER) return accessibleStores.map((s) => s.id);
    return accessibleStores.some((s) => s.id === storeFilter) ? [storeFilter] : [];
  }, [storeFilter, accessibleStores]);

  const { casts } = useCasts(targetStoreIds);
  const castOf = useMemo(() => {
    const m = new Map(casts.map((c) => [c.id, c]));
    return (id: string) => m.get(id) ?? null;
  }, [casts]);

  const [results, setResults] = useState<MonthlyResultWithId[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

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
  }, [storeKey, month, refreshKey]);

  const filtered = useMemo(
    () => (castFilter ? results.filter((r) => r.castId === castFilter) : results),
    [results, castFilter]
  );

  const [formCast, setFormCast] = useState<CastWithId | null>(null);
  const [formResult, setFormResult] = useState<MonthlyResultWithId | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  function openAdd() {
    const target = castFilter ? castOf(castFilter) : null;
    const cast = target ?? casts.find((c) => !c.archived) ?? null;
    if (!cast) {
      setActionError("成績を入力するキャストがいません。先にキャストを登録してください。");
      return;
    }
    setFormCast(cast);
    setFormResult(null);
    setFormOpen(true);
  }

  function openEdit(r: MonthlyResultWithId) {
    const cast = castOf(r.castId);
    if (!cast) {
      setActionError("キャスト情報が見つかりません");
      return;
    }
    setFormCast(cast);
    setFormResult(r);
    setFormOpen(true);
  }

  async function onDelete(r: MonthlyResultWithId) {
    const c = castOf(r.castId);
    if (
      !window.confirm(
        `${c?.stageName ?? "?"} の ${monthToJa(r.month)} の成績を削除しますか？`
      )
    )
      return;
    if (!firebaseUser) return;
    setActionError(null);
    try {
      await deleteMonthlyResult(firebaseUser.uid, userDoc?.displayName ?? "", r.id);
    } catch (err) {
      setActionError((err as Error).message);
    }
  }

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="app-main app-main-wide">
        <div className="page-head">
          <div>
            <h1 className="page-title">月別成績 — {monthToJa(month)}</h1>
            <p className="page-sub">{filtered.length}件を表示中（総売上の降順）</p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => setRefreshKey((k) => k + 1)}
              disabled={loading}
            >
              ↻ 更新
            </button>
            {canEdit && (
              <button className="btn btn-primary btn-sm" onClick={openAdd}>
                ＋ 成績を入力
              </button>
            )}
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
          <select
            className="form-input"
            value={castFilter}
            onChange={(e) => setCastFilter(e.target.value)}
            aria-label="キャスト"
          >
            <option value="">全キャスト</option>
            {casts
              .filter((c) => !c.archived)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.stageName}
                </option>
              ))}
          </select>
        </div>

        {error && <div className="error-box">読み込みエラー: {error}</div>}
        {actionError && <div className="error-box">{actionError}</div>}

        {loading || storesLoading ? (
          <div className="loading-block" style={{ padding: 60 }}>
            <div className="spinner" aria-hidden />
            <p>成績を読み込んでいます…</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="info-box">
            データなし
            {canEdit && (
              <div style={{ marginTop: 10 }}>
                <button className="btn btn-primary btn-sm" onClick={openAdd}>
                  入力する
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table" style={{ minWidth: 900 }}>
              <thead>
                <tr>
                  <th>キャスト</th>
                  <th className="num">総売上</th>
                  <th className="num">支給額</th>
                  <th className="num">実質時給</th>
                  <th className="num">給与差額</th>
                  <th className="num">時給差額</th>
                  <th className="num">本指名</th>
                  <th className="num">場内</th>
                  <th className="num">同伴</th>
                  <th className="num">出勤日数</th>
                  <th className="num">出勤時間</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const c = castOf(r.castId);
                  const pr = payDiff(r.totalSales, r.payment);
                  const hr = c
                    ? wageDiff(r.totalSales, c.hourlyWage, r.workHours, r.workDays)
                    : null;
                  const rw = realHourlyWage(r.payment, r.workHours, r.workDays);
                  // 既存版と同一: 目標達成で緑・太字
                  const overTarget = !!c && r.totalSales >= (c.targetSales || 0) && (c.targetSales || 0) > 0;
                  return (
                    <tr
                      key={r.id}
                      className="row-clickable"
                      onClick={() => {
                        // 既存不具合の修正: 行クリック/タップで詳細を開く
                        if (c) router.push(`/casts/${c.id}`);
                      }}
                    >
                      <td>
                        <span className="cast-link">{c ? c.stageName : "?"}</span>
                      </td>
                      <td
                        className="num"
                        style={{
                          color: overTarget ? "var(--green)" : "var(--text)",
                          fontWeight: overTarget ? 700 : 400,
                        }}
                      >
                        ¥{(r.totalSales || 0).toLocaleString()}
                      </td>
                      <td className="num">¥{(r.payment || 0).toLocaleString()}</td>
                      <td className="num" style={{ color: "var(--acc2)" }}>
                        {rw != null ? "¥" + rw.toLocaleString() : "-"}
                      </td>
                      <td className="num">{fmtDiff(pr)}</td>
                      <td className="num">{fmtDiff(hr)}</td>
                      <td className="num" style={{ color: "var(--acc2)" }}>
                        {r.honshimeiCount || 0}
                      </td>
                      <td className="num">{r.jounaiCount || 0}</td>
                      <td className="num">{r.douhan || 0}</td>
                      <td className="num">{r.workDays || 0}</td>
                      <td className="num" style={{ color: "var(--text2)" }}>
                        {r.workHours > 0
                          ? r.workHours.toFixed(1) + "h"
                          : r.workDays
                            ? (r.workDays * 4.5).toFixed(1) + "h*"
                            : "-"}
                      </td>
                      <td onClick={(e) => e.stopPropagation() /* ボタン操作は行遷移させない */}>
                        {canEdit && (
                          <div style={{ display: "flex", gap: 4 }}>
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => openEdit(r)}
                            >
                              編集
                            </button>
                            <button
                              className="btn btn-danger btn-sm"
                              onClick={() => void onDelete(r)}
                            >
                              削除
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p style={{ fontSize: 11, color: "var(--text3)", marginTop: 8 }}>
          出勤時間の「*」は未入力のため出勤日数×4.5hで計算した推定値です。
        </p>
      </main>

      {formOpen && formCast && (
        <MonthlyResultFormModal
          cast={formCast}
          result={formResult}
          defaultMonth={month}
          onClose={() => setFormOpen(false)}
          onSaved={() => setFormOpen(false)}
        />
      )}
    </div>
  );
}
