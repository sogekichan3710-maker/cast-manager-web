"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";
import { useStores } from "@/hooks/useStores";
import {
  approveUser,
  changeUserRole,
  disableUser,
  enableUser,
  setAccessibleStores,
  subscribeAllUsers,
} from "@/services/userAdminService";
import {
  ROLES,
  ROLE_LABELS,
  USER_STATUS_LABELS,
  isOwner,
  type Role,
  type StoreWithId,
  type UserWithId,
} from "@/types";

export default function AdminUsersPage() {
  const { userDoc, firebaseUser } = useAuth();
  const router = useRouter();
  const owner = isOwner(userDoc);
  const { accessibleStores: stores } = useStores();

  const [users, setUsers] = useState<UserWithId[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyUid, setBusyUid] = useState<string | null>(null);

  // owner以外はダッシュボードへ（Rules側でも読めないため二重防御）
  useEffect(() => {
    if (userDoc && !owner) router.replace("/dashboard");
  }, [userDoc, owner, router]);

  useEffect(() => {
    if (!owner) return;
    const unsub = subscribeAllUsers(setUsers, (msg) => setLoadError(msg));
    return unsub;
  }, [owner]);

  const approvedOwnerCount = useMemo(
    () => users.filter((u) => u.role === "owner" && u.status === "approved").length,
    [users]
  );

  const pending = users.filter((u) => u.status === "pending");
  const approved = users.filter((u) => u.status === "approved");
  const disabled = users.filter((u) => u.status === "disabled");

  if (!owner) return null;

  async function run(uid: string, fn: () => Promise<void>) {
    setActionError(null);
    setBusyUid(uid);
    try {
      await fn();
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusyUid(null);
    }
  }

  function isLastOwner(u: UserWithId): boolean {
    return u.role === "owner" && u.status === "approved" && approvedOwnerCount <= 1;
  }

  function onApprove(u: UserWithId) {
    if (!firebaseUser) return;
    void run(u.uid, () => approveUser(u.uid));
  }

  function onChangeRole(u: UserWithId, newRole: Role) {
    if (!firebaseUser) return;
    if (newRole === u.role) return;
    // クライアント側の事前チェックはUX向けの表示専用。実際の保証は
    // Cloud Functions（changeUserRole）がトランザクション内で行う。
    if (isLastOwner(u) && newRole !== "owner") {
      setActionError("最後のオーナーは降格できません。先に別のオーナーを追加してください。");
      return;
    }
    if (u.uid === firebaseUser.uid && newRole !== "owner") {
      const ok = window.confirm(
        "自分自身の権限をオーナーから変更すると、ユーザー管理画面にアクセスできなくなります。\n本当に変更しますか？"
      );
      if (!ok) return;
    }
    void run(u.uid, () => changeUserRole(u, newRole));
  }

  function onDisable(u: UserWithId) {
    if (!firebaseUser) return;
    // クライアント側の事前チェックはUX向けの表示専用。実際の保証は
    // Cloud Functions（disableUser）がトランザクション内で行う。
    if (isLastOwner(u)) {
      setActionError("最後のオーナーは無効化できません。先に別のオーナーを追加してください。");
      return;
    }
    const isSelf = u.uid === firebaseUser.uid;
    if (isSelf) {
      const ok = window.confirm(
        "自分自身を無効化すると、即座にアプリへアクセスできなくなります。\n本当に無効化しますか？"
      );
      if (!ok) return;
    } else {
      const ok = window.confirm(`${u.displayName}（${u.email}）を無効化しますか？`);
      if (!ok) return;
    }
    // 自分自身の無効化はCloud Functions側でも確認フラグ（confirmSelf）が
    // 必須（誤操作による自己ロックアウト防止の多層防御）
    void run(u.uid, () => disableUser(u, isSelf));
  }

  function onEnable(u: UserWithId) {
    if (!firebaseUser) return;
    void run(u.uid, () => enableUser(u.uid));
  }

  function onSaveStoreAccess(u: UserWithId, storeIds: string[], confirmEmpty: boolean) {
    if (!firebaseUser) return;
    void run(u.uid, () => setAccessibleStores(u.uid, storeIds, confirmEmpty).then(() => undefined));
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="title">CAST MANAGER</span>
        <Link href="/dashboard" className="btn btn-ghost btn-sm">
          ← ダッシュボード
        </Link>
      </header>

      <main className="app-main">
        <h1 className="page-title">ユーザー管理</h1>
        <p className="page-sub">
          利用申請の承認・権限の変更・アカウントの無効化・閲覧可能店舗の設定を行います（オーナー専用）
        </p>

        {loadError && <div className="error-box">読み込みエラー: {loadError}</div>}
        {actionError && <div className="error-box">{actionError}</div>}

        <div className="section-label">承認待ち（{pending.length}）</div>
        {pending.length === 0 && (
          <p style={{ color: "var(--text3)", fontSize: 12 }}>承認待ちのユーザーはいません</p>
        )}
        {pending.map((u) => (
          <UserCard key={u.uid} user={u} meUid={firebaseUser?.uid ?? ""} lastOwner={false}>
            <button
              className="btn btn-primary btn-sm"
              disabled={busyUid === u.uid}
              onClick={() => onApprove(u)}
            >
              承認する
            </button>
            <button
              className="btn btn-danger btn-sm"
              disabled={busyUid === u.uid}
              onClick={() => onDisable(u)}
            >
              却下（無効化）
            </button>
          </UserCard>
        ))}

        <div className="section-label">利用中（{approved.length}）</div>
        {approved.map((u) => (
          <UserCard
            key={u.uid}
            user={u}
            meUid={firebaseUser?.uid ?? ""}
            lastOwner={isLastOwner(u)}
          >
            <label style={{ fontSize: 12, color: "var(--text3)" }}>
              権限:{" "}
              <select
                className="form-input"
                style={{ width: "auto", display: "inline-block", padding: "4px 8px" }}
                value={u.role}
                disabled={busyUid === u.uid || isLastOwner(u)}
                onChange={(e) => onChangeRole(u, e.target.value as Role)}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="btn btn-danger btn-sm"
              disabled={busyUid === u.uid || isLastOwner(u)}
              title={isLastOwner(u) ? "最後のオーナーは無効化できません" : ""}
              onClick={() => onDisable(u)}
            >
              無効化
            </button>
            {isLastOwner(u) && (
              <span style={{ fontSize: 11, color: "var(--yellow)" }}>
                最後のオーナーのため変更できません
              </span>
            )}
            {u.role === "owner" ? (
              <span style={{ fontSize: 11, color: "var(--text3)" }}>
                閲覧可能店舗: 全店舗（オーナーは設定不要）
              </span>
            ) : (
              <StoreAccessEditor
                user={u}
                stores={stores}
                busy={busyUid === u.uid}
                onSave={(storeIds, confirmEmpty) => onSaveStoreAccess(u, storeIds, confirmEmpty)}
              />
            )}
          </UserCard>
        ))}

        <div className="section-label">無効（{disabled.length}）</div>
        {disabled.length === 0 && (
          <p style={{ color: "var(--text3)", fontSize: 12 }}>無効化されたユーザーはいません</p>
        )}
        {disabled.map((u) => (
          <UserCard key={u.uid} user={u} meUid={firebaseUser?.uid ?? ""} lastOwner={false}>
            <button
              className="btn btn-primary btn-sm"
              disabled={busyUid === u.uid}
              onClick={() => onEnable(u)}
            >
              再有効化（承認済みに戻す）
            </button>
          </UserCard>
        ))}
      </main>
    </div>
  );
}

/**
 * 閲覧可能店舗の設定UI（owner専用・PR5レビュー対応）。
 * - 有効店舗一覧はstoresから取得（useStores経由）
 * - 保存前に変更内容を確認（window.confirm）
 * - 保存中は二重クリックを防止（busyで無効化）
 * - 保存失敗時は成功表示を出さない（親のactionErrorのみに委ねる）
 * - 保存後の画面反映はsubscribeAllUsersのリアルタイム購読で自動的に行われる
 * - 承認直後などaccessibleStoreIdsが空の場合は「店舗未設定」を明示
 */
function StoreAccessEditor({
  user,
  stores,
  busy,
  onSave,
}: {
  user: UserWithId;
  stores: StoreWithId[];
  busy: boolean;
  onSave: (storeIds: string[], confirmEmpty: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>(user.accessibleStoreIds);

  // 保存成功後（親のFirestore購読が更新される）に選択状態を同期する
  useEffect(() => {
    setSelected(user.accessibleStoreIds);
  }, [user.accessibleStoreIds]);

  function toggle(storeId: string) {
    setSelected((prev) =>
      prev.includes(storeId) ? prev.filter((id) => id !== storeId) : [...prev, storeId]
    );
  }

  const changed =
    selected.length !== user.accessibleStoreIds.length ||
    selected.some((id) => !user.accessibleStoreIds.includes(id));

  function onSubmit() {
    const names = stores.filter((s) => selected.includes(s.id)).map((s) => s.name);
    const message =
      selected.length === 0
        ? `${user.displayName} の閲覧可能店舗をすべて解除します。どの店舗のデータも見えなくなりますが、よろしいですか？`
        : `${user.displayName} の閲覧可能店舗を次のとおり保存します。\n\n${names.join("、")}\n\nよろしいですか？`;
    if (!window.confirm(message)) return;
    onSave(selected, selected.length === 0);
  }

  const noStoreConfigured = user.accessibleStoreIds.length === 0;

  return (
    <div style={{ width: "100%", marginTop: 6 }}>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => setOpen((v) => !v)}
      >
        閲覧可能店舗を設定 {open ? "▲" : "▼"}
      </button>
      {noStoreConfigured && (
        <span className="badge badge-yellow" style={{ marginLeft: 8 }}>
          店舗が未設定です（このままではどのデータも閲覧できません）
        </span>
      )}
      {open && (
        <div
          style={{
            marginTop: 8,
            padding: 10,
            border: "1px solid var(--border)",
            borderRadius: 8,
          }}
        >
          {stores.length === 0 ? (
            <p className="empty-note">有効な店舗がありません</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {stores.map((s) => (
                <label
                  key={s.id}
                  style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(s.id)}
                    disabled={busy}
                    onChange={() => toggle(s.id)}
                  />
                  {s.name}
                </label>
              ))}
            </div>
          )}
          <button
            type="button"
            className="btn btn-primary btn-sm"
            style={{ marginTop: 10 }}
            disabled={busy || !changed}
            onClick={onSubmit}
          >
            {busy ? "保存中…" : "店舗設定を保存"}
          </button>
        </div>
      )}
    </div>
  );
}

function UserCard({
  user,
  meUid,
  lastOwner,
  children,
}: {
  user: UserWithId;
  meUid: string;
  lastOwner: boolean;
  children: React.ReactNode;
}) {
  const statusBadge =
    user.status === "approved"
      ? "badge-green"
      : user.status === "pending"
        ? "badge-yellow"
        : "badge-red";
  return (
    <div className="user-card">
      <div className="row1">
        <div>
          <div className="name">
            {user.displayName}
            {user.uid === meUid && (
              <span style={{ fontSize: 11, color: "var(--acc2)", marginLeft: 6 }}>
                （自分）
              </span>
            )}
          </div>
          <div className="email">{user.email}</div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span className="badge badge-purple">{ROLE_LABELS[user.role]}</span>
          <span className={`badge ${statusBadge}`}>{USER_STATUS_LABELS[user.status]}</span>
          {lastOwner && <span className="badge badge-yellow">最後のオーナー</span>}
        </div>
      </div>
      <div className="actions">{children}</div>
    </div>
  );
}
