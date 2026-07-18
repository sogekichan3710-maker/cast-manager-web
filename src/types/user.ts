import type { Timestamp } from "firebase/firestore";

/** ユーザー権限（一元管理・変更時はFirestore Rulesも更新すること） */
export const ROLES = ["owner", "admin", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/** ユーザー状態 */
export const USER_STATUSES = ["pending", "approved", "disabled"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: "オーナー",
  admin: "管理者",
  viewer: "閲覧のみ",
};

export const USER_STATUS_LABELS: Record<UserStatus, string> = {
  pending: "承認待ち",
  approved: "承認済み",
  disabled: "無効",
};

/**
 * users/{uid} ドキュメント。
 * 新規登録時は必ず role: 'viewer' / status: 'pending' で作成される
 * （Firestore Rules で強制）。
 */
export interface UserDoc {
  email: string;
  displayName: string;
  role: Role;
  status: UserStatus;
  /** 閲覧可能な店舗ID。owner は空配列でも全店舗アクセス可とする。 */
  accessibleStoreIds: string[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
  approvedAt: Timestamp | null;
  approvedBy: string | null;
  disabledAt: Timestamp | null;
}

/** 画面で扱うときの uid 付きユーザー */
export interface UserWithId extends UserDoc {
  uid: string;
}

export function isOwner(user: Pick<UserDoc, "role" | "status"> | null): boolean {
  return !!user && user.status === "approved" && user.role === "owner";
}

export function isAdminOrAbove(user: Pick<UserDoc, "role" | "status"> | null): boolean {
  return (
    !!user &&
    user.status === "approved" &&
    (user.role === "owner" || user.role === "admin")
  );
}
