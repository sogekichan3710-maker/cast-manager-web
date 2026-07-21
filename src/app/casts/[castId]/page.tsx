"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { Timestamp } from "firebase/firestore";
import { useAuth } from "@/contexts/AuthContext";
import { AppHeader } from "@/components/AppHeader";
import { RankBadge, StatusBadge } from "@/components/Badges";
import { CastDetailSections } from "@/components/CastDetailSections";
import { CastFormModal } from "@/components/CastFormModal";
import { useStores } from "@/hooks/useStores";
import { subscribeCast } from "@/services/castService";
import { isAdminOrAbove, type CastWithId } from "@/types";

/**
 * キャスト詳細ページ。
 * 基本情報・メモ・記録情報に加え、CastDetailSections が
 * 成績サマリー・推移グラフ・月別成績一覧・面談・目標・モチベーション・
 * 時給履歴の各セクションを表示する。
 */
export default function CastDetailPage() {
  const params = useParams<{ castId: string }>();
  const castId = params.castId;

  const { userDoc } = useAuth();
  const canEdit = isAdminOrAbove(userDoc);
  const { accessibleStores } = useStores();

  const [cast, setCast] = useState<CastWithId | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "notFound" | "denied" | "error">(
    "loading"
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  useEffect(() => {
    if (!castId) return;
    setState("loading");
    const unsub = subscribeCast(
      castId,
      (c) => {
        if (!c) {
          setCast(null);
          setState("notFound");
          return;
        }
        setCast(c);
        setState("ok");
      },
      (msg) => {
        // 許可外店舗のキャストはRulesでpermission-deniedになる
        if (msg.toLowerCase().includes("permission")) {
          setState("denied");
        } else {
          setErrorMsg(msg);
          setState("error");
        }
      }
    );
    return unsub;
  }, [castId]);

  const storeName = useMemo(() => {
    if (!cast) return "";
    return accessibleStores.find((s) => s.id === cast.storeId)?.name ?? cast.storeId;
  }, [cast, accessibleStores]);

  return (
    <div className="app-shell">
      <AppHeader />
      <main className="app-main">
        <p style={{ marginBottom: 14 }}>
          <Link href="/casts" style={{ fontSize: 12 }}>
            ← キャスト一覧へ戻る
          </Link>
        </p>

        {state === "loading" && (
          <div className="loading-block" style={{ padding: 60 }}>
            <div className="spinner" aria-hidden />
            <p>キャスト情報を読み込んでいます…</p>
          </div>
        )}

        {state === "notFound" && (
          <div className="info-box">
            このキャストは見つかりません。削除されたか、URLが誤っている可能性があります。
          </div>
        )}

        {state === "denied" && (
          <div className="error-box">
            このキャストを閲覧する権限がありません（許可されていない店舗のデータです）。
          </div>
        )}

        {state === "error" && (
          <div className="error-box">読み込みに失敗しました: {errorMsg}</div>
        )}

        {state === "ok" && cast && (
          <>
            <div className="page-head">
              <div>
                <h1 className="page-title" style={{ fontSize: 20 }}>
                  {cast.stageName}
                  {cast.archived && (
                    <span className="badge badge-gray" style={{ marginLeft: 8 }}>
                      アーカイブ済み
                    </span>
                  )}
                </h1>
                <p className="page-sub" style={{ marginBottom: 0 }}>
                  {storeName} ・ <StatusBadge status={cast.status} />{" "}
                  {cast.rank && <RankBadge rank={cast.rank} />}
                </p>
              </div>
              {canEdit && (
                <button className="btn btn-primary btn-sm" onClick={() => setEditOpen(true)}>
                  編集
                </button>
              )}
            </div>

            <section className="detail-card">
              <h2 className="detail-heading">基本情報</h2>
              <dl className="detail-grid">
                <Item label="源氏名" value={cast.stageName} />
                <Item label="本名" value={cast.realName} />
                <Item label="ふりがな" value={cast.kana} />
                <Item label="店舗" value={storeName} />
                <Item label="在籍状態" value={cast.status} />
                <Item label="ランク" value={cast.rank} />
                <Item
                  label="時給"
                  value={cast.hourlyWage ? `¥${cast.hourlyWage.toLocaleString()}` : ""}
                />
                <Item label="入店日" value={cast.joinDate} />
                <Item label="退店日" value={cast.leftDate} />
                <Item label="誕生日" value={cast.birthday} />
                <Item label="電話番号" value={cast.phone} />
                <Item label="LINE" value={cast.line} />
                <Item label="担当者" value={cast.manager} />
                <Item label="スカウト者" value={cast.scoutedBy} />
                <Item label="保証" value={cast.guarantee} />
                <Item
                  label="目標売上"
                  value={cast.targetSales ? `¥${cast.targetSales.toLocaleString()}` : ""}
                />
                <Item
                  label="目標本指名"
                  value={cast.targetHonmei ? `${cast.targetHonmei}本` : ""}
                />
                <Item
                  label="目標同伴"
                  value={cast.targetDouhan ? `${cast.targetDouhan}回` : ""}
                />
                <Item label="性格" value={cast.personality} />
              </dl>
            </section>

            <section className="detail-card">
              <h2 className="detail-heading">メモ</h2>
              <MultilineItem label="メモ" value={cast.memo} />
              <MultilineItem label="顧客メモ" value={cast.customerNotes} />
            </section>

            <section className="detail-card">
              <h2 className="detail-heading">記録情報</h2>
              <dl className="detail-grid">
                <Item label="作成日時" value={formatTs(cast.createdAt)} />
                <Item label="更新日時" value={formatTs(cast.updatedAt)} />
                <Item
                  label="アーカイブ状態"
                  value={cast.archived ? "アーカイブ済み" : "表示中"}
                />
              </dl>
            </section>

            <CastDetailSections cast={cast} />
          </>
        )}
      </main>

      {editOpen && cast && (
        <CastFormModal
          cast={cast}
          defaultStoreId={cast.storeId}
          stores={accessibleStores}
          onClose={() => setEditOpen(false)}
          onSaved={() => setEditOpen(false)}
        />
      )}
    </div>
  );
}

function Item({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="detail-item">
      <dt>{label}</dt>
      <dd>{value?.trim?.() !== "" && value != null ? value : "—"}</dd>
    </div>
  );
}

function MultilineItem({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="detail-label">{label}</div>
      <div className="detail-multiline">{value?.trim() ? value : "—"}</div>
    </div>
  );
}

function formatTs(ts: Timestamp | null | undefined): string {
  if (!ts || typeof ts.toDate !== "function") return "";
  return ts.toDate().toLocaleString("ja-JP");
}
