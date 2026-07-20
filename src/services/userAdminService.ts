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
 * actorUid / actorName はクライアントから送らない（PR5レビュー対応）。
 * actorUidはCallable Function呼び出し時のIDトークンからサーバー側が
 * request.auth.uidとして取得し、actorNameも呼び出し元自身のusers
 * ドキュメントからサーバー側が取得する。クライアントが送った値をサーバーが
 * 信用することはない。
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
export async function approveUser(targetUid: string): Promise<void> {
  try {
    const fn = httpsCallable(getFunctionsInstance(), "approveUser");
    await fn({ targetUid });
  } catch (err) {
    throw new Error(toErrorMessage(err));
  }
}

/** 権限を変更する（owner専用・Cloud Functions経由。最後のowner降格はサーバー側で拒否） */
export async function changeUserRole(target: UserWithId, newRole: Role): Promise<void> {
  try {
    const fn = httpsCallable(getFunctionsInstance(), "changeUserRole");
    await fn({ targetUid: target.uid, newRole });
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
export async function disableUser(target: UserWithId, confirmSelf = false): Promise<void> {
  try {
    const fn = httpsCallable(getFunctionsInstance(), "disableUser");
    await fn({ targetUid: target.uid, confirmSelf });
  } catch (err) {
    throw new Error(toErrorMessage(err));
  }
}

/** 無効化ユーザーを再有効化する（owner専用・Cloud Functions経由） */
export async function enableUser(targetUid: string): Promise<void> {
  try {
    const fn = httpsCallable(getFunctionsInstance(), "enableUser");
    await fn({ targetUid });
  } catch (err) {
    throw new Error(toErrorMessage(err));
  }
}

/**
 * 閲覧可能店舗を設定する（owner専用・Cloud Functions経由）。
 * 空配列（全店舗アクセスの剥奪）を保存する場合は confirmEmpty を true に
 * すること。指定しないままだとサーバー側で failed-precondition が返る
 * （誤操作でユーザーの全店舗アクセスを奪うことを防ぐ確認）。
 * サーバー側で各storeIdの実在・active判定・重複除去・'__all__'拒否を行う。
 */
export async function setAccessibleStores(
  targetUid: string,
  storeIds: string[],
  confirmEmpty = false
): Promise<string[]> {
  try {
    const fn = httpsCallable(getFunctionsInstance(), "setAccessibleStores");
    const res = await fn({ targetUid, storeIds, confirmEmpty });
    const data = res.data as { ok: boolean; storeIds: string[] };
    return data.storeIds;
  } catch (err) {
    throw new Error(toErrorMessage(err));
  }
}
