"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { Timestamp } from "firebase/firestore";
import { useAuth } from "@/contexts/AuthContext";
import {
  InterviewConflictError,
  updateInterview,
  type InterviewEditInput,
} from "@/services/recordService";
import { FOLLOW_NEEDS, type InterviewWithId } from "@/types";

/**
 * 面談記録の編集モーダル。
 * 面談フィールドのみを編集する（目標・モチベーションは別レコードのため
 * ここでは扱わず、重複作成を防ぐ）。
 * 競合検知: 編集開始時点の updatedAt を保持し、保存時に比較。
 */
export function InterviewEditModal({
  interview,
  onClose,
  onSaved,
}: {
  interview: InterviewWithId;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { firebaseUser, userDoc } = useAuth();
  const [input, setInput] = useState<InterviewEditInput>({
    date: interview.date ?? "",
    interviewer: interview.interviewer ?? "",
    follow: interview.follow ?? "",
    nextDate: interview.nextDate ?? "",
    content: interview.content ?? "",
    worries: interview.worries ?? "",
    decisions: interview.decisions ?? "",
    nextTask: interview.nextTask ?? "",
  });
  // 編集開始時点の updatedAt（競合検知用）
  const [baseUpdatedAt] = useState<Timestamp | null>(interview.updatedAt ?? null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  function set<K extends keyof InterviewEditInput>(key: K, value: InterviewEditInput[K]) {
    setInput((p) => ({ ...p, [key]: value }));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (saving || !firebaseUser) return; // 二重クリック防止
    setError(null);
    setSaving(true);
    try {
      await updateInterview(
        firebaseUser.uid,
        userDoc?.displayName ?? "",
        interview.id,
        input,
        baseUpdatedAt
      );
      onSaved();
    } catch (err: unknown) {
      if (err instanceof InterviewConflictError) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : "保存に失敗しました");
      }
      setSaving(false); // 失敗時のみ解除（成功表示は出さない）
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-card">
        <div className="modal-head">
          <h2>面談記録を編集</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={saving}>
            ✕ 閉じる
          </button>
        </div>

        {error && <div className="error-box">{error}</div>}

        <form onSubmit={onSubmit}>
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
                value={input.follow}
                onChange={(e) => set("follow", e.target.value as InterviewEditInput["follow"])}
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

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              キャンセル
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? "保存中…" : "変更を保存"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
