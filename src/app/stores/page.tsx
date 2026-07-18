"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { AppHeader } from "@/components/AppHeader";
import { useStores } from "@/hooks/useStores";
import {
  createStore,
  seedInitialStores,
  setStoreActive,
  updateStore,
  type StoreInput,
} from "@/services/storeService";
import { INITIAL_STORES, isOwner, type StoreWithId } from "@/types";

export default function StoresPage() {
  const { firebaseUser, userDoc } = useAuth();
  const owner = isOwner(userDoc);
  const router = useRouter();
  const { stores, loading, error } = useStores();

  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<StoreWithId | null>(null);
  const [formOpen, setFormOpen] = useState(false);

  // owner以外はダッシュボードへ（Rules側でも書き込み不可の二重防御）
  useEffect(() => {
    if (userDoc && !owner) router.replace("/dashboard");
  }, [userDoc, owner, router]);

  if (!owner) return null;

  async function run(fn: () => Promise<void>) {
    setActionError(null);
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function onSeed() {
    if (!firebaseUser) return;
    const names = INITIAL_STORES.map((s) => s.name).join("・");
    if (!window.confirm(`初期店舗（${names}）を作成しますか？`)) return;
    void run(() => seedInitialStores(firebaseUser.uid));
  }

  function onToggleActive(s: StoreWithId) {
    if (!firebaseUser) return;
    const msg = s.active
      ? `「${s.name}」を無効にしますか？（店舗切替に表示されなくなります）`
      : `「${s.name}」を有効に戻しますか？`;
    if (!window.confirm(msg)) return;
    void run(() => setStoreActive(firebaseUser.uid, s.id, !s.active));
  }

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="app-main">
        <div className="page-head">
          <div>
            <h1 className="page-title">店舗管理</h1>
            <p className="page-sub">店舗の登録・編集・有効/無効の切替（オーナー専用）</p>
          </div>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            ＋ 店舗を追加
          </button>
        </div>

        {error && <div className="error-box">読み込みエラー: {error}</div>}
        {actionError && <div className="error-box">{actionError}</div>}

        {loading ? (
          <div className="loading-block" style={{ padding: 40 }}>
            <div className="spinner" aria-hidden />
            <p>店舗を読み込んでいます…</p>
          </div>
        ) : stores.length === 0 ? (
          <div className="info-box">
            店舗がまだ登録されていません。
            <div style={{ marginTop: 12 }}>
              <button className="btn btn-primary btn-sm" onClick={onSeed} disabled={busy}>
                初期店舗（{INITIAL_STORES.map((s) => s.name).join("・")}）を作成
              </button>
            </div>
          </div>
        ) : (
          stores.map((s) => (
            <div key={s.id} className="user-card">
              <div className="row1">
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span
                    aria-hidden
                    style={{
                      width: 14,
                      height: 14,
                      borderRadius: 4,
                      background: s.color,
                      display: "inline-block",
                    }}
                  />
                  <div>
                    <div className="name">{s.name}</div>
                    <div className="email">
                      ID: {s.id} / code: {s.code} / 表示順: {s.order}
                    </div>
                  </div>
                </div>
                <span className={`badge ${s.active ? "badge-green" : "badge-gray"}`}>
                  {s.active ? "有効" : "無効"}
                </span>
              </div>
              <div className="actions">
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() => {
                    setEditing(s);
                    setFormOpen(true);
                  }}
                >
                  編集
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() => onToggleActive(s)}
                >
                  {s.active ? "無効にする" : "有効に戻す"}
                </button>
              </div>
            </div>
          ))
        )}
      </main>

      {formOpen && (
        <StoreFormModal
          store={editing}
          onClose={() => setFormOpen(false)}
          onSaved={() => setFormOpen(false)}
        />
      )}
    </div>
  );
}

function StoreFormModal({
  store,
  onClose,
  onSaved,
}: {
  store: StoreWithId | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { firebaseUser } = useAuth();
  const [input, setInput] = useState<StoreInput>({
    name: store?.name ?? "",
    code: store?.code ?? "",
    color: store?.color ?? "#9c6bff",
    active: store?.active ?? true,
    order: store?.order ?? 0,
  });
  const [storeId, setStoreId] = useState(store?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (saving || !firebaseUser) return;
    setError(null);
    setSaving(true);
    try {
      if (store) {
        await updateStore(firebaseUser.uid, store.id, input);
      } else {
        const id = storeId.trim() || input.code.trim();
        if (!/^[a-z0-9_-]+$/.test(id)) {
          throw new Error("店舗IDは半角英小文字・数字・ハイフンのみ使用できます");
        }
        await createStore(firebaseUser.uid, id, input);
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message || "保存に失敗しました");
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal-card" style={{ maxWidth: 480 }}>
        <div className="modal-head">
          <h2>{store ? "店舗を編集" : "店舗を追加"}</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} disabled={saving}>
            ✕ 閉じる
          </button>
        </div>

        {error && <div className="error-box">{error}</div>}

        <form onSubmit={onSubmit}>
          {!store && (
            <div className="form-group">
              <label>店舗ID（半角英数・後から変更不可。空欄ならcodeを使用）</label>
              <input
                className="form-input"
                value={storeId}
                placeholder="例: virgo"
                onChange={(e) => setStoreId(e.target.value)}
              />
            </div>
          )}
          <div className="form-group">
            <label>店舗名 *</label>
            <input
              className="form-input"
              value={input.name}
              onChange={(e) => setInput((p) => ({ ...p, name: e.target.value }))}
              required
            />
          </div>
          <div className="form-group">
            <label>店舗コード *（半角英数）</label>
            <input
              className="form-input"
              value={input.code}
              onChange={(e) => setInput((p) => ({ ...p, code: e.target.value }))}
              required
            />
          </div>
          <div className="form-group">
            <label>カラー</label>
            <input
              className="form-input"
              type="color"
              value={input.color}
              onChange={(e) => setInput((p) => ({ ...p, color: e.target.value }))}
              style={{ height: 42, padding: 4 }}
            />
          </div>
          <div className="form-group">
            <label>表示順</label>
            <input
              className="form-input"
              type="number"
              value={input.order}
              onChange={(e) => setInput((p) => ({ ...p, order: Number(e.target.value) }))}
            />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={saving}>
              キャンセル
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? "保存中…" : store ? "変更を保存" : "追加する"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
