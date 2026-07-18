"use client";

import { useCallback, useEffect, useState } from "react";
import { subscribeCasts } from "@/services/castService";
import type { CastWithId } from "@/types";

/**
 * キャスト一覧の購読hook。
 * storeIds: 実際に購読する店舗IDの配列（'__all__' は渡さないこと。
 * 「全店舗」表示は呼び出し側で accessibleStores のID配列へ展開する）。
 * 画面表示中のみ購読し、アンマウント時に解除する。
 */
export function useCasts(storeIds: string[]) {
  const [casts, setCasts] = useState<CastWithId[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // 更新ボタン用: 購読を張り直して確実に再取得する
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const key = storeIds.slice().sort().join(",");

  useEffect(() => {
    if (storeIds.length === 0) {
      setCasts([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const unsub = subscribeCasts(
      storeIds,
      (list) => {
        setCasts(list);
        setError(null);
        setLoading(false);
      },
      (msg) => {
        setError(msg);
        setLoading(false);
      }
    );
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refreshKey]);

  return { casts, loading, error, refresh };
}
