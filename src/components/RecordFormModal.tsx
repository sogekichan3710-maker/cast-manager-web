"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { emptyRecordInput, saveRecord, type RecordInput } from "@/services/recordService";
import {
  FOLLOW_NEEDS,
  GOAL_STATUSES,
  MOTI_LEVELS,
  currentMonth,
  type CastWithId,
} from "@/types";

/**
 * 統合記録フォーム（既存ローカル版 recordModal の移植）。
 * 面談・目標・モチベーションを1フォームから同時保存する既存仕様を維持。
 */
export function RecordFormModal({
  cast,
  onClose,
  onSaved,
}: {
  cast: CastWithId;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { firebaseUser, userDoc } = useAuth();
  const [input, setInput] = useState<RecordInput>(() =>
    emptyRecordInput(cast.id, cast.storeId, currentMonth())
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  function set<K extends keyof RecordInput>(key: K, value: RecordInput[K]) {
    setInput((p) => ({ ...p, [key]: value }));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (saving || !firebaseUser) return;
    setError(null);
    setSaving(true);
    try {
      await saveRecord(firebaseUser.uid, userDoc?.displayName ?? "", input);
      onSaved();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "保存に失敗しました");
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-card">
        <div className="modal-head">
          <h2>面談記録を追加 — {cast.stageName}</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={saving}>
            ✕ 閉じる
          </button>
        </div>

        {error && <div className="error-box">{error}</div>}

        <form onSubmit={onSubmit}>
          <div className="section-label" style={{ marginTop: 0 }}>面談</div>
          <div className="form-grid">
            <div className="form-group">
              <label>面談日 *</label>
              <input
                className="form-input"
                type="date"
                value={input.date}
                onChange={(e) => set("date", e.target.value)}
                required
              />
            </div>
            <div className="form-group">
              <label>面談者</label>
              <input
                className="form-input"
                value={input.interviewer}
                onChange={(e) => set("interviewer", e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>フォロー必要度</label>
              <select
                className="form-input"
                value={input.followNeed}
                onChange={(e) => set("followNeed", e.target.value as RecordInput["followNeed"])}
              >
                <option value="">--</option>
                {FOLLOW_NEEDS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>次回面談日</label>
              <input
                className="form-input"
                type="date"
                value={input.nextDate}
                onChange={(e) => set("nextDate", e.target.value)}
              />
            </div>
          </div>
          <div className="form-group">
            <label>面談内容</label>
            <textarea
              className="form-input"
              rows={3}
              value={input.content}
              onChange={(e) => set("content", e.target.value)}
            />
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label>悩み・相談</label>
              <textarea
                className="form-input"
                rows={2}
                value={input.worries}
                onChange={(e) => set("worries", e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>決定事項</label>
              <textarea
                className="form-input"
                rows={2}
                value={input.decisions}
                onChange={(e) => set("decisions", e.target.value)}
              />
            </div>
          </div>
          <div className="form-group">
            <label>次回までの課題</label>
            <input
              className="form-input"
              value={input.nextTask}
              onChange={(e) => set("nextTask", e.target.value)}
            />
          </div>

          <div className="section-label">目標（入力した場合のみ保存・同月は上書き）</div>
          <div className="form-grid">
            <div className="form-group">
              <label>対象月</label>
              <input
                className="form-input"
                type="month"
                value={input.goalMonth}
                onChange={(e) => set("goalMonth", e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>達成状況</label>
              <select
                className="form-input"
                value={input.goalStatus}
                onChange={(e) => set("goalStatus", e.target.value as RecordInput["goalStatus"])}
              >
                <option value="">--</option>
                {GOAL_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>目標売上（円）</label>
              <input
                className="form-input"
                type="number"
                min={0}
                step={10000}
                value={input.salesTarget}
                onChange={(e) => set("salesTarget", Number(e.target.value))}
              />
            </div>
            <div className="form-group">
              <label>目標本指名（本）</label>
              <input
                className="form-input"
                type="number"
                min={0}
                value={input.honshimeiTarget}
                onChange={(e) => set("honshimeiTarget", Number(e.target.value))}
              />
            </div>
            <div className="form-group">
              <label>目標本指名（組）</label>
              <input
                className="form-input"
                type="number"
                min={0}
                value={input.honGroupTarget}
                onChange={(e) => set("honGroupTarget", Number(e.target.value))}
              />
            </div>
            <div className="form-group">
              <label>目標場内</label>
              <input
                className="form-input"
                type="number"
                min={0}
                value={input.jounaiTarget}
                onChange={(e) => set("jounaiTarget", Number(e.target.value))}
              />
            </div>
            <div className="form-group">
              <label>目標同伴</label>
              <input
                className="form-input"
                type="number"
                min={0}
                value={input.douhanTarget}
                onChange={(e) => set("douhanTarget", Number(e.target.value))}
              />
            </div>
            <div className="form-group">
              <label>目標出勤日数</label>
              <input
                className="form-input"
                type="number"
                min={0}
                value={input.workDaysTarget}
                onChange={(e) => set("workDaysTarget", Number(e.target.value))}
              />
            </div>
            <div className="form-group">
              <label>目標出勤時間（h）</label>
              <input
                className="form-input"
                type="number"
                min={0}
                step={0.5}
                value={input.workHoursTarget}
                onChange={(e) => set("workHoursTarget", Number(e.target.value))}
              />
            </div>
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label>目標メモ</label>
              <textarea
                className="form-input"
                rows={2}
                value={input.goalMemo}
                onChange={(e) => set("goalMemo", e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>アクション・課題</label>
              <textarea
                className="form-input"
                rows={2}
                value={input.goalTask}
                onChange={(e) => set("goalTask", e.target.value)}
              />
            </div>
          </div>

          <div className="section-label">モチベーション（レベルを選んだ場合のみ保存）</div>
          <div className="form-grid">
            <div className="form-group">
              <label>モチベーションレベル</label>
              <select
                className="form-input"
                value={input.motiLevel}
                onChange={(e) => set("motiLevel", e.target.value as RecordInput["motiLevel"])}
              >
                <option value="">--</option>
                {MOTI_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>フォロー予定日</label>
              <input
                className="form-input"
                type="date"
                value={input.followDate}
                onChange={(e) => set("followDate", e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>現在の状態</label>
              <input
                className="form-input"
                value={input.motiState}
                onChange={(e) => set("motiState", e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>危険信号・退店リスク</label>
              <input
                className="form-input"
                value={input.motiDanger}
                onChange={(e) => set("motiDanger", e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>フォロー内容</label>
              <input
                className="form-input"
                value={input.motiFollow}
                onChange={(e) => set("motiFollow", e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>成長ポイント</label>
              <input
                className="form-input"
                value={input.motiGrowth}
                onChange={(e) => set("motiGrowth", e.target.value)}
              />
            </div>
          </div>

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              キャンセル
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? "保存中…" : "記録を保存"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
