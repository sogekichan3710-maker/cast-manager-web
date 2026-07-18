"use client";

import { useEffect, useMemo, useState } from "react";
import { subscribeStores } from "@/services/storeService";
import { useAuth } from "@/contexts/AuthContext";
import { isOwner, type StoreWithId } from "@/types";

/**
 * 店舗一覧の購読hook。
 * accessibleStores: ログインユーザーが閲覧できる有効店舗のみ
 * （owner: 全有効店舗 / admin・viewer: accessibleStoreIds の店舗）
 */
export function useStores() {
  const { userDoc } = useAuth();
  const [stores, setStores] = useState<StoreWithId[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    const unsub = subscribeStores(
      (list) => {
        setStores(list);
        setError(null);
        setLoading(false);
      },
      (msg) => {
        setError(msg);
        setLoading(false);
      }
    );
    return unsub;
  }, []);

  const accessibleStores = useMemo(() => {
    const active = stores.filter((s) => s.active);
    if (!userDoc) return [];
    if (isOwner(userDoc)) return active;
    return active.filter((s) => userDoc.accessibleStoreIds.includes(s.id));
  }, [stores, userDoc]);

  return { stores, accessibleStores, loading, error };
}
