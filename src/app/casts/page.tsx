"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/contexts/AuthContext";
import { AppHeader } from "@/components/AppHeader";
import { RankBadge, StatusBadge } from "@/components/Badges";
import { CastFormModal } from "@/components/CastFormModal";
import { useCasts } from "@/hooks/useCasts";
import { useStores } from "@/hooks/useStores";
import { archiveCast, restoreCast } from "@/services/castService";
import {
  ALL_STORES_FILTER,
  CAST_STATUSES,
  RANKS,
  isAdminOrAbove,
  type CastWithId,
} from "@/types";

export default function CastsPage() {
  const { firebaseUser, userDoc } = useAuth();
  const canEdit = isAdminOrAbove(userDoc);

  const { accessibleStores, loading: storesLoading, error: storesError } = useStores();

  // 表示フィルター（'__all__' は表示条件のみ。Firestoreへは保存しない）
  const [storeFilter, setStoreFilter] = useState<string>(ALL_STORES_FILTER);
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [rankFilter, setRankFilter] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  // 実際に購読する店舗ID（全店舗 = アクセス可能な全店舗へ展開）
  const targetStoreIds = useMemo(() => {
    if (storeFilter === ALL_STORES_FILTER) return accessibleStores.map((s) => s.id);
    return accessibleStores.some((s) => s.id === storeFilter) ? [storeFilter] : [];
  }, [storeFilter, accessibleStores]);

  const { casts, loading: castsLoading, error: castsError, refresh } = useCasts(targetStoreIds);

  const storeNameOf = useMemo(() => {
    const m = new Map(accessibleStores.map((s) => [s.id, s.name]));
    return (id: string) => m.get(id) ?? id;
  }, [accessibleStores]);

  const filtered = useMemo(() => {
    // 検索の正規化: 前後空白除去 + 小文字化 + 全角半角統一（NFKC）
    const norm = (s: string) => s.normalize("NFKC").toLowerCase().trim();
    const query = norm(q);
    return casts.filter((c) => {
      if (!showArchived && c.archived) return false;
      if (showArchived && !c.archived) return false;
      if (statusFilter && c.status !== statusFilter) return false;
      if (rankFilter && c.rank !== rankFilter) return false;
      if (query) {
        // 既存ローカル版と同じ対象: 源氏名・本名・メモ・担当者（＋ふりがな）
        const hit =
          norm(c.stageName ?? "").includes(query) ||
          norm(c.realName ?? "").includes(query) ||
          norm(c.kana ?? "").includes(query) ||
          norm(c.memo ?? "").includes(query) ||
          norm(c.manager ?? "").includes(query);
        if (!hit) return false;
      }
      return true;
    });
  }, [casts, q, statusFilter, rankFilter, showArchived]);

  const [formCast, setFormCast] = useState<CastWithId | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function onToggleArchive(c: CastWithId) {
    if (!firebaseUser) return;
    const msg = c.archived
      ? `「${c.stageName}」をアーカイブから復元しますか？`
      : `「${c.stageName}」をアーカイブしますか？（一覧から非表示になります）`;
    if (!window.confirm(msg)) return;
    setActionError(null);
    setBusyId(c.id);
    try {
      const actorName = userDoc?.displayName ?? "";
      if (c.archived) await restoreCast(firebaseUser.uid, actorName, c.id);
      else await archiveCast(firebaseUser.uid, actorName, c.id);
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  const loading = storesLoading || castsLoading;
  const error = storesError || castsError;

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="app-main app-main-wide">
        <div className="page-head">
          <div>
            <h1 className="page-title">キャスト一覧</h1>
            <p className="page-sub">
              {storeFilter === ALL_STORES_FILTER
                ? `全店舗（閲覧可能な${accessibleStores.length}店舗）`
                : storeNameOf(storeFilter)}
              {" ・ "}
              {filtered.length}名を表示中
            </p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn btn-ghost btn-sm" onClick={refresh} disabled={loading}>
              ↻ 更新
            </button>
            {canEdit && (
              <button
                className="btn btn-primary btn-sm"
                onClick={() => {
                  setFormCast(null);
                  setFormOpen(true);
                }}
                disabled={accessibleStores.length === 0}
              >
                ＋ キャスト登録
              </button>
            )}
          </div>
        </div>

        <div className="filter-bar">
          <select
            className="form-input"
            value={storeFilter}
            onChange={(e) => setStoreFilter(e.target.value)}
            aria-label="店舗"
          >
            <option value={ALL_STORES_FILTER}>全店舗</option>
            {accessibleStores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <input
            className="form-input"
            placeholder="源氏名・本名・ふりがな・メモ・担当者で検索"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="検索"
          />
          <select
            className="form-input"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            aria-label="在籍状態"
          >
            <option value="">全状態</option>
            {CAST_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            className="form-input"
            value={rankFilter}
            onChange={(e) => setRankFilter(e.target.value)}
            aria-label="ランク"
          >
            <option value="">全ランク</option>
            {RANKS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <label className="check-label">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            アーカイブを表示
          </label>
        </div>

        {error && <div className="error-box">読み込みエラー: {error}</div>}
        {actionError && <div className="error-box">{actionError}</div>}

        {loading ? (
          <div className="loading-block" style={{ padding: 60 }}>
            <div className="spinner" aria-hidden />
            <p>キャストを読み込んでいます…</p>
          </div>
        ) : accessibleStores.length === 0 ? (
          <div className="info-box">
            閲覧できる店舗がありません。オーナーに店舗アクセスの設定を依頼してください。
          </div>
        ) : filtered.length === 0 ? (
          <div className="info-box">
            {showArchived
              ? "アーカイブ済みのキャストはいません。"
              : casts.length === 0
                ? "キャストがまだ登録されていません。「＋ キャスト登録」から追加してください。"
                : "条件に一致するキャストがいません。検索条件を変更してください。"}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>源氏名</th>
                  <th>本名</th>
                  <th>店舗</th>
                  <th>状態</th>
                  <th>ランク</th>
                  <th className="num">時給</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.id} className={c.archived ? "row-archived" : ""}>
                    <td>
                      <Link href={`/casts/${c.id}`} className="cast-link">
                        {c.stageName}
                      </Link>
                      {c.archived && <span className="badge badge-gray">アーカイブ</span>}
                    </td>
                    <td className="dim">{c.realName || "—"}</td>
                    <td>{storeNameOf(c.storeId)}</td>
                    <td>
                      <StatusBadge status={c.status} />
                    </td>
                    <td>{c.rank ? <RankBadge rank={c.rank} /> : "—"}</td>
                    <td className="num">
                      {c.hourlyWage ? `¥${c.hourlyWage.toLocaleString()}` : "—"}
                    </td>
                    <td>
                      <div style={{ display: "flex", gap: 6 }}>
                        {canEdit && (
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={() => {
                              setFormCast(c);
                              setFormOpen(true);
                            }}
                          >
                            編集
                          </button>
                        )}
                        {canEdit && (
                          <button
                            className="btn btn-ghost btn-sm"
                            disabled={busyId === c.id}
                            onClick={() => void onToggleArchive(c)}
                          >
                            {c.archived ? "復元" : "アーカイブ"}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {formOpen && (
        <CastFormModal
          cast={formCast}
          defaultStoreId={storeFilter}
          stores={accessibleStores}
          onClose={() => setFormOpen(false)}
          onSaved={() => setFormOpen(false)}
        />
      )}
    </div>
  );
}
