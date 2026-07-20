/**
 * 最後のowner保護・自己操作確認のための純粋ロジック（PR5）。
 *
 * Firebase Admin SDK や Cloud Functions ランタイムに依存しない純粋関数として
 * 分離しており、functions/ 単体のvitestで実際の判定条件を検証できる。
 * 呼び出し側（index.ts の callable functions）は、Firestore トランザクション内で
 * 「承認済みownerの実数」をクエリで取得し、ここへ渡す。
 */

export type Role = "owner" | "admin" | "viewer";
export type UserStatus = "pending" | "approved" | "disabled";

export interface TargetUserSnapshot {
  uid: string;
  role: Role;
  status: UserStatus;
}

export class GuardError extends Error {
  constructor(
    message: string,
    public code: "last-owner" | "self-confirm-required" = "last-owner"
  ) {
    super(message);
    this.name = "GuardError";
  }
}

/** 対象ユーザーが「唯一の承認済みowner」かどうか */
export function isLastApprovedOwner(
  target: TargetUserSnapshot,
  approvedOwnerCount: number
): boolean {
  const targetIsApprovedOwner = target.role === "owner" && target.status === "approved";
  if (!targetIsApprovedOwner) return false;
  return approvedOwnerCount <= 1;
}

/**
 * 権限変更が許可されるか検証する。
 * 最後の承認済みownerを owner 以外へ降格することを禁止する。
 */
export function assertCanChangeRole(
  target: TargetUserSnapshot,
  newRole: Role,
  approvedOwnerCount: number
): void {
  if (newRole === "owner") return; // 昇格は常に許可
  if (isLastApprovedOwner(target, approvedOwnerCount)) {
    throw new GuardError("最後のオーナーは降格できません");
  }
}

/** 無効化が許可されるか検証する。最後の承認済みownerの無効化を禁止する。 */
export function assertCanDisable(
  target: TargetUserSnapshot,
  approvedOwnerCount: number
): void {
  if (isLastApprovedOwner(target, approvedOwnerCount)) {
    throw new GuardError("最後のオーナーは無効化できません");
  }
}

/**
 * 自分自身に対する無効化操作は、明示的な確認フラグ（confirmSelf）が
 * ない限り拒否する（誤操作によるロックアウト防止）。
 */
export function assertSelfDisableConfirmed(
  callerUid: string,
  targetUid: string,
  confirmSelf: boolean
): void {
  if (callerUid === targetUid && !confirmSelf) {
    throw new GuardError(
      "自分自身を無効化しようとしています。確認のうえ再実行してください（confirmSelf）",
      "self-confirm-required"
    );
  }
}
