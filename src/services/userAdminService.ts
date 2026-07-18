import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  where,
  type Unsubscribe,
} from "firebase/firestore";
import { getDb } from "@/lib/firebase";
import type { Role, UserDoc, UserWithId } from "@/types";

/**
 * ユーザー管理サービス層。
 *
 * ⚠️ 暫定実装（PR1時点）
 * ここにある承認・権限変更・無効化などの重要操作は、現時点では
 * クライアント側の Firestore トランザクションで実装している。
 * クライアント側の owner 数チェックは、同時操作や改変されたクライアント
 * に対して完全な安全性を保証できない。
 *
 * 本番運用前に、以下の関数を Callable Cloud Functions へ移行すること：
 *   - approveUser
 *   - changeUserRole
 *   - disableUser / enableUser
 *   - setAccessibleStores
 *
 * この前提で、各関数のシグネチャは Cloud Functions の callable
 * （data in / result out、例外でエラー）と同じ形に揃えてある。
 * 置き換え時は関数本体を httpsCallable(...) 呼び出しに差し替えるだけでよい。
 * UIコンポーネントからは必ずこのサービス層経由で操作し、
 * users ドキュメントを直接更新しないこと。
 */

const USERS = "users";

export function subscribeAllUsers(
  onChange: (users: UserWithId[]) => void,
  onError: (message: string) => void
): Unsubscribe {
  const q = query(collection(getDb(), USERS));
  return onSnapshot(
    q,
    (snap) => {
      const users = snap.docs.map((d) => ({ uid: d.id, ...(d.data() as UserDoc) }));
      users.sort((a, b) => (a.email < b.email ? -1 : 1));
      onChange(users);
    },
    (err) => onError(err.message)
  );
}

/** 承認済みownerの数を数える（最後のowner保護のためのクライアント側チェック） */
async function countApprovedOwners(): Promise<number> {
  const q = query(
    collection(getDb(), USERS),
    where("role", "==", "owner"),
    where("status", "==", "approved")
  );
  const snap = await getDocs(q);
  return snap.size;
}

/**
 * 対象ユーザーが「最後の承認済みowner」かどうか。
 * 注意: クエリとトランザクションの間に競合が起こる可能性があり、
 * クライアント側では完全には防げない（README・残課題参照）。
 */
export async function isLastApprovedOwner(target: UserWithId): Promise<boolean> {
  if (target.role !== "owner" || target.status !== "approved") return false;
  const owners = await countApprovedOwners();
  return owners <= 1;
}

/** pendingユーザーを承認する（owner専用・Rulesでも制限） */
export async function approveUser(actorUid: string, targetUid: string): Promise<void> {
  const db = getDb();
  await runTransaction(db, async (tx) => {
    const ref = doc(db, USERS, targetUid);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("対象ユーザーが見つかりません");
    const data = snap.data() as UserDoc;
    if (data.status === "approved") throw new Error("既に承認済みです");
    tx.update(ref, {
      status: "approved",
      approvedAt: serverTimestamp(),
      approvedBy: actorUid,
      disabledAt: null,
      updatedAt: serverTimestamp(),
    });
  });
}

/** 権限を変更する（owner専用） */
export async function changeUserRole(
  actorUid: string,
  target: UserWithId,
  newRole: Role
): Promise<void> {
  if (target.uid === actorUid && newRole !== "owner") {
    // 自分自身の降格は最後のowner保護と自己ロックアウト防止のため必ず確認済みで呼ぶこと
    const last = await isLastApprovedOwner(target);
    if (last) throw new Error("最後のオーナーは降格できません");
  }
  if (target.role === "owner" && newRole !== "owner") {
    const last = await isLastApprovedOwner(target);
    if (last) throw new Error("最後のオーナーは降格できません");
  }
  const db = getDb();
  await runTransaction(db, async (tx) => {
    const ref = doc(db, USERS, target.uid);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("対象ユーザーが見つかりません");
    tx.update(ref, { role: newRole, updatedAt: serverTimestamp() });
  });
}

/** ユーザーを無効化する（owner専用） */
export async function disableUser(actorUid: string, target: UserWithId): Promise<void> {
  if (target.role === "owner" && target.status === "approved") {
    const last = await isLastApprovedOwner(target);
    if (last) throw new Error("最後のオーナーは無効化できません");
  }
  const db = getDb();
  await runTransaction(db, async (tx) => {
    const ref = doc(db, USERS, target.uid);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("対象ユーザーが見つかりません");
    tx.update(ref, {
      status: "disabled",
      disabledAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });
}

/** 無効化ユーザーを再有効化する（owner専用・approvedに戻す） */
export async function enableUser(actorUid: string, targetUid: string): Promise<void> {
  const db = getDb();
  await runTransaction(db, async (tx) => {
    const ref = doc(db, USERS, targetUid);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("対象ユーザーが見つかりません");
    const data = snap.data() as UserDoc;
    if (data.status !== "disabled") throw new Error("無効化されたユーザーではありません");
    tx.update(ref, {
      status: "approved",
      approvedAt: serverTimestamp(),
      approvedBy: actorUid,
      disabledAt: null,
      updatedAt: serverTimestamp(),
    });
  });
}

/** 閲覧可能店舗を設定する（owner専用） */
export async function setAccessibleStores(
  targetUid: string,
  storeIds: string[]
): Promise<void> {
  const db = getDb();
  await runTransaction(db, async (tx) => {
    const ref = doc(db, USERS, targetUid);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("対象ユーザーが見つかりません");
    tx.update(ref, { accessibleStoreIds: storeIds, updatedAt: serverTimestamp() });
  });
}
