import {
  collection,
  onSnapshot,
  query,
  type Unsubscribe,
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { getDb, getFunctionsInstance } from "@/lib/firebase";
import type { Role, UserDoc, UserWithId } from "@/types";

/**
 * ユーザー管理サービス層（PR5でCloud Functionsへ移行）。
 *
 * 承認・権限変更・無効化・accessibleStoreIds設定は functions/src/index.ts の
 * Callable Functions（Admin SDK・Firestoreトランザクション内で承認済みowner数を
 * クエリして判定）で実行する。Firestore Rules 側も users.role / status /
 * accessibleStoreIds / approvedAt / approvedBy / disabledAt を
 * クライアントから直接変更できないよう制限しており、これらの変更は
 * 必ずこのサービス経由（＝Cloud Functions経由）になる。
 *
 * 「最後の承認済みownerの降格・無効化禁止」はCloud Functions側で
 * トランザクション内の実クエリにより保証される（クライアント側の
 * 事前チェックだけに頼らない）。
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

/** Cloud Functions呼び出しエラーをUI向けメッセージへ変換する */
function toErrorMessage(err: unknown): string {
  const e = err as { code?: string; message?: string };
  if (e?.message) return e.message;
  return "操作に失敗しました";
}

/** pendingユーザーを承認する（owner専用・Cloud Functions経由） */
export async function approveUser(
  actorUid: string,
  actorName: string,
  targetUid: string
): Promise<void> {
  try {
    const fn = httpsCallable(getFunctionsInstance(), "approveUser");
    await fn({ targetUid, actorName });
  } catch (err) {
    throw new Error(toErrorMessage(err));
  }
}

/** 権限を変更する（owner専用・Cloud Functions経由。最後のowner降格はサーバー側で拒否） */
export async function changeUserRole(
  actorUid: string,
  actorName: string,
  target: UserWithId,
  newRole: Role
): Promise<void> {
  try {
    const fn = httpsCallable(getFunctionsInstance(), "changeUserRole");
    await fn({ targetUid: target.uid, newRole, actorName });
  } catch (err) {
    throw new Error(toErrorMessage(err));
  }
}

/**
 * ユーザーを無効化する（owner専用・Cloud Functions経由）。
 * 最後のownerの無効化はサーバー側で拒否される。
 * 自分自身を無効化する場合は confirmSelf を true にして呼び出すこと
 * （未確認のまま呼ぶとサーバー側で failed-precondition が返る）。
 */
export async function disableUser(
  actorUid: string,
  actorName: string,
  target: UserWithId,
  confirmSelf = false
): Promise<void> {
  try {
    const fn = httpsCallable(getFunctionsInstance(), "disableUser");
    await fn({ targetUid: target.uid, actorName, confirmSelf });
  } catch (err) {
    throw new Error(toErrorMessage(err));
  }
}

/** 無効化ユーザーを再有効化する（owner専用・Cloud Functions経由） */
export async function enableUser(
  actorUid: string,
  actorName: string,
  targetUid: string
): Promise<void> {
  try {
    const fn = httpsCallable(getFunctionsInstance(), "enableUser");
    await fn({ targetUid, actorName });
  } catch (err) {
    throw new Error(toErrorMessage(err));
  }
}

/** 閲覧可能店舗を設定する（owner専用・Cloud Functions経由） */
export async function setAccessibleStores(
  actorUid: string,
  actorName: string,
  targetUid: string,
  storeIds: string[]
): Promise<void> {
  try {
    const fn = httpsCallable(getFunctionsInstance(), "setAccessibleStores");
    await fn({ targetUid, storeIds, actorName });
  } catch (err) {
    throw new Error(toErrorMessage(err));
  }
}
