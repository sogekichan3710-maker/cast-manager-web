import { describe, expect, it } from "vitest";
import { resolveCastDeleteOutcome } from "../castDeleteGuard";

describe("resolveCastDeleteOutcome", () => {
  it("キャストが存在すれば常に proceed（初回実行 or 途中失敗後の再実行）", () => {
    expect(resolveCastDeleteOutcome(true, false)).toBe("proceed");
    expect(resolveCastDeleteOutcome(true, true)).toBe("proceed");
  });

  it("キャストが存在せず完全削除ログも存在しなければ not-found", () => {
    expect(resolveCastDeleteOutcome(false, false)).toBe("not-found");
  });

  it("キャストが存在せず完全削除ログが存在すれば already-deleted（冪等な再実行）", () => {
    expect(resolveCastDeleteOutcome(false, true)).toBe("already-deleted");
  });
});
