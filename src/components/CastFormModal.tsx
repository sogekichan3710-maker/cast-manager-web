"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { Timestamp } from "firebase/firestore";
import { useAuth } from "@/contexts/AuthContext";
import {
  ConflictError,
  castToInput,
  createCast,
  emptyCastInput,
  updateCast,
  type CastInput,
} from "@/services/castService";
import {
  CAST_STATUSES,
  RANKS,
  isOwner,
  type CastWithId,
  type StoreWithId,
} from "@/types";

interface Props {
  /** null = 新規作成 / CastWithId = 編集 */
  cast: CastWithId | null;
  /** 新規作成時の初期店舗ID（'__all__' の場合は先頭の許可店舗） */
  defaultStoreId: string;
  /** 選択できる店舗（ログインユーザーの許可店舗のみ渡すこと） */
  stores: StoreWithId[];
  onClose: () => void;
  onSaved: (castId: string) => void;
}

export function CastFormModal({ cast, defaultStoreId, stores, onClose, onSaved }: Props) {
  const { firebaseUser, userDoc } = useAuth();
  const owner = isOwner(userDoc);

  const [input, setInput] = useState<CastInput>(() =>
    cast
      ? castToInput(cast)
      : emptyCastInput(
          stores.some((s) => s.id === defaultStoreId) ? defaultStoreId : (stores[0]?.id ?? "")
        )
  );
  // 競合検知: 編集開始時点の updatedAt を保持
  const [baseUpdatedAt] = useState<Timestamp | null>(cast?.updatedAt ?? null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // モーダル表示中は背景スクロールを固定（iPhone対応）
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  function set<K extends keyof CastInput>(key: K, value: CastInput[K]) {
    setInput((p) => ({ ...p, [key]: value }));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (saving) return; // 二重クリック防止
    if (!firebaseUser || !userDoc) return;
    setError(null);
    setSaving(true);
    const allowed = owner ? ("all" as const) : userDoc.accessibleStoreIds;
    try {
      const actorName = userDoc.displayName ?? "";
      if (cast) {
        await updateCast(firebaseUser.uid, actorName, cast.id, input, allowed, baseUpdatedAt);
        onSaved(cast.id);
      } else {
        const id = await createCast(firebaseUser.uid, actorName, input, allowed);
        onSaved(id);
      }
    } catch (err: unknown) {
      if (err instanceof ConflictError) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : "保存に失敗しました");
      }
      setSaving(false); // 失敗時のみ解除（成功時はモーダルが閉じる）
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-card">
        <div className="modal-head">
          <h2>{cast ? "キャストを編集" : "キャストを登録"}</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={saving}>
            ✕ 閉じる
          </button>
        </div>

        {error && <div className="error-box">{error}</div>}

        <form onSubmit={onSubmit}>
          <div className="form-grid">
            <div className="form-group">
              <label>店舗 *</label>
              <select
                className="form-input"
                value={input.storeId}
                disabled={!!cast /* 編集時の店舗移動は不可 */}
                onChange={(e) => set("storeId", e.target.value)}
                required
              >
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>源氏名 *</label>
              <input
                className="form-input"
                value={input.stageName}
                onChange={(e) => set("stageName", e.target.value)}
                required
              />
            </div>
            <div className="form-group">
              <label>本名</label>
              <input
                className="form-input"
                value={input.realName}
                onChange={(e) => set("realName", e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>ふりがな</label>
              <input
                className="form-input"
                value={input.kana}
                onChange={(e) => set("kana", e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>在籍状態</label>
              <select
                className="form-input"
                value={input.status}
                onChange={(e) => set("status", e.target.value as CastInput["status"])}
              >
                {CAST_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>ランク</label>
              <select
                className="form-input"
                value={input.rank}
                onChange={(e) => set("rank", e.target.value as CastInput["rank"])}
              >
                <option value="">未設定</option>
                {RANKS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>時給（円）</label>
              <input
                className="form-input"
                type="number"
                min={0}
                step={100}
                value={input.hourlyWage}
                onChange={(e) => set("hourlyWage", Number(e.target.value))}
              />
            </div>
            <div className="form-group">
              <label>入店日</label>
              <input
                className="form-input"
                type="date"
                value={input.joinDate}
                onChange={(e) => set("joinDate", e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>退店日</label>
              <input
                className="form-input"
                type="date"
                value={input.leftDate}
                onChange={(e) => set("leftDate", e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>誕生日</label>
              <input
                className="form-input"
                type="date"
                value={input.birthday}
                onChange={(e) => set("birthday", e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>電話番号</label>
              <input
                className="form-input"
                type="tel"
                value={input.phone}
                onChange={(e) => set("phone", e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>LINE</label>
              <input
                className="form-input"
                value={input.line}
                onChange={(e) => set("line", e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>担当者</label>
              <input
                className="form-input"
                value={input.manager}
                onChange={(e) => set("manager", e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>目標売上（円）</label>
              <input
                className="form-input"
                type="number"
                min={0}
                step={10000}
                value={input.targetSales}
                onChange={(e) => set("targetSales", Number(e.target.value))}
              />
            </div>
            <div className="form-group">
              <label>目標本指名（本）</label>
              <input
                className="form-input"
                type="number"
                min={0}
                value={input.targetHonmei}
                onChange={(e) => set("targetHonmei", Number(e.target.value))}
              />
            </div>
            <div className="form-group">
              <label>目標同伴（回）</label>
              <input
                className="form-input"
                type="number"
                min={0}
                value={input.targetDouhan}
                onChange={(e) => set("targetDouhan", Number(e.target.value))}
              />
            </div>
            <div className="form-group">
              <label>保証</label>
              <input
                className="form-input"
                value={input.guarantee}
                onChange={(e) => set("guarantee", e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>性格</label>
              <input
                className="form-input"
                value={input.personality}
                onChange={(e) => set("personality", e.target.value)}
              />
            </div>
          </div>

          <div className="form-group">
            <label>メモ</label>
            <textarea
              className="form-input"
              rows={3}
              value={input.memo}
              onChange={(e) => set("memo", e.target.value)}
            />
          </div>
          <div className="form-group">
            <label>顧客メモ</label>
            <textarea
              className="form-input"
              rows={3}
              value={input.customerNotes}
              onChange={(e) => set("customerNotes", e.target.value)}
            />
          </div>

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              キャンセル
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? "保存中…" : cast ? "変更を保存" : "登録する"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
