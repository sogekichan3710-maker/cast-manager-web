"use client";

import { useEffect, useState } from "react";
import { subscribeMonthlyResultsByStores } from "@/services/monthlyResultService";
import {
  subscribeGoalsByStores,
  subscribeInterviewsByStores,
  subscribeMotivationsByStores,
} from "@/services/recordService";
import type {
  GoalWithId,
  InterviewWithId,
  MonthlyResultWithId,
  MotivationWithId,
} from "@/types";

/**
 * ダッシュボード用の一括購読フック。
 * 画面表示中のみ購読し、アンマウント時に解除する。
 * 注意: 閲覧可能店舗の全件購読のため、データ量が大きくなった場合は
 * 期間絞り込みへの最適化を検討（残課題としてREADMEに記載）。
 */
export function useDashboardData(storeIds: string[]) {
  const [results, setResults] = useState<MonthlyResultWithId[]>([]);
  const [interviews, setInterviews] = useState<InterviewWithId[]>([]);
  const [goals, setGoals] = useState<GoalWithId[]>([]);
  const [motivations, setMotivations] = useState<MotivationWithId[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const key = storeIds.slice().sort().join(",");

  useEffect(() => {
    if (storeIds.length === 0) {
      setResults([]);
      setInterviews([]);
      setGoals([]);
      setMotivations([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    let loaded = 0;
    const done = () => {
      loaded++;
      if (loaded >= 4) setLoading(false);
    };
    const onErr = (m: string) => {
      setError(m);
      setLoading(false);
    };
    const unsubs = [
      subscribeMonthlyResultsByStores(
        storeIds,
        (v) => {
          setResults(v);
          done();
        },
        onErr
      ),
      subscribeInterviewsByStores(
        storeIds,
        (v) => {
          setInterviews(v);
          done();
        },
        onErr
      ),
      subscribeGoalsByStores(
        storeIds,
        (v) => {
          setGoals(v);
          done();
        },
        onErr
      ),
      subscribeMotivationsByStores(
        storeIds,
        (v) => {
          setMotivations(v);
          done();
        },
        onErr
      ),
    ];
    return () => unsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refreshKey]);

  return {
    results,
    interviews,
    goals,
    motivations,
    loading,
    error,
    refresh: () => setRefreshKey((k) => k + 1),
  };
}
