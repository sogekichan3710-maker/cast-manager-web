import { describe, expect, it } from "vitest";
import {
  GuardError,
  assertCanChangeRole,
  assertCanDisable,
  assertSelfDisableConfirmed,
  isLastApprovedOwner,
  type TargetUserSnapshot,
} from "../lastOwnerGuard";

function owner(overrides: Partial<TargetUserSnapshot> = {}): TargetUserSnapshot {
  return { uid: "u1", role: "owner", status: "approved", ...overrides };
}

describe("isLastApprovedOwner", () => {
  it("承認済みownerが1名のみ・対象がそのowner本人 → true", () => {
    expect(isLastApprovedOwner(owner(), 1)).toBe(true);
  });

  it("承認済みownerが2名以上 → false", () => {
    expect(isLastApprovedOwner(owner(), 2)).toBe(false);
    expect(isLastApprovedOwner(owner(), 5)).toBe(false);
  });

  it("対象がadmin/viewerの場合は常にfalse", () => {
    expect(isLastApprovedOwner(owner({ role: "admin" }), 1)).toBe(false);
    expect(isLastApprovedOwner(owner({ role: "viewer" }), 1)).toBe(false);
  });

  it("対象がpending/disabledのownerの場合は常にfalse（承認済みではないため）", () => {
    expect(isLastApprovedOwner(owner({ status: "pending" }), 1)).toBe(false);
    expect(isLastApprovedOwner(owner({ status: "disabled" }), 1)).toBe(false);
  });
});

describe("assertCanChangeRole（最後のowner降格不可）", () => {
  it("最後のownerをadminへ降格 → GuardError", () => {
    expect(() => assertCanChangeRole(owner(), "admin", 1)).toThrow(GuardError);
  });

  it("最後のownerをviewerへ降格 → GuardError", () => {
    expect(() => assertCanChangeRole(owner(), "viewer", 1)).toThrow(GuardError);
  });

  it("owner昇格は常に許可（承認済みowner数に関わらず）", () => {
    expect(() => assertCanChangeRole(owner({ role: "viewer" }), "owner", 0)).not.toThrow();
  });

  it("2名以上ownerがいる場合の降格は許可", () => {
    expect(() => assertCanChangeRole(owner(), "admin", 2)).not.toThrow();
  });

  it("admin/viewerの権限変更は最後のowner保護の対象外", () => {
    expect(() => assertCanChangeRole(owner({ role: "admin" }), "viewer", 1)).not.toThrow();
  });
});

describe("assertCanDisable（最後のowner無効化不可）", () => {
  it("最後のownerの無効化 → GuardError", () => {
    expect(() => assertCanDisable(owner(), 1)).toThrow(GuardError);
  });

  it("2名以上ownerがいる場合の無効化は許可", () => {
    expect(() => assertCanDisable(owner(), 2)).not.toThrow();
  });

  it("admin/viewerの無効化は最後のowner保護の対象外", () => {
    expect(() => assertCanDisable(owner({ role: "admin" }), 1)).not.toThrow();
  });
});

describe("assertSelfDisableConfirmed（自分自身の無効化確認）", () => {
  it("自分自身をconfirmSelf無しで無効化しようとすると拒否", () => {
    expect(() => assertSelfDisableConfirmed("u1", "u1", false)).toThrow(GuardError);
    try {
      assertSelfDisableConfirmed("u1", "u1", false);
    } catch (e) {
      expect((e as GuardError).code).toBe("self-confirm-required");
    }
  });

  it("自分自身をconfirmSelf付きで無効化は許可", () => {
    expect(() => assertSelfDisableConfirmed("u1", "u1", true)).not.toThrow();
  });

  it("他人を無効化する場合はconfirmSelf不要", () => {
    expect(() => assertSelfDisableConfirmed("u1", "u2", false)).not.toThrow();
  });
});
