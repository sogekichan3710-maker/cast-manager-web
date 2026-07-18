"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { InterviewEditModal } from "@/components/InterviewEditModal";
import { MonthlyResultFormModal } from "@/components/MonthlyResultFormModal";
import { RecordFormModal } from "@/components/RecordFormModal";
import { TrendChart } from "@/components/TrendChart";
import { subscribeMonthlyResultsByCast } from "@/services/monthlyResultService";
import {
  recordWageChange,
  subscribeGoals,
  subscribeInterviews,
  subscribeMotivations,
  subscribeWageHistory,
} from "@/services/recordService";
import {
  currentMonth,
  fmtDiff,
  isAdminOrAbove,
  monthToJa,
  payDiff,
  realHourlyWage,
  wageDiff,
  type CastWithId,
  type GoalWithId,
  type InterviewWithId,
  type MonthlyResultWithId,
  type MotivationWithId,
  type WageHistoryWithId,
} from "@/types";

/**
 * キャスト詳細ページの成績・記録セクション。
 * 既存ローカル版 openCastDetail の情報量を復元:
 * 今月成績・年間成績・月別推移グラフ・月別成績一覧・面談履歴・目標・
 * モチベーション・時給履歴・成績入力/面談記録追加ボタン
 */
export function CastDetailSections({ cast }: { cast: CastWithId }) {
  const { firebaseUser, userDoc } = useAuth();
  const canEdit = isAdminOrAbove(userDoc);

  const [results, setResults] = useState<MonthlyResultWithId[]>([]);
  const [interviews, setInterviews] = useState<InterviewWithId[]>([]);
  const [goals, setGoals] = useState<GoalWithId[]>([]);
  const [motivations, setMotivations] = useState<MotivationWithId[]>([]);
  const [wageHistory, setWageHistory] = useState<WageHistoryWithId[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onErr = (m: string) => setError(m);
    const unsubs = [
      subscribeMonthlyResultsByCast(cast.id, setResults, onErr),
      subscribeInterviews(cast.id, setInterviews, onErr),
      subscribeGoals(cast.id, setGoals, onErr),
      subscribeMotivations(cast.id, setMotivations, onErr),
      subscribeWageHistory(cast.id, setWageHistory, onErr),
    ];
    return () => unsubs.forEach((u) => u());
  }, [cast.id]);

  // ── 今月成績・年間成績（既存版 openCastDetail のサマリーと同一定義） ──
  const cm = currentMonth();
  const thisYear = cm.slice(0, 4);
  const cmr = results.find((r) => r.month === cm) ?? null;
  const yearResults = results.filter((r) => r.month.startsWith(thisYear));
  const yS = yearResults.reduce((s, r) => s + (r.totalSales || 0), 0);
  const yH = yearResults.reduce((s, r) => s + (r.honshimeiCount || 0), 0);

  const [mrFormOpen, setMrFormOpen] = useState(false);
  const [mrEdit, setMrEdit] = useState<MonthlyResultWithId | null>(null);
  const [recFormOpen, setRecFormOpen] = useState(false);
  const [ivEdit, setIvEdit] = useState<InterviewWithId | null>(null);
  const [wageFormOpen, setWageFormOpen] = useState(false);

  return (
    <>
      {error && <div className="error-box">読み込みエラー: {error}</div>}

      {/* 成績サマリー（既存版と同一4項目: 今月売上/年間売上/年間本指名/データ月数） */}
      <section className="detail-card">
        <div className="stats-grid">
          <StatCard
            label="今月売上"
            value={cmr ? "¥" + (cmr.totalSales || 0).toLocaleString() : "-"}
          />
          <StatCard label="年間売上" value={"¥" + yS.toLocaleString()} />
          <StatCard label="年間本指名" value={String(yH)} />
          <StatCard label="データ月数" value={String(results.length)} />
        </div>
        {canEdit && (
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => {
                setMrEdit(null);
                setMrFormOpen(true);
              }}
            >
              ＋ 成績を入力
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setRecFormOpen(true)}>
              ＋ 面談記録を追加
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setWageFormOpen(true)}>
              ¥ 時給を変更
            </button>
          </div>
        )}
      </section>

      {/* 月別推移グラフ（既存版の8種・直近12ヶ月・古い月→新しい月） */}
      <section className="detail-card">
        <h2 className="detail-heading">月別推移グラフ</h2>
        <TrendChart cast={cast} results={results} />
      </section>

      {/* 月別成績一覧（新しい月が上・既存版の表示項目） */}
      <section className="detail-card">
        <h2 className="detail-heading">月別成績一覧（{results.length}件）</h2>
        {results.length === 0 ? (
          <p className="empty-note">成績データがありません</p>
        ) : (
          <div className="table-wrap" style={{ border: "none" }}>
            <table className="data-table" style={{ minWidth: 760 }}>
              <thead>
                <tr>
                  <th>月</th>
                  <th className="num">総売上</th>
                  <th className="num">支給額</th>
                  <th className="num">実質時給</th>
                  <th className="num">給与差額</th>
                  <th className="num">時給差額</th>
                  <th className="num">本指名</th>
                  <th className="num">場内</th>
                  <th className="num">同伴</th>
                  <th className="num">出勤</th>
                  {canEdit && <th></th>}
                </tr>
              </thead>
              <tbody>
                {results
                  .slice()
                  .reverse() /* 一覧は新しい月が上（既存版と同じ） */
                  .map((r) => {
                    const pr = payDiff(r.totalSales, r.payment);
                    const hr = wageDiff(r.totalSales, cast.hourlyWage, r.workHours, r.workDays);
                    const rw = realHourlyWage(r.payment, r.workHours, r.workDays);
                    return (
                      <tr key={r.id}>
                        <td>{monthToJa(r.month)}</td>
                        <td className="num">¥{(r.totalSales || 0).toLocaleString()}</td>
                        <td className="num">¥{(r.payment || 0).toLocaleString()}</td>
                        <td className="num" style={{ color: "var(--acc2)" }}>
                          {rw != null ? "¥" + rw.toLocaleString() : "-"}
                        </td>
                        <td className="num">{fmtDiff(pr)}</td>
                        <td className="num">{fmtDiff(hr)}</td>
                        <td className="num">{r.honshimeiCount || 0}</td>
                        <td className="num">{r.jounaiCount || 0}</td>
                        <td className="num">{r.douhan || 0}</td>
                        <td className="num">{r.workDays || 0}日</td>
                        {canEdit && (
                          <td>
                            <button
                              className="btn btn-ghost btn-sm"
                              onClick={() => {
                                setMrEdit(r);
                                setMrFormOpen(true);
                              }}
                            >
                              編集
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 面談履歴 */}
      <section className="detail-card">
        <h2 className="detail-heading">面談履歴（{interviews.length}件）</h2>
        {interviews.length === 0 ? (
          <p className="empty-note">面談記録がありません</p>
        ) : (
          interviews.map((iv) => (
            <div key={iv.id} className="record-item">
              <div className="record-head">
                <strong>{iv.date}</strong>
                {iv.interviewer && <span className="dim">面談者: {iv.interviewer}</span>}
                {iv.follow && (
                  <span
                    className={`badge ${
                      iv.follow === "高"
                        ? "badge-red"
                        : iv.follow === "中"
                          ? "badge-yellow"
                          : "badge-gray"
                    }`}
                  >
                    フォロー{iv.follow}
                  </span>
                )}
                {canEdit && (
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ marginLeft: "auto" }}
                    onClick={() => setIvEdit(iv)}
                  >
                    編集
                  </button>
                )}
              </div>
              {iv.content && <p className="record-text">{iv.content}</p>}
              {iv.worries && (
                <p className="record-text dim">悩み: {iv.worries}</p>
              )}
              {iv.decisions && (
                <p className="record-text dim">決定事項: {iv.decisions}</p>
              )}
              {(iv.nextDate || iv.nextTask) && (
                <p className="record-text dim">
                  次回: {iv.nextDate || "未定"}
                  {iv.nextTask ? ` / 課題: ${iv.nextTask}` : ""}
                </p>
              )}
            </div>
          ))
        )}
      </section>

      {/* 目標 */}
      <section className="detail-card">
        <h2 className="detail-heading">目標（{goals.length}件）</h2>
        {goals.length === 0 ? (
          <p className="empty-note">目標が設定されていません</p>
        ) : (
          goals.map((g) => (
            <div key={g.id} className="record-item">
              <div className="record-head">
                <strong>{monthToJa(g.month)}</strong>
                {g.status && (
                  <span
                    className={`badge ${
                      g.status === "達成"
                        ? "badge-green"
                        : g.status === "進行中"
                          ? "badge-yellow"
                          : "badge-gray"
                    }`}
                  >
                    {g.status}
                  </span>
                )}
              </div>
              <p className="record-text">
                {[
                  g.salesTarget ? `売上 ¥${g.salesTarget.toLocaleString()}` : null,
                  g.honshimeiTarget ? `本指名 ${g.honshimeiTarget}本` : null,
                  g.honGroupTarget ? `${g.honGroupTarget}組` : null,
                  g.jounaiTarget ? `場内 ${g.jounaiTarget}` : null,
                  g.douhanTarget ? `同伴 ${g.douhanTarget}` : null,
                  g.workDaysTarget ? `出勤 ${g.workDaysTarget}日` : null,
                  g.workHoursTarget ? `${g.workHoursTarget}h` : null,
                ]
                  .filter(Boolean)
                  .join(" / ") || "目標値なし"}
              </p>
              {g.memo && <p className="record-text dim">{g.memo}</p>}
              {g.task && <p className="record-text dim">課題: {g.task}</p>}
            </div>
          ))
        )}
      </section>

      {/* モチベーション */}
      <section className="detail-card">
        <h2 className="detail-heading">モチベーション（{motivations.length}件）</h2>
        {motivations.length === 0 ? (
          <p className="empty-note">モチベーション記録がありません</p>
        ) : (
          motivations.map((m) => (
            <div key={m.id} className="record-item">
              <div className="record-head">
                <strong>{m.date}</strong>
                <span
                  className={`badge ${
                    m.level.startsWith("5") || m.level.startsWith("4")
                      ? "badge-green"
                      : m.level.startsWith("3")
                        ? "badge-yellow"
                        : "badge-red"
                  }`}
                >
                  {m.level}
                </span>
                {m.followNeed && <span className="dim">フォロー: {m.followNeed}</span>}
              </div>
              {m.state && <p className="record-text">状態: {m.state}</p>}
              {m.danger && <p className="record-text" style={{ color: "var(--red)" }}>危険信号: {m.danger}</p>}
              {m.follow && <p className="record-text dim">フォロー内容: {m.follow}</p>}
              {m.growth && <p className="record-text dim">成長: {m.growth}</p>}
            </div>
          ))
        )}
      </section>

      {/* 時給履歴 */}
      <section className="detail-card">
        <h2 className="detail-heading">時給履歴（{wageHistory.length}件）</h2>
        {wageHistory.length === 0 ? (
          <p className="empty-note">時給変更の履歴がありません</p>
        ) : (
          wageHistory.map((w) => (
            <div key={w.id} className="record-item">
              <div className="record-head">
                <strong>{monthToJa(w.effectiveMonth)}</strong>
                <span>
                  ¥{w.oldHourlyWage.toLocaleString()} →{" "}
                  <strong style={{ color: "var(--acc2)" }}>
                    ¥{w.newHourlyWage.toLocaleString()}
                  </strong>
                </span>
              </div>
              {w.reason && <p className="record-text dim">{w.reason}</p>}
            </div>
          ))
        )}
      </section>

      {mrFormOpen && (
        <MonthlyResultFormModal
          cast={cast}
          result={mrEdit}
          defaultMonth={currentMonth()}
          onClose={() => setMrFormOpen(false)}
          onSaved={() => setMrFormOpen(false)}
        />
      )}
      {ivEdit && (
        <InterviewEditModal
          interview={ivEdit}
          onClose={() => setIvEdit(null)}
          onSaved={() => setIvEdit(null)}
        />
      )}
      {recFormOpen && (
        <RecordFormModal
          cast={cast}
          onClose={() => setRecFormOpen(false)}
          onSaved={() => setRecFormOpen(false)}
        />
      )}
      {wageFormOpen && firebaseUser && (
        <WageChangeModal
          cast={cast}
          actorUid={firebaseUser.uid}
          onClose={() => setWageFormOpen(false)}
        />
      )}
    </>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

/** 時給変更モーダル（wageHistoryへ追記し、キャストの時給も更新） */
function WageChangeModal({
  cast,
  actorUid,
  onClose,
}: {
  cast: CastWithId;
  actorUid: string;
  onClose: () => void;
}) {
  const [newWage, setNewWage] = useState<number>(cast.hourlyWage || 0);
  const [effectiveMonth, setEffectiveMonth] = useState<string>(currentMonth());
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    if (!Number.isFinite(newWage) || newWage <= 0) {
      setError("新しい時給を入力してください");
      return;
    }
    if (newWage === cast.hourlyWage) {
      setError("時給が変更されていません");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await recordWageChange(actorUid, {
        castId: cast.id,
        storeId: cast.storeId,
        oldHourlyWage: cast.hourlyWage || 0,
        newHourlyWage: newWage,
        effectiveMonth,
        reason,
      });
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "保存に失敗しました");
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-card" style={{ maxWidth: 440 }}>
        <div className="modal-head">
          <h2>時給を変更 — {cast.stageName}</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={saving}>
            ✕ 閉じる
          </button>
        </div>
        {error && <div className="error-box">{error}</div>}
        <form onSubmit={onSubmit}>
          <div className="form-group">
            <label>現在の時給</label>
            <input
              className="form-input"
              value={`¥${(cast.hourlyWage || 0).toLocaleString()}`}
              disabled
            />
          </div>
          <div className="form-group">
            <label>新しい時給（円）*</label>
            <input
              className="form-input"
              type="number"
              min={0}
              step={100}
              value={newWage}
              onChange={(e) => setNewWage(Number(e.target.value))}
              required
            />
          </div>
          <div className="form-group">
            <label>適用月</label>
            <input
              className="form-input"
              type="month"
              value={effectiveMonth}
              onChange={(e) => setEffectiveMonth(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>変更理由</label>
            <input
              className="form-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="例: 昇給・成績優秀"
            />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              キャンセル
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? "保存中…" : "時給を変更"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
