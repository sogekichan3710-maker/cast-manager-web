"use client";

import { useMemo } from "react";
import { useTheme } from "@/contexts/ThemeContext";
import { readableStoreColor } from "@/lib/storeColor";
import type { StoreWithId } from "@/types";

/**
 * 店舗IDから、その店舗の設定カラー（stores/{storeId}.color）を
 * 現在のテーマ背景で読める文字色に補正して引く関数を返すhook。
 * 色は店舗ドキュメントの既存フィールドのみを参照し、別途保存はしない。
 * 未設定・不正値・未知の店舗IDの場合は undefined（＝色指定なし＝現在の文字色）。
 */
export function useStoreColor(stores: StoreWithId[]): (storeId: string) => string | undefined {
  const { theme } = useTheme();
  return useMemo(() => {
    const map = new Map<string, string>();
    for (const s of stores) {
      const c = readableStoreColor(s.color, theme);
      if (c) map.set(s.id, c);
    }
    return (storeId: string) => map.get(storeId);
  }, [stores, theme]);
}
