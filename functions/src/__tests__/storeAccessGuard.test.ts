import { describe, expect, it } from "vitest";
import { StoreAccessGuardError, normalizeStoreIds } from "../storeAccessGuard";

describe("normalizeStoreIds", () => {
  it("文字列配列以外は拒否する", () => {
    expect(() => normalizeStoreIds("store_a", false)).toThrow(StoreAccessGuardError);
    expect(() => normalizeStoreIds([1, 2], false)).toThrow(StoreAccessGuardError);
    expect(() => normalizeStoreIds(null, false)).toThrow(StoreAccessGuardError);
  });

  it("'__all__' を含む場合は拒否する", () => {
    expect(() => normalizeStoreIds(["store_a", "__all__"], false)).toThrow(StoreAccessGuardError);
  });

  it("重複するstoreIdは除去する", () => {
    expect(normalizeStoreIds(["store_a", "store_b", "store_a"], false)).toEqual([
      "store_a",
      "store_b",
    ]);
  });

  it("空配列はconfirmEmptyがfalseだと拒否する", () => {
    expect(() => normalizeStoreIds([], false)).toThrow(StoreAccessGuardError);
    try {
      normalizeStoreIds([], false);
    } catch (err) {
      expect((err as StoreAccessGuardError).code).toBe("confirm-empty-required");
    }
  });

  it("空配列はconfirmEmptyがtrueなら許可する", () => {
    expect(normalizeStoreIds([], true)).toEqual([]);
  });

  it("正常な配列はそのまま（重複除去済み）返す", () => {
    expect(normalizeStoreIds(["store_a", "store_b"], false)).toEqual(["store_a", "store_b"]);
  });
});
